import { nowMicro, nowSeconds } from '../clock.ts';
import { readGraphSnapshot } from '../graph.ts';
import {
  EOL,
  atomicWriteBytes,
  atomicWriteJson,
  jsonBytes,
  readJsonFile,
  type JsonBytesOptions,
  type JsonRead,
} from '../jsonio.ts';
import { withRecordLock, type RecordLockOptions } from '../ledgerlock.ts';
import { recordPaths } from '../paths.ts';
import type { NodeRecord } from '../types.ts';
import {
  createVerbSurface,
  type VerbSurface,
  type VerbSurfaceTables,
} from './verb-surface.ts';

/**
 * The record base a plugin's own layer takes its mechanics from, handed in on the host context
 * (`ctx.base`): the byte format of a record on disk, the atomic landing, the reader with its three
 * readings, the cross-process record lock with its in-process queue, the two timestamp spellings,
 * the one-copy mechanics of a command surface, and — for a plugin whose word acts on the graph — the
 * node table as the engine itself reads it. The engine owns this foundation once —
 * `src/jsonio.ts`, `src/ledgerlock.ts`, `src/clock.ts`, `src/plugins/verb-surface.ts`, and the one
 * reading of `ideas.json` in `src/graph.ts` — and a plugin's storage keeps only what belongs to its
 * own record: its landing path, its vocabulary, and the read and write of its own fields. Nothing
 * here is reachable by a plugin in any other way: a plugin folder is loaded by path and imports
 * nothing from the engine, so every one of these capabilities travels through the context the host
 * assembles (`src/plugins/context.ts`).
 *
 * The object is stateless — every cell is a plain function over the engine's own modules — so one
 * shared instance serves every context, real or rehearsal, without one round seeing another.
 */

/** The capabilities the host context hands a plugin's own record layer and command surface. */
export interface PluginBase {
  /** The platform line ending; only text a person reads follows the platform, a record on disk is LF everywhere. */
  readonly EOL: string;
  /** The microsecond-shape timestamp of now (UTC with a literal `Z`), strictly increasing within the process. */
  nowMicro(): string;
  /** The seconds-shape timestamp of now (the shape lines, tickets and session files use). */
  nowSeconds(): string;
  /** The bytes of one record on disk: two-space indent, non-ASCII as it is, LF on every platform, no trailing newline; deep key sort on the option. */
  jsonBytes(value: unknown, options?: JsonBytesOptions): Uint8Array;
  /** Read one record: present or missing; unparsable bytes throw a `RecordError` (`invalid_utf8` / `parse_failure`), never repaired automatically. */
  readJson(path: string, label?: string): Promise<JsonRead>;
  /**
   * The node table of the graph at one project root, as the engine reads it: the same reading every
   * graph verb asks (`graph.readNodeTable`), so what a bad document answers and which cells count as
   * nodes are not re-decided here. A plugin whose word acts on the graph takes the table from this
   * cell; it never reads `ideas.json` itself and keeps no tolerance of its own.
   */
  readGraph(root: string): Promise<{ readonly nodes: Readonly<Record<string, NodeRecord>> }>;
  /** Land a block of bytes onto a path as a whole: a temp file in the target's own directory, fsynced, renamed into place. */
  atomicWrite(path: string, bytes: Uint8Array): Promise<void>;
  /** Land one JSON record: the bytes of `jsonBytes` through the atomic landing. */
  writeJson(path: string, value: unknown, options?: JsonBytesOptions): Promise<void>;
  /**
   * Hold one record lock through one "read → change → write", under the path the caller names:
   * the in-process queue serializes same-path callers, the cross-process mutex is the exclusive
   * creation of an empty file (50 ms probe, 10 s limit), and the timeout throws the decidable
   * `lock_timeout` naming the path. One record, one lock — the record's owner names the path.
   */
  withLock<T>(lockPath: string, body: () => Promise<T>, options?: RecordLockOptions): Promise<T>;
  /** Assemble one command surface from a plugin's own tables: parsing, usage, refusals and writing-verb locking are this engine's one copy. */
  verbSurface<C>(tables: VerbSurfaceTables<C>): VerbSurface<C>;
}

/** The one spelling of the base, shared by every context: stateless cells over the engine's own modules. */
export function pluginBase(): PluginBase {
  const base: PluginBase = {
    EOL,
    nowMicro: () => nowMicro(),
    nowSeconds: () => nowSeconds(),
    jsonBytes: (value, options) => jsonBytes(value, options),
    readJson: (path, label) => readJsonFile(path, label),
    readGraph: (root) => readGraphSnapshot(recordPaths(root)),
    atomicWrite: (path, bytes) => atomicWriteBytes(path, bytes),
    writeJson: (path, value, options) => atomicWriteJson(path, value, options),
    withLock: (lockPath, body, options) => withRecordLock(lockPath, body, options),
    verbSurface: <C,>(tables: VerbSurfaceTables<C>): VerbSurface<C> => createVerbSurface(tables),
  };
  return Object.freeze(base);
}
