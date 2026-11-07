/**
 * The panel's language port: where the reader's language comes from, and how a component asks for
 * one word.
 *
 * DSH already owns the language preference — its settings page has a Language row, it remembers the
 * choice in the Host's user-settings document, and it falls back to the browser's own language and
 * then to English. A plugin does not need a second mechanism for any of that: it registers its
 * dictionaries under a namespace and binds a translate function. So this file registers the panel's
 * lookup tables with `ctx.locale` and binds through it when that service is there, and serves the
 * bundled fallback table when it is not.
 *
 * The fallback is not a stub. Deployments without the locale service (an older DSH, a test harness,
 * a stand-alone panel) get Chinese, read straight from the bundled table. That keeps every word on
 * the panel defined in every deployment — a missing service degrades the feature, never the copy.
 *
 * The port stands on the same store skeleton as `prefs.ts` (`store.ts`): a snapshot that only
 * changes identity when something truly changed, a `subscribe`, and a module-level default so a
 * component is readable before anything attached. What is this port's own is the folding (which
 * language is in force, and which translator reads it). This file stays `.ts` and builds its
 * components with `React.createElement`: Node loads `.ts` directly for the unit tests and rejects
 * `.tsx`, and this module is on the import path of the files those tests do load.
 */
import * as React from 'react'
import { WORD_TABLES, zh, type WordKey } from './locales/index.ts'
import { createStore } from './store.ts'

/**
 * The namespace this panel's lookup tables register under in DSH's locale service.
 *
 * It names the feature and nothing else; DSH keys its dictionary registry by it. Distinct from the
 * settings namespace (`SETTINGS_NAMESPACE`), which is a different registry in a different service —
 * the two are allowed to share a word without colliding.
 */
export const LOCALE_NS = 'superworker'

/**
 * The language the panel speaks when nothing tells it otherwise.
 *
 * Chinese, the bundled table's own language: a deployment with no locale service still draws real
 * words.
 */
export const FALLBACK_LOCALE = 'zh'

/** The values a `{name}` placeholder can take. */
export type WordParams = Readonly<Record<string, string | number>>

/**
 * Ask for one word.
 *
 * A key is a compile-time name, so a typo is an error rather than a blank spot on the screen. The
 * placeholders a key names are substituted from `params`; a placeholder with no matching value is
 * left standing, which is visible on the spot instead of failing silently.
 */
export type Translate = (key: WordKey, params?: WordParams) => string

/** The reading a component consumes: which language is in force, and how to say a word in it. */
export interface LocaleSnapshot {
  /** Which lookup table is in force, by locale id; `FALLBACK_LOCALE` until a service says otherwise. */
  readonly active: string
  /** Advanced on every locale change; the identity of this snapshot rides it, so components redraw. */
  readonly revision: number
  /** Reads the active language at call time, so a stale snapshot can never serve a stale word. */
  readonly t: Translate
}

export interface LocaleSource {
  subscribe(listener: () => void): () => void
  getSnapshot(): LocaleSnapshot
}

/**
 * The part of DSH's locale service this layer uses: register dictionaries, bind a translator,
 * subscribe to changes, and read which language is active.
 *
 * Every method is optional-by-probe at the call site. Only `register` and `bind` are load-bearing —
 * a service missing the two reads still translates; the panel just cannot tell which language it
 * is in, and redraws on the service's own notification instead.
 */
export interface LocaleService {
  register(ns: string, locale: string, dict: Readonly<Record<string, string>>): unknown
  bind(ns: string): (key: string, params?: WordParams) => string
  subscribe?: (listener: () => void) => unknown
  /** DSH's own snapshot; `active`/`revision` names are the service's, not this file's. */
  getSnapshot?: () => { readonly active?: unknown; readonly revision?: unknown }
  getLocale?: () => { readonly active?: unknown; readonly revision?: unknown }
}

export interface LocalePort extends LocaleSource {
  /** Attach (or swap out) DSH's locale service; `null` takes it away and returns to the fallback. */
  attach(service: LocaleService | null): () => void
}

/** Substitute `{name}` placeholders; a name with no value is left as it stands, which is visible. */
function interpolate(template: string, params: WordParams | undefined): string {
  if (params === undefined) return template
  return template.replace(/\{([A-Za-z0-9_]+)\}/gu, (whole: string, name: string) => {
    const value = params[name]
    return value === undefined ? whole : String(value)
  })
}

/**
 * A translator reading straight from the bundled lookup tables.
 *
 * Used before any service attaches and whenever none does. A key the active table is missing
 * falls back to the source-of-truth table and only then to the key itself — a deployment
 * cannot end up drawing a bare `notes.add` on a button.
 */
function bundledAt(locale: string): Translate {
  return (key, params) => interpolate(WORD_TABLES[locale]?.[key] ?? zh[key] ?? key, params)
}

/**
 * The port itself.
 *
 * It stands first on the bundled fallback and stays usable whether or not a service ever arrives.
 */
export function createLocalePort(): LocalePort {
  let off: (() => void) | null = null
  let service: LocaleService | null = null
  let bound: Translate | null = null
  let active = FALLBACK_LOCALE
  let revision = 0
  /** What the attached service said last time, so a notification that changed nothing is not relayed. */
  let lastActive: string = FALLBACK_LOCALE
  let lastRevision: unknown = undefined
  const store = createStore<LocaleSnapshot>(Object.freeze({ active, revision, t: bundledAt(active) }))

  /**
   * Rebuild the reading and tell subscribers, but only when it truly changed.
   *
   * The snapshot's identity is what `useSyncExternalStore` compares, so fabricating a fresh object
   * on every read would redraw the panel forever; the revision is the one thing that is allowed to
   * make it new.
   */
  const publish = (nextActive: string, nextT: Translate, changed: boolean): void => {
    if (!changed && nextActive === active && nextT === store.getSnapshot().t) return
    active = nextActive
    revision += 1
    store.put(Object.freeze({ active, revision, t: nextT }))
  }

  /**
   * Read which language the attached service is in, and how far its registry has moved.
   *
   * The service spells that fact in two ways (`getSnapshot` / `getLocale`); both are probed because
   * this layer is attached to a service it does not own. The registry's own revision is carried back
   * so a notification that changed nothing does not wake every component for nothing — DSH bumps it
   * when a lookup table arrives late, and that IS worth a redraw.
   */
  const stateOf = (held: LocaleService): { readonly active: string; readonly revision: unknown } => {
    try {
      const read = held.getSnapshot?.() ?? held.getLocale?.()
      const said = read?.active
      return {
        active: typeof said === 'string' && said.length > 0 ? said : FALLBACK_LOCALE,
        revision: read?.revision,
      }
    } catch (error) {
      /* A service that cannot be read is treated as saying nothing; the fallback still speaks. */
      return { active: FALLBACK_LOCALE, revision: undefined }
    }
  }

  const detach = (): void => {
    const held = off
    off = null
    service = null
    bound = null
    if (held === null) return
    try {
      held()
    } catch (error) {
      /* If it cannot be detached, let it go: the reading falls back to the bundled copy anyway. */
    }
  }

  /** Take whatever the service now says: which language, and the translator that reads it live. */
  const refresh = (): void => {
    const held = service
    if (held === null) {
      publish(FALLBACK_LOCALE, bundledAt(FALLBACK_LOCALE), true)
      return
    }
    const now = stateOf(held)
    /* The bound translator carries no language of its own: it resolves per call, so one reference
     * serves every language and the revision is what tells components to ask again. */
    const translator = bound ?? bundledAt(now.active)
    /* A notification that moved neither the language nor the service's own registry is not news:
     * republishing would churn every subscriber for nothing. */
    const moved = now.active !== lastActive || now.revision !== lastRevision
    lastActive = now.active
    lastRevision = now.revision
    publish(now.active, translator, moved)
  }

  return {
    getSnapshot: store.getSnapshot,
    subscribe: store.subscribe,
    attach(next) {
      detach()
      if (next === null) {
        publish(FALLBACK_LOCALE, bundledAt(FALLBACK_LOCALE), true)
        return () => undefined
      }
      service = next
      /* Register every shipped table. One namespace has a single occupant, so a namespace that
       * a previous load already registered refuses the second call — that refusal is not a reason to
       * give up translating: the tables are the same ones, and `bind` then reads them. */
      for (const [locale, dict] of Object.entries(WORD_TABLES)) {
        try {
          next.register(LOCALE_NS, locale, dict)
        } catch (error) {
          /* Already registered by an earlier load of this same panel: the words are there. */
        }
      }
      try {
        bound = ((key, params) => next.bind(LOCALE_NS)(key, params)) as Translate
      } catch (error) {
        /* A service that cannot bind is no better than none: the bundled table takes over. */
        bound = null
      }
      try {
        const subscribe = next.subscribe
        off = typeof subscribe === 'function'
          ? (() => {
            const held = subscribe.call(next, refresh)
            return typeof held === 'function' ? (held as () => void) : () => undefined
          })()
          : null
      } catch (error) {
        off = null
      }
      /* A fresh attachment is news whatever it says: the previous reading belonged to another
       * service, so the comparison below starts from this one's state. */
      const fresh = stateOf(next)
      lastActive = fresh.active
      lastRevision = fresh.revision
      publish(fresh.active, bound ?? bundledAt(fresh.active), true)
      return () => {
        if (service !== next) return
        detach()
        /* Detaching is not the end of the story: this port keeps serving the panel, so it must fall
         * back to the bundled table and say so, or the snapshot would go on reporting a
         * language nobody is answering for any more. */
        lastActive = FALLBACK_LOCALE
        lastRevision = undefined
        publish(FALLBACK_LOCALE, bundledAt(FALLBACK_LOCALE), true)
      }
    },
  }
}

/**
 * What a component reads when nothing was handed to it: the bundled fallback, never a service.
 *
 * A component must be drawable before anything attached — the panel's first frame arrives before
 * the locale service does — and this is what makes that frame say real words.
 */
export const DEFAULT_LOCALE_SOURCE: LocaleSource = createLocalePort()

/**
 * Where a subtree's language comes from.
 *
 * Two roots need it (the panel cell and the settings section) and they are not in one another's
 * tree, so the port is passed down by context rather than carried through every pane's props: the
 * alternative is threading a translator through a dozen components that do not care where it came
 * from. A test hands in its own source here, which is how a language switch becomes assertable.
 */
const LocaleContext = React.createContext<LocaleSource>(DEFAULT_LOCALE_SOURCE)

export function LocaleProvider(props: {
  readonly source?: LocaleSource | undefined
  readonly children?: React.ReactNode
}): React.ReactElement {
  return React.createElement(
    LocaleContext.Provider,
    { value: props.source ?? DEFAULT_LOCALE_SOURCE },
    props.children,
  )
}

/**
 * The translator for the component calling it.
 *
 * Every caller subscribes, so the components that print words are exactly the components that
 * redraw when the language changes — the port's snapshot keeps its identity between changes, so
 * nothing else re-renders for it.
 */
export function useT(): Translate {
  const source = React.useContext(LocaleContext)
  return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot).t
}

/** The whole reading, for the few places that must know which language is in force. */
export function useLocale(): LocaleSnapshot {
  const source = React.useContext(LocaleContext)
  return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot)
}

/** The same reading, outside a component: for assembly code and the unit tests. */
export function localeOf(source: LocaleSource): LocaleSnapshot {
  return source.getSnapshot()
}