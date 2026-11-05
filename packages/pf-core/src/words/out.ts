/**
 * The small shared cells every verb's lines are built from: the short id, the path spelling, the two
 * scalar spellings the lines print, the project handle, and the one shape of a refusal. The JSON
 * spellings live here too — the compact one-line form and the two-space indented form — since the
 * engine hands back plain values with the key order already fixed, so the spelling is the only thing
 * left to get right.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { open } from '../open';
import type { Pf } from '../open';
import type { WordsIO, WordProject } from './types';

/** The first eight characters of an id: the short form the lines print. */
export const short = (id: unknown): string => String(id).slice(0, 8);

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

/** Wrap one handler so an engine refusal lands as its sentence plus that door's exit code. */
export function guarded(
  body: (call: any) => any,
  exitCode = 1,
): (call: any) => Promise<{ code?: number; stdout?: string; stderr?: string }> {
  return async (call: any) => {
    try {
      return await body(call);
    } catch (error) {
      return refuse(messageOf(error), exitCode);
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

/** The project root and the handle of one call, on the seams the caller handed in. */
export async function project(value: string | undefined, io: WordsIO): Promise<WordProject> {
  const root = projectRootOf(value, io.root);
  return { root, pf: await handleOf(root, io) };
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
// command line's printed bytes are their own contract), and a projection that needs
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
  if (new TextEncoder().encode(stdout).byteLength <= LONG_RESULT_LIMIT) return null;
  return LONG_RESULT_POINTERS[word] ?? null;
}

