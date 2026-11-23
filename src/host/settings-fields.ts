/**
 * The field surface of the panel's own preferences section in the settings
 * document: field names, factory defaults, and a few value sets.
 *
 * Both sides read this file (the host builds `Config` from it, the browser
 * reads and writes the settings document by it), so the factory defaults are
 * written exactly once. The namespace is decided by the profile line, not
 * here.
 */

/** Ids of the five views; a tab element is `tab-<id>` and its pane `pane-<id>`. */
export type ViewId = 'overview' | 'nodes' | 'notes' | 'issue' | 'config'

/**
 * The two ways the node page can be drawn: the map, and the list.
 *
 * One page, two projections of one reading — which cells are in scope — and the reader picks the
 * one they want to read. It is remembered for the same reason the tab is: it is where the reader
 * was, not a choice to offer.
 */
export type NodeMode = 'map' | 'detail'

/** The two readings of the node page, ordered as the segmented control. */
export const NODE_MODES: readonly NodeMode[] = ['map', 'detail']

/**
 * The two ways the overview's stage can be drawn: the feed whole, or one line per step.
 *
 * One reading, two drawings — the same arrangement the node page already has, and for the same
 * reason: how far a reader wants to be from the detail is where they were, not a choice to offer.
 * `full` draws every row the conversation wrote; `brief` folds each run of work into one line that
 * says what it was (see `src/model/brief.ts`). The words are DSH's own two for its transcript.
 */
export type OverviewMode = 'full' | 'brief'

/** The two drawings of the overview's stage, ordered as the segmented control. */
export const OVERVIEW_MODES: readonly OverviewMode[] = ['full', 'brief']

/**
 * The names of the fields in this section: the host schema's keys, the paths
 * of the write-back `set` calls, and the keys the browser half reads back are
 * all the same string, so it is written only here.
 */
export const PANEL_PREF_FIELDS = {
  lastTab: 'lastTab',
  nodeMode: 'nodeMode',
  overviewMode: 'overviewMode',
  showArchived: 'showArchived',
  showOtherStates: 'showOtherStates',
  autoRelay: 'autoRelay',
  injectInstructions: 'injectInstructions',
} as const

/** The five views, ordered as the row of tabs. */
export const VIEW_IDS: readonly ViewId[] = ['overview', 'nodes', 'notes', 'issue', 'config']

/**
 * The shape before anything has been recorded.
 *
 * Two fields have no row in the settings page. `lastTab` is the view the panel
 * was last left on, which the panel writes back on every switch — it is the
 * panel's memory of where it was, not a choice to offer (a row for it would be
 * overwritten by the next click anyway), and `nodeMode` is the same memory for
 * the node page's two drawings. Both still live in this document, so both still
 * get a factory default here.
 *
 * The relay switch defaults to on: whether a round is opened by hand or by
 * the relay should not depend on a row nobody has touched. The injection
 * switch defaults to on for the same reason — a workspace that holds standing
 * constraints carries them without anyone visiting the settings page first,
 * and the row is there for the one who wants silence.
 */
export const PANEL_PREF_DEFAULTS = {
  lastTab: 'overview',
  /* The map: it is the page's signature drawing, and the one that answers "where does this line
   * stand" without being read row by row. */
  nodeMode: 'map',
  /* The feed whole: the stage opens on what actually happened, and the concise drawing is the one a
   * reader asks for after finding the full one too much — never the drawing they are given first. */
  overviewMode: 'full',
  showArchived: false,
  showOtherStates: false,
  autoRelay: true,
  injectInstructions: true,
} as const