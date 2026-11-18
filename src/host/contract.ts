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
import { RECORD_DIR_NAME } from 'superworker-core'
import type { SuperworkerReading, RecordSourceKey } from '../model/records.ts'
import type { SuperworkerSessionsReading } from './sessions.ts'

export type {
  SuperworkerCycle,
  SuperworkerHolding,
  SuperworkerInstruction,
  SuperworkerIssue,
  SuperworkerNode,
  SuperworkerReading,
  SuperworkerReadingState,
  SuperworkerSourceState,
  SuperworkerStep,
} from '../model/records.ts'

/**
 * The directory layer holding the records, workspace-relative.
 *
 * The name comes from the engine, never respelled here: the engine is the side
 * that lays the directory down and reads it back, and a second spelling on this
 * side would let the panel and the records disagree about where the records
 * are while both sides still compile.
 */
export const RECORD_DIR = RECORD_DIR_NAME

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
 * One push of the panel's reading: what the stream endpoint sends, and the one
 * shape every pane of this plugin draws from.
 *
 * The two halves are the two reads the panel used to make in two calls — the
 * four records, and the session side (notes, dispatch claims, the live roster) —
 * carried together because they are read at one moment and any pane reads across
 * both. One of them being unreadable is a frame that says so (`failure`), never a
 * frame that pretends: a half that could not be read stands `null`, and the panel
 * keeps showing the last reading it had rather than an invented empty one.
 */
export interface SuperworkerFrame {
  /** The absolute workspace root this frame reads. */
  readonly workspaceRoot: string
  /** When the read happened, epoch milliseconds by this host's clock. */
  readonly at: number
  /** The four records' reading; `null` when this pass could not read them. */
  readonly reading: SuperworkerReading | null
  /** The records' session side; `null` on the same terms as {@link reading}. */
  readonly sessions: SuperworkerSessionsReading | null
  /** Why the halves are `null`, when they are: a code, and whatever the far side said as the detail. */
  readonly failure?: { readonly code: string; readonly detail?: string }
}

/**
 * The service the host exposes to the browser half: given a session id and a
 * workspace root, it reads that workspace's records into a reading. Missing
 * records yield an empty reading (all four sources `missing`, all collections
 * empty). A workspace whose records sit only in the older layer yields the
 * `legacy` reading instead — all four sources `legacy`, all collections empty,
 * and no old file read to produce them.
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
