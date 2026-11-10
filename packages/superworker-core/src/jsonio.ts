import { mkdir, open, readFile, rename } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { RecordError } from './errors.ts';
import {
  RETRY_ATTEMPTS,
  RETRY_BASE_MS,
  isBusyPath,
  isMissingPath,
  sleep,
  tryUnlinkWithRetry,
} from './fs-helpers.ts';

/**
 * The only reader and the only writer of `.superworker` records. The reading:
 *
 * - **the bytes of one record on disk**: two-space indent; non-ASCII written as it is
 *   (Chinese text in a record stays readable); **LF on every platform** (machine-read bytes
 *   must be the same byte for byte whichever machine wrote them, otherwise a merge of two
 *   sides that say the same thing would still rewrite the whole file); no trailing newline;
 *   key order is given by the caller — the writers of ideas.json and issues.json sort keys
 *   deeply (each writer's own habit), the other records land in construction order. Which
 *   record is sorted is in `jsonOptionsForRecord`.
 * - **a write is atomic**: the temporary file lands in the target's own directory (a
 *   cross-directory rename leaves half a file on the way), created exclusively, written out
 *   and fsynced, then renamed into place; when the rename meets a process that is reading,
 *   it backs off and retries in small steps (within a limit). Any step failing: the
 *   temporary file is cleared, the original file stays as it was, the error is thrown as it
 *   is — a reader sees either the old record or the new one, never half of one.
 * - **a read has only three readings**: present (`kind: 'present'`); missing
 *   (`kind: 'missing'`, whether that counts as empty is up to the caller); unparsable
 *   (throws `RecordError`, the code is decidable, never repaired automatically). A read
 *   tolerates unknown fields: whatever parses is handed back, no validation, no rewriting.
 */

/**
 * The platform line ending. Only the text products a **person** reads follow the platform (the
 * dispatch prompt, the run doc, the `started` marker); everything a machine reads — the records
 * and the four layout files — is LF on every platform, which `jsonBytes` writes as it is.
 */
export const EOL = process.platform === 'win32' ? '\r\n' : '\n';

const encoder = new TextEncoder();

/** Byte-strict UTF-8 decoding: a bad byte reports at once; a byte order mark stays in the text (and fails parsing just the same). */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The options of `jsonBytes` / `atomicWriteJson`. */
export interface JsonBytesOptions {
  /** Sort keys deeply (compared by code point). */
  readonly sortKeys?: boolean;
}

/** The key-order reading of the records this engine writes: which record's writer sorts keys, checked one by one. */
export type RecordKind =
  | 'state'
  | 'ideas'
  | 'issues'
  | 'signal'
  | 'session-note';

/**
 * Give the key-order options of one record kind when landing: the issue pool and the graph sort keys, the
 * rest keep construction order. A name outside this engine's own list keeps construction order too — the
 * merge driver hands in the kind words of its own table (`src/ledgermerge/`), and the byte rule is one rule
 * for every name.
 */
export function jsonOptionsForRecord(record: RecordKind | string): JsonBytesOptions {
  return record === 'ideas' || record === 'issues' ? { sortKeys: true } : {};
}

/** Keys are compared by code point, not in UTF-16 code unit order. */
function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let i = 0; i < shared; i++) {
    const difference = (left[i]?.codePointAt(0) ?? 0) - (right[i]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return left.length - right.length;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort(compareCodePoints)) {
      sorted[key] = sortDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * The bytes of one record on disk — exactly the block `atomicWriteJson` lands.
 * A caller that has to tell whether a write would change the file (the merge driver
 * later) takes the bytes from here instead of spelling a second serialization itself.
 *
 * The bytes are LF on every platform: the same record written on two machines has to be the
 * same bytes, so that "both sides are byte-identical, nothing to do" can hold at merge time.
 */
export function jsonBytes(value: unknown, options: JsonBytesOptions = {}): Uint8Array {
  const ordered = options.sortKeys === true ? sortDeep(value) : value;
  const text = JSON.stringify(ordered, null, 2);
  if (text === undefined) {
    throw new TypeError('the value jsonBytes received does not serialize to JSON (undefined / function / symbol)');
  }
  return encoder.encode(text);
}

/** The reading of one record: present, or missing. Unparsable throws `RecordError`, see the module head. */
export type JsonRead =
  | {
      readonly kind: 'present';
      readonly value: unknown;
      /** The on-disk literal of every top-level JSON number, handed back only under the `numberLiterals` option (the integer reading of disk uses it to tell `4` from `4.0`). */
      readonly numberLiterals?: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'missing' };

/** The options of `readJsonFile`. */
export interface ReadJsonFileOptions {
  /**
   * Hand back the raw on-disk literal of every top-level JSON number as well. A JS number has
   * no integer/float distinction, `JSON.parse('4.0')` is just 4; the on-disk text is the only
   * evidence that tells an "integer" from a "decimal spelling".
   */
  readonly numberLiterals?: boolean;
}

/** The mark of a top-level JSON number: the literal hangs on a private symbol key JSON cannot spell, and recognising the mark is recognising the number. */
const numberLiteralMark = Symbol('superworker.jsonNumberLiteral');

type MarkedNumber = { readonly [numberLiteralMark]: string };

function isMarkedNumber(value: unknown): value is MarkedNumber {
  return typeof value === 'object' && value !== null && numberLiteralMark in value;
}

/**
 * The on-disk literal of every top-level JSON number (`{"a": 4.0}` → `{a: '4.0'}`). Parsing
 * uses a reviver that hangs each number leaf's original literal (`JSON.parse`'s third argument
 * `context.source`) on the mark, and only the root object's own cells are taken — a
 * configuration layer file is a flat object, so the root level is enough and nested cells are
 * not taken.
 */
function topLevelNumberLiterals(text: string): Record<string, string> {
  const annotated = JSON.parse(
    text,
    ((_key: string, value: unknown, context?: { readonly source?: string }) => {
      if (typeof value === 'number' && typeof context?.source === 'string') {
        return { [numberLiteralMark]: context.source };
      }
      return value;
    }) as (this: unknown, key: string, value: unknown) => unknown,
  ) as unknown;
  const out: Record<string, string> = {};
  if (annotated === null || typeof annotated !== 'object' || Array.isArray(annotated)) return out;
  for (const [key, cell] of Object.entries(annotated as Record<string, unknown>)) {
    if (isMarkedNumber(cell)) out[key] = cell[numberLiteralMark];
  }
  return out;
}

/**
 * Read one record. `label` is the name the caller shows people (`state.json`,
 * `signals/<line>/<node>.json`); errors name it, and the path itself is the default.
 */
export async function readJsonFile(
  path: string,
  label: string = path,
  options: ReadJsonFileOptions = {},
): Promise<JsonRead> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(path);
  } catch (error) {
    if (isMissingPath(error)) return { kind: 'missing' };
    throw error;
  }
  let text: string;
  try {
    text = strictUtf8.decode(bytes);
  } catch (error) {
    throw new RecordError('invalid_utf8', path, `${label} is not valid UTF-8: ${reasonOf(error)}`, {
      cause: error,
    });
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (options.numberLiterals !== true) return { kind: 'present', value };
    return { kind: 'present', value, numberLiterals: topLevelNumberLiterals(text) };
  } catch (error) {
    throw new RecordError('parse_failure', path, `${label} parse failure: ${reasonOf(error)}`, {
      cause: error,
    });
  }
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Land a block of bytes onto `path` as a whole: readers see only the old record or the new one.
 * The temporary file shares the target's directory, is created exclusively, renamed after fsync;
 * on failure it is cleared away and the original error is handed out.
 */
export async function atomicWriteBytes(path: string, payload: Uint8Array): Promise<void> {
  await landTemp(path, payload, (tmp) => renameWithRetry(tmp, path));
}

export async function atomicWriteJson(
  path: string,
  value: unknown,
  options: JsonBytesOptions = {},
): Promise<void> {
  await atomicWriteBytes(path, jsonBytes(value, options));
}

/**
 * Land a block of bytes onto `path` by **exclusive creation**: the file either appears whole (the
 * first writer wins) or, when it is already there, is not touched by one byte and Node's own
 * `EEXIST` is handed out — the disk's decidable "already there" (the caller branches on the code;
 * the foundation adds no vocabulary of its own).
 *
 * The landing is a same-directory temporary file written out and synced, then hard-linked onto the
 * target name: the link is the moment the file comes into existence, so a reader sees either the
 * old nothing or the whole new file, never half of one, and two creators racing on one target name
 * cannot both win — the second link reports `EEXIST` and its temporary file is cleared. This is
 * the run doc's landing (`<record>/nodes/<node>/run.md`): the first dispatch preparation sets it up,
 * and whatever a live session has written into it since is never overwritten.
 */
export async function exclusiveCreateBytes(path: string, payload: Uint8Array): Promise<void> {
  // The self-contained Node declarations (`src/node-runtime.d.ts`) do not carry the hard link yet;
  // the widened view stays local to this landing until the declaration learns it.
  const linkIntoPlace = fsPromises as typeof fsPromises & {
    link(from: string, to: string): Promise<void>;
  };
  await landTemp(path, payload, (tmp) => linkIntoPlace.link(tmp, path));
}

/**
 * The one landing a block of bytes onto `path` goes through: the temporary file sits in the target's
 * own directory (a cross-directory rename leaves half a file on the way), is created exclusively,
 * written out and fsynced; `place` is the one step that differs between the two landings — a rename
 * onto the target (atomic write) or a hard link onto it (exclusive creation). The temporary file is
 * cleared either way once `place` is done (after a rename it is already gone), and on any failure the
 * handle is closed, the temporary file is cleared and the original error is handed out as it is — the
 * original record stays as it was, and a reader sees either the old file or the new one, never half.
 *
 * The temporary name's rule, the fsync moment and the failure cleanup therefore have one home: a
 * hardening of any of them lands for both writers at once instead of one of them keeping half the fix.
 */
async function landTemp(
  path: string,
  payload: Uint8Array,
  place: (tmp: string) => Promise<void>,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const tmp = join(dir, tempName(basename(path)));
  try {
    handle = await open(tmp, 'wx');
    await handle.writeFile(payload);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await place(tmp);
  } catch (error) {
    if (handle !== undefined) {
      try {
        await handle.close();
      } catch {
        // A handle that will not close goes away with the process; a failed cleanup must not cover
        // the original error that is about to be handed out.
      }
    }
    await discardTemp(tmp);
    throw error;
  }
  await discardTemp(tmp);
}

let tempSequence = 0;

function tempName(target: string): string {
  tempSequence += 1;
  const entropy = `${Date.now().toString(36)}-${tempSequence}-${Math.random().toString(36).slice(2, 10)}`;
  return `.${target}.${entropy}.tmp`;
}

/** A rename meeting a process that is reading (a brief standoff on Windows) backs off and retries. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!isBusyPath(error) || attempt >= RETRY_ATTEMPTS) throw error;
      await sleep(RETRY_BASE_MS * attempt);
    }
  }
}

/**
 * Clear a leftover temporary file: the foundation's one removal protocol, in its never-throwing
 * spelling (`fs-helpers.tryUnlinkWithRetry`) — absent counts as cleared, a brief standoff (EPERM,
 * EACCES, EBUSY) backs off and retries, and if it will not clear it is left in place: the original
 * error is the thing to hand out. Leaving a `.<name>.<entropy>.tmp` behind is silent, so it must
 * not be given up on the first busy reading.
 */
async function discardTemp(tmp: string): Promise<void> {
  await tryUnlinkWithRetry(tmp);
}
