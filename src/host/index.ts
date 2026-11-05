/**
 * Entry point of the host half's plugin: installs the `pathfinder` service on the
 * host, and arms the wake that registers the agent-facing `pathfinder` tool into the
 * scope of exactly the agents whose session loads a pipeline skill.
 *
 * It holds no data and caches nothing: every call resolves the workspace root
 * from the session identity on the spot. A process gateway is not in `inject`
 * and is never consulted: writes are answered in-process by the engine's words
 * layer, so the plugin never gets stuck pending installation.
 *
 * The export surface is only the things the plugin protocol requires
 * (`name` / `inject` / `apply` / `Config`) plus the gateway class itself: the
 * line is installed by DSH's plugin loader (mount point in
 * `cordis.patch.yml`), which reads only those; the other in-repo consumers
 * are `tests/host-plugin` and `tests/client-render`, which build a gateway over
 * a fake host context to drive the panel. Everything else is internal, each piece in its
 * own module; the browser half and tests import via deep paths, not through
 * the entry — names unused on the entry surface are not exported.
 */
import type { Context } from '@deepseek-ai/cordis'
/* The declaration merges for the services live on the package entries: they must stand on the Context type before `apply` installs the service. All type-only imports — nothing enters the runtime or the build output. */
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session'
import { Config } from './config.ts'
import { PathfinderRecordsGateway } from './gateway.ts'
import { installSkillsWhenReady } from './skills.ts'
import { installRelay } from './relay.ts'
import { installToolWake } from './tool.ts'
import type { PathfinderRecords } from './contract.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host half's record-reading service; the interface the browser half's cell needs. */
    pathfinder: PathfinderRecords
  }
}

/** The plugin line's own name; DSH's plugin protocol identifies the line by it. */
export const name = 'pathfinder-records'

/** `apply` runs only once these are present; DSH's plugin protocol reads it before assembly. */
export const inject = ['workspaceFiles', 'sessions', 'sandboxPolicy', 'tools']

/**
 * This line's settings schema; DSH's plugin protocol uses it to build the
 * settings namespace. When the host lacks schemastery this is `undefined` —
 * DSH reads that as "no form" and the line takes no place in settings.
 */
export { Config }

/** The gateway class itself; `tests/host-plugin` and `tests/client-render` each build one over a fake host context to drive the panel. */
export { PathfinderRecordsGateway }

/**
 * Installs `ctx.pathfinder`. The service unloads with the fiber this plugin
 * lives on.
 *
 * The skills the shipped pf plugins carry go in and come out with the same
 * fiber: `installSkillsWhenReady` places them into the DSH home's skill root
 * (where the filesystem provider scans them, above the old hand-copied copies
 * by the provider's own rank), records exactly what it wrote, and hands the
 * undo to that fiber, so a host that unloads the line is left with nothing of
 * ours under that root. The placement needs no skill service to happen — it is
 * a filesystem action — and the catalog a session sees is read back later, as
 * one diagnostic line, where a workspace is known (`executor.ts`).
 *
 * The tool wake's listeners live here too: `installToolWake` watches the skill
 * tool's settled calls and the step proposals that carry a user `/pf-*`
 * invocation, and registers the agent-facing tool into the waking agent's own
 * scope — never anywhere else, so a session that never touches a pipeline
 * skill keeps the request header it would have had without this plugin.
 *
 * @returns whatever the placement seam handed back, so a caller (or a test)
 * can wait for the attempt to settle.
 */
export function apply(ctx: Context, config?: unknown): unknown {
  ctx.provide('pathfinder', new PathfinderRecordsGateway(ctx))
  /* The dispatch relay's listeners live as long as this line does: the
   * disposer goes into a fiber effect, so an unload (or a reload) takes them
   * back instead of leaving a second trigger behind. A stand-in context
   * without `effect` keeps the listeners unowned — they die with it. The
   * line's own resolved config rides along: that object is where the relay's
   * switch is read (the context proxy itself refuses undeclared reads). */
  const relayOff = installRelay(ctx, config)
  const wakeOff = installToolWake(ctx)
  const effect = (ctx as { effect?: (make: () => unknown, label?: string) => unknown }).effect
  if (typeof effect === 'function') {
    effect.call(ctx, () => relayOff, 'dsh-pathfinder: dispatch relay')
    effect.call(ctx, () => wakeOff, 'dsh-pathfinder: tool wake')
  }
  return installSkillsWhenReady(ctx)
}
