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
export type ViewId = 'map' | 'detail' | 'notes' | 'issue' | 'config'

/**
 * The names of the fields in this section: the host schema's keys, the paths
 * of the write-back `set` calls, and the keys the browser half reads back are
 * all the same string, so it is written only here.
 */
export const PANEL_PREF_FIELDS = {
  sideWidth: 'sideWidth',
  defaultTab: 'defaultTab',
  showArchived: 'showArchived',
  showOtherStates: 'showOtherStates',
  autoRelay: 'autoRelay',
  injectInstructions: 'injectInstructions',
} as const

/** Lower bound of the wire column width on the detail's left. */
export const SIDE_MIN = 120

export const SIDE_MAX = 320

/** The width before any dragging. */
export const SIDE_DEFAULT = 176

/** The five views, ordered as the row of tabs. */
export const VIEW_IDS: readonly ViewId[] = ['map', 'detail', 'notes', 'issue', 'config']

/**
 * The shape before anything has been recorded.
 *
 * Two fields have no row in the settings page. The sidebar width is a
 * dragged value; the tab is the view the panel was last left on, which the
 * panel writes back on every switch — a row for it would read as a default and
 * then be overwritten by the next click. Both still live in this document, so
 * both still get a factory default here.
 *
 * The relay switch defaults to on: whether a round is opened by hand or by
 * the relay should not depend on a row nobody has touched. The injection
 * switch defaults to on for the same reason — a workspace that holds standing
 * constraints carries them without anyone visiting the settings page first,
 * and the row is there for the one who wants silence.
 */
export const PANEL_PREF_DEFAULTS = {
  sideWidth: SIDE_DEFAULT,
  defaultTab: 'map',
  showArchived: false,
  showOtherStates: false,
  autoRelay: true,
  injectInstructions: true,
} as const