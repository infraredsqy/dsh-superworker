/**
 * Entry of the browser-half plugin: mounts the panel as the service `ctx.pathfinderPanel`, then
 * wires up the settings section, Pathfinder Center's sidebar items, and the center-column cell.
 *
 * Readings arrive through the port; the panel only draws. The panel's own preferences come from
 * settings and are written back to settings.
 */
import * as React from 'react'
import { report } from './context.ts'
import { injectAt } from './context.ts'
import { createPanelPort, serviceAt, type PanelPort } from './data.ts'
import { createLocalePort, LocaleProvider, localeOf, type LocaleService, type LocaleSource } from './locale.ts'
import { currentSessionOf, knownSessionsOf, sessionsSnapshotOf } from './sessions-view.ts'
import { registerSeats, SEAT_WORD } from './mount.ts'
import { PathfinderPanel } from './panel.tsx'
import { createPrefsSource, type PrefsStore } from './prefs.ts'
import { dropSettingsStyle, registerSettingsSection } from './settings.tsx'
import { dropStyle, ensureStyle } from './styles.ts'
import type { WorkspaceSource } from './workspaces.ts'

/** The panel's identity: used as key by the center-column cell and as id by the sidebar row. */
export const PANEL_ID = 'pathfinder'

export const SERVICE_KEY = 'pathfinderPanel'

/**
 * The body of the panel's stylesheet, as the bundle carries it: re-exported so a caller that holds
 * only `lib/client.js` can attach the same sheet the panel ships rather than fetch some other copy.
 */
export { PANEL_CSS } from './styles.ts'

/** The settings section's identity and component, readable off the bundle. */
export {
  SECTION_ORDER,
  SECTION_SLOT,
  SECTION_WORD,
  SETTINGS_CSS,
  SETTINGS_NAMESPACE,
  SettingsSection,
} from './settings.tsx'

/** The identities of the two Pathfinder Center spots, readable off the bundle. */
export { createWorkspaceNav, PANEL_ORDER, SEAT_WORD } from './mount.ts'

/** Why and which session a card opens: the session-list projections, readable off the bundle. */
export { currentSessionOf, knownSessionsOf, sessionsSnapshotOf } from './sessions-view.ts'

/**
 * The language machinery and the bundled tables, readable off the bundle.
 *
 * `FALLBACK_WORD_TABLE` is the source-of-truth table, which is also the one an unattached port
 * serves — so a caller that reads a word off the panel and compares it against this cannot drift
 * from what a deployment without a locale service really draws.
 */
export { createLocalePort, FALLBACK_LOCALE, localeOf, LOCALE_NS, LocaleProvider, useT } from './locale.ts'
export type { LocaleService, LocaleSource, LocaleSnapshot, Translate } from './locale.ts'
export { WORD_TABLES, zh as FALLBACK_WORD_TABLE } from './locales/index.ts'
export { failureWord } from './words.ts'

export { NO_WORKSPACES, workspaceOf, workspacesAt } from './workspaces.ts'
export type { WorkspaceChoice, WorkspaceSnapshot, WorkspaceSource } from './workspaces.ts'

/** Markers of the two injected stylesheets in the document: neither should remain after unmount. */
export { PANEL_STYLE_ID, SETTINGS_STYLE_ID } from './style-tags.ts'

export interface PathfinderPanelApi {
  readonly id: string
  /** The panel's declared name, in the language in force when it is read. */
  readonly title: string
  /** The port for talking to the host: reads the four records, writes archive / restore / delete and the three policy numbers. */
  readonly port: PanelPort
  /** The port the panel uses to read and write settings; the settings page reads it too. */
  readonly prefs: PrefsStore
  /** Where the words come from; the settings section is handed the same one, so both speak one language. */
  readonly locale: LocaleSource
  /** The panel itself, passed directly as the second argument of `slots.register`. */
  readonly Panel: (props: PanelArgs) => React.ReactElement
}

/** What the panel receives: the port is bound at assembly time, sessions are passed in by the seat side. */
export interface PanelArgs {
  readonly port: PanelPort
  readonly sessionId?: string | undefined
  /** Which settings document holds the panel's own preferences; factory defaults apply when absent. */
  readonly prefs?: PrefsStore | undefined
  /** Which language to speak; the bundled fallback applies when absent. */
  readonly locale?: LocaleSource | undefined
  /** Where card clicks go: DSH's navigation gateway. Cards are inert without it. */
  readonly openSession?: ((target: string) => void) | undefined
  /** DSH's workspace list: candidates for the selector at the top of the panel. Nothing is pickable without it. */
  readonly workspaces?: WorkspaceSource | undefined
}

export function apply(ctx: unknown): void {
  const port = createPanelPort(ctx)
  const prefs = createPrefsSource()
  /* DSH owns the language preference — its settings page has the row, it remembers the choice, and
   * it falls back to the browser's language and then to English. This attaches to that rather than
   * inventing a second preference: when the service is absent (an older DSH, a stand-in context)
   * the port keeps serving the bundled table, so the panel still says real words. */
  const locale = createLocalePort()
  injectAt(ctx, ['locale'], 'the locale layer did not attach', (owner) => {
    locale.attach((serviceAt(owner, 'locale') as LocaleService | undefined) ?? null)
  })
  const api: PathfinderPanelApi = {
    id: PANEL_ID,
    /* A getter rather than a captured string: the panel's name is read by whoever asks, which may be
     * after the reader has changed language. The panel and the row it sits on are one object, so
     * both say the same word. */
    get title() {
      return localeOf(locale).t(SEAT_WORD)
    },
    port,
    prefs,
    locale,
    Panel: Entry,
  }
  try {
    const provide = (ctx as { provide?: (key: string, value: unknown) => void } | null | undefined)?.provide
    if (typeof provide === 'function') provide.call(ctx, SERVICE_KEY, api)
  } catch (error) {
    report('the panel seat did not mount', error)
  }
  registerSettingsSection(ctx, prefs, locale)
  /* The two seats' unmount hangs on the `effect` in `mount.ts`: this line only registers them. */
  registerSeats(ctx, api, () => {
    dropStyle()
    dropSettingsStyle()
  })
}

/**
 * The component actually rendered by the seat side.
 *
 * It adds one thing over {@link PathfinderPanel}: the center-column cell sits at the root scope and
 * does not inject `sessionId`, so this layer picks the current one from the `useSessions` snapshot;
 * when the seat passes a `sessionId` itself, that one wins. The same snapshot also yields a roster
 * the panel uses to check whether a record's session exists on this machine.
 */
function Entry(props: PanelArgs & { readonly useSessions?: unknown }): React.ReactElement {
  ensureStyle()
  /* `useSessions` is a real hook: the snapshot is fetched unconditionally; only picking the session falls to `??`. */
  const snapshot = sessionsSnapshotOf(props.useSessions)
  const sessionId = props.sessionId ?? currentSessionOf(snapshot)
  const knownSessions = React.useMemo(() => knownSessionsOf(snapshot), [snapshot])
  /* The provider sits at this root rather than in `apply`: the language has to be readable while a
   * component draws, and this is the one point every pane passes through. The settings section is
   * not in this tree and wraps itself the same way. */
  return React.createElement(
    LocaleProvider,
    { source: props.locale },
    React.createElement(PathfinderPanel, {
      port: props.port,
      sessionId,
      prefs: props.prefs,
      openSession: props.openSession,
      knownSessions,
      workspaces: props.workspaces,
    }),
  )
}