/**
 * The body of the git merge driver: one three-way merge of one `.pf` record.
 *
 * This file knows three things — which record this is, how to read the bytes of the three sides, and how the
 * merged result lands — and then hands the merge itself to the four engines beside it. It defines no merge rule
 * of its own.
 *
 * Why a driver is needed
 * ----------------------
 * Two machines each run a pipeline and each hold the same record. Every writer rewrites the whole file from the
 * data in memory (two-space indent, sorted keys for `ideas.json`, LF on every platform, no trailing newline), so
 * two records that each changed one field differ on every line: a line-by-line merge reports a false conflict,
 * and worse, "cleanly" merges a mixture that neither side recognises. So the merge happens on the parsed record,
 * and the result is written back through **the same byte writer** (`jsonBytes` + `jsonOptionsForRecord`) — the
 * decision and the bytes come from one place, and the two formats cannot drift apart.
 *
 * Which record this is: the name first, then the shape
 * ---------------------------------------------------
 * Under git `<ours>` is often git's own temporary file, whose name cannot be recognised, so the driver
 * configuration passes `%P` (the path in the repository) as the fourth argument. When the name cannot be
 * recognised the shape decides: the three that carry a `nodes` / `cycles` / `instructions` collection key, or a
 * handoff ticket ("it has a status, and no collection underneath"). A file recognised by neither is refused.
 *
 * Where the record tree is: git says so, the driver does not assume
 * -----------------------------------------------------------------
 * git runs a merge driver at the top of the working tree, and a project may sit several directories below that
 * (or a checkout may hold several projects). The record tree is therefore located from `%P` — the directory in
 * front of its `.pf` segment, joined onto the driver's working directory, and confirmed to hold an init-ed
 * `.pf` — and, when no `%P` came in, by walking up from the working directory to the nearest init-ed `.pf`. When
 * neither locates one, the driver says plainly that no `.pf` sits at that position instead of judging a conflict
 * it cannot place; a `%P` that names a position with no record tree is exactly that case, not "a record tree that
 * was never init-ed".
 *
 * The exit codes, and what git does with them
 * -------------------------------------------
 *   0  merged and written into `<ours>` (or nothing needed doing)
 *   1  needs a human decision (or the record tree's lock never came free): not one byte was written, so git
 *      keeps `<ours>` and records this merge as a conflict
 *   2  a usage or read error: the file does not read as a record (it does not parse, its shape is wrong), a side
 *      is there but cannot be read at all, or there is no record tree at the position git named
 */

import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { isPfError } from '../errors';
import { isMissingPath } from '../fs-helpers';
import { assertLedgerInitialized, isLedgerInitialized } from '../initledger';
import { atomicWriteBytes, jsonBytes, jsonOptionsForRecord, readJsonFile } from '../jsonio';
import { withLedgerLock } from '../ledgerlock';
import { pfPaths } from '../paths';
import {
  EXIT_CONFLICT,
  EXIT_OK,
  EXIT_USAGE,
  KIND_IDEAS,
  KIND_INSTRUCTIONS,
  KIND_SIGNAL,
  KIND_STATE,
  MergeReport,
  type MergeKind,
  isRecord,
  kindFromShape,
  kindOf,
} from './generic';
import { mergeIdeas } from './ideas';
import { mergeInstructions } from './instructions';
import { mergeSignal } from './signal';
import { mergeState } from './state';

/** One merge the driver received: the three sides, plus git's `%P` and the location of the record tree. */
export interface MergeDriverRequest {
  /** git's `%O`: the common ancestor side. */
  readonly base: string;
  /** git's `%A`: the merge result is written here. */
  readonly ours: string;
  /** git's `%B`: the other branch's side. */
  readonly theirs: string;
  /** git's `%P`: this record's path in the repository, which is how the record is recognised and where the record tree is located. */
  readonly path?: string;
  /**
   * The project root holding the record tree. Left out by the installed entry: the root is then located
   * from `%P` (and, failing that, by walking up from the current directory) — git runs a driver at the
   * top of the working tree, not necessarily beside `.pf`.
   */
  readonly root?: string;
  /** Only print the verdict, writing not one byte. */
  readonly dryRun?: boolean;
}

/** Where the verdict goes: into this process's stdout / stderr by default. */
export interface MergeDriverIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const defaultIo: MergeDriverIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** The reading of one side: its bytes (used to decide "does this need writing"), and the value parsed out of them (null when absent). */
interface Side {
  readonly bytes: Uint8Array;
  readonly value: unknown;
}

/** One merge run: read the three sides, merge them by record kind, write the result into `<ours>`, and hand back the exit code. */
export async function runMergeDriver(
  request: MergeDriverRequest,
  io: MergeDriverIo = defaultIo,
): Promise<number> {
  const oursPath = request.ours;
  const theirsPath = request.theirs;
  const basePath = request.base;
  const named = request.path;

  let kind: MergeKind | null =
    kindOf(named) ?? kindOf(oursPath) ?? kindOf(theirsPath) ?? kindOf(basePath);

  let base: Side | null;
  let ours: Side | null;
  let theirs: Side | null;
  try {
    const readings = {
      base: await readSide(basePath, 'base', io),
      ours: await readSide(oursPath, 'ours', io),
      theirs: await readSide(theirsPath, 'theirs', io),
    };
    // A 0-byte side is the one absence git itself produces (add/add hands an empty file over); it is
    // read as "this side has no record", and that is said out loud rather than guessed from blankness.
    for (const reading of Object.values(readings)) {
      if (reading.told !== undefined) io.stderr(`merge-ledger: ${reading.told}\n`);
    }
    base = readings.base.side;
    ours = readings.ours.side;
    theirs = readings.theirs.side;
  } catch {
    return EXIT_USAGE;
  }

  if (kind === null) kind = kindFromShape(ours?.value, theirs?.value, base?.value);
  if (kind === null) {
    io.stderr(
      `merge-ledger: by name (${named ?? oursPath}) this is not a ledger file this driver ` +
        'handles, and by its content it is none of the four records -- not touching it\n',
    );
    return EXIT_USAGE;
  }

  const report = new MergeReport(kind, named ?? oursPath);

  let oursValue = ours?.value ?? null;
  let theirsValue = theirs?.value ?? null;
  let needsMerge = false;
  if (ours === null && theirs === null) {
    io.stderr(`merge-ledger [${report.path}]: neither side has a file; there is nothing to merge\n`);
    return EXIT_OK;
  }
  if (ours === null) {
    report.decide('ours does not exist (added on this side) -> take theirs');
    oursValue = theirsValue;
    theirsValue = null;
  } else if (theirs === null) {
    report.decide('theirs does not exist (added on this side) -> take ours');
  } else {
    needsMerge = true;
  }

  let merged: unknown;
  if (needsMerge) {
    if (!isRecord(oursValue) || !isRecord(theirsValue)) {
      io.stderr(
        `merge-ledger [${report.path}]: the file is not a JSON object; wrong shape, ` +
          'nothing written\n',
      );
      return EXIT_USAGE;
    }
    if (base !== null && !isRecord(base.value)) {
      io.stderr(
        `merge-ledger [${report.path}]: base is not a JSON object; wrong shape, ` +
          'nothing written\n',
      );
      return EXIT_USAGE;
    }
    merged = mergeByKind(kind, base?.value ?? null, oursValue, theirsValue, report);
  } else {
    // Only one side has the file: that whole side is the result, and there is nothing to compare.
    merged = oursValue;
  }

  if (request.dryRun === true) {
    io.stdout(`merge-ledger --dry-run [${report.path}] kind=${kind}\n`);
    if (report.decisions.length > 0) {
      for (const line of report.decisions) io.stdout(`${line}\n`);
    } else {
      io.stdout(
        '  (nothing to adjudicate: the two sides agree, or only one of them changed anything)\n',
      );
    }
    for (const line of report.conflicts) io.stderr(`${line}\n`);
    io.stdout(
      `  -> ${
        report.conflicts.length > 0
          ? 'conflicts; nothing written'
          : `no conflicts; would have written ${report.path}`
      }\n`,
    );
    return report.conflicts.length > 0 ? EXIT_CONFLICT : EXIT_OK;
  }

  if (report.conflicts.length > 0) {
    for (const line of report.conflicts) io.stderr(`${line}\n`);
    io.stderr(
      `merge-ledger: ${report.conflicts.length} places need a human decision; not a byte of ` +
        `${report.path} was touched. Merge it by hand first, then \`git add\` and carry on.\n`,
    );
    return EXIT_CONFLICT;
  }

  let payload: Uint8Array;
  try {
    payload = jsonBytes(merged, jsonOptionsForRecord(kind));
  } catch (error) {
    io.stderr(
      `merge-ledger [${report.path}]: the merged result is not valid JSON: ` +
        `${messageOf(error)}\n`,
    );
    return EXIT_USAGE;
  }

  const current = ours?.bytes ?? null;
  if (current !== null && sameBytes(current, payload)) return EXIT_OK;

  const root = request.root ?? recordRootOf(named, process.cwd());
  if (root === null) {
    const looked = named === undefined ? process.cwd() : join(process.cwd(), named);
    io.stderr(
      `merge-ledger [${report.path}]: no .pf sits at ${looked} nor at any directory above it, ` +
        'so there is no record tree to merge this into -- nothing written, left for a person\n',
    );
    return EXIT_USAGE;
  }

  const paths = pfPaths(root);
  try {
    // This gate is asked first: a record directory that was never initialised gets no write, and it also keeps the
    // lock's mkdir from setting up a `.pf/meta/` along the way.
    assertLedgerInitialized(paths);
  } catch (error) {
    io.stderr(`Error: ${messageOf(error)}\n`);
    return EXIT_CONFLICT;
  }
  try {
    // Writing the whole record is mutually exclusive with the other writers: two whole-file writes colliding would
    // silently swallow one side's record.
    await withLedgerLock(paths, async () => {
      await atomicWriteBytes(oursPath, payload);
    });
  } catch (error) {
    io.stderr(`Error: ${messageOf(error)}\n`);
    return EXIT_CONFLICT;
  }
  return EXIT_OK;
}

/**
 * Which engine merges which record.
 *
 * The identity of a record — its name, its file, its collection key, its conflict-line label — is one row of the
 * kind table in `generic.ts`; the engine is the one column that table cannot carry (the engines read `generic`, so a
 * table holding them would close the circle). `Record<MergeKind, Engine>` is what keeps the two in step: a fifth kind
 * compiles only once it has an engine here.
 */
type Engine = (base: unknown, ours: unknown, theirs: unknown, report: MergeReport) => unknown;

const ENGINES: Record<MergeKind, Engine> = {
  [KIND_IDEAS]: mergeIdeas,
  [KIND_STATE]: mergeState,
  [KIND_INSTRUCTIONS]: mergeInstructions,
  [KIND_SIGNAL]: mergeSignal,
};

/** Hand the record kind to its engine. */
function mergeByKind(
  kind: MergeKind,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): unknown {
  const engine = ENGINES[kind];
  if (engine === undefined) throw new Error(`merge-ledger: no engine for ${String(kind)}`);
  return engine(base, ours, theirs, report);
}

/**
 * The project root holding the record tree, located from information git gave:
 *
 * 1. `%P` (the path in the repository): the record tree is the directory in front of its `.pf`
 *    segment, joined onto the driver's working directory (the top of the working tree). A project in
 *    a subdirectory of the repository is found this way, and so is one of several projects. The
 *    directory that comes out has to hold an **init-ed** `.pf`, exactly as the walk-up arm requires:
 *    a `%P` under a tree with no record tree (or with one that was never init-ed) is not a located
 *    record tree, and answering it as one would judge the merge at a position git never named.
 * 2. no usable `%P`: walk up from the working directory to the nearest init-ed `.pf`.
 * 3. neither: null — the caller says plainly that no `.pf` sits there.
 */
function recordRootOf(path: string | undefined, cwd: string): string | null {
  if (path !== undefined && path !== '') {
    const segments = path.replace(/\\/g, '/').split('/');
    const at = segments.lastIndexOf('.pf');
    if (at >= 0) {
      const candidate = resolve(cwd, ...segments.slice(0, at));
      if (isLedgerInitialized(pfPaths(candidate))) return candidate;
      return null;
    }
  }
  let current = resolve(cwd);
  for (;;) {
    if (isLedgerInitialized(pfPaths(current))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** The reading of one side: absent, or present with its bytes and its parsed value. */
interface SideReading {
  /** The side as the merge sees it: null when this side has no record. */
  readonly side: Side | null;
  /** What to tell a person when absence was read from something other than a missing file (a 0-byte file git handed over). */
  readonly told?: string;
}

/** Which side of the merge one path is: git's `%O` (the common ancestor), `%A` (this side) or `%B` (the other side). */
type SideRole = 'base' | 'ours' | 'theirs';

/**
 * How one side is named in a line a person reads: the side word once, then the file it was read
 * from. Building the sentence here is what keeps a side from being said twice (a file named after
 * its own side used to read "theirs theirs").
 */
function sideLabel(side: SideRole, path: string): string {
  return `the ${side} side (${basename(path)})`;
}

/**
 * The reading of one side. Only **a missing file or a 0-byte one** means "this side has no record" —
 * the 0-byte file is the one shape git's add/add produces, and it is said out loud, not inferred
 * from blankness. A path that is there but does not read as a file (a share-locked handle on
 * Windows, no permission on POSIX, a directory where a file should be) is **not** an absent side:
 * reading it as absent would write the other side's record over it and let git call the merge
 * resolved, so it is a usage error with a line on stderr, and not a byte is written. Anything else
 * has to read as the record: a file that is only whitespace, carries a byte order mark, or is
 * written in UTF-16 does not get quietly dropped in favour of the other side — it is a parse error
 * with a decidable code (`readJsonFile`'s own), and the human sees it.
 */
async function readSide(path: string, side: SideRole, io: MergeDriverIo): Promise<SideReading> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    // A path that is not there all along is the one reading that means "absent"; every other read
    // failure is a usage error the human sees (exit 2 through the caller's catch).
    if (isMissingPath(error)) return { side: null };
    io.stderr(
      `merge-ledger: ${sideLabel(side, path)} is there but could not be read (${messageOf(error)}); ` +
        'treating it as absent would drop that side of the merge, so nothing is written\n',
    );
    throw error;
  }
  if (bytes.byteLength === 0) {
    return {
      side: null,
      told: `${sideLabel(side, path)} is a 0-byte file, which is how git hands over "this side has no record" (add/add) -> reading it as absent`,
    };
  }
  try {
    const read = await readJsonFile(path, sideLabel(side, path));
    return { side: read.kind === 'present' ? { bytes, value: read.value } : null };
  } catch (error) {
    if (isPfError(error)) {
      io.stderr(`Error: ${messageOf(error)}\n`);
    }
    io.stderr(
      `merge-ledger: ${sideLabel(side, path)} is not a record that reads (a file that is not JSON, or not valid ` +
        'UTF-8); nothing is written\n',
    );
    throw error;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
