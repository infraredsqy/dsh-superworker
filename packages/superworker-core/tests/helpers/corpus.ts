import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { jsonBytes, jsonOptionsForRecord, type RecordKind } from '../../src/jsonio';
import { createConfigNamespace } from '../../src/config';
import { createConductorNamespace } from '../../src/conductor';
import { SimulatedExecutor } from '../../src/executor';
import { open } from '../../src/open';

/**
 * Golden corpus replayer: one set of input records + one operation → byte-for-byte comparison of
 * the expected products.
 *
 * Case convention: `tests/fixtures/<case name>/` holds one
 * directory per case — `input/` holds the records from before the operation (relative to the
 * project root, tokenised; absent means empty input), `op.json` holds one operation (action path +
 * positional args) and `expected/` holds the expected products after the operation (the products of
 * that same operation, tokenised).
 *
 * The token rules are one set shared by the generation side and the replay side:
 * - node ids: each `@node-a@…` in the input takes a fresh uuid (allocated in token-name order); ids
 *   the operation newly creates continue from the highest existing letter in appearance order
 *   (`@node-e@…`). Id tokens appear in two places: in record bodies and in record file names (a
 *   handoff lands in `signals/<cycle>/<node>.json`, and the file name carries the node id).
 *   The **eight-character short id used to refer to a node** in a product (such as `a5c1de00`)
 *   takes its own `@short-a@…`: letters are allocated in appearance order (the same continuation
 *   as `@node-a@`), one short form, one token. Full ids and short ids are numbered separately, so
 *   how far an id is truncated is pinned by the comparison — printing the full id, or ten
 *   characters of it, shows up as a difference.
 * - project root: `@root@`. Planning products write the absolute path of the project root into
 *   their body (the landing spot of the prompt), and both sides swap it for this token; a JSON body
 *   carries the escaped spelling, so the swap is done on the escaped one too.
 * - timestamps: `@tN@` in the input takes a stamp stepping from a base point
 *   (2020-01-01T00:00:00Z plus N seconds, strictly earlier than the "now" the operation writes);
 *   which spelling one token materialises to follows the record shape — the graph and issues (micro
 *   form) spell down to the microsecond, while cycles, instructions, handoffs and session notes
 *   (seconds form) are truncated to the second. In a product an input stamp becomes its original
 *   token again, while a stamp the operation newly wrote takes the next number after the highest
 *   one, in ascending value order (`@t6@…`); both spellings are recognised.
 * - both sides put the records through the same formatting (`jsonBytes`, deep-sorted keys for ideas /
 *   issues) and then fold to LF for the byte compare; separators fold to `/` at the same time, so a
 *   fixture recorded on one platform replays green on another. Layout and other non-record files are
 *   folded to LF and compared directly. A failure points at the line number and context of the first
 *   difference.
 *
 * Some operations produce a **return value** (the plan of `conductor.next` lands in the return
 * value) and write no record file: `op.json` says `"expect": "return"`, and the replayer serialises
 * the return value with two-space indentation, tokenises it, and compares it with
 * `expected/return.json` byte for byte. Older cases leave that cell out and compare product files
 * only, as before.
 *
 * A case whose product carries the **current date** (the default cycle title `Cycle <YYYY-MM-DD>`
 * is derived from the clock) declares a **clock pin**: `op.json` says `"clock": "<ISO instant>"`, and
 * every timestamp the operation writes is derived from that instant instead of the wall clock. The
 * expectation can then hold the date literally and the case stays green on any day. Cases without a
 * pin read the real clock, exactly as before.
 */

/** The shape of op.json: an action path + positional args (never through argv) + where the products are compared. */
export interface CorpusOp {
  readonly path: string;
  readonly args: readonly unknown[];
  /**
   * The products are in the return value (serialised and compared with `expected/return.json`);
   * unset means the product files are compared.
   */
  readonly expect?: 'return';
  /**
   * Pin the clock of this case to one instant (ISO spelling, e.g. `2026-11-02T12:00:00Z`): every
   * timestamp the operation writes is derived from it instead of the wall clock, so a product that
   * records the current date (the default cycle title `Cycle <YYYY-MM-DD>`) can hold that date
   * literally and the case stays green on any day. Unset means the real clock.
   */
  readonly clock?: string;
  /**
   * The plugin folders this case's project has installed, by folder name, copied out of the shipped
   * set (`plugins/`) when the case is staged. A case that writes a record some plugin owns (`the
   * instruction account`, the issue pool) passes a word of that plugin's surface through
   * `conductor.pluginCommand`, so the temp project has to carry that plugin: this is how it says
   * which one, without a second copy of the plugin's files living in `fixtures/`.
   */
  readonly plugins?: readonly string[];
}

/**
 * The clock pin of the running case (epoch microseconds); `null` means the real clock. It lives in
 * `vi.hoisted` so it is initialised before the mocked `src/clock` is first imported.
 */
const clockPin = vi.hoisted(() => ({ epochUs: null as number | null }));

/**
 * The clock the engine's records are stamped with: the real `src/clock`, except that `nowMicro` /
 * `nowSeconds` answer from the pinned instant while a case that declares `op.clock` runs. The mock
 * is registered in every file that loads this helper, and the pin is the only switch — a case
 * without a pin reads the wall clock through the real functions, untouched.
 */
vi.mock('../../src/clock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/clock')>();
  return {
    ...actual,
    nowMicro: () =>
      clockPin.epochUs === null ? actual.nowMicro() : actual.microTimestampOf(clockPin.epochUs),
    nowSeconds: () =>
      clockPin.epochUs === null ? actual.nowSeconds() : actual.secondsTimestampOf(clockPin.epochUs),
  };
});

/** Parse the case's clock pin into epoch microseconds; a spelling it cannot read is a case error. */
function parseClockPin(spelling: string): number {
  const ms = Date.parse(spelling);
  if (Number.isNaN(ms)) {
    throw new Error(`op.json's clock pin cannot be read (an ISO instant such as 2026-11-02T12:00:00Z is expected): ${spelling}`);
  }
  return ms * 1000;
}

/** Run `body` with the clock pinned to `epochUs` (`null`: the real clock); the previous pin is restored afterwards. */
async function withPinnedClock<T>(epochUs: number | null, body: () => Promise<T>): Promise<T> {
  const previous = clockPin.epochUs;
  clockPin.epochUs = epochUs;
  try {
    return await body();
  } finally {
    clockPin.epochUs = previous;
  }
}

/**
 * The runner for one operation: a temporary project root with the input laid out + the materialised
 * positional args. By default the run walks down the action path from the handle; only a
 * transitional shape the corpus cannot reach brings a runner of its own.
 */
export type CorpusRunner = (root: string, args: readonly unknown[]) => Promise<unknown>;

/** The replay reading of one case: whether it passed, and where which files first disagree. */
export interface ReplayResult {
  readonly ok: boolean;
  readonly caseName: string;
  readonly problems: readonly string[];
}

/** The token spelling of a node id: @node-a@… (letters continue); one net scans bodies and file names alike. */
const NODE_TOKEN_RE = /@node-([a-z]+)@/;
const NODE_TOKEN_SCAN_RE = /@node-[a-z]+@/g;
const STAMP_TOKEN_RE = /@t(\d+)@/g;
/** Micro-form stamps (UTC with a literal Z), the spelling of the graph, issues and plugin records. */
const MICRO_STAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z/g;
/** Seconds-form stamps (UTC with a literal Z), the spelling of cycles, handoffs, instructions and session notes. */
const SECONDS_STAMP_RE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/**
 * An eight-character short id standing alone in a body (the prefix used when a body refers to a
 * node). It is followed by neither `-` nor `0-9a-f` and preceded by neither either: the first eight
 * characters of a full uuid (followed by `-`) and any slice of a longer hex string do not count as a
 * short form.
 */
const SHORT_ID_RE = /(?<![0-9a-f-])[0-9a-f]{8}(?![0-9a-f-])/g;

/** The base point of input stamps: every "now" an operation writes is strictly later than it, which keeps the ordering stable. */
const STAMP_BASE_US = Date.UTC(2020, 0, 1) * 1000;
/** The step of input stamps: one second. In a seconds-form file two different tokens cannot spell the same string. */
const STAMP_STEP_US = 1_000_000;

/** The token-to-value maps plus the two cursors used for continuing. Stamps keep two spellings, one per record shape. */
interface TokenMaps {
  readonly idToReal: Map<string, string>;
  /** token → stamp (epoch microseconds); which spelling it materialises to follows the record shape. */
  readonly stampToUs: Map<string, number>;
  readonly maxLetter: string;
  readonly maxStamp: number;
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

const pad = (value: number, width: number = 2) => String(value).padStart(width, '0');

/** The micro-form spelling of one epoch-microsecond reading (the same algorithm as src/clock, with the value given). */
function microStamp(epochUs: number): string {
  const epochMs = Math.floor(epochUs / 1000);
  const microRemainder = epochUs - epochMs * 1000;
  const moment = new Date(epochMs);
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}` +
    `T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}` +
    `.${pad(moment.getUTCMilliseconds() * 1000 + microRemainder, 6)}Z`
  );
}

/**
 * The seconds-form spelling of one epoch-microsecond reading (truncated below the second, the same
 * convention as the state.json writer).
 */
function secondsStamp(epochUs: number): string {
  const moment = new Date(Math.floor(epochUs / 1000));
  return (
    `${pad(moment.getUTCFullYear(), 4)}-${pad(moment.getUTCMonth() + 1)}-${pad(moment.getUTCDate())}` +
    `T${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}Z`
  );
}

/** Parse either stamp spelling back into epoch microseconds; a shape it cannot recognise returns null. */
function parseStampUs(spelling: string): number | null {
  const seconds = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(spelling);
  if (seconds !== null) {
    const [, y, m, d, h, mi, s] = seconds;
    return Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)) * 1000;
  }
  const micro = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{6})Z$/.exec(spelling);
  if (micro !== null) {
    const [, y, m, d, h, mi, s, frac] = micro;
    return (
      Date.UTC(Number(y), Number(m) - 1, Number(d), Number(h), Number(mi), Number(s)) * 1000 +
      Number(frac)
    );
  }
  return null;
}

/**
 * Read the token maps out of the tokenised input records: each id takes a fresh uuid (the keys of
 * the graph and the values in the bodies and file names of the other records all count), and each
 * stamp takes a value stepping from the base point (one token, both the micro and the seconds
 * spelling). Stamp tokens are collected from every input record (a cycle's stamps live in
 * state.json, not in ideas).
 * `ideasText` / `restText` are the raw text of all record files (the first is ideas.json, the second
 * is the remaining records joined); pass null / '' when the directory is absent.
 */
function materializeMaps(ideasText: string | null, restText: string): TokenMaps {
  const data = ideasText !== null ? (JSON.parse(ideasText) as { nodes?: Record<string, unknown> }) : {};
  const names = new Set<string>(
    Object.keys(data.nodes ?? {}).filter((key) => NODE_TOKEN_RE.test(key)),
  );
  const haystack = `${ideasText ?? ''}\n${restText}`;
  for (const match of haystack.matchAll(NODE_TOKEN_SCAN_RE)) names.add(match[0]);
  const keys = [...names].sort();
  const idToReal = new Map(keys.map((key) => [key, randomUUID()] as const));
  const stampNums = new Set<number>();
  for (const match of haystack.matchAll(STAMP_TOKEN_RE)) stampNums.add(Number(match[1]));
  const stampToUs = new Map(
    [...stampNums]
      .sort((a, b) => a - b)
      .map((n) => [`@t${n}@`, STAMP_BASE_US + n * STAMP_STEP_US] as const),
  );
  return {
    idToReal,
    stampToUs,
    maxLetter: keys.length > 0 ? (keys[keys.length - 1]!.match(NODE_TOKEN_RE)?.[1] ?? '') : '',
    maxStamp: stampNums.size > 0 ? Math.max(...stampNums) : 0,
  };
}

/** Continue the letters: d → e, z → aa, empty → a. */
function nextLetters(letter: string): string {
  if (letter === '') return 'a';
  const chars = [...letter];
  for (let index = chars.length - 1; index >= 0; index--) {
    const current = chars[index]!;
    if (current !== 'z') {
      chars[index] = String.fromCharCode(current.charCodeAt(0) + 1);
      return chars.join('');
    }
    chars[index] = 'a';
  }
  return 'a'.repeat(chars.length + 1);
}

/** Swap tokens in the text for concrete values (materialise); stamp spellings follow the `seconds` flag.
 *  The text is a JSON body: the project root is swapped in its spelling inside JSON (backslash written as two). */
function substitute(text: string, maps: TokenMaps, seconds: boolean, root: string): string {
  let out = text.split('@root@').join(escapedJson(root));
  for (const [token, real] of maps.idToReal) out = out.split(token).join(real);
  for (const [token, us] of maps.stampToUs) {
    out = out.split(token).join(seconds ? secondsStamp(us) : microStamp(us));
  }
  return out;
}

function escapedJson(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Swap id tokens in a path for concrete values (a handoff's file name carries the node id); paths carry no stamps. */
function substitutePath(relPath: string, maps: TokenMaps): string {
  let out = relPath;
  for (const [token, real] of maps.idToReal) out = out.split(token).join(real);
  return out;
}

/**
 * Swap the records one operation produced back into tokenised form: input values become their
 * original tokens and new values continue from there.
 *
 * Three kinds of input value become their original token: the absolute path of the project root
 * (including the escaped spelling), node ids (full ids first, the eight-character prefix in the
 * body last) and input stamps (both the micro and the seconds spelling are tried). The uuids and
 * stamps left after that are new values and take the next numbers in appearance order (stamps by
 * value). A short id takes its own `@short-` token: short forms are only collected after every full
 * id and every id the operation created has been swapped, so no slice of a long hex string gets
 * eaten.
 */
function detokenize(capture: string, maps: TokenMaps, root: string): string {
  let text = toLf(capture);
  // The project root: all three spellings in the body are folded — escaped inside a JSON body
  // (backslashes doubled), as is in a text product (a non-record file such as the prompt or the run
  // doc), and with forward slashes for a "written for humans" spelling such as a spec path. The
  // as-is spelling is folded before the other two: an escaped spelling does not contain it as a
  // substring (the doubled backslashes stand in the way), so the three do not interfere.
  text = text.split(root).join('@root@');
  text = text.split(root.split('\\').join('/')).join('@root@');
  text = text.split(escapedJson(root)).join('@root@');
  const idToToken = new Map([...maps.idToReal].map(([token, real]) => [real, token] as const));
  for (const [real, token] of idToToken) text = text.split(real).join(token);
  // Input stamps become their original token again: both the micro and the seconds spelling are tried, longest first.
  const spellings: Array<[string, string]> = [];
  for (const [token, us] of maps.stampToUs) {
    spellings.push([microStamp(us), token], [secondsStamp(us), token]);
  }
  spellings.sort((a, b) => b[0].length - a[0].length);
  for (const [spelling, token] of spellings) text = text.split(spelling).join(token);
  // Stamps the operation newly wrote: both spellings are collected and numbered after the highest
  // existing number in ascending value (epoch microseconds); two spellings of the same microsecond
  // share one token.
  const fresh = new Map<number, string>();
  for (const match of text.matchAll(MICRO_STAMP_RE)) fresh.set(parseStampUs(match[0])!, match[0]);
  for (const match of text.matchAll(SECONDS_STAMP_RE)) {
    const us = parseStampUs(match[0])!;
    if (!fresh.has(us)) fresh.set(us, match[0]);
  }
  const ordered = [...fresh.entries()].sort((a, b) => a[0] - b[0]);
  ordered.forEach(([us], index) => {
    const token = `@t${maps.maxStamp + 1 + index}@`;
    text = text.split(microStamp(us)).join(token);
    text = text.split(secondsStamp(us)).join(token);
  });
  const freshIds: string[] = [];
  for (const match of text.matchAll(UUID_RE)) {
    const value = match[0];
    if (!idToToken.has(value) && !freshIds.includes(value)) freshIds.push(value);
  }
  let letter = maps.maxLetter;
  for (const value of freshIds) {
    letter = nextLetters(letter);
    text = text.split(value).join(`@node-${letter}@`);
  }
  // The eight-character short id a body uses to refer to a node: its own `@short-` token, letters
  // allocated in appearance order. This step comes last — every full id and every id the operation
  // created is swapped by then, so no slice of a long hex string can be taken for a short form.
  const shorts: string[] = [];
  for (const match of text.matchAll(SHORT_ID_RE)) {
    if (!shorts.includes(match[0])) shorts.push(match[0]);
  }
  let shortLetter = '';
  for (const value of shorts) {
    shortLetter = nextLetters(shortLetter);
    text = text.split(value).join(`@short-${shortLetter}@`);
  }
  return text;
}

/** Where the key-order convention of each of the six record kinds lands; a path it cannot match is not a record file. */
function recordKindOf(relPath: string): RecordKind | null {
  const path = relPath.split('\\').join('/');
  if (path === '.superworker/ideas.json') return 'ideas';
  if (path === '.superworker/state.json') return 'state';
  if (path === '.superworker/instructions.json') return 'instructions';
  if (path === '.superworker/issues/issues.json') return 'issues';
  if (path.startsWith('.superworker/signals/') && path.endsWith('.json')) return 'signal';
  if (path.startsWith('.superworker/meta/sessions/') && path.endsWith('.json')) return 'session-note';
  return null;
}

/**
 * Records with seconds-form stamps: cycles, instructions, handoffs and session notes; the graph and
 * the issue pool use the micro form.
 */
function usesSecondsStamp(kind: RecordKind): boolean {
  return kind !== 'ideas' && kind !== 'issues';
}

/**
 * The two text products of dispatch preparation (prompt.txt and the node's run.md): not record
 * files, yet their bodies embed tokenised values such as ids and the project root — so before the
 * comparison they are folded back into tokens the way records are (including the as-is spelling of
 * `@root@`), only without going through the jsonBytes formatting.
 */
function isProseProduct(relPath: string): boolean {
  const path = relPath.split('\\').join('/');
  if (path.startsWith('.superworker/meta/launch/') && path.endsWith('/prompt.txt')) return true;
  return path.startsWith('.superworker/nodes/') && path.endsWith('/run.md');
}

/**
 * Fold one file into a comparable form: a record file is tokenised and then put through the record
 * writer's formatting (jsonBytes); a text product (prompt, run doc) is tokenised and folded to LF; any
 * other file (layout and such) is folded to LF and compared directly.
 */
function toComparableText(relPath: string, rawText: string, maps: TokenMaps, root: string): string {
  if (isProseProduct(relPath)) return foldSeparators(toLf(detokenize(rawText, maps, root)), false);
  const kind = recordKindOf(relPath);
  if (kind === null) return toLf(rawText);
  const tokenized = detokenize(rawText, maps, root);
  const bytes = jsonBytes(JSON.parse(tokenized) as unknown, jsonOptionsForRecord(kind));
  return foldSeparators(toLf(Buffer.from(bytes).toString('utf8')), true);
}

/**
 * The expectation side of the same fold: the fixtures were recorded on one platform, so the same
 * case has to be green on any of them.
 */
function comparableExpected(relPath: string, rawText: string): string {
  if (isProseProduct(relPath)) return foldSeparators(toLf(rawText), false);
  if (recordKindOf(relPath) !== null) return foldSeparators(toLf(rawText), true);
  return toLf(rawText);
}

/**
 * A separator carries no meaning for the comparison. A record body keeps one as a doubled backslash
 * (the escaped spelling inside JSON), a text product as a single one; both fold to `/` on either
 * side, so a fixture recorded on Windows replays green on a POSIX runner and the other way round. A
 * single backslash in a record body is an escape such as `\n` and is left alone.
 */
function foldSeparators(text: string, escaped: boolean): string {
  return escaped ? text.split('\\\\').join('/') : text.split('\\').join('/');
}

function listFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (current: string, prefix: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

function firstDiffOf(actual: string, expected: string): { line: number; offset: number } {
  const limit = Math.min(actual.length, expected.length);
  let offset = 0;
  while (offset < limit && actual[offset] === expected[offset]) offset += 1;
  const line = (expected.slice(0, offset).match(/\n/g) ?? []).length + 1;
  return { line, offset };
}

/** The comparison failure report for one file: line and offset of the first difference plus the context on both sides. */
function diffMessage(relPath: string, actual: string, expected: string): string {
  const { line, offset } = firstDiffOf(actual, expected);
  const windowOf = (text: string) => JSON.stringify(text.slice(Math.max(0, offset - 30), offset + 30));
  return [
    `${relPath}: the first difference is at line ${line}` +
      ` (character ${offset} after folding to LF; expected ${expected.length} characters, actual ${actual.length})`,
    `  expected around it: ${windowOf(expected)}`,
    `  actual around it:   ${windowOf(actual)}`,
  ].join('\n');
}

/** One case with its table laid: op, temporary project root (input already materialised onto disk) and token maps. */
interface StagedCase {
  readonly op: CorpusOp;
  readonly root: string;
  readonly maps: TokenMaps;
}

/** The shipped plugin set a case can install into its temp project (`op.plugins`). */
const SHIPPED_PLUGINS = fileURLToPath(new URL('../../plugins/', import.meta.url));

/**
 * The staging shared by case replay and expectation generation: temporary project root → (non-init
 * cases pass the init gate first) → lay down the materialised input → hand the scene to the caller.
 * The temporary directory is cleared when the call is done.
 */
async function withStagedCase<T>(
  caseDir: string,
  body: (stage: StagedCase) => Promise<T>,
): Promise<T> {
  const opPath = join(caseDir, 'op.json');
  if (!existsSync(opPath)) {
    throw new Error(`incomplete case directory (op.json is missing): ${caseDir}`);
  }
  const op = JSON.parse(readFileSync(opPath, 'utf8')) as CorpusOp;
  const inputDir = join(caseDir, 'input');
  const root = mkdtempSync(join(tmpdir(), 'superworker-corpus-'));
  try {
    // The token maps are read from every record input (the keys of the graph and the bodies and file
    // names of the other records all count); with no record input at all (init cases) the table is
    // empty — a new stamp in the product still has to take a number.
    const inputFiles = listFilesUnder(inputDir);
    const recordFiles = inputFiles.filter((rel) => recordKindOf(rel) !== null);
    const ideasText = inputFiles.includes('.superworker/ideas.json')
      ? readFileSync(join(inputDir, '.superworker', 'ideas.json'), 'utf8')
      : null;
    const restText = recordFiles
      .filter((rel) => rel !== '.superworker/ideas.json')
      .map((rel) => readFileSync(join(inputDir, ...rel.split('/')), 'utf8'))
      .join('\n');
    const maps = materializeMaps(ideasText, restText);

    // The operation of an init case is laying the layout down; other cases pass the init gate first
    // (the layout is constant bytes and does not enter the comparison).
    if (op.path !== 'ledger.init' && op.path !== 'ledger.register') {
      await open(root).ledger.init();
    }

    for (const rel of inputFiles) {
      const raw = readFileSync(join(inputDir, ...rel.split('/')), 'utf8');
      const kind = recordKindOf(rel);
      const text = kind !== null
        ? substitute(raw, maps, usesSecondsStamp(kind), root)
        // A text product can come in as input too (an idempotence case brings the prompt / run doc
        // of the previous preparation along): the tokens materialise the same way, only without the
        // record formatting.
        : isProseProduct(rel)
          ? substitute(raw, maps, false, root)
          : raw;
      // A file name can carry tokens too (a handoff lands in signals/<cycle>/<node>.json): the
      // concrete name is swapped in before the file lands.
      const target = join(root, ...substitutePath(rel, maps).split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, 'utf8');
    }
    // The plugin folders this case's project has installed: copied out of the shipped set as they
    // are (nothing is generated, and the case's `input/` carries no second copy of a plugin's files).
    for (const name of op.plugins ?? []) {
      cpSync(join(SHIPPED_PLUGINS, name), join(root, 'plugins', name), { recursive: true });
    }
    // The clock pin covers the operation and the comparison of its products: a case that records the
    // current date in a product declares one, so its expectation can hold that date literally.
    const pin = op.clock === undefined ? null : parseClockPin(op.clock);
    return await withPinnedClock(pin, () => body({ op, root, maps }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Second-boundary alignment: the several seconds-form stamps one operation writes share the same
 * second — the same convention as the generation side's "align the phase to the start of a second".
 * When the operation starts at the tail of a second (less than half of this second left) it waits,
 * within bounds, for the next second start; a random phase straddling a second boundary splits the
 * two seconds-form stamps of one operation into two tokens and makes the comparison flicker red
 * (debt corpus-close-timestamp-phase-flake).
 */
const OP_SECOND_BUDGET_MS = 500;

async function alignOpToSecondStart(): Promise<void> {
  const waitMs = 1000 - (Date.now() % 1000);
  if (waitMs <= OP_SECOND_BUDGET_MS) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
}

/**
 * Replay one case: stage → run the operation → compare file by file with expected/.
 */
export async function replayCase(caseDir: string, run?: CorpusRunner): Promise<ReplayResult> {
  const caseName = basename(caseDir);
  return withStagedCase(caseDir, async ({ op, root, maps }) => {
    const expectedDir = join(caseDir, 'expected');
    // When the products are in the return value, `expected/return.json` is the comparison surface
    // and is not a file under the project root.
    const byReturn = op.expect === 'return';
    const expectedFiles = listFilesUnder(expectedDir).filter(
      (rel) => !(byReturn && rel === 'return.json'),
    );

    // The action path is the API path: walk down from the handle and spread the args by position.
    // When a runner is given (for a transitional shape the corpus cannot reach) it takes the call,
    // everything else the same.
    // The config and conductor namespaces close "home" into the temporary project root
    // (<root>/_home): machine-wide reads and writes never touch the real machine's ~/.superworker, and the
    // generation side uses the same convention (SUPERWORKER_HOME_DIR=<sandbox>/_home).
    // The conductor's plugin directory uses the default (<root>/plugins); the cases that pass one of a
    // shipped plugin's words through `pluginCommand` name that plugin in `op.plugins`, which staging
    // copies into the temp project (a plugin is installed, not linked). The dispatch green-light path
    // hands over a simulated executor that opens a session and comes back with a receipt (the replay
    // locks product bytes only, and the session a receipt names does not enter the comparison).
    const home = join(root, '_home');
    const superworker = {
      ...open(root),
      config: createConfigNamespace(root, { homeDir: home }),
      conductor: createConductorNamespace(
        root,
        new SimulatedExecutor(),
        { homeDir: home },
      ),
    };
    await alignOpToSecondStart();
    const args = JSON.parse(substitute(JSON.stringify(op.args), maps, false, root)) as unknown[];
    let returned: unknown;
    if (run !== undefined) {
      returned = await run(root, args);
    } else {
      const segments = op.path.split('.');
      let holder: unknown = superworker;
      for (const segment of segments.slice(0, -1)) {
        holder = (holder as Record<string, unknown>)[segment];
        if (holder === undefined || holder === null) {
          throw new Error(`unparseable action path: ${op.path} (it breaks at "${segment}")`);
        }
      }
      const leaf = segments[segments.length - 1]!;
      const method = (holder as Record<string, unknown>)[leaf];
      if (typeof method !== 'function') {
        throw new Error(`unparseable action path: ${op.path} ("${leaf}" is not a method)`);
      }
      returned = await (method as (...callArgs: unknown[]) => Promise<unknown>).apply(
        holder,
        args,
      );
    }

    const problems: string[] = [];
    for (const rel of expectedFiles) {
      const realRel = substitutePath(rel, maps);
      const producedPath = join(root, ...realRel.split('/'));
      if (!existsSync(producedPath)) {
        problems.push(`${rel}: this product is missing after the operation`);
        continue;
      }
      const actual = toComparableText(
        realRel,
        readFileSync(producedPath, 'utf8'),
        maps,
        root,
      );
      const expected = comparableExpected(
        realRel,
        readFileSync(join(expectedDir, ...rel.split('/')), 'utf8'),
      );
      if (actual !== expected) problems.push(diffMessage(rel, actual, expected));
    }
    if (byReturn) {
      const expectedReturn = join(expectedDir, 'return.json');
      if (!existsSync(expectedReturn)) {
        problems.push('return.json: the expected product is absent (op.json said expect: return)');
      } else {
        // The return value is serialised with two-space indentation — the same formatting the record writer
        // prints JSON with — then tokenised and compared byte for byte.
        const actual =
          foldSeparators(toLf(detokenize(JSON.stringify(returned, null, 2), maps, root)) + '\n', true);
        const expected = foldSeparators(toLf(readFileSync(expectedReturn, 'utf8')), true);
        if (actual !== expected) problems.push(diffMessage('return.json', actual, expected));
      }
    }
    return { ok: problems.length === 0, caseName, problems };
  });
}

/**
 * The generation side of the expected products (used when generating, and not part of the replay
 * list): stage → snapshot the file list from before the operation → run the operation → fold
 * the **newly appeared** products back into tokens and write them into the case's expected/, either
 * through the record formatting (jsonBytes) or as plain text. A case whose product is the return
 * value (`"expect": "return"`) gets its `expected/return.json` the same way — generated from the
 * operation's answer, never written by hand — and the file products are still laid down beside it.
 * Returns the relative paths written.
 */
export async function generateExpected(
  caseDir: string,
  run: CorpusRunner,
): Promise<string[]> {
  return writeCaseExpectations(caseDir, run, false);
}

/**
 * Regenerate one case's expected products from the current engine: stage the input, run the operation,
 * and write back **every product the operation changed** — a file that appeared, or one whose bytes the
 * operation rewrote (a close changes `ideas.json` and `state.json`; an insert adds a node directory).
 * Files the operation left alone are not expectations and are not written, so the case keeps the corpus
 * convention: `expected/` holds products, not a copy of the input.
 *
 * This is the repair path for a case whose recorded products predate a deliberate change: the products
 * come from the engine, never from a hand edit.
 */
export async function rebuildExpected(caseDir: string, run: CorpusRunner): Promise<string[]> {
  return writeCaseExpectations(caseDir, run, true);
}

/** The one writer behind both generation entries (`changed=false`: only new files, the creation-time reading; `changed=true`: new and rewritten ones). */
async function writeCaseExpectations(
  caseDir: string,
  run: CorpusRunner,
  changed: boolean,
): Promise<string[]> {
  const expectedDir = join(caseDir, 'expected');
  const written: string[] = [];
  await withStagedCase(caseDir, async ({ op, root, maps }) => {
    const before = new Map(listFilesUnder(root).map((rel) => [rel, readFileSync(join(root, ...rel.split('/')))] as const));
    await alignOpToSecondStart();
    const args = JSON.parse(substitute(JSON.stringify(op.args), maps, false, root)) as unknown[];
    const returned = await run(root, args);
    // Ids in file names are folded back into tokens too (the landing paths of handoffs and dispatch
    // material carry the node id) — the same spelling as the tokenised relative paths in expected/.
    const foldPath = (rel: string): string => {
      let out = rel.split('\\').join('/');
      for (const [token, real] of maps.idToReal) out = out.split(real).join(token);
      return out;
    };
    for (const rel of listFilesUnder(root)) {
      const raw = readFileSync(join(root, ...rel.split('/')));
      if (!changed && before.has(rel)) continue;
      if (changed && before.has(rel) && Buffer.compare(before.get(rel)!, raw) === 0) continue;
      const rawText = raw.toString('utf8');
      const tokenized = detokenize(rawText, maps, root);
      const kind = recordKindOf(rel);
      const text = kind !== null
        ? Buffer.from(jsonBytes(JSON.parse(tokenized) as unknown, jsonOptionsForRecord(kind)))
          .toString('utf8')
        : tokenized;
      const relTokenized = foldPath(rel);
      const target = join(expectedDir, ...relTokenized.split('/'));
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, 'utf8');
      written.push(relTokenized);
    }
    if (op.expect === 'return') {
      // The same serialisation the replayer compares: two-space indentation, tokenised, one final LF.
      const text = toLf(detokenize(JSON.stringify(returned, null, 2), maps, root)) + '\n';
      const target = join(expectedDir, 'return.json');
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text, 'utf8');
      written.push('return.json');
    }
  });
  return written;
}
