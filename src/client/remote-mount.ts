/**
 * Mounting this plugin's own Remote namespace on DSH's Client gateway.
 *
 * The browser half reads its readings through the mounted namespace (`remote.<namespace>`), and
 * that namespace exists only because someone mounts a contribution for it: DSH's own assemblies
 * call `remote.$mount` once per selected package (its `dsh-api-remotes` does it for thirty-odd of
 * them). A plugin that never does is left with the carrier layer underneath — one read and then
 * silence — which is a panel that stops updating while the pipeline keeps running.
 *
 * The descriptors built here are the Client half of the contract the host's markers declare: each
 * endpoint's parameter names in call order, which endpoints answer as a stream, and which take the
 * carrier's cancellation instead of a business argument. Both tables are handed in by the caller
 * (`data.ts`), so this file writes no second copy of them.
 *
 * Nothing here validates a value: the host judges every value on its own boundary, and the Client
 * only has to carry one. So each codec is a pass-through wearing the strict tag DSH requires of a
 * generated contribution — the tag is what stops a deployment from mounting this at all, not a
 * claim that the shape was checked twice.
 */
import { injectAt, report } from './context.ts'
import { serviceAt } from './data.ts'

/** The contribution's package identity: one live contribution per package, so it is this plugin's own name. */
export const REMOTE_PACKAGE = 'dsh-superworker'

/**
 * What the caller knows about the contract.
 *
 * `order` is each endpoint's wire names in call order — the same table the panel's positional calls
 * read, so a renamed or reordered parameter cannot drift between the two uses of it. `streams` names
 * the endpoints the host marked `mode: 'stream'`; every other one answers one value.
 */
export interface RemoteContract {
  readonly namespace: string
  readonly order: Readonly<Record<string, readonly string[]>>
  readonly streams: ReadonlySet<string>
}

/** The boundary codec DSH's registry requires of a generated contribution; it passes every value through. */
const PASSTHROUGH = {
  mode: 'strict' as const,
  typeSymbol: `${REMOTE_PACKAGE}#json`,
  create: () => ({ parse: (value: unknown) => value }),
}

/** One endpoint as the Client gateway takes it (only the fields this side writes are named). */
interface Descriptor {
  readonly id: string
  readonly service: string
  readonly namespace: string
  readonly method: string
  readonly invocation: { readonly kind: 'direct' }
  readonly mode?: 'stream'
  readonly parameters: readonly {
    readonly name: string
    readonly wire: string
    readonly source: 'json'
    readonly codec: typeof PASSTHROUGH
  }[]
  readonly cancellation?: { readonly parameter: 'signal' }
  readonly result: typeof PASSTHROUGH
}

/** What `remote.$mount` takes. */
export interface Contribution {
  readonly package: string
  readonly descriptors: readonly Descriptor[]
}

/**
 * Build the contribution from the contract.
 *
 * A stream endpoint's `signal` is the carrier's, so it is declared as `cancellation` and never as a
 * parameter: the Client appends the caller's own signal, which is how the host's `watch` receives
 * the abort that closes its pump. A unary endpoint declares no cancellation, which is what makes
 * the argument count match its parameters exactly.
 * @param contract - The namespace, the wire order per endpoint, and which endpoints are streams.
 * @returns The contribution to mount.
 */
export function remoteContribution(contract: RemoteContract): Contribution {
  const descriptors = Object.entries(contract.order).map(([method, wires]): Descriptor => {
    const stream = contract.streams.has(method)
    return {
      id: `${REMOTE_PACKAGE}#${contract.namespace}/${method}`,
      service: contract.namespace,
      namespace: contract.namespace,
      method,
      invocation: { kind: 'direct' },
      ...(stream ? { mode: 'stream' as const } : {}),
      parameters: wires.map((wire) => ({ name: wire, wire, source: 'json' as const, codec: PASSTHROUGH })),
      ...(stream ? { cancellation: { parameter: 'signal' as const } } : {}),
      result: PASSTHROUGH,
    }
  })
  return { package: REMOTE_PACKAGE, descriptors }
}

/** The one method of DSH's Client Remote service this file calls. */
interface MountFace {
  readonly $mount?: (contribution: Contribution) => unknown
}

/**
 * Mount the namespace, and say so once it is readable.
 *
 * `remote` is waited for rather than assumed: a plugin applied before DSH's gateway is a plugin
 * whose mount would silently never happen, and the wait costs nothing when the service is already
 * there. The returned disposer is dropped on purpose — `$mount` hangs its own cleanup on the
 * calling fiber (cordis's `effect`), so the namespace goes away with this plugin.
 * @param ctx - The browser-half plugin context.
 * @param contract - The namespace and its endpoint tables.
 * @param onMounted - Called once the namespace is mounted; not called when the mount was refused.
 */
export function mountRemoteNamespace(ctx: unknown, contract: RemoteContract, onMounted: () => void): void {
  injectAt(ctx, ['remote'], 'the Remote namespace did not mount', (owner) => {
    const remote = serviceAt(owner, 'remote') as MountFace | undefined
    const mount = remote?.$mount
    if (remote === undefined || typeof mount !== 'function') return
    let mounting: unknown
    try {
      mounting = mount.call(remote, remoteContribution(contract))
    } catch (error) {
      report('the Remote namespace did not mount', error)
      return
    }
    /* A refused mount is a real answer from the gateway (an older host, a namespace already taken),
       and the carrier path still works: say so and stay on it rather than throwing at load. */
    void Promise.resolve(mounting).then(
      () => { onMounted() },
      (error: unknown) => { report('the Remote namespace did not mount', error) },
    )
  })
}
