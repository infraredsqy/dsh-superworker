/**
 * The small shared cells every verb's lines are built from: the short id, the path spelling, the two
 * scalar spellings the lines print, the project handle, and the one shape of a refusal. The JSON
 * spellings live here too — the compact one-line form and the two-space indented form — since the
 * engine hands back plain values with the key order already fixed, so the spelling is the only thing
 * left to get right.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { PfError } from '../errors';
import type { PfErrorCode } from '../errors';
import { open } from '../open';
import type { Pf } from '../open';
import { short as shortOf } from '../graph';
import type { VerbAnswer, VerbCall, WordsIO } from './types';

const encoder = new TextEncoder();

/**
 * The first eight characters of an id: the short form the lines print. The width is the graph layer's
 * one rule (`graph.short`) and is cited from here rather than written a second time; a cell that is
 * not a string yet is spelled first, which is all this wrapper adds.
 */
export const short = (id: unknown): string => shortOf(String(id));

/** A path the way the listings spell it: forward slashes, on every platform. */
export const posix = (path: unknown): string => String(path).split('\\').join('/');

/** The list spelling: `['coding', 'writing']`. */
export function pyList(words: readonly string[]): string {
  return `[${words.map((word) => `'${word}'`).join(', ')}]`;
}

/** The scalar spelling: booleans spell `True` / `False`. */
export function pyScalar(value: unknown): string {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null || value === undefined) return 'None';
  return String(value);
}

/** One value in the compact spelling: `", "` between items, `": "` after a key. */
export function pyCompact(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(pyCompact).join(', ')}]`;
  const held = value as Record<string, unknown>;
  const keys = Object.keys(held).filter((key) => held[key] !== undefined);
  return `{${keys.map((key) => `${JSON.stringify(key)}: ${pyCompact(held[key])}`).join(', ')}}`;
}

/** One value in the two-space indented spelling. */
export function pyIndented(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** One refusal: the sentence on stderr, and the exit code a refusal answers with. */
export function refuse(message: string, code = 1): { code: number; stderr: string } {
  return { code, stderr: `Error: ${message}` };
}

/** The exact words of one refusal: the engine's own sentence when it carries one. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── the exit codes ──────────────────────────────────────────────────────────
//
// One table, in one place. `2` is "this line cannot be taken" — a usage refusal, a record that does
// not fit the line, or a record that cannot be read at all (plan / settle / advance answer a read
// failure here, as they always have); `3` is the session that could not be opened after the word
// began (dispatch's failures after it began, a read failure included); `1` is everything else that
// failed. A word's own code is the fallback. The code table only ever **tightens** a word's own
// tier (`1` → `2`): it reaches the refusals the engine names with a `PfError` code saying the line
// does not fit, and it never lowers a word's own `2` or `3` into `1` — the four disk-failure codes
// (`parse_failure`, `invalid_utf8`, `lock_timeout`, `invalid_config_file`) are deliberately absent
// from it, so a record that cannot be read keeps the word's own tier. A failure the engine throws
// as a plain `Error` (a record verb's "no such line", for one) never gets here either and keeps the
// word's own code, so the same sentence can answer `2` from one word and `1` from another.

/** The three numbers this layer answers with. */
export const EXIT = {
  /** The word failed: a refusal with no more specific answer, a write that did not land. */
  failed: 1,
  /** This line cannot be taken: a usage refusal, or a record that refuses the line as written. */
  refused: 2,
  /** The session could not be opened (the opener failed after the word began). */
  noSession: 3,
} as const;

/** The words that answer with a code other than `failed`; a word absent here answers `failed`. */
const WORD_EXIT_CODES: Readonly<Record<string, number>> = {
  plan: EXIT.refused,
  settle: EXIT.refused,
  advance: EXIT.refused,
  handoff: EXIT.refused,
  dispatch: EXIT.noSession,
};

/**
 * The engine's own refusal codes → the code an answer takes. A line the record cannot accept is a
 * refusal like any other (`2`), even from a word whose own tier is `1`. The disk-failure codes are
 * absent on purpose: a record that cannot be read is not a refusal of the line — no line can be
 * taken at all — so those fall through to the word's own tier (`exitCodeOf` below), and the table
 * never answers below what the word itself answers.
 */
const ERROR_EXIT_CODES: Readonly<Partial<Record<PfErrorCode, number>>> = {
  unknown_key: EXIT.refused,
  invalid_value: EXIT.refused,
  layer_not_allowed: EXIT.refused,
  cycle_not_found: EXIT.refused,
  node_not_found: EXIT.refused,
  ambiguous_holder: EXIT.refused,
  not_a_project: EXIT.refused,
  worktree_mode_unsupported: EXIT.refused,
  dispatch_blocked: EXIT.refused,
  nothing_to_settle: EXIT.refused,
  not_holding: EXIT.refused,
};

/**
 * The code one failed word answers with: the engine's named-refusal code when it has one (the table
 * above only tightens), else the word's own tier — a read failure of the records lands here, so
 * `plan` / `settle` / `advance` answer `2` and `dispatch` `3`, exactly as their catches used to.
 */
export function exitCodeOf(verb: string, error: unknown): number {
  if (error instanceof PfError) return ERROR_EXIT_CODES[error.code] ?? WORD_EXIT_CODES[verb] ?? EXIT.failed;
  return WORD_EXIT_CODES[verb] ?? EXIT.failed;
}

// ── the one skeleton ────────────────────────────────────────────────────────

/**
 * What one verb's body is handed: the parsed line, and the two things every word used to open for
 * itself — the project root it acts on and that project's engine handle. A word that answers without
 * a record (`version`, `dag help`, the merge driver) simply does not read them: opening a handle
 * touches no disk.
 */
export interface VerbScene extends VerbCall {
  /** The project root this word acts on: `--project`, else the caller's own (worktrees resolved). */
  readonly root: string;
  /** The engine handle of that root, opened on this call's own seams. */
  readonly pf: Pf;
  /** The first word of one positional cell — `undefined` when the line did not give one. */
  readonly at: (index: number) => string | undefined;
}

/** One word's body: the engine call and the lines it answers with, nothing else. */
export type VerbBody = (scene: VerbScene) => Promise<VerbAnswer> | VerbAnswer;

/** One wired word: what the router's table holds for it. */
export type VerbHandler = (call: VerbCall) => Promise<VerbAnswer>;

/**
 * Wrap one word's body: the project root and the handle are opened here, once, and a refusal thrown
 * anywhere inside lands as that sentence plus the exit code the table above gives it. A word writes
 * only its answer.
 */
export function run(verb: string, body: VerbBody): VerbHandler {
  return async (call: VerbCall): Promise<VerbAnswer> => {
    try {
      const root = projectRootOf(call.values.project, call.io.root);
      const pf = handleOf(root, call.io);
      return await body({
        ...call,
        root,
        pf,
        at: (index: number) => call.positionals[index]?.[0],
      });
    } catch (error) {
      return refuse(messageOf(error), exitCodeOf(verb, error));
    }
  };
}

/**
 * The project root a word acts on: the directory named, else the caller's own — as it is, with one
 * exception. Inside a linked worktree the ledger is not the worktree's own copy: in parallel mode a
 * node's code work goes into the main tree's `.pf/worktrees/<short id>`, and that checkout holds a
 * copy of `.pf/` as of the fork, so a recording command that accepted it would settle on a stale
 * snapshot. A worktree root is recognised by its `.git` being a **file** pointing at
 * `<main>/.git/worktrees/<name>`; that pointer leads back to the main tree, and only when the main
 * tree really has a `.pf/`. Everything else — a subdirectory, a submodule (its `.git` file points at
 * `.git/modules/…`), a directory that is no project at all — is answered as the directory it is.
 * Nothing climbs to a repository root: the engine itself refuses a folder with no `.pf` of its own
 * rather than trying one above it.
 */
export function projectRootOf(named: string | undefined, start: string): string {
  const base = named === undefined || named === '' ? start : resolve(named);
  return mainTreeOf(base) ?? base;
}

/** The main tree a linked worktree's checkout root points back at, or `null` when this is no worktree root. */
function mainTreeOf(start: string): string | null {
  let firstLine: string;
  try {
    const dotGit = join(start, '.git');
    if (!statSync(dotGit).isFile()) return null;
    firstLine = readFileSync(dotGit, 'utf8').split('\n')[0]!.trim();
  } catch {
    return null;
  }
  if (!firstLine.startsWith('gitdir:')) return null;
  const target = firstLine.slice('gitdir:'.length).trim();
  if (target === '') return null;
  const gitdir = resolve(start, target);
  // `<main>/.git/worktrees/<name>` and nothing else: a submodule's `gitdir:` does not name a worktree.
  if (basename(dirname(gitdir)) !== 'worktrees') return null;
  const main = resolve(gitdir, '..', '..', '..');
  try {
    if (!statSync(join(main, '.pf')).isDirectory()) return null;
  } catch {
    return null;
  }
  return main;
}

/** The engine handle of one project, opened on this call's own seams. */
export function handleOf(root: string, io: WordsIO): Pf {
  return open(root, {
    executor: io.executor,
    ...(io.homeDir === undefined ? {} : { homeDir: io.homeDir }),
    ...(io.pluginsDir === undefined ? {} : { pluginsDir: io.pluginsDir }),
  });
}

/** The tag list of one filter cell: comma-separated, empty words dropped. */
export function splitTags(text: unknown): string[] {
  return String(text).split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
}

/** A count cell (`--parallel`, `--limit`): the number as written, `off` as the default. */
export function readCount(text: unknown): number | string {
  if (text === 'off') return 1;
  const value = Number(text);
  return Number.isFinite(value) ? value : String(text);
}

/** A policy value as the record takes it: `on` / `off` become booleans, numbers become numbers. */
export function readPolicyValue(text: unknown): unknown {
  if (text === 'on') return true;
  if (text === 'off') return null;
  const raw = String(text);
  if (text !== '' && text !== undefined && text !== null && Number.isFinite(Number(raw))) return Number(raw);
  return text;
}

// ── the long-answer contract ────────────────────────────────────────────────
//
// A tool answer is one message, and three words can outgrow it. The cap and the
// per-word pointer live here, once: the transport's printer never applies them (a
// word's printed bytes are their own contract), and a projection that needs
// the pointer asks this layer instead of spelling its own — so the cap and the words
// it covers cannot drift apart between two callers.

/** The answer size in UTF-8 bytes above which one of the long words carries a pointer instead of more rows. */
export const LONG_RESULT_LIMIT = 4000;

/** The pointer each long word hands back, naming the word to ask next (never a second pagination state). */
const LONG_RESULT_POINTERS: Record<string, string> = {
  'dag list': 'ask `dag info <node id>` for one node in full, or rerun with `--limit <n>`',
  'dag search': 'rerun with `--limit <n>` to narrow this answer, or `dag info <node id>` for one node in full',
  'session list': "ask `session show <node id>` for one node's note in full",
};

/**
 * The pointer one long answer carries, or `null` when it fits (or the word is not one
 * of the long ones): the cap and the comparison both count UTF-8 bytes, the same measure
 * `Buffer.byteLength` gives, never characters. The caller appends it as the answer's own
 * last line — nothing here truncates: an oversized answer travels whole, with the pointer
 * after it.
 */
export function longResultPointerOf(stdout: string, word: string): string | null {
  if (encoder.encode(stdout).byteLength <= LONG_RESULT_LIMIT) return null;
  return LONG_RESULT_POINTERS[word] ?? null;
}

