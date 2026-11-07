/**
 * The candidate list for the workspace selector at the top of the panel: DSH's own workspace list.
 *
 * Superworker does not care which session DSH currently shows in the center column — all
 * workspaces are openable to it. This layer only reads that list into a snapshot, works out which
 * workspace a session falls into, and hands back an empty list when there is no list. The list
 * itself belongs to DSH's `workspaces` service: no caching, no copying here.
 */
import { serviceAt } from './data.ts'

export interface WorkspaceChoice {
  /** Workspace identity; the dropdown's value is it. */
  readonly workspaceId: string
  /** The workspace's absolute path: the root used when reading records. */
  readonly path: string
  /** The name shown in the dropdown: DSH's own title. */
  readonly title: string
  readonly sessionIds: readonly string[]
}

export interface WorkspaceSnapshot {
  /** Workspaces in DSH's own order. */
  readonly items: readonly WorkspaceChoice[]
}

/**
 * The gateway to DSH's workspace list.
 *
 * Only the two read methods: this layer never writes the list — creating, renaming, and deleting
 * are the business of DSH's own sidebar.
 */
export interface WorkspaceSource {
  getSnapshot(): WorkspaceSnapshot
  subscribe(listener: () => void): () => void
}

/**
 * An empty list.
 *
 * It must be the same object: once `getSnapshot` hands a snapshot to React, an unchanged list has
 * to yield the same reference every time — assembling a fresh one would make React think it keeps
 * changing. Deployments without a workspace list share this one.
 */
const EMPTY: WorkspaceSnapshot = { items: [] }

/** The gateway used when this deployment has no workspace list: the list stays empty and nobody subscribes. */
export const NO_WORKSPACES: WorkspaceSource = {
  getSnapshot: () => EMPTY,
  subscribe: () => () => undefined,
}

/**
 * Take DSH's workspace list from the context.
 *
 * If it cannot be fetched, it cannot be fetched: the panel simply shows no selector and keeps
 * reading the current session's own workspace. This layer does not throw.
 * @param owner - A context (the plugin's own, or the one given to the inject callback).
 */
export function workspacesAt(owner: unknown): WorkspaceSource | undefined {
  const service = serviceAt(owner, 'workspaces')
  const list = service?.list
  if (typeof list !== 'object' || list === null) return undefined
  const held = list as { readonly getSnapshot?: unknown; readonly subscribe?: unknown }
  if (typeof held.getSnapshot !== 'function' || typeof held.subscribe !== 'function') return undefined
  return list as WorkspaceSource
}

/**
 * Which workspace a session falls into.
 *
 * A "bucket" is one of DSH's sidebar groups: if the session's id appears in some workspace's
 * `sessionIds`, it falls into that one; if it appears in none, it is ungrouped — DSH reads it the
 * same way. The name says workspace rather than bucket: "bucket" is the model's word for the state
 * one node sits in (`bucketOf`), and one name for two readings is the collision this rename ends.
 */
export function workspaceOf(
  items: readonly WorkspaceChoice[],
  sessionId: string | undefined,
): WorkspaceChoice | undefined {
  if (sessionId === undefined || sessionId.length === 0) return undefined
  return items.find((item) => item.sessionIds.includes(sessionId))
}
