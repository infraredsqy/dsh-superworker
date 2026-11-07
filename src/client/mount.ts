/**
 * The mount points of Superworker in DSH's own two spots: an item in the sidebar's panel
 * icon column, and the center-column cell.
 *
 * Both slots are already declared by others (the seats are declared at runtime by ui-layout /
 * ui-sidebar), and registering into an undeclared slot throws straight at load time, so everything
 * goes through `slots.inject('<slot>', …)` — it waits for the declaration, regardless of which of
 * the two plugins loads first.
 *
 * What stands here is assembly only: the session-switching move, the workspace list's forwarding,
 * the row's own icon, and the two registrations. Reading the session-list snapshot is a pure
 * projection and lives in `sessions-view.ts`, so a test of it stands no slot registry up.
 *
 * This file deliberately stays `.ts` with components written via `React.createElement`: Node
 * loading `.tsx` directly dies with `ERR_UNKNOWN_FILE_EXTENSION` and unit tests could not come in —
 * and the registration and the session identity here are exactly what the unit tests must lock
 * down.
 */
import * as React from 'react'
import type { SuperworkerPanelApi } from './index.ts'
import { injectAt, report, serveOn, type SlotsService } from './context.ts'
import { serviceAt } from './data.ts'
import { localeOf, LOCALE_NS } from './locale.ts'
import type { WordKey } from './locales/index.ts'
import { createStore } from './store.ts'
import { NO_WORKSPACES, workspacesAt, type WorkspaceSnapshot, type WorkspaceSource } from './workspaces.ts'

/** The sidebar row's position: "plugins" is 0, "schedule" is 10; this tier sits right below plugins. */
export const PANEL_ORDER = 1

/**
 * The word on that sidebar row.
 *
 * A key rather than the word: the row carries the panel's own name — the wordmark over the panel is
 * the product's English name, the package and repo stay `dsh-superworker` — and which language says
 * it is the reader's business. The row is registered with a `label` FUNCTION, which DSH calls while
 * drawing, so the word is looked up on every frame and a language switch needs no re-registration.
 */
export const SEAT_WORD: WordKey = 'seat.label'

interface NavigationFace {
  readonly openSession?: (target: string) => void
}

export interface SessionNav {
  open(target: string): void
}

/**
 * The session-switching move: a thin shell over DSH's ready-made navigation gateway
 * (`ctx.uiWorkspace.openSession`).
 *
 * That gateway only switches; it draws no conclusion — whether the record's session is on this
 * machine is worked out by the panel against the session list itself. When it arrives later than
 * this layer (plugin mounted first, workspace layer later) it does nothing at first and re-checks
 * once it arrives; each of the two places is fetched only once.
 * @param ctx - The browser-half plugin context.
 */
export function createSessionNav(ctx: unknown): SessionNav {
  let face: NavigationFace | undefined
  const take = (owner: unknown): void => {
    const found = serviceAt(owner, 'uiWorkspace')
    /* What was fetched is a proxy: whether that hand is written correctly can only be asked at this moment. */
    if (found !== undefined && typeof found.openSession === 'function') face = found as NavigationFace
  }
  take(ctx)
  if (face === undefined) injectAt(ctx, ['uiWorkspace'], 'the navigation seam did not attach', take)
  return {
    open(target) {
      if (face === undefined) return
      try {
        face.openSession?.(target)
      } catch (error) {
        report('switching session did not go through', error)
      }
    },
  }
}

/**
 * The list the workspace selector at the top wants: the read-only gateway on DSH's `workspaces`
 * service.
 *
 * Written the same way as the session-switching move, with one more layer of forwarding: when that
 * service arrives later than this layer, the top of the panel still shows no control and re-checks
 * once it arrives. The forwarding is necessary — after `getSnapshot` is handed to React it must
 * return the same object every time (while the list is unchanged), so an empty list cannot be
 * assembled on the fly; there has to be one stable empty snapshot. And when the list changes hands,
 * a shout must go out so the panel redraws.
 * @param ctx - The browser-half plugin context.
 */
export function createWorkspaceNav(ctx: unknown): WorkspaceSource {
  let face: WorkspaceSource | undefined
  let stopFace: (() => void) | undefined
  /* The same store skeleton the panel's own ports stand on (`store.ts`): the forwarding only differs
     in what it holds — the list currently in hand, replaced when the service changes hands. With no
     listeners the upstream join is not taken, so after the panel unmounts this layer does not keep
     someone else's subscription hanging. */
  const store = createStore<WorkspaceSnapshot>(NO_WORKSPACES.getSnapshot())
  const sync = (): void => {
    store.put(face?.getSnapshot() ?? NO_WORKSPACES.getSnapshot())
  }
  const adopt = (found: WorkspaceSource | undefined): void => {
    if (found === undefined || found === face) return
    stopFace?.()
    stopFace = undefined
    face = found
    if (store.watching > 0) stopFace = found.subscribe(sync)
    sync()
  }
  adopt(workspacesAt(ctx))
  if (face === undefined) {
    injectAt(ctx, ['workspaces'], 'the workspace list did not attach', (owner) => { adopt(workspacesAt(owner)) })
  }
  return {
    getSnapshot: store.getSnapshot,
    subscribe(listener) {
      const off = store.subscribe(listener)
      if (store.watching === 1 && face !== undefined) {
        stopFace = face.subscribe(sync)
        sync()
      }
      return () => {
        off()
        if (store.watching === 0) {
          stopFace?.()
          stopFace = undefined
        }
      }
    },
  }
}

/**
 * The sidebar item's icon: a hand-drawn inline SVG. Only `react` stays external in the bundle; DSH's
 * icon package is not on this repo's module graph and cannot be imported.
 */
function PanelIcon(props: { readonly size?: number }): React.ReactElement {
  const size = typeof props.size === 'number' && props.size > 0 ? props.size : 16
  return React.createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 16 16',
      fill: 'none',
      focusable: false,
      'aria-hidden': true,
    },
    React.createElement('path', {
      d: 'M4.5 7.1 11.1 4 M5.2 8 11.1 8 M4.5 8.9 11.1 12',
      stroke: 'currentColor',
      strokeWidth: 1.2,
      strokeLinecap: 'round',
    }),
    React.createElement('circle', { cx: 3.6, cy: 8, r: 1.7, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12.1, cy: 3.5, r: 1.2, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12.1, cy: 8, r: 1.2, fill: 'currentColor' }),
    React.createElement('circle', { cx: 12.1, cy: 12.5, r: 1.2, fill: 'currentColor' }),
  )
}

/**
 * Wire Superworker's two spots onto their slots.
 *
 * The two registrations happen in one pass, and both withdrawers go to the same `effect`'s cleanup;
 * the cleanup's order is: withdraw the registrations first, then take down the two style tags — the
 * components unmount with the withdrawal, the tags are collected after; the reverse would leave
 * still-drawing components stripped bare for a beat.
 *
 * Services are awaited with dynamic `ctx.inject(['slots'], …)`: when `slots` cannot be fetched,
 * quietly do nothing.
 *
 * Unmount ownership splits by context kind: real Cordis contexts all carry `effect`, the cleanup
 * hangs on it, and runs as the plugin unmounts. Contexts without `effect` are only ever stand-ins:
 * on such a context the `ctx.inject` callback runs a microtask late, so the call site's return value
 * is necessarily `undefined` — this layer therefore returns nothing to the call site.
 * @param ctx - The browser-half plugin context.
 * @param api - The panel assembled in the same `apply`: id, port, preferences, and the panel itself.
 * @param dropStyles - Take down the two injected stylesheets; handed in by the plugin entry, so this layer never drags the two sheet bodies in.
 */
export function registerSeats(
  ctx: unknown,
  api: SuperworkerPanelApi,
  dropStyles: () => void,
): void {
  injectAt(ctx, ['slots'], 'the two Superworker seats did not mount', (owner) => {
    const slots = serviceAt(owner, 'slots') as SlotsService | undefined
    if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
    const nav = createSessionNav(ctx)
    const workspaces = createWorkspaceNav(ctx)
    serveOn(owner, () => {
      const disposers = contribute(slots, api, nav, workspaces)
      return () => {
        for (const dispose of disposers.reverse()) dispose()
        dropStyles()
      }
    }, 'dsh-superworker: seats')
  })
}

/**
 * The two registrations, each contained in its own `try`.
 *
 * One failing to mount (say, the same id already registered) must not take the other down with it:
 * those spots are meant to show up all the same, and a duplicate registration throws inside the slot
 * registry's notification, where React's own subscription also sits — that throw must stop in this
 * layer.
 */
function contribute(
  slots: SlotsService,
  api: SuperworkerPanelApi,
  nav: SessionNav,
  workspaces: WorkspaceSource,
): (() => void)[] {
  const disposers: (() => void)[] = []
  const put = (what: string, run: () => unknown): void => {
    try {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose as () => void)
    } catch (error) {
      report(`${what} did not register`, error)
    }
  }
  put('the sidebar seat', () => slots.inject?.('sidebar.panellist', () => slots.register?.({
    name: 'sidebar.panellist',
    id: api.id,
    order: PANEL_ORDER,
    /* Marked with the dictionary this outlet speaks: DSH redraws the row on a language switch, the
     * same way it does for its own rows. */
    locale: LOCALE_NS,
    label: () => localeOf(api.locale).t(SEAT_WORD),
  }, PanelIcon)))
  put('the main-column seat', () => slots.inject?.('main', () => slots.register?.({
    name: 'main',
    key: api.id,
    locale: LOCALE_NS,
    inject: () => ({ port: api.port, prefs: api.prefs, locale: api.locale, openSession: nav.open, workspaces }),
  }, api.Panel)))
  return disposers
}