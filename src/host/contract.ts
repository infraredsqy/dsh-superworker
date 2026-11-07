/**
 * Type contract between the host and the browser half: where the records live
 * and the shape of the reading service.
 *
 * The raw record shapes (field-for-field copies of the four records) and the
 * reading result types are owned by the model layer in `src/model/records.ts`;
 * this module re-exports them and keeps only the path constants and the
 * service shape.
 *
 * Paths are always workspace-relative: the host resolves absolute roots from
 * the session identity, so no machine-specific path appears here.
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SuperworkerReading, RecordSourceKey } from '../model/records.ts'

export type {
  SuperworkerCycle,
  SuperworkerHolding,
  SuperworkerInstruction,
  SuperworkerIssue,
  SuperworkerNode,
  SuperworkerReading,
  SuperworkerSourceState,
  SuperworkerStep,
} from '../model/records.ts'

/** The directory layer holding the records, workspace-relative. */
export const RECORD_DIR = '.superworker'

/** Workspace-relative locations of the four sources; keys match the model layer's source keys ({@link RecordSourceKey}). */
export const RECORD_SOURCES: Readonly<Record<RecordSourceKey, string>> = {
  /** `nodes` of `ideas.json`, keyed by node id. */
  nodes: `${RECORD_DIR}/ideas.json`,
  /** `cycles` of `state.json`, each cycle carrying its own `path`. */
  cycles: `${RECORD_DIR}/state.json`,
  /** `instructions` of `instructions.json`. */
  instructions: `${RECORD_DIR}/instructions.json`,
  /** `issues` of `issues/issues.json`, keyed by issue id. */
  issues: `${RECORD_DIR}/issues/issues.json`,
}

/**
 * The directory layer holding session notes, workspace-relative: one small
 * file per node, named by the node id.
 *
 * Session identity belongs to this machine and does not travel with the
 * records — on a new machine or a fresh clone of the records this directory
 * is absent, and the panel reads those nodes as "no notes on this machine".
 */
export const RECORD_SESSIONS = `${RECORD_DIR}/meta/sessions`

/**
 * The directory layer holding the dispatch cells, workspace-relative:
 * `<launch>/<line>/<node>/`, the cell where the plan's prompt and the
 * dispatch claim (`started`, written by the dispatch itself) live. The claim
 * is what keeps a dispatched cell from being dispatched again — reading
 * which cells carry one is read-only and answers "which rounds are out".
 */
export const RECORD_LAUNCH = `${RECORD_DIR}/meta/launch`

/**
 * The file holding one cell's launch prompt, under the cell's own directory
 * (`<launch>/<line>/<node>/`): the plan's first instruction, read verbatim. Named
 * here so the launch layer's shape is stated in this one module.
 */
export const LAUNCH_PROMPT_FILE = 'prompt.txt'

/** Options that may accompany a read. */
export interface SuperworkerReadOptions {
  readonly signal?: AbortSignal
}

/**
 * The service the host exposes to the browser half: given a session id and a
 * workspace root, it reads that workspace's records into a reading. Missing
 * records yield an empty reading (all four sources `missing`, all collections
 * empty).
 *
 * The workspace root is named by the caller, selecting which workspace to
 * read; an empty string means "not named", in which case it is resolved from
 * the session identity.
 */
export interface SuperworkerRecords {
  /**
   * @param workspaceRoot - The workspace root to read, absolute; an empty string means this session's own root.
   */
  read(sessionId: SessionId, workspaceRoot: string, options?: SuperworkerReadOptions): Promise<SuperworkerReading>
}
