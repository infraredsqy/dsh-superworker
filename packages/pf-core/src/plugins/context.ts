import { resolveConfig, type ConfigValue, type KnobSpec } from '../config';
import { nodeSpecPath, pfPaths } from '../paths';
import type { PluginAssembly } from './assembly';
import { implOf } from './scan';
import { declaredKnobSpecs, readingsOf } from './tables';
import { routableCommands } from '../words/plugin-commands';
import type {
  PluginCommandEntry,
  PluginContext,
  PluginFolder,
  PluginGraphSnapshot,
  PluginInsertTarget,
  PluginReadingEntry,
} from './types';
import { PLUGIN_IMPL_NAME } from './scan';

/**
 * The host context: everything a plugin can see at one timing, and nothing outside this surface.
 * The caller reads the scene and hands it in — the line record, the node in hand, the ticket, the graph
 * snapshot — so the plugin gets no path of the record directory and no gate that would read the records
 * again, and therefore cannot read behind the project.
 *
 * The two kinds of gate each have their own tolerance: an unreadable knob answers null, a number that cannot
 * be computed answers null, and a command that produces no text answers null as well — each failure leaves one
 * WARNING line (data, not stderr) and the main flow goes on as usual. Whether a command ran at all is a
 * separate question from what text it answered: `run` tells the two apart (`false` for one that did not run),
 * and a command that ran and answered no text is a command that ran. A number asked a second time gets the
 * first answer (the computing function runs once per round); a self-question that goes round in circles is
 * named and then treated as "none this round".
 *
 * **One routing, two readers.** A plugin command is routed here once — find the word in the routing table,
 * load the implementation, cut argv by `keep_name`, call `main`, and read what it answered into the four
 * cells `ran / text / code / error`. This context's `capture` / `run` and `conductor.pluginCommand` both
 * read that one answer, so neither of them has to explain "it did not run" or "it ran without a word".
 */

/** The one spelling of the WARNING line on the tolerant path: `WARNING: plugin <name> <what went wrong>: <detail>`. */
export function warnLine(name: string, what: string, detail: unknown): string {
  const message = detail instanceof Error ? detail.message : String(detail);
  return `WARNING: plugin ${name} ${what}: ${message}`;
}

/** Turn a reading into a number: a number is a number — a boolean is a decision JSON spells out, and strings are not guessed at. */
function asNumber(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

/** The number reported inside a ticket (the outputs of a handoff ticket). */
function fromSig(sig: unknown, key: string): number | null {
  if (sig === null || typeof sig !== 'object') return null;
  const outputs = (sig as Record<string, unknown>).outputs;
  if (outputs === null || typeof outputs !== 'object') return null;
  const reading = (outputs as Record<string, unknown>).reading;
  if (reading === null || typeof reading !== 'object') return null;
  return asNumber((reading as Record<string, unknown>)[key]);
}

/**
 * What one routed plugin command did, in the four cells both readers take: whether a routed command was
 * found and ran to its end, the text it answered with, the exit code a `main` answered with a number, and
 * the sentence a failure leaves (`null` when it ran). The WARNING line for a failure is left here as well,
 * so the two readers cannot describe the same failure two ways.
 */
export interface CommandRoute {
  /** The plugin whose word this was; null when no installed plugin claims the word. */
  readonly plugin: string | null;
  /** Whether a routed command was found and its `main()` ran to its end. */
  readonly ran: boolean;
  /** The text the command answered with; null when it answered none (a failure, or an effectful command that answers no text). */
  readonly text: string | null;
  /** The exit code `main` answered with a number; null when it answered none. */
  readonly code: number | null;
  /** The sentence the failure leaves: no routed word, no `main()`, or the throw itself; null when it ran. */
  readonly error: string | null;
}

/**
 * Route one plugin command in this process: the word picks the owning plugin out of the routing table, its
 * `main` runs here, and the answer comes back in the four cells above. Every failure leaves one WARNING line
 * and reads as "it did not run"; a command that ran to its end ran even when it answered no text at all.
 */
export async function routeCommand(
  argv: readonly string[],
  folders: readonly PluginFolder[],
  ctx: PluginContext,
  warnings: string[],
  routable: readonly PluginCommandEntry[] = routableCommands(folders),
): Promise<CommandRoute> {
  const neverRan: CommandRoute = { plugin: null, ran: false, text: null, code: null, error: null };
  if (argv.length === 0 || typeof argv[0] !== 'string') return neverRan;
  const word = argv[0];
  const entry = routable.find((candidate) => candidate.name === word);
  if (entry === undefined) return neverRan;
  const folder = folders.find((f) => f.name === entry.plugin);
  const impl = folder === undefined ? null : await implOf(folder);
  const main = impl === null ? undefined : (impl as Record<string, unknown>).main;
  if (typeof main !== 'function') {
    const error = `plugin ${JSON.stringify(entry.plugin)} declares the command ${JSON.stringify(word)} ` +
      'but has no main() to run it';
    warnings.push(warnLine(entry.plugin, 'has no main()', `the command ${JSON.stringify(word)} cannot run`));
    return { plugin: entry.plugin, ran: false, text: null, code: null, error };
  }
  const callArgv = entry.keepName ? argv : argv.slice(1);
  try {
    const answered = await (main as (argv: readonly string[], ctx: PluginContext) => unknown)(callArgv, ctx);
    // The command ran to its end: what it answered is its business (an effectful one answers no text at all),
    // and a number is the exit code it asks its caller to leave with.
    return {
      plugin: entry.plugin,
      ran: true,
      text: typeof answered === 'string' ? answered : null,
      code: typeof answered === 'number' ? answered : null,
      error: null,
    };
  } catch (error) {
    warnings.push(warnLine(entry.plugin, `failed to run ${JSON.stringify(word)}`, error));
    return {
      plugin: entry.plugin,
      ran: false,
      text: null,
      code: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The options for assembling the context: the loaded plugin table, the home shut into a given directory, and where warnings land. */
export interface ContextOptions {
  readonly root: string;
  readonly folders: readonly PluginFolder[];
  readonly homeDir?: string;
  /** Where warnings are gathered: every line of the tolerant path is pushed here (data; the library has no stderr). */
  readonly warnings: string[];
  readonly cycle?: Record<string, unknown>;
  readonly nodeId?: string | null;
  readonly sig?: unknown;
  readonly dag?: PluginGraphSnapshot;
  readonly target?: PluginInsertTarget | null;
  /**
   * Whether this round is a rehearsal: the context then carries `preview: true`, and `run` refuses (its
   * effect belongs to the real timing). The read side — knobs, readings, tags, `capture` — is the same,
   * so a plugin's preview sees the scene its real door would see.
   */
  readonly preview?: boolean;
  /**
   * The round's own assembly: the merged tables (knobs, readings, routing) are worked out once and read
   * from there, instead of being rebuilt by every question this context answers.
   */
  readonly assembly?: PluginAssembly;
}

/** The merged tables one context reads: from the round's assembly when it was handed in, worked out from the folders in hand otherwise. */
async function tablesOf(options: ContextOptions): Promise<{
  knobs: Record<string, KnobSpec>;
  readings: readonly PluginReadingEntry[];
  routable: readonly PluginCommandEntry[];
}> {
  if (options.assembly !== undefined) {
    return {
      knobs: await options.assembly.knobs(),
      readings: await options.assembly.readings(),
      routable: await options.assembly.routable(),
    };
  }
  return {
    knobs: declaredKnobSpecs(options.folders),
    readings: readingsOf(options.folders),
    routable: routableCommands(options.folders),
  };
}

export function createContext(options: ContextOptions): PluginContext {
  const { root, folders, warnings } = options;
  const paths = pfPaths(root);
  const cycle = options.cycle ?? {};
  const nodeId = options.nodeId ?? null;
  // The merged tables are read once per context (a table should not shift within one timing); a context
  // built on the round's assembly reads the assembly's own copy, which is one for the whole round.
  const tables = tablesOf(options);

  // Knobs: the whole chain is read once and cached for this round (a value should not shift within one timing).
  let chain: Promise<Record<string, ConfigValue | null>> | null = null;
  const readChain = (): Promise<Record<string, ConfigValue | null>> => {
    if (chain === null) {
      chain = tables.then((merged) => resolveConfig(root, {
        homeDir: options.homeDir,
        declaredKnobs: merged.knobs,
        cycle: typeof cycle.id === 'string' ? cycle.id : undefined,
        node: nodeId ?? undefined,
      })).then((readings) => {
        const out: Record<string, ConfigValue | null> = {};
        for (const [key, reading] of Object.entries(readings)) out[key] = reading.value;
        return out;
      }).catch((error) => {
        warnings.push(warnLine('<context>', 'could not read the knob chain', error));
        return {};
      });
    }
    return chain;
  };

  // Readings: a declared cell is supplied by the source it names; a ticket's number comes from outputs.reading of the handoff ticket.
  const computed = new Map<string, number | null>();
  const computing = new Set<string>();

  const cellFor = async (key: string): Promise<PluginReadingEntry | undefined> =>
    (await tables).readings.find((entry) => entry.key === key);

  const computedValue = async (key: string): Promise<number | null> => {
    if (computed.has(key)) return computed.get(key) ?? null;
    const cell = await cellFor(key);
    const by = cell?.by ?? '';
    const plugin = cell?.plugin ?? '?';
    let value: number | null = null;
    if (by !== '') {
      if (computing.has(key)) {
        warnings.push(warnLine(
          plugin,
          `asked for ${JSON.stringify(key)} while computing it`,
          'the number stays unknown this pass',
        ));
      } else {
        computing.add(key);
        try {
          const folder = folders.find((f) => f.name === plugin);
          const impl = folder === undefined ? null : await implOf(folder);
          const call = impl === null ? undefined : (impl as Record<string, unknown>)[by];
          if (folder === undefined || impl === null) {
            warnings.push(warnLine(plugin, 'has no usable implementation', `${PLUGIN_IMPL_NAME} is missing or will not load`));
          } else if (typeof call !== 'function') {
            warnings.push(warnLine(plugin, `has no ${by}()`, `its source for ${JSON.stringify(key)} cannot be computed`));
          } else {
            value = asNumber(await (call as (ctx: PluginContext) => unknown)(context));
          }
        } catch (error) {
          warnings.push(warnLine(plugin, `failed to compute ${JSON.stringify(key)}`, error));
          value = null;
        } finally {
          computing.delete(key);
        }
      }
    }
    computed.set(key, value);
    return value;
  };

  const context: PluginContext = {
    root,
    ...(options.preview === true ? { preview: true } : {}),
    cycle,
    nodeId,
    sig: options.sig ?? null,
    dag: options.dag ?? { nodes: {} },
    target: options.target ?? null,

    async knob(name: string) {
      if (name === '') return null;
      const chainRead = await readChain();
      return chainRead[name] ?? null;
    },

    async reading(key: string) {
      if (key === '') return null;
      const cell = await cellFor(key);
      if (cell === undefined || cell.source === 'ticket') return fromSig(options.sig ?? null, key);
      return computedValue(key);
    },

    nodesWithTag(tag: string): string[] {
      const out: string[] = [];
      for (const [id, node] of Object.entries(context.dag.nodes)) {
        if (node === null || typeof node !== 'object' || node.status !== 'todo') continue;
        const tags = Array.isArray(node.tags) ? node.tags.filter((t) => typeof t === 'string') : [];
        if (tags.includes(tag)) out.push(id);
      }
      return out.sort();
    },

    capture: async (argv) => (await routeCommand(argv, folders, context, warnings, (await tables).routable)).text,
    // A rehearsal may read but must not act: a command whose effect is the point refuses here, and the
    // line it leaves says which word was not run — the picture stays whole instead of quietly missing it.
    run: options.preview === true
      ? async (argv) => {
          warnings.push(
            `WARNING: a rehearsal cannot run \`${argv.map(String).join(' ')}\`: ` +
              "the command's effect belongs to the timing itself",
          );
          return false;
        }
      : async (argv) => (await routeCommand(argv, folders, context, warnings, (await tables).routable)).ran,
    specPath: (nodeIdIn: string) => nodeSpecPath(paths, nodeIdIn),
  };

  return context;
}
