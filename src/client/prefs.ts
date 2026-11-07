/**
 * The panel's own preferences: the layer between a settings document and the few values the panel
 * reads.
 *
 * Everything the panel remembers lives in the Host's settings document (schema in
 * `src/host/config.ts`). This file reads that section into the values the panel wants and writes a
 * change as the single atomic action the settings service accepts. A bad read is treated the same
 * as no record: the panel stands on the factory defaults.
 */
import type { WordKey } from './locales/index.ts'
import { createStore } from './store.ts'
import {
  PANEL_PREF_DEFAULTS,
  PANEL_PREF_FIELDS,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_IDS,
} from '../host/settings-fields.ts'
import type { ViewId } from '../host/settings-fields.ts'

export type { ViewId }
export { PANEL_PREF_DEFAULTS, PANEL_PREF_FIELDS, SIDE_DEFAULT, SIDE_MAX, SIDE_MIN, VIEW_IDS }

/** Which settings-document field the panel writes back to; the names are the document's keys. */
export type PrefField = (typeof PANEL_PREF_FIELDS)[keyof typeof PANEL_PREF_FIELDS]

/** What each of the five views is called, as a key rather than as a word: both the settings row and
 * the tab row render it through the same translator, so the two cannot drift apart, and the word
 * itself can change language without either of them knowing. */
export const VIEW_WORDS: Readonly<Record<ViewId, WordKey>> = {
  map: 'view.map',
  detail: 'view.detail',
  notes: 'view.notes',
  issue: 'view.issue',
  config: 'view.config',
}

export interface PanelPrefs {
  /** Width of the line sidebar on the left of the detail view, in pixels. */
  readonly sideWidth: number
  /** Which view the panel lands on when shown. */
  readonly tab: ViewId
  /** Whether the instructions view folds archived entries back into their sections. */
  readonly archived: boolean
  /** Whether the issues view also puts the three handled states back on the page. */
  readonly otherStates: boolean
  /** Whether the host opens the next round itself after a session settles and the plan says dispatch. */
  readonly autoRelay: boolean
}

export const DEFAULT_PREFS: PanelPrefs = {
  sideWidth: PANEL_PREF_DEFAULTS.sideWidth,
  tab: 'map',
  archived: false,
  otherStates: false,
  autoRelay: PANEL_PREF_DEFAULTS.autoRelay,
}

export function clampSide(px: number): number {
  return Math.round(Math.max(SIDE_MIN, Math.min(SIDE_MAX, px)))
}

/**
 * Read this section of the settings document into the values the panel wants.
 *
 * A field that cannot be understood falls back to the factory default on its own; the rest read as
 * usual. The settings document is written elsewhere: it may hold words left by older versions, or
 * nothing at all.
 * @param section - The section; its shape is not guaranteed.
 */
export function prefsFromSection(section: unknown): PanelPrefs {
  const held = (typeof section === 'object' && section !== null ? section : {}) as Readonly<Record<string, unknown>>
  const width = held[PANEL_PREF_FIELDS.sideWidth]
  const tab = held[PANEL_PREF_FIELDS.defaultTab]
  const relay = held[PANEL_PREF_FIELDS.autoRelay]
  return {
    sideWidth: typeof width === 'number' && Number.isFinite(width) ? clampSide(width) : DEFAULT_PREFS.sideWidth,
    tab: VIEW_IDS.includes(tab as ViewId) ? (tab as ViewId) : DEFAULT_PREFS.tab,
    archived: held[PANEL_PREF_FIELDS.showArchived] === true,
    otherStates: held[PANEL_PREF_FIELDS.showOtherStates] === true,
    autoRelay: typeof relay === 'boolean' ? relay : DEFAULT_PREFS.autoRelay,
  }
}

/** The single atomic action the settings service accepts: one `set` on a top-level path. */
export interface PrefsWriteOp {
  readonly op: 'set'
  readonly path: readonly string[]
  readonly value: unknown
}

/**
 * Write one change as the atomic action the settings service accepts.
 *
 * The path has a single segment, because all four fields in this section sit at the top level —
 * the settings service decides by path whether a field is accepted, and one segment more or less
 * lands nowhere.
 */
export function prefsWriteOp(field: PrefField, value: unknown): PrefsWriteOp {
  return { op: 'set', path: [field], value }
}

/** The reading of this section of a settings document; this is the shape the settings form hands over. */
export interface PrefsFormSnapshot {
  /** `loading` / `ready` / `unavailable`, the settings form's own words. */
  readonly status?: string | undefined
  readonly value?: unknown
  /** The namespace's revision number: carried along on write as the credential. */
  readonly revision?: number | undefined
  readonly writable?: boolean | undefined
}

export interface PrefsForm {
  getSnapshot(): PrefsFormSnapshot
  subscribe(listener: () => void): () => void
  mutate(ops: readonly PrefsWriteOp[], revision?: number): Promise<boolean>
}

/**
 * The reading the panel consumes.
 *
 * `prefs` only becomes a new object when a value truly changed: `useSyncExternalStore` compares it
 * against the previous one, and if every read fabricated a fresh object the panel would redraw
 * forever.
 */
export interface PrefsSnapshot {
  readonly prefs: PanelPrefs
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly revision: number | undefined
  readonly writable: boolean
  /**
   * Whether the last write this panel made was refused and did not land; back to `false` after a
   * successful write, or once the form is taken away.
   *
   * A rejected settings form only returns `false` and swallows the reason — and the panel's
   * `void store.write(…)` call sites drop that `false` too, so the control silently snaps back.
   * This field is the road that forbids that silence. It is a fact rather than a sentence: which
   * words say it is the panel's business, because the language is the reader's.
   *
   * Swapping one form for another keeps it: no write landed in between, so the reader still has not
   * seen that change saved, and the new form's reading says nothing about it.
   */
  readonly refused: boolean
}

export interface PrefsSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): PrefsSnapshot
  /** Hand one change over; gives `false` when no settings service sits on this port, never throws. */
  write(field: PrefField, value: unknown): Promise<boolean>
}

/** Attachable once the settings service arrives: the panel has a readable port from the first frame. */
export interface PrefsStore extends PrefsSource {
  /** Attach (or swap out) the settings form; `null` means this one is taken away. */
  attach(form: PrefsForm | null): () => void
}

const UNAVAILABLE: PrefsSnapshot = Object.freeze({
  prefs: DEFAULT_PREFS,
  status: 'unavailable',
  revision: undefined,
  writable: false,
  refused: false,
})

/** Whether two readings say the same thing: values compared item by item, the rest as-is. */
function sameSnapshot(left: PrefsSnapshot, right: PrefsSnapshot): boolean {
  return left.status === right.status
    && left.revision === right.revision
    && left.writable === right.writable
    && left.refused === right.refused
    && samePrefs(left.prefs, right.prefs)
}

/** Whether the panel's values say the same thing: item by item, object identity not consulted. */
function samePrefs(left: PanelPrefs, right: PanelPrefs): boolean {
  return left.sideWidth === right.sideWidth
    && left.tab === right.tab
    && left.archived === right.archived
    && left.otherStates === right.otherStates
    && left.autoRelay === right.autoRelay
}

/**
 * The port itself.
 *
 * It stands first (on the factory defaults) and mounts once the settings service arrives: the panel
 * need not wait for anyone to start drawing, and the moment settings arrive, subscribers get a
 * fresh reading on the spot.
 */
export function createPrefsSource(): PrefsStore {
  const store = createStore<PrefsSnapshot>(UNAVAILABLE, sameSnapshot)
  let form: PrefsForm | null = null
  let off: (() => void) | null = null

  /** Mark whether the last write landed; a successful write or a form swap takes it back. */
  const setRefused = (refused: boolean): void => {
    if (store.getSnapshot().refused === refused) return
    store.put({ ...store.getSnapshot(), refused })
  }

  /** Fold the form's current reading into this port's reading; leave subscribers alone when nothing changed. */
  const derive = (): void => {
    let next = UNAVAILABLE
    if (form !== null) {
      try {
        const held = form.getSnapshot()
        next = {
          prefs: prefsFromSection(held.value),
          status: held.status === 'ready' ? 'ready' : held.status === 'loading' ? 'loading' : 'unavailable',
          revision: typeof held.revision === 'number' ? held.revision : undefined,
          writable: held.writable === true,
          /* This fold reads the document itself, so "the last write did not land" stays until a write truly succeeds. */
          refused: store.getSnapshot().refused,
        }
      } catch (error) {
        next = UNAVAILABLE
      }
    }
    store.put(next)
  }

  const detach = (): void => {
    const held = off
    off = null
    form = null
    if (held === null) return
    try {
      held()
    } catch (error) {
      /* If it cannot be detached, let it go: the reading has already fallen back to the factory copy. */
    }
  }

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    attach(next) {
      detach()
      if (next === null) {
        derive()
        return () => undefined
      }
      form = next
      try {
        off = next.subscribe(derive)
      } catch (error) {
        off = null
      }
      derive()
      return () => {
        if (form === next) detach()
      }
    },
    write(field, value) {
      const held = form
      if (held === null) return Promise.resolve(false)
      const ops = [prefsWriteOp(field, value)]
      /** This write's final outcome: on success take the "did not land" mark back, if both attempts fail put it up. */
      const settle = (accepted: boolean): boolean => {
        setRefused(!accepted)
        return accepted
      }
      /** The retry after a refusal: drop the revision fence and let the controller take the latest one itself. */
      const again = (): Promise<boolean> => {
        try {
          return Promise.resolve(held.mutate(ops)).then(
            (accepted) => settle(accepted === true),
            () => settle(false),
          )
        } catch (error) {
          return Promise.resolve(settle(false))
        }
      }
      try {
        /* The first attempt carries the revision read earlier. A second write in the same round trip
         * still sees the pre-landing number, so the host refuses it on that fence; drop the fence and
         * go again. If this attempt is refused too, `settle` puts the sentence into the reading. */
        return Promise.resolve(held.mutate(ops, store.getSnapshot().revision)).then(
          (accepted) => (accepted === true ? settle(true) : again()),
          () => again(),
        )
      } catch (error) {
        return again()
      }
    },
  }
}

/** What the panel reads while the settings service has never arrived: factory defaults, all writes refused. */
export const DEFAULT_SOURCE: PrefsSource = createPrefsSource()