/* The one host-context stand-in the host-side tests share: the services by name, the faces each
 * file needs, and the readings a case judges. One copy, so a new service or a new event the host
 * grows is answered here once.
 *
 * Every face is a parameter, and a face turned off is a face the context does not carry at all —
 * that is how a file states a narrower host (one whose sessions answer nothing, one with no process
 * gateway, one with no event bus) instead of writing its own copy of this object.
 */
import { fakeWorkspaceFiles } from './workspace-files-port.mjs'

/**
 * A minimal host context, standing in for the host the plugin is applied to.
 *
 * The faces, each off unless asked for:
 * - `root` — the shorthand for "one root, both places": the sandbox policy's root *and* the cwd
 *   every live session header carries;
 * - `live` — a session id → record map the live-session service answers with;
 * - `sessionCwd` — the cwd every live session header carries (a context whose `sessions.get` names
 *   one root whatever the id is);
 * - `stored` — a session id → record map read through the host's `sessionPersistence` service; the
 *   ids asked for are recorded on `statCalls`. Given nothing, that service is not on the context;
 * - `sandboxRoot` — the sandbox policy's root; without it the context has no `sandboxPolicy`;
 * - `port` — a ready workspace-files port, or `files` — the dict the shared port stand-in reads
 *   through; neither means the context carries an empty object, the "no port at all" face;
 * - `services` — what `get(name)` answers besides the two above;
 * - `absent` — service name → message: asking for that service throws (a host exposing none);
 * - `config` — the settings surface, when the line has one;
 * - `bus` — an event bus with `on`/`emit` (returned as `events`);
 * - `tools` — a gating tool registry on the context (`register` + `resolve`), with the entries it
 *   holds as `tools.entries`; the host's own rule is the `resolve` this stand-in answers: every
 *   entry whose condition admits the step, and every entry without one;
 * - `logger` — a `logger.warn` that collects its lines;
 * - `provide` / `effect` — collect what the plugin provides and the effects it installs;
 * - `sessions: false` — no live-session service on the context at all (the opener reaches the
 *   session store through `get('sessions')` instead).
 *
 * The result: `{ ctx, provided, asked, statCalls, warnings, events, effects, tools }` — `asked` is the
 * port's own call log; the rest are the readings the cases judge.
 */
export function fakeContext({
  root,
  live = {},
  sessionCwd = root,
  stored,
  sandboxRoot = root,
  port,
  files,
  services = {},
  absent = {},
  config,
  bus = false,
  tools = false,
  logger = false,
  provide = false,
  effect = false,
  sessions = true,
} = {}) {
  const provided = {}
  const effects = []
  const warnings = []
  const statCalls = []
  const listeners = new Map()
  const events = {
    on(name, listener) {
      const set = listeners.get(name) ?? new Set()
      set.add(listener)
      listeners.set(name, set)
      return () => set.delete(listener)
    },
    emit(name, ...args) {
      for (const listener of [...(listeners.get(name) ?? [])]) listener(...args)
    },
    /* The listeners on one event right now: what a case asserts about a road being taken back. */
    listenersOf(name) {
      return [...(listeners.get(name) ?? [])]
    },
  }
  const heldPort = port ?? (files === undefined ? {} : fakeWorkspaceFiles(files))
  /* The live-session service: the ids the file named, and — when a root is fixed — that header for
   * anyone. */
  const sessionService =
    sessions === false
      ? undefined
      : { get: (id) => live[id] ?? (sessionCwd === undefined ? undefined : { header: { cwd: sessionCwd } }) }
  const answered = { ...services }
  if (stored !== undefined) {
    answered.sessionPersistence = {
      stat: async (sessionId) => {
        statCalls.push(sessionId)
        return stored[sessionId]
      },
    }
  }

  const ctx = {
    workspaceFiles: heldPort,
    ...(sessionService === undefined ? {} : { sessions: sessionService }),
    ...(sandboxRoot === undefined ? {} : { sandboxPolicy: { workspaceRoot: sandboxRoot } }),
    ...(config === undefined ? {} : { config }),
    get(name) {
      const refusal = absent[name]
      if (refusal !== undefined) throw new Error(refusal)
      return answered[name]
    },
  }
  /* The host's registry in one stand-in: `register` collects `{ definition, when }`, and `resolve`
   * applies the host's own rule — an entry with no condition is admitted, one whose condition says
   * no is left out of the step. */
  const registry = {
    entries: [],
    register(definition, options) {
      const entry = { definition, when: options?.when }
      registry.entries.push(entry)
      return () => {
        const at = registry.entries.indexOf(entry)
        if (at >= 0) registry.entries.splice(at, 1)
      }
    },
    async resolve(context) {
      const visible = new Map()
      for (const entry of registry.entries) {
        if (entry.when !== undefined && !(await entry.when({ agent: context.agent }))) continue
        visible.set(entry.definition.name, entry.definition)
      }
      return visible
    },
  }
  if (tools) ctx.tools = registry
  if (bus) ctx.on = events.on
  if (logger) ctx.logger = { warn: (line) => warnings.push(line) }
  if (provide) ctx.provide = (service, value) => { provided[service] = value }
  if (effect) {
    ctx.effect = (make) => {
      const off = make()
      effects.push(off)
      return typeof off === 'function' ? off : () => undefined
    }
  }

  return { ctx, provided, asked: heldPort.calls ?? [], statCalls, warnings, events, effects, tools: tools ? registry : undefined }
}
