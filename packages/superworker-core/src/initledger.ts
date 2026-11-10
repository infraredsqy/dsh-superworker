import { existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitResult, GitRunner } from './git';
import { isMissingPath } from './fs-helpers';
import { atomicWriteBytes } from './jsonio';
import { withLedgerLock } from './ledgerlock';
import { RECORD_DIR_NAME, recordPaths, type RecordPaths } from './paths';

/**
 * `init` and `register`: the one-shot setup action that lays down `.superworker/`, and the two keys that
 * register the merge driver with git.
 *
 * The reading:
 *
 * - **The bottom line first, and unconditional.** Four layout files land — `.superworker/.gitignore`,
 *   `.superworker/.gitattributes`, `.superworker/AGENTS.md` and `.superworker/config.json` (the last one only when absent, or
 *   under `force`) — so that when `init` returns, the directory is a superworker workspace whatever the
 *   environment: no git, not a checkout, `git init` failing, all alike. Layout files are LF on every
 *   platform and are rewritten from the constants whenever their bytes differ (a hand-broken one is
 *   repaired by re-running, an intact one is not touched at all); every write is atomic.
 * - **The attachments after it, best-effort.** Three things are nice to have and never the
 *   condition of "this is a superworker project": a repository of `.superworker`'s own, one `info/exclude` line that
 *   keeps `.superworker` out of the project repository, and the merge driver's two keys in the project's git
 *   config. Each one that does not happen is named in one sentence of `warnings` — never a throw,
 *   never a rollback.
 * - **The records stay out of the project repository, and a tracked directory is an error.** The
 *   exclude line is the one layout there is; a record directory the project's git tracks is refused
 *   by `init` outright, because taking records back out of a repository's history is a person's
 *   decision, and no flag of this action is allowed to make it for them.
 * - **git is asked, never guessed at.** All directory-layout knowledge of git (where
 *   `info/exclude` lives, where the repository root is, whether this is a checkout at all) goes
 *   through the injected `GitRunner`. No `.git` file is parsed by hand. A repository of `.superworker`'s own
 *   is given when the caller asks for one (`ownRepo`, the default), and
 *   the giving is one `git init --quiet` through the same runner; an existing one is never touched.
 *   Without a runner the git-side attachments are skipped and said so, and a `git init` git refuses
 *   leaves one warning.
 * - **The merge driver is registered in the absolute form, and read before it is written.** A
 *   registration this machine really answers — the one form, both quoted paths files here — is left
 *   exactly as it is (re-running `init` must not silently rewrite a working driver, a string a person
 *   may have chosen on purpose), and the reading says so. Only a missing or dead registration is
 *   replaced, with the command computed at write time: the quoted node path plus this package's built
 *   entry, both absolute — no form of the registration depends on what a machine happens to have on
 *   `PATH`, so the one string a person can read is the one string the doctor's predicate can judge.
 *   The command now in force is handed back with the report, so a caller prints what was really
 *   written or kept.
 */

/**
 * `.superworker/.gitignore`: where the three machine pieces go (dispatch, worktrees, a node's temp).
 * Written with LF like every other file a machine reads.
 */
const GITIGNORE_BODY = [
  "# This tool's own machinery: where dispatch lands, worktrees, the temp files a node produces.",
  'meta/',
  'worktrees/',
  'temp/',
  '',
].join('\n');

/**
 * `.superworker/.gitattributes`: the line endings of these files are ours, and every record under the directory
 * merges entry-wise rather than line by line.
 *
 * The record line is a pattern, not a list of names: a record the driver is handed is recognised by its own shape
 * (the four it names, then the anonymous one-collection-of-`id`-entries rule), so a record that changes hands — one
 * did, from the engine to a plugin — keeps merging without this file being edited again. The one file that steps out
 * is the layout's own settings: `config.json` is one setting, not a table of entries. Handed to the driver it is
 * none of the four records and not the anonymous one-collection shape either, so the driver rejects it (exit 2, not
 * a byte written); `-merge` steps it out here instead, and git leaves the two settings to a person.
 */
const GITATTRIBUTES_BODY = [
  '# The line endings of these files are ours: every record is written with LF, and no machine\'s',
  '# core.autocrlf has any business rewriting that.',
  '** -text',
  '',
  '# Records merge entry-wise, not line by line; the driver is sw-merge-ledger, and that command is',
  '# registered in each machine\'s git config (ledger.register). Every JSON under this directory is a',
  '# record and goes to the driver -- the settings file is one setting, not a table of entries, so it',
  '# steps out of that line explicitly.',
  '*.json merge=superworker',
  'config.json -merge',
  '',
].join('\n');

/** `.superworker/AGENTS.md`: how to use this directory. The engine writes it at init time and the project carries it along. */
const LEDGER_AGENTS_BODY = [
  '# .superworker usage note',
  '',
  '> This file (`.superworker/AGENTS.md`) must not exceed 100 lines.',
  '> This file is written and maintained by this tool at `init` time. **To change it, ask the user first** -- once they have said "go ahead", then touch it.',
  '',
  'This directory is the superworker pipeline\'s ledger: `ideas.json`, `state.json` and',
  '`signals/` are the pipeline\'s records, and `nodes/<uuid>/` holds the spec and the deliverable of',
  'each slot (DAG node).',
  '',
  '- Records are read and written only through the pipeline\'s words (`dag …`, `plan`); hand-editing the JSON is forbidden, and so is reading `ideas.json` raw -- use the tool\'s list / plan output.',
  '- Process artifacts belonging to one slot (probes, raw output, self-check scripts) go in `.superworker/nodes/<uuid>/temp/`, which is temporary and not committed: do not submit them as deliverables.',
  '- Everything else temporary goes in `.tmp/` at the workspace root.',
  '- `meta/`, `worktrees/` and `nodes/<id>/temp/` are kept out of the repository by `.gitignore`; do not move anything from inside them out by hand and commit it.',
  '',
].join('\n');

/**
 * `.superworker/config.json` as the factory hands it out: an empty object, LF, no trailing newline — the record
 * writers' own byte rule (`src/jsonio.ts`), so the file init lays down and the one `config.set` rewrites
 * are the same bytes. A trailing newline here would give this one record two byte readings.
 */
const EMPTY_CONFIG_BODY = '{}';

const encoder = new TextEncoder();

/**
 * The layout files, and the one table they come from: the name, the bytes, whether the file is an **init
 * marker** (the presence of the markers is what `isLedgerInitialized` reads), and whether it lands only
 * when absent. The writing, the init gate and the doctor's check of the layout all derive from here, so a
 * fifth layout file is added in one place and lands in all three at once.
 *
 * `.superworker/config.json` is the one file with a rule of its own: it is a record a person edits, so init lands it
 * only when it is absent (`force` is the one way to reset it), while the three constant files are repaired
 * whenever their bytes differ.
 */
interface LayoutFile {
  readonly name: string;
  readonly body: string;
  /** Whether this file's presence is part of "this `.superworker` was deliberately set up". */
  readonly initMarker: boolean;
  /** Land it only when the file is absent (or `force` was asked for): never to repair its bytes. */
  readonly onlyWhenAbsent?: boolean;
}

const LAYOUT_FILES: readonly LayoutFile[] = [
  { name: '.gitignore', body: GITIGNORE_BODY, initMarker: true },
  { name: '.gitattributes', body: GITATTRIBUTES_BODY, initMarker: true },
  { name: 'AGENTS.md', body: LEDGER_AGENTS_BODY, initMarker: false },
  { name: 'config.json', body: EMPTY_CONFIG_BODY, initMarker: false, onlyWhenAbsent: true },
];

/** Every layout file's name, in the order they land: what `init` lays down and what the doctor checks for. */
export const LAYOUT_FILE_NAMES: readonly string[] = LAYOUT_FILES.map((file) => file.name);

/**
 * The two marks init lands: only with these two files present does this `.superworker` count as deliberately set up.
 * Derived from the layout table above — a mark is a column of that table, not a second list of names.
 */
const INIT_MARKERS: readonly string[] = LAYOUT_FILES.filter((file) => file.initMarker).map(
  (file) => file.name,
);
/** The marks, under their own name: a legacy record directory is recognised by the same two files. */
export { INIT_MARKERS };

/**
 * The strict reader of the exclude file: bytes that are not valid UTF-8 are refused rather than
 * replaced, and a leading byte order mark is kept as U+FEFF, so what this run writes back is the
 * same bytes it read (valid UTF-8 round-trips byte for byte). Exported because the migration
 * switches the same file to the new directory name under the same rules.
 */
export const excludeDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The args git hands a merge driver, in its own order — one array, and both the command string and the reading pattern are built from it. */
const MERGE_DRIVER_ARGS = ['%O', '%A', '%B', '%P'] as const;

/** The same args as they appear in the driver string. */
const MERGE_DRIVER_ARGS_TEXT = MERGE_DRIVER_ARGS.join(' ');

/** The built entry the absolute form points at (a sibling of `dist/index.mjs`). */
const MERGE_DRIVER_PRODUCT = 'merge-ledger.mjs';

/** Whether this record directory counts as init-ed: the directory is there and both marks are there — a pure filesystem question, git is never asked. */
export function isLedgerInitialized(paths: RecordPaths): boolean {
  if (!existsSync(paths.recordDir) || !statSync(paths.recordDir).isDirectory()) return false;
  return INIT_MARKERS.every((marker) => {
    const path = join(paths.recordDir, marker);
    return existsSync(path) && statSync(path).isFile();
  });
}

/** The one gate the verbs that change records share: refuse when never init-ed, landing no byte and creating no directory. */
export function assertLedgerInitialized(paths: RecordPaths): void {
  if (isLedgerInitialized(paths)) return;
  throw new Error(
    `${paths.recordDir} was never init-ed (missing ${INIT_MARKERS.join(' or ')}). Ask \`init\` first.`,
  );
}

// ── the choices ──────────────────────────────────────────────────────────────

/** The choices of `init`. */
export interface LedgerInitOptions {
  /**
   * Besides the default action, reset `.superworker/config.json` to the factory empty object as well — what a
   * person wrote is cleared, so use it sparingly. The layout files are rewritten from the constants
   * whenever they differ by default, and force does not govern them.
   */
  readonly force?: boolean;
  /**
   * Whether `.superworker` should have a repository of its own: one `git init --quiet` in the record
   * directory, run through the injected runner, when it has none yet. The default is yes, and an
   * existing one is never touched.
   */
  readonly ownRepo?: boolean;
  /** The git capability; without it the git-side attachments are skipped and named in `warnings`. */
  readonly git?: GitRunner;
}

/** The choices of `register`. */
export interface LedgerRegisterOptions {
  /** The git capability; without it registration is skipped silently (the same reading as "not a checkout"). */
  readonly git?: GitRunner;
}

/**
 * How `.superworker`'s own repository reads this time. Four readings: what was there, and whether this run
 * was the one that gave it.
 */
export type OwnRepoReading =
  /** No `.superworker/.git` was there, one was asked for, and `git init --quiet` created it now. */
  | 'created'
  /** `.superworker/.git` is there. The engine created nothing this time and removes nothing. */
  | 'present'
  /** No `.superworker/.git`, and one was not asked for: plain files, on purpose. */
  | 'skipped'
  /** No `.superworker/.git`, one was asked for, and no git was handed in: `git init .superworker` stays the person's move. */
  | 'skipped-no-git';

/**
 * How the project repository's `info/exclude` line reads this time. A reading only ever says what
 * this run saw and did, so a failure after git answered has a reading of its own rather than
 * borrowing the one that says git could not be asked.
 */
export type ExcludeReading =
  /** The line is in place (written now, or already there). */
  | 'written'
  /** Nothing was looked at or written: no git was handed in, git would not answer, or it would not say where the file or this project is. */
  | 'skipped-not-a-checkout'
  /** The checkout and the file were found, and reading or writing it failed; `warnings` names the file and the failure, and nothing was written. */
  | 'failed';

/** How the merge driver's two keys read this time. */
export type MergeDriverReading =
  /** The two keys were written now: there was no registration, or the one there did not answer this machine. */
  | 'written'
  /** A registration this machine really answers was already there and was left exactly as it was. */
  | 'kept'
  /** No writable git config (no runner, not a checkout, or git refused). */
  | 'skipped-no-config';

/** What `init` hands back: what it did, and what it could not do and why. */
export interface InitReport {
  /** The layout files this run really wrote (a file whose bytes already match is left alone). */
  written: string[];
  ownRepo: OwnRepoReading;
  exclude: ExcludeReading;
  mergeDriver: MergeDriverReading;
  /** The command `merge.superworker.driver` holds after this run — written now, or the registration that was kept; null when nothing could be registered. */
  mergeDriverCommand: string | null;
  /** One sentence per attachment that did not happen: what was not done, why, and what `.superworker` is like without it. */
  warnings: string[];
}

// ── the layout files ─────────────────────────────────────────────────────────

async function bytesMatch(path: string, payload: Uint8Array): Promise<boolean> {
  let current: Uint8Array;
  try {
    current = await readFile(path);
  } catch {
    return false;
  }
  if (current.byteLength !== payload.byteLength) return false;
  for (let index = 0; index < payload.byteLength; index += 1) {
    if (current[index] !== payload[index]) return false;
  }
  return true;
}

/** Whether the file is there and is a file (a directory or an unreadable cell is not). Exported: the migration's machine-layer copy asks the same question about two files. */
export function isFileThere(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Land the layout files from the one table: the three constant files whenever their bytes differ,
 * `.superworker/config.json` only when absent (or `force`).
 *
 * The config.json landing is a read → change → write of a record like any other, so it goes through the
 * record tree's lock, and whether the file is there is read **inside** that lock: a `config set` another
 * process is running right now is either finished (the file exists, and init leaves it alone) or not
 * started (the empty object lands first, and that write then queues behind). Without the lock, init could
 * look between a `set`'s read and its write and put the whole document back to `{}`.
 *
 * The lock is taken only when this run really has that write to do: a run with nothing to land on
 * config.json (every second `init`) answers at once instead of queueing behind a `config set` that holds
 * the lock, or waiting out a lock file a dead holder left behind. The gate outside the lock is a plain
 * filesystem read; the one inside asks again, so the write acts on an answer that still holds. When the
 * lock is needed it is taken around the whole landing, so a lock nobody can get leaves no half of the
 * layout behind: nothing lands, and the directory does not read as init-ed.
 */
async function writeLayoutFiles(paths: RecordPaths, force: boolean): Promise<string[]> {
  const written: string[] = [];
  const gated = LAYOUT_FILES.filter((file) => file.onlyWhenAbsent === true);

  /** The one landing, in table order: the constant files, then the ones that only land when absent. */
  const land = async (): Promise<void> => {
    for (const file of LAYOUT_FILES) {
      const path = join(paths.recordDir, file.name);
      const payload = encoder.encode(file.body);
      if (file.onlyWhenAbsent === true) {
        // `force` is the one way to reset what a person wrote; without it an existing config.json is never touched.
        if (!force && isFileThere(path)) continue;
      } else if (await bytesMatch(path, payload)) continue;
      await atomicWriteBytes(path, payload);
      written.push(file.name);
    }
  };

  if (force || gated.some((file) => !isFileThere(join(paths.recordDir, file.name)))) {
    await withLedgerLock(paths, land);
  } else {
    await land();
  }
  return written;
}

/**
 * Bring one constant layout file's bytes current, under the same rule the whole landing applies:
 * written when its bytes differ, untouched when they match. `name` must be one of the layout table's
 * constant names — the migration asks for the one file whose driver attribute moves with a directory
 * rename, and the constant body is the only spelling of the new attribute there is.
 */
export async function repairLayoutFile(paths: RecordPaths, name: string): Promise<boolean> {
  const file = LAYOUT_FILES.find((entry) => entry.name === name);
  if (file === undefined || file.onlyWhenAbsent === true) return false;
  const path = join(paths.recordDir, file.name);
  const payload = encoder.encode(file.body);
  if (await bytesMatch(path, payload)) return false;
  await atomicWriteBytes(path, payload);
  return true;
}

// ── git, as asked through the injected runner ────────────────────────────────

/** The answer of "can git answer here at all?"; nothing below it runs when the answer is no. */
type CheckoutProbe =
  | { readonly kind: 'checkout'; readonly git: GitRunner }
  | { readonly kind: 'not-a-checkout'; readonly note: string };

async function probeCheckout(root: string, git: GitRunner | undefined): Promise<CheckoutProbe> {
  if (git === undefined) return { kind: 'not-a-checkout', note: 'no git was handed to the engine' };
  try {
    const result = await git.run(root, ['rev-parse', '--git-common-dir']);
    if (result.code === 0) return { kind: 'checkout', git };
    return {
      kind: 'not-a-checkout',
      note: `git answered that this is not a checkout (rev-parse --git-common-dir exited ${result.code})`,
    };
  } catch (error) {
    return { kind: 'not-a-checkout', note: `git could not be run (${messageOf(error)})` };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Ask git for a path it knows the location of; null when it will not say. Exported: the migration asks where the same file lives before it writes it. */
export async function gitPathOf(root: string, git: GitRunner, ...args: string[]): Promise<string | null> {
  try {
    const result = await git.run(root, ['rev-parse', ...args]);
    if (result.code !== 0) return null;
    const spelled = result.stdout.trim();
    return spelled === '' ? null : resolve(root, spelled);
  } catch {
    return null;
  }
}

// ── the exclude line ─────────────────────────────────────────────────────────

/**
 * Put this project's line into the exclude text (`keep`), or take it out.
 *
 * Exactly one line per project root: a duplicate of this project's line is dropped, and a line
 * spelling the same project root is replaced in place, so a repeated write never leaves two lines
 * behind. Lines belonging to **other** project roots in the same repository are
 * left exactly as they are — taking one away would silently un-ignore another project's records,
 * which is the accident this rule exists to prevent. "Exactly as they are" is byte-level: every
 * line keeps the ending it already had (`\n`, `\r\n`, or a lone `\r`), so a CRLF file stays CRLF
 * and a hand-mixed one is not half-normalized by this write. `had` says whether this project's
 * line was there before.
 *
 * Exported because the migration switches the same file to the new directory name: the old line
 * goes out through one `keep: false` call per old spelling, and the new line in through one
 * `keep: true` call — one splicer, so the byte rules cannot drift between the two writers.
 */
export function withExcludeLine(
  text: string,
  line: string,
  keep: boolean,
): { readonly text: string; readonly had: boolean } {
  const lines = text === '' ? [] : splitExcludeLines(text);
  const out: ExcludeLine[] = [];
  let had = false;
  let placed = false;
  for (const current of lines) {
    if (current.text.trim() === line) {
      had = true;
      if (keep && !placed) {
        out.push({ text: line, ending: current.ending });
        placed = true;
      }
      continue;
    }
    out.push(current);
  }
  // A line this run adds takes the file's own ending when every line already uses one (a wholly
  // CRLF file stays wholly CRLF, so this write introduces no mixing), and LF otherwise.
  if (keep && !placed) out.push({ text: line, ending: addedEndingOf(lines) });
  if (out.length === 0) return { text: '', had };
  const pieces: string[] = [];
  for (let index = 0; index < out.length; index += 1) {
    const current = out[index]!;
    // Only the last line may end without an ending; a line with none that now has a successor is
    // given LF, since two lines cannot share one.
    const ending =
      current.ending !== '' ? current.ending : index < out.length - 1 ? '\n' : '';
    pieces.push(current.text + ending);
  }
  return { text: pieces.join(''), had };
}

/** One line of the exclude text with the ending it arrived with (exported beside the splicer and the splitter that produce and consume it). */
export interface ExcludeLine {
  readonly text: string;
  readonly ending: string;
}

/**
 * The ending a line this run adds takes: the ending every existing line shares, when there is such
 * an ending; LF otherwise (no file yet, or a file that was already mixed, including a last line
 * that had no ending at all).
 */
function addedEndingOf(lines: readonly ExcludeLine[]): string {
  const shared = lines[0]?.ending ?? '';
  if (shared === '') return '\n';
  return lines.every((one) => one.ending === shared) ? shared : '\n';
}

/** Split the exclude text into lines, keeping each line's own ending (`\r\n`, `\n`, a lone `\r`, or none on the last one). Exported beside the splicer it serves: a reader of these lines that split them differently would read the endings differently too. */
export function splitExcludeLines(text: string): ExcludeLine[] {
  const lines: ExcludeLine[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  for (;;) {
    const match = pattern.exec(text);
    if (match === null) break;
    // The final `$` of the walk matches once more with an empty line: that is the end, not a line.
    if (match[0] === '') break;
    lines.push({ text: match[1]!, ending: match[2]! });
  }
  return lines;
}

/**
 * The exclude line one directory name gets for this project: anchored at the repository root, so
 * several record directories in one repository each get their own. The directory name is a
 * parameter, not a constant, because the migration asks for the old name's line — the line it has
 * to take out — through the same probe that writes the new name's.
 */
export async function excludeLineFor(
  root: string,
  git: GitRunner,
  dirName: string = RECORD_DIR_NAME,
): Promise<string | null> {
  try {
    const result = await git.run(root, ['rev-parse', '--show-prefix']);
    if (result.code !== 0) return null;
    const prefix = result.stdout.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    return prefix === '' ? `/${dirName}/` : `/${prefix}/${dirName}/`;
  } catch {
    return null;
  }
}

interface ExcludeOutcome {
  readonly reading: ExcludeReading;
  readonly warning?: string;
}

/** The three ways the exclude file itself can defeat this run: unreadable, bytes we cannot re-encode, unwritable. */
type ExcludeFailure = 'read' | 'bytes' | 'write';

/** The exclude attachment's opening clause: the sentence says what the workspace is like without the line. */
const EXCLUDE_GOAL = '.superworker is not kept out of the project repository';

/**
 * The sentence a failed exclude attachment leaves. All three kinds are `failed` readings: a file
 * the engine could not read, could not re-encode, or could not write must not be rewritten from a
 * half-reading of it, and each sentence names which one it was.
 */
function excludeFailure(
  excludePath: string,
  kind: ExcludeFailure,
  detail?: string,
): string {
  const failure =
    kind === 'read'
      ? `${excludePath} was found but could not be read (${detail ?? ''})`
      : kind === 'bytes'
        ? `${excludePath} was found but its bytes are not valid UTF-8`
        : `${excludePath} was found but could not be written (${detail ?? ''})`;
  if (kind === 'read') {
    return (
      `${EXCLUDE_GOAL}: ${failure}, so rewriting it could drop ` +
      "another project's line; nothing was written."
    );
  }
  if (kind === 'bytes') {
    return (
      `${EXCLUDE_GOAL}: ${failure}, so rewriting it would replace ` +
      'bytes this engine cannot re-encode; nothing was written.'
    );
  }
  return `${EXCLUDE_GOAL}: ${failure}.`;
}

async function syncExclude(root: string, probe: CheckoutProbe): Promise<ExcludeOutcome> {
  if (probe.kind !== 'checkout') {
    return {
      reading: 'skipped-not-a-checkout',
      warning:
        `${EXCLUDE_GOAL}: the info/exclude line was not written because ${probe.note}.`,
    };
  }
  const excludePath = await gitPathOf(root, probe.git, '--git-path', 'info/exclude');
  if (excludePath === null) {
    return {
      reading: 'skipped-not-a-checkout',
      warning:
        `${EXCLUDE_GOAL}: git would not say where info/exclude is ` +
        '(rev-parse --git-path info/exclude answered nothing usable).',
    };
  }
  const line = await excludeLineFor(root, probe.git);
  if (line === null) {
    return {
      reading: 'skipped-not-a-checkout',
      warning:
        `${EXCLUDE_GOAL}: git would not say where this project sits ` +
        'inside the repository (rev-parse --show-prefix answered nothing usable).',
    };
  }
  let bytes: Uint8Array | null = null;
  try {
    bytes = await readFile(excludePath);
  } catch (error) {
    // Only a file that is not there yet means "no exclude file": that reading is correct, and the
    // line then goes into a fresh file. Any other read failure is not — folding it to `''` and
    // rewriting the file would drop every other project's line, the accident the rule above exists
    // to prevent. So the read is named as a failure, and nothing is written.
    if (!isMissingPath(error)) {
      return {
        reading: 'failed',
        warning: excludeFailure(excludePath, 'read', messageOf(error)),
      };
    }
  }
  let current = '';
  if (bytes !== null) {
    try {
      current = excludeDecoder.decode(bytes);
    } catch {
      // The file is there, but its bytes are not valid UTF-8: decoding it leniently would turn them
      // into replacement characters, and writing the result back would destroy the user's own
      // lines. Bytes this engine cannot re-encode are bytes it must not rewrite, so the reading is
      // `failed`, the warning names the encoding, and the file is left exactly as it was.
      return {
        reading: 'failed',
        warning: excludeFailure(excludePath, 'bytes'),
      };
    }
  }
  const next = withExcludeLine(current, line, true);
  if (next.text !== current) {
    try {
      await atomicWriteBytes(excludePath, encoder.encode(next.text));
    } catch (error) {
      // git was asked and answered: the checkout and the file were both found, so this is a write
      // that failed, not a checkout this engine could not see. The reading says so and the warning
      // names the file and the reason.
      return {
        reading: 'failed',
        warning: excludeFailure(excludePath, 'write', messageOf(error)),
      };
    }
  }
  return { reading: 'written' };
}

// ── the merge driver's registration string ───────────────────────────────────

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The built entry the absolute form points at. Three shapes are shipped or run, and the entry sits
 * beside this module in only the first of them:
 *
 * - the engine product itself (`dist/index.mjs`): its sibling `merge-ledger.mjs`;
 * - the host bundle (`lib/host/index.js`, which inlines this module): the entry did not come along,
 *   and the package carries it where the publishing surface lists it,
 *   `packages/superworker-core/dist/`;
 * - run from source (a test importing `src/`): the product `pnpm build` lays in the package's `dist/`.
 *
 * The first candidate that is a file here wins. When none is, the first is named as it stands: a
 * driver string that points at nothing is worth seeing spelled out rather than guessed around.
 */
function mergeLedgerProductPath(): string {
  const here = fileURLToPath(import.meta.url);
  const dir = dirname(here);
  const candidates = basename(here).endsWith('.ts')
    ? [resolve(dir, '..', 'dist', MERGE_DRIVER_PRODUCT)]
    : [
        join(dir, MERGE_DRIVER_PRODUCT),
        resolve(dir, '..', '..', 'packages', 'superworker-core', 'dist', MERGE_DRIVER_PRODUCT),
      ];
  return candidates.find((candidate) => isFile(candidate)) ?? candidates[0]!;
}

/**
 * The string written into `merge.superworker.driver`, in the one form this package writes and reads:
 * `process.execPath` (node) plus this package's built entry, both quoted — a Windows node path has
 * spaces in it, and git splits the driver string on spaces. The registration names no command on
 * `PATH`: a form that depends on what a machine happens to have installed answers on one machine and
 * dies on the next, and a registration spelled out in full is one the reader can actually judge.
 */
export function mergeDriverCommand(): string {
  return `"${process.execPath}" "${mergeLedgerProductPath()}" ${MERGE_DRIVER_ARGS_TEXT}`;
}

/**
 * The absolute form this package writes: the quoted node path, the quoted built entry, then git's args —
 * the args spelled from `MERGE_DRIVER_ARGS`, the same array the command string is built from. A second
 * literal copy of `%O %A %B %P` here would let a change of order (or one arg more) go unrecognised by the
 * reader, and the registration a person's machine really answers would be judged dead and rewritten.
 */
const ABSOLUTE_FORM = new RegExp(`^"([^"]+)" "([^"]+)" ${MERGE_DRIVER_ARGS_TEXT}$`);

/** The absolute form as this machine reads it: its shape, the two paths it names, and which of them are not here. */
export interface AbsoluteFormReading {
  /** Whether the string has the shape this package writes (two quoted paths, then git's args). */
  readonly shaped: boolean;
  /** The two quoted paths in order (the interpreter first, this package's built entry second); empty when it is not shaped. */
  readonly paths: readonly string[];
  /** The quoted paths that are not files on this machine; empty when it is shaped and both are there. */
  readonly missing: readonly string[];
}

/**
 * Read an absolute-form registration against this machine. The absolute form is the only form this
 * package writes; a registration is only worth the green cell when the thing it names can actually
 * be answered here, so the interpreter **and** the built entry both have to be present. A moved
 * checkout leaves both paths behind, and the string that pointed at them is dead — it must not be
 * certified as "works on this machine".
 */
export function readAbsoluteForm(driver: string): AbsoluteFormReading {
  const match = ABSOLUTE_FORM.exec(driver);
  if (match === null) return { shaped: false, paths: [], missing: [] };
  const paths = [match[1]!, match[2]!];
  const missing = paths.filter((path) => !isFile(path));
  return { shaped: true, paths, missing };
}

/**
 * Whether this machine really answers one registered driver string: the absolute form only, with
 * both quoted paths files here. One predicate for the writer and the doctor, so what is written and
 * what is judged cannot describe two different forms — anything else on the key is dead, whatever
 * once wrote it.
 */
export function driverRunsHere(driver: string): boolean {
  const absolute = readAbsoluteForm(driver);
  return absolute.shaped && absolute.missing.length === 0;
}

// ── the two attachments git writes ───────────────────────────────────────────

interface MergeDriverOutcome {
  readonly reading: MergeDriverReading;
  /** The command `merge.superworker.driver` holds after this run, or null when the registration was skipped. */
  readonly command: string | null;
  readonly warning?: string;
}

/**
 * Write the two keys through `git config --local`, and nothing else: git owns the config file's
 * locking, atomicity and every other section in it, so the engine writes no config byte itself.
 * The first key that comes back non-zero is the failure, named with git's own first stderr line.
 * Exported because the migration re-registers the same pair, through the same one writer.
 */
export async function writeMergeDriverKeys(
  root: string,
  git: GitRunner,
  command: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly detail: string }> {
  const name = 'superworker ledger three-way merge';
  const wroteName = await git.run(root, ['config', '--local', 'merge.superworker.name', name]);
  const wroteDriver = await git.run(root, [
    'config',
    '--local',
    'merge.superworker.driver',
    command,
  ]);
  const failed = [wroteName, wroteDriver].find((result) => result.code !== 0);
  if (failed === undefined) return { ok: true };
  const detail = failed.stderr.trim().split(/\r?\n/)[0] ?? '';
  return {
    ok: false,
    detail: `git config exited ${failed.code}${detail === '' ? '' : ` (${detail})`}`,
  };
}

/**
 * Register the merge driver through `git config --local`: git owns the config file's locking,
 * atomicity and every other section in it, so the engine writes no config byte itself.
 *
 * The registration is read first. One this machine really answers is left exactly as it is — an
 * existing working driver is not rewritten behind a person's back, and re-running `init` therefore has
 * no side effect on it. Only a missing or dead registration is replaced, with the command computed now.
 */
async function writeMergeDriver(root: string, probe: CheckoutProbe): Promise<MergeDriverOutcome> {
  if (probe.kind !== 'checkout') {
    return {
      reading: 'skipped-no-config',
      command: null,
      warning:
        `The merge driver was not registered because ${probe.note}, so two branches that both changed ` +
        'a record come back as a plain git conflict.',
    };
  }
  try {
    const read = await probe.git.run(root, ['config', '--local', '--get', 'merge.superworker.driver']);
    const registered = read.code === 0 ? read.stdout.trim() : '';
    if (registered !== '' && driverRunsHere(registered)) {
      // Already there and answerable here: kept byte for byte, and the report says which string it is.
      return { reading: 'kept', command: registered };
    }
    const command = mergeDriverCommand();
    const wrote = await writeMergeDriverKeys(root, probe.git, command);
    if (!wrote.ok) {
      return {
        reading: 'skipped-no-config',
        command: null,
        warning:
          `The merge driver was not registered: ${wrote.detail}. Two branches that both changed a record ` +
          'come back as a plain git conflict.',
      };
    }
    return { reading: 'written', command };
  } catch (error) {
    return {
      reading: 'skipped-no-config',
      command: null,
      warning: `The merge driver was not registered: git could not be run (${messageOf(error)}).`,
    };
  }
}

interface OwnRepoOutcome {
  readonly reading: OwnRepoReading;
  readonly warning?: string;
}

/**
 * Settle `.superworker`'s own repository: create one when the caller asked for it and there is none yet, and
 * otherwise only report what is there. The whole look is one presence question — `existsSync`
 * answers `false` on any error instead of throwing — so the reading has no "unknown" state; the one
 * `git init` goes through the injected runner, never a process of the engine's own.
 */
async function settleOwnRepo(
  paths: RecordPaths,
  ownRepo: boolean,
  git: GitRunner | undefined,
): Promise<OwnRepoOutcome> {
  const dotGit = join(paths.recordDir, '.git');
  if (existsSync(dotGit)) return { reading: 'present' };
  if (!ownRepo) return { reading: 'skipped' };
  const advice =
    'The records are one local copy until then: `git clean -xdf` would take the history with it.';
  if (git === undefined) {
    return {
      reading: 'skipped-no-git',
      warning:
        'No git was handed to the engine, so this directory has no repository of its own: run ' +
        `\`git init .superworker\` by hand once git is available. ${advice}`,
    };
  }
  try {
    const done = await git.run(paths.recordDir, ['init', '--quiet']);
    if (done.code === 0) return { reading: 'created' };
    const detail = done.stderr.trim().split(/\r?\n/u)[0] ?? '';
    return {
      reading: 'skipped',
      warning:
        `\`git init\` failed: ${detail === '' ? `git exited ${done.code}` : detail}. ${advice}`,
    };
  } catch (error) {
    return {
      reading: 'skipped',
      warning: `\`git init\` failed: git could not be run (${messageOf(error)}). ${advice}`,
    };
  }
}

/**
 * The one gate `init` refuses on: a record directory the project's git tracks. The records belong to
 * the machine that runs the pipeline, and taking them back out of a repository's history is a
 * person's decision — so the error hands the job to an agent instead of naming git's own commands,
 * and lands no byte. A git that cannot be asked is not this gate: outside a checkout there is
 * nothing to track with, and the doctor's tracked cell names the state where one appears.
 */
async function refuseTrackedRecordDir(root: string, git: GitRunner | undefined): Promise<void> {
  if (git === undefined) return;
  let listing: GitResult;
  try {
    listing = await git.run(root, ['ls-files', '--', RECORD_DIR_NAME]);
  } catch {
    return;
  }
  if (listing.code === 0 && listing.stdout.trim() !== '') {
    throw new Error(
      `${join(root, RECORD_DIR_NAME)} is tracked by this project's git: the records belong to the ` +
        'machine that runs the pipeline, and taking them back out of the repository\'s history is not ' +
        'this engine\'s call — consult an agent. Nothing was written.',
    );
  }
}

// ── the two verbs ────────────────────────────────────────────────────────────

/**
 * `register`: write the merge driver's two keys into this project's git config — or keep a registration
 * this machine already answers — and hand back the command now in force (null when git cannot be asked,
 * or this is not a checkout: nothing was registered, so there is no string to claim).
 */
export async function registerLedger(
  root: string,
  options: LedgerRegisterOptions = {},
): Promise<string | null> {
  const probe = await probeCheckout(root, options.git);
  if (probe.kind !== 'checkout') return null;
  const outcome = await writeMergeDriver(root, probe);
  return outcome.command;
}

/**
 * Set up the `.superworker/` record directory for a project: the four layout files first (the bottom line,
 * true in every environment), then the three best-effort attachments, each failure named in
 * `warnings` instead of thrown. Idempotent: re-running it never does anything twice. A record
 * directory the project's git tracks is the one refusal — it stops `init` before a byte lands.
 */
export async function initLedger(
  root: string,
  options: LedgerInitOptions = {},
): Promise<InitReport> {
  await refuseTrackedRecordDir(root, options.git);
  const paths = recordPaths(root);
  mkdirSync(paths.recordDir, { recursive: true });

  const written = await writeLayoutFiles(paths, options.force === true);

  const warnings: string[] = [];
  const probe = await probeCheckout(root, options.git);

  const ownRepo = await settleOwnRepo(paths, options.ownRepo !== false, options.git);
  if (ownRepo.warning !== undefined) warnings.push(ownRepo.warning);

  const exclude = await syncExclude(root, probe);
  if (exclude.warning !== undefined) warnings.push(exclude.warning);

  const mergeDriver = await writeMergeDriver(root, probe);
  if (mergeDriver.warning !== undefined) warnings.push(mergeDriver.warning);

  return {
    written,
    ownRepo: ownRepo.reading,
    exclude: exclude.reading,
    mergeDriver: mergeDriver.reading,
    mergeDriverCommand: mergeDriver.command,
    warnings,
  };
}
