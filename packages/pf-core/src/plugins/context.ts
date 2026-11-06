import { join } from 'node:path';
import { resolveConfig, type ConfigValue } from '../config';
import { readJsonFile } from '../jsonio';
import { nodeDir, pfPaths, type PfPaths } from '../paths';
import type { NodeRecord } from '../types';
import { PLUGIN_IMPL_NAME, declaredKnobSpecs, implOf, readingsOf, routableCommands } from './registry';
import type { PluginContext, PluginFolder, PluginGraphSnapshot, PluginInsertTarget } from './types';

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
 * What one routed command did, told apart in the two ways a plugin can act on: whether it ran to its
 * end, and the text it answered with when it answered text. A word nobody routes, a routed command
 * whose implementation has no `main()`, and a command that threw are all "it did not run" — and a
 * command that answers no text at all still ran (the effect may be the whole point of it).
 */
interface CommandAnswer {
  /** Whether a routed command was found and its `main()` ran to its end. */
  readonly ran: boolean;
  /** The text the command answered with; null when it answered none (a failure, or an effectful command that answers no text). */
  readonly text: string | null;
}

/** The spec.md location of one node: this tree's own layout, with forward slashes as a human reads it. */
function specPathOf(paths: PfPaths, nodeId: string): string {
  return join(nodeDir(paths, nodeId), 'spec.md').split('\\').join('/');
}

/** The graph snapshot: the node table the caller reads once before opening the seam (absent means an empty graph). */
export async function readGraphSnapshot(paths: PfPaths): Promise<PluginGraphSnapshot> {
  const read = await readJsonFile(paths.ideasJson, 'ideas.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  const nodes = data.nodes !== null && typeof data.nodes === 'object' && !Array.isArray(data.nodes)
    ? (data.nodes as Record<string, NodeRecord>)
    : {};
  return { nodes };
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
}

export function createContext(options: ContextOptions): PluginContext {
  const { root, folders, warnings } = options;
  const paths = pfPaths(root);
  const cycle = options.cycle ?? {};
  const nodeId = options.nodeId ?? null;

  // Knobs: the whole chain is read once and cached for this round (a value should not shift within one timing).
  let chain: Promise<Record<string, ConfigValue | null>> | null = null;
  const readChain = (): Promise<Record<string, ConfigValue | null>> => {
    if (chain === null) {
      chain = resolveConfig(root, {
        homeDir: options.homeDir,
        declaredKnobs: declaredKnobSpecs(folders),
        cycle: typeof cycle.id === 'string' ? cycle.id : undefined,
        node: nodeId ?? undefined,
      }).then((readings) => {
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

  const cellFor = (key: string) => readingsOf(folders).find((entry) => entry.key === key);

  const computedValue = async (key: string): Promise<number | null> => {
    if (computed.has(key)) return computed.get(key) ?? null;
    const cell = cellFor(key);
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

  // Commands: only a plugin's own words are routed; a word the core reserves, and a word nobody claims, both answer "none".
  const dispatchCommand = async (
    argv: readonly string[],
    warnMissingMain: boolean,
  ): Promise<CommandAnswer> => {
    const neverRan: CommandAnswer = { ran: false, text: null };
    if (argv.length === 0 || typeof argv[0] !== 'string') return neverRan;
    const word = argv[0];
    const entry = routableCommands(folders).find((candidate) => candidate.name === word);
    if (entry === undefined) return neverRan;
    const folder = folders.find((f) => f.name === entry.plugin);
    if (folder === undefined) return neverRan;
    const impl = await implOf(folder);
    if (impl === null) return neverRan;
    const main = (impl as Record<string, unknown>).main;
    if (typeof main !== 'function') {
      if (warnMissingMain) warnings.push(warnLine(entry.plugin, 'has no main()', `the command ${JSON.stringify(word)} cannot run`));
      return neverRan;
    }
    const callArgv = entry.keepName ? argv : argv.slice(1);
    try {
      const answered = await (main as (argv: readonly string[], ctx: PluginContext) => unknown)(
        callArgv,
        context,
      );
      // The command ran to its end: what it answered is its business (an effectful one answers no text at all).
      return { ran: true, text: typeof answered === 'string' ? answered : null };
    } catch (error) {
      warnings.push(warnLine(entry.plugin, `failed to run ${JSON.stringify(word)}`, error));
      return neverRan;
    }
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
      const cell = cellFor(key);
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

    capture: async (argv) => (await dispatchCommand(argv, true)).text,
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
      : async (argv) => (await dispatchCommand(argv, false)).ran,
    specPath: (nodeIdIn: string) => specPathOf(paths, nodeIdIn),
  };

  return context;
}
