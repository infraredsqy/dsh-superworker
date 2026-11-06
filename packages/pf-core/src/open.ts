import type { Executor } from './executor';
import { createConfigNamespace } from './config';
import type { ConfigNamespace } from './config';
import { createConductorNamespace } from './conductor';
import type { ConductorNamespace } from './conductor';
import { createLedgerNamespace } from './ledger';
import type { LedgerNamespace } from './ledger';
import { createSessionsNamespace } from './sessions';
import type { SessionsNamespace } from './sessions';
import { pluginAssemblyOf } from './plugins/assembly';
import { recordLocations } from './paths';
import type { PfLocations } from './paths';

/** The options of open; executor is the only injection point for the executor. */
export interface PfOpenOptions {
  /** The executor is handed in from outside; without one, actions that need an executor stay unavailable. */
  readonly executor?: Executor;
  /**
   * The home of the machine layer (the one `<home>/.pf/config.json` lives in), handed to every
   * namespace that reads that layer: `config` reads its global layer there, and `conductor` reads the
   * same home in dispatch preparation and in the plugin context. One handle answers from one machine
   * layer. Nothing given here falls back to `PF_HOME_DIR`, then to this user's home.
   */
  readonly homeDir?: string;
  /**
   * The plugin directory this handle scans: the option the call hands in wins over `PF_PLUGINS_DIR`,
   * and both win over the default `<root>/plugins` (one folder per plugin). Left out, the reading is
   * the one it has always been — the switch, then the project's own folder — so a caller that names
   * nothing changes nothing.
   */
  readonly pluginsDir?: string;
}

/** The pf handle: the project root plus four namespaces and where the record tree lives. */
export interface Pf {
  /** The project root, the spelling open received is kept as it is (open itself does not touch disk). */
  readonly root: string;
  readonly ledger: LedgerNamespace;
  readonly conductor: ConductorNamespace;
  readonly config: ConfigNamespace;
  readonly sessions: SessionsNamespace;
  /**
   * The record tree's own locations of this root: the directories, and the four file builders a caller
   * prints. A caller that has to name a path asks here — the `.pf` layout is not respelled outside
   * `paths.ts`.
   */
  readonly locations: PfLocations;
}

const executors = new WeakMap<Pf, Executor | undefined>();

/** Read the executor injected into a handle (an in-package seam, not on the frozen surface). */
export function executorOf(pf: Pf): Executor | undefined {
  return executors.get(pf);
}

/**
 * Open the pf handle of a project.
 *
 * The settings namespace reads the plugin declarations of the project it is asked about: the knobs a
 * `plugin.json` declares are on the same list as the built-ins, on the same chain. `open` itself still
 * touches no disk — it hands the namespace a reader, and the reader scans the plugin folder on the call
 * that asks, so a plugin installed or removed is in force on the next call rather than at the next open.
 */
export function open(root: string, options: PfOpenOptions = {}): Pf {
  if (typeof root !== 'string' || root.length === 0) {
    throw new TypeError('open(root, ...) needs a non-empty project root path');
  }
  const pf: Pf = {
    root,
    ledger: createLedgerNamespace(root),
    conductor: createConductorNamespace(root, options.executor, {
      homeDir: options.homeDir,
      pluginsDir: options.pluginsDir,
    }),
    // Each call makes its own assembly: the folder on disk is the answer every time.
    config: createConfigNamespace(root, {
      homeDir: options.homeDir,
      declaredKnobsOf: (dir) => pluginAssemblyOf(dir, options.pluginsDir).knobs(),
    }),
    sessions: createSessionsNamespace(root),
    locations: recordLocations(root),
  };
  executors.set(pf, options.executor);
  return pf;
}
