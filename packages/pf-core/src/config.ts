import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { nowSeconds } from './clock';
import { cycleHoldingIds } from './cycles';
import { PfError } from './errors';
import { atomicWriteJson, jsonOptionsForRecord, readJsonFile } from './jsonio';
import { assertLedgerInitialized } from './initledger';
import { withLedgerLock } from './ledgerlock';
import { globalConfigPath, nodeConfigPath, PF_DIR_NAME, pfPaths, type PfPaths } from './paths';
import type { CycleRecord } from './types';

/**
 * Settings: reading and writing along one resolution chain — the same set of knobs is written on the
 * narrower layer and resolved by the chain into the value in use.
 *
 * The layers of the chain, narrowest first; narrow overrides wide, whoever states it first wins:
 *
 *     node      `<root>/.pf/nodes/<id>/config.json`   one node's own round
 *     cycle     the `policies` slot of the line record one work line
 *     project   `<root>/.pf/config.json`             travels with the project (init lays down an empty object)
 *     global    `<home>/.pf/config.json`             travels with this machine (nobody generates it for you)
 *     builtin   the `default` of the knob list       where it lands when nobody said anything
 *
 * How the four verbs divide the work:
 *
 * - `set` / `unset` land on exactly one layer, and that layer is **named** by the caller — there is no
 *   default layer, because a hidden default is the easiest way to change a setting in the wrong place.
 *   The four spellings are `{ project: true }`, `{ global: true }`, `{ cycle: '<line id>' }` and
 *   `{ node: '<node id>' }`; naming none, or naming two, is refused on the spot. A line id or a node id
 *   that does not exist is refused as well (nothing is created for the caller), and so is a layer the
 *   knob does not accept — that refusal names the layers it does accept.
 * - `get` reads one setting and hands back `{ value, source }`; `list` reads every setting and hands
 *   back the same pair per key. Both read the chain from the widest layer inward and stop at the layer
 *   the caller named (`at`), the two wide layers when nothing was named; `source` says which layer the
 *   value in force came from, and `builtin` says nobody on the chain stated anything (the declaration's
 *   default is in force — see the defaults rule below). The line layer sits between the project layer
 *   and a node's own: a `{ node }` read is placed on the one line holding that node — no holder means
 *   the node has no line-layer value and the line layer is skipped, and a record putting one node in
 *   two lines' hands is refused by name instead of guessed past. A `{ node }` read resolves its id the
 *   way a write does: an id that is not on the graph is refused `node_not_found`, while a node on the
 *   graph with no settings file of its own is no error — that layer states nothing and the reading goes
 *   on below it.
 * - Every verb takes an optional directory to work in. Left out, the handle's own project root is
 *   used; either way that directory has to hold a `.pf` of its own — a directory that is not a pf
 *   project root is refused outright, never guessed upward to a wider directory. A fork-mode node works
 *   in a worktree of its own; under the own-repo layout that checkout carries no `.pf`, so the agent there
 *   is told the directory is not a pf project instead of being handed the main tree's settings (under the
 *   in-repo layout the records travel with the checkout, so the verb answers from that worktree's own
 *   records). A relative path is resolved against the process's current directory.
 *
 * There are only four kinds: `number` (a positive numeric value), `integer` (a positive integer), `word` (a
 * word from a vocabulary), `switch` (on / off). The read side and the write side go through the same
 * `parseConfigValue` — a JSON value read from disk and a string handed in by a word pass the
 * same gate, so the boundary of a kind is written once. The write side has two extra rules: number /
 * integer take positive values only (0 would put every reading over the bound); `off` is a value for a
 * switch; for a non-switch kind, writing `off` is refused just like writing any other word outside the
 * vocabulary — taking a layer off is the job of `unset`.
 *
 * Which layers each knob accepts is stated in its own cell: a built-in setting governs the whole project
 * or the whole machine, so it takes only the project / global layers; a knob a plugin declares is read by
 * the host along the whole chain, taking all four layers by default, and a declaration that narrows it is
 * followed. `set` / `unset` refuse a layer the knob does not take, naming the layers it does take, and
 * `get` refuses the same way; `list` has no key to refuse, so it shows the chain up to the named layer — a
 * knob that does not take that layer is shown from the layer below it. The line-level policy keys
 * (parallel / when_shelved / model) live on the line record and are written by
 * `ledger.cycles.setPolicy`; this module does not know them.
 *
 * Defaults: every setting the engine declares carries one — a literal, or a function of the project root
 * when the answer is worked out per project (the worktree mode follows whether the project has a `.git`).
 * A core declaration that carries none, or carries a `null`, is refused the moment the list is merged,
 * naming the setting, so no core reading runs into "not configured": the factory value is always there
 * and its source is `builtin`. A plugin declaration is not put through that gate, but its cells state a
 * default too: there `null` is the spelling for "no factory value", its way of saying "this line was never
 * set up", and `null` stays a reading (the plugin knob reader keeps that meaning); a cell that leaves the
 * key out is turned away where the declaration is read. A declared default that is not of its own
 * kind is a broken cell: the cell does not enter the list, the knob then reads as unknown, and — because a
 * broken cell is a declaration problem — the whole plugin it belongs to takes no part (its close-time work
 * is skipped) until the cell is fixed; doctor names the plugin and the knob. A malformed declaration never
 * stops a settings verb or a dispatch: the read side keeps answering for every knob that can be honoured.
 *
 * Only two kinds of thing stop a reading: the caller's pointer — a layer the knob does not accept, or
 * a line / node id that is not on the record — and a layer file that cannot be read or parsed.
 * Everything else about the files is silent, because none of it changes a reading: an unknown name (a
 * plugin was removed, a key was renamed), a known name sitting in a layer that does not take it, and a
 * value that is not of its kind are all skipped — the value that counts is the next layer's, or the
 * declaration's default. The write side is where those mistakes are caught: `set` refuses the wrong
 * layer, the unknown name and the value of the wrong kind, so a file carrying one of them was edited by
 * hand and the person who edited it knows which layer it went into.
 *
 * Writing the line layer: the `policies` slot of `state.json` is written from this one place
 * (`ledger.cycles.setPolicy` goes through the same slot), read and rewritten as a whole document, holding
 * the record tree's lock throughout, past the init gate first.
 */

/** A setting value: word, number, true/false. */
export type ConfigValue = string | number | boolean;

/**
 * The layer one verb works on, named explicitly by the caller: one layer at a time, and there is no
 * default layer. `project` is the project root's own file, `global` is this machine's, `cycle` is one
 * line's own layer (it rides on the line record) and `node` is one node's own file.
 */
export type ConfigLayer =
  | { readonly project: true }
  | { readonly global: true }
  | { readonly cycle: string }
  | { readonly node: string };

/** The reading of one setting: the value in force, and the layer it came from. */
export interface ConfigReading {
  readonly value: ConfigValue | null;
  readonly source: ConfigSource;
}

/**
 * The config namespace: reading and writing along one settings chain, these five verbs. Each takes an
 * optional directory to work in (the handle's project root when left out).
 */
export interface ConfigNamespace {
  /** Read one setting up to the named layer (the two wide layers when no layer is named); the value and its source. */
  get(key: string, at?: ConfigLayer, dir?: string): Promise<ConfigReading>;
  /** Write one setting onto exactly the named layer. */
  set(key: string, value: ConfigValue, at: ConfigLayer, dir?: string): Promise<void>;
  /** Take one setting off exactly the named layer, so the next layer shows through. */
  unset(key: string, at: ConfigLayer, dir?: string): Promise<void>;
  /** Every setting with the value in force and its source, up to the named layer. */
  list(at?: ConfigLayer, dir?: string): Promise<Record<string, ConfigReading>>;
  /**
   * The names the settings verbs accept here, sorted: the knob list in force — the core settings plus the
   * knobs installed plugins declare — narrowed to the names that take the project layer, which is what a
   * `get` / `set` / `unset` answer is about. A name that has no project layer is the machine's own and is
   * not on this list: a caller printing the vocabulary prints these names.
   */
  keys(dir?: string): Promise<string[]>;
}

// ── the knob list: kind, layers, default ─────────────────────────────────────

/** The kind of a value: numeric / integer / word / switch, four and no others. */
export type ConfigKind = 'number' | 'integer' | 'word' | 'switch';

/** The layer names on the resolution chain, narrowest first. */
export type ConfigLayerName = 'node' | 'cycle' | 'project' | 'global';

/** The source layer of one reading; `builtin` is the declaration's default, where it lands when nobody on the chain said anything. */
export type ConfigSource = ConfigLayerName | 'builtin';

/** A factory value that is worked out per project rather than written down (the worktree mode follows the project). */
export type ConfigDefault = ConfigValue | ((root: string) => ConfigValue);

/** One knob-list cell: kind, factory default, the vocabulary of a word, which layers it accepts, a one-line description. */
export interface KnobSpec {
  readonly kind: ConfigKind;
  /**
   * The factory value in force when nobody on the chain states anything: a literal, or a function of the
   * project root for a value worked out per project. A declaration that leaves the key out is refused
   * when the list is merged, and so is one stating `null` — a default is required and may not be null.
   * `null` is the one spelling for "this knob has no factory value at all", and only a plugin
   * declaration may state it: the gate is the engine's own list, a plugin's missing default is how it
   * says "this line was never set up", and the plugin knob reader keeps that meaning. A default that is
   * not of its own kind is a broken cell wherever it comes from: it keeps out of the merged list, so the
   * knob reads as unknown and doctor names the plugin and the knob.
   */
  readonly default: ConfigValue | ConfigDefault | null;
  /** The vocabulary of a word; absent means any word is taken. */
  readonly values?: readonly string[];
  /** Which layers this knob accepts; absent takes all four (the reading of a plugin knob). */
  readonly layers?: readonly ConfigLayerName[];
  readonly summary: string;
}

/** All four layers of the resolution chain, narrowest first. */
export const CHAIN_LAYERS: readonly ConfigLayerName[] = ['node', 'cycle', 'project', 'global'];

/** The layers a built-in setting accepts: a setting governs the whole project or the whole machine, and the two narrow layers have no reader. */
export const SETTING_LAYERS: readonly ConfigLayerName[] = ['project', 'global'];

/** The settings the core itself reads. Vocabulary and defaults are in the table below. */
export const BUILTIN_KNOBS: Readonly<Record<string, KnobSpec>> = {
  max_agents: {
    kind: 'integer',
    default: 3,
    layers: SETTING_LAYERS,
    summary: 'how many subagents one session may have in flight at once',
  },
  test_tier: {
    kind: 'word',
    values: ['full', 'minimal'],
    default: 'full',
    layers: SETTING_LAYERS,
    summary: 'how this project is verified: full runs the whole suite, minimal runs only the few checks the project names',
  },
  worktree_mode: {
    kind: 'word',
    values: ['off', 'fork', 'reuse'],
    // Worked out per project: a git project forks by default, anything else works on the main tree.
    default: (root: string) => (existsSync(join(root, '.git')) ? 'fork' : 'off'),
    layers: SETTING_LAYERS,
    summary: 'whether a node gets a worktree of its own: fork by default in a git project, off otherwise',
  },
};

/** Who declares a cell: the engine's own list (the gate applies) or a plugin's `plugin.json` data (the gate is not put on it). */
export type KnobDeclarant = 'engine' | 'plugin';

/** The merge point of the knob list: the core built-ins plus the plugin declarations. A built-in name keeps its own cell and declarations are appended after it. */
export function knobSpecs(
  declared: Readonly<Record<string, KnobSpec>> = {},
): Record<string, KnobSpec> {
  const out: Record<string, KnobSpec> = {};
  for (const [name, cell] of Object.entries(BUILTIN_KNOBS)) {
    assertDefault(name, cell);
    out[name] = { ...cell };
  }
  for (const [name, cell] of Object.entries(declared)) {
    if (Object.hasOwn(out, name)) continue;
    assertDefault(name, cell, 'plugin');
    const merged: KnobSpec = { layers: [...CHAIN_LAYERS], ...cell };
    // A stated default that cannot be honoured is a broken cell: it keeps out of the list instead of
    // stopping every read (the plugin door drops the same cell before it gets here, and doctor says why).
    if (defaultFits(merged)) out[name] = merged;
  }
  return out;
}

/** Whether a cell's stated default can be honoured by it: a cell stating none or `null` keeps the plugin door's meaning, and a function is worked out when it is read. */
function defaultFits(spec: KnobSpec): boolean {
  const stated = spec.default;
  if (stated === undefined || stated === null || typeof stated === 'function') return true;
  return parseConfigValue(spec.kind, stated, spec.values) !== null;
}

/**
 * The declaration gate: a setting the engine declares carries a factory value, written down or worked
 * out from the project root. A declaration that leaves it out is refused right here, at the moment the
 * list is merged, and the refusal names the setting; a literal that is not of its own kind is refused
 * the same way. A `null` default is refused too: a default is required of the engine's own cells and may
 * not be null, so no reading of a core setting can land on "no value".
 *
 * A plugin declaration is not put through that gate, but its cells state a default too — `null` is its
 * spelling for "no factory value" (see `KnobSpec.default`), and a cell that leaves the key out is turned
 * away where the declaration is read. The kind of a declared default is judged where the declaration is
 * read (`declaredKnobSpecs`): a cell that cannot be honoured keeps out of the list, and doctor says why.
 */
export function assertDefault(
  name: string,
  spec: KnobSpec,
  declaredBy: KnobDeclarant = 'engine',
): void {
  const stated = spec.default;
  if (stated === undefined) {
    throw new TypeError(
      `the setting ${JSON.stringify(name)} has no default: every declaration carries one ` +
        '(a literal, or a function of the project root)',
    );
  }
  if (stated === null) {
    if (declaredBy === 'plugin') return;
    throw new TypeError(
      `the setting ${JSON.stringify(name)} has a default of null: a default is required and may not ` +
        'be null (a literal, or a function of the project root)',
    );
  }
  // A value worked out per project is checked when it is read (it takes the project root).
  if (typeof stated === 'function') return;
  if (declaredBy === 'plugin') return;
  if (parseConfigValue(spec.kind, stated, spec.values) === null) {
    throw new TypeError(
      `the setting ${JSON.stringify(name)} has a default that is not a ${spec.kind}: ${JSON.stringify(stated)}`,
    );
  }
}

/** Which layers a knob accepts: what its cell declares is followed, otherwise all four are taken. */
export function acceptedLayers(spec: KnobSpec): readonly ConfigLayerName[] {
  return spec.layers ?? CHAIN_LAYERS;
}

/**
 * One knob of a merged list: only a name the table owns counts. Every object inherits `constructor`,
 * `toString`, `__proto__` and the like, so a membership test that walks the prototype would read those
 * as settings and hand back a function where a value belongs; the table owns the knob list, and nothing
 * else does.
 */
function knobOf(
  specs: Readonly<Record<string, KnobSpec>>,
  key: string,
): KnobSpec | undefined {
  return Object.hasOwn(specs, key) ? specs[key] : undefined;
}

// ── the shape of a value: one gate per kind ──────────────────────────────────

/**
 * One value of one kind, moved into the knob's own domain; `null` when it does not move.
 * A boolean never becomes a number: it is a decision JSON spells out, and reading it as 1 would go wrong.
 * Number spellings: an integer string takes `1_000` = 1000 (underscores between digits are typography), and
 * `4.0` or `0x10` are not taken at all; a numeric string only takes a decimal spelling. `literal` is the raw
 * on-disk literal of this number (present only on the file-layer read side): a JS number has no
 * integer/float distinction, `4.0` lands as 4, and only the on-disk text tells an "integer literal" and
 * "a decimal written into an integer cell" apart — the latter is not taken.
 */
export function parseConfigValue(
  kind: ConfigKind,
  value: unknown,
  values?: readonly string[],
  literal?: string,
): ConfigValue | null {
  if (kind === 'integer') {
    if (typeof value === 'boolean') return null;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^[+-]?\d+(?:_\d+)*$/.test(text)) return null;
      value = Number(text.replace(/_/g, ''));
    }
    if (typeof value === 'number') {
      if (literal !== undefined && !/^-?\d+$/.test(literal)) return null;
      return Number.isInteger(value) && value >= 1 ? value : null;
    }
    return null;
  }
  if (kind === 'number') {
    if (typeof value === 'boolean') return null;
    if (typeof value === 'string') {
      const text = value.trim();
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
      value = Number(text);
    }
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }
  if (kind === 'word') {
    if (typeof value !== 'string') return null;
    return values === undefined || values.includes(value) ? value : null;
  }
  if (kind === 'switch') {
    return value === 'on' || value === 'off' ? value : null;
  }
  return null;
}

/**
 * The factory value of a knob: what the cell states, or what its function works out from the project
 * root. A plugin cell stating `null` reads as no value (the engine's own cells never state it).
 */
function defaultOf(spec: KnobSpec, root: string): ConfigValue | null {
  const stated = spec.default;
  if (stated === null) return null;
  const value = typeof stated === 'function' ? stated(root) : stated;
  return parseConfigValue(spec.kind, value, spec.values);
}

/** The refusal sentence of the write side: it names the key and what this kind takes (a knob with a vocabulary names the vocabulary along with it). */
function refuseMessage(key: string, spec: KnobSpec, value: unknown): string {
  const read = JSON.stringify(value) ?? String(value);
  if (spec.kind === 'number') return `${key} wants a positive number, but read ${read}`;
  if (spec.kind === 'integer') return `${key} wants a positive integer, but read ${read}`;
  if (spec.kind === 'switch') return `${key} wants on or off, but read ${read}`;
  if (spec.values !== undefined) {
    return `${key} wants one of ${JSON.stringify(spec.values)}, but read ${read}`;
  }
  return `${key} wants a word, but read ${read}`;
}

// ── the layer a verb points at ──────────────────────────────────────────────

/** The layer a verb points at, already read out of its spelling. */
interface LayerPoint {
  readonly layer: ConfigLayerName;
  readonly cycle?: string;
  readonly node?: string;
}

/** What one verb does with its layer, for the refusal sentence: a write names the layer it writes, a read the layer it reads up to. */
const LAYER_VERBS: Readonly<Record<string, string>> = {
  set: 'writes',
  unset: 'writes',
  get: 'reads up to',
  list: 'reads up to',
};

/**
 * Read the layer out of its spelling: exactly one of the four has to be named. None named, two named,
 * or a spelling that is not an object at all is refused on the spot — there is no default layer.
 */
function layerPointOf(at: ConfigLayer | undefined, verb: string): LayerPoint {
  const does = LAYER_VERBS[verb] ?? 'works on';
  if (at === null || typeof at !== 'object') {
    throw new TypeError(`${verb} needs the layer it ${does}: project / global / cycle / node.`);
  }
  const named: LayerPoint[] = [];
  const raw = at as Record<string, unknown>;
  if (raw['project'] === true) named.push({ layer: 'project' });
  if (raw['global'] === true) named.push({ layer: 'global' });
  const cycle = raw['cycle'];
  if (typeof cycle === 'string' && cycle !== '') named.push({ layer: 'cycle', cycle });
  const node = raw['node'];
  if (typeof node === 'string' && node !== '') named.push({ layer: 'node', node });
  if (named.length !== 1) {
    throw new TypeError(`${verb} points at one layer at a time: project / global / cycle / node.`);
  }
  return named[0]!;
}

/**
 * The directory one verb works in: the handle's own project root when none is named; a named directory
 * has to hold a `.pf` itself, because guessing upward would read a wider project's settings without
 * the caller noticing. A relative path is taken against the process's current directory.
 *
 * The handle's own root is a directory like any other here, and the same `.pf` refusal applies to it: a
 * fork-mode node works in its own worktree; under the own-repo layout that checkout carries no `.pf` of
 * its own, and the answer an agent gets there has to be "this is not a pf project" — never the main
 * tree's settings read quietly from a wider layer (under the in-repo layout the records travel with the
 * checkout, so that worktree answers from its own copies).
 */
function rootOf(dir: string | undefined, fallback: string): string {
  let root: string;
  if (dir === undefined || dir === null) {
    root = fallback;
  } else {
    if (typeof dir !== 'string' || dir === '') {
      throw new TypeError('the directory a setting verb works in has to be a non-empty path');
    }
    root = resolve(dir);
  }
  if (!existsSync(join(root, PF_DIR_NAME))) {
    throw new PfError(
      'not_a_project',
      root,
      `${root} holds no ${PF_DIR_NAME} of its own: this is not a pf project root. Pass the directory of ` +
        'a pf project (a directory with a .pf in it); no directory above it is tried instead.',
    );
  }
  return root;
}

// ── reading: layer by layer from the bottom ─────────────────────────────────

/**
 * Where the knobs a plugin declares come in from: a table the caller already read (the package entry for one
 * call reads the plugin folder once and hands the same copy to every reader in that call), or a reader that
 * goes and gets them for the directory being asked. The handle uses the reader: `open` keeps no plugin table
 * of its own, so the folder on disk is the answer on the call that asks, exactly as it is for every other
 * reader of a declaration.
 */
export interface DeclaredKnobSource {
  /** The knobs a plugin declares, merged into the built-in list (a built-in name keeps its own cell). */
  readonly declaredKnobs?: Readonly<Record<string, KnobSpec>>;
  /** The same table, read for the project being asked when the caller holds none. */
  readonly declaredKnobsOf?: (root: string) => Promise<Readonly<Record<string, KnobSpec>>>;
}

/** The context of `resolveConfig`: the line and node layers enter the reading only when named; home and plugin declarations go the same way as in the namespace. */
export interface ConfigResolutionOptions extends DeclaredKnobSource {
  readonly cycle?: string;
  readonly node?: string;
  readonly homeDir?: string;
}

/** The own options taken when assembling the namespace: where home is shut in, where the plugin declarations come from (not on the frozen surface). */
export interface ConfigNamespaceOptions extends DeclaredKnobSource {
  /** The home of the machine layer (`<home>/.pf/config.json`); this machine's user home directory by default, which tests shut into a temporary directory. */
  readonly homeDir?: string;
}

/**
 * The merged settings list of one project: the built-ins plus the knobs the plugins of that project declare.
 * An explicit table wins; otherwise the reader is asked with the directory this call was pointed at, so a verb
 * pointed at another project reads that project's declarations (and a handle opened where no plugin directory
 * is reads an empty list, the same way it would read no folders).
 */
async function specsFor(
  root: string,
  options: DeclaredKnobSource,
): Promise<Record<string, KnobSpec>> {
  if (options.declaredKnobs !== undefined) return knobSpecs(options.declaredKnobs);
  if (options.declaredKnobsOf !== undefined) return knobSpecs(await options.declaredKnobsOf(root));
  return knobSpecs();
}

/**
 * The knobs one file layer declares, parsed by kind. A missing file means an empty table (the ordinary
 * state); an unknown name and a knob this layer does not take are skipped, and so is a value that does
 * not match its kind — none of the three changes a reading, so the read path stays silent about them.
 * A file that cannot be read or parsed is the one thing this refuses, because then no data is there.
 */
async function readLayerValues(
  path: string,
  specs: Readonly<Record<string, KnobSpec>>,
  layer: ConfigLayerName,
): Promise<Record<string, ConfigValue>> {
  const read = await readJsonFile(path, path, { numberLiterals: true });
  if (read.kind === 'missing') return {};
  const data = read.value;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new PfError('invalid_config_file', path, `${path} must be a JSON object (key -> value)`);
  }
  const out: Record<string, ConfigValue> = {};
  for (const [key, raw] of Object.entries(data as Record<string, unknown>)) {
    const spec = knobOf(specs, key);
    if (spec === undefined) continue;
    if (!acceptedLayers(spec).includes(layer)) continue;
    const parsed = parseConfigValue(spec.kind, raw, spec.values, read.numberLiterals?.[key]);
    if (parsed === null) continue;
    out[key] = parsed;
  }
  return out;
}

/** The line layer: the knobs recognised in the `policies` slot, read loosely — an unrecognised value counts as unsaid (the old rule of the state record). */
function cycleLayerValues(
  policies: unknown,
  specs: Readonly<Record<string, KnobSpec>>,
): Record<string, ConfigValue> {
  if (policies === null || typeof policies !== 'object' || Array.isArray(policies)) return {};
  const out: Record<string, ConfigValue> = {};
  for (const [key, raw] of Object.entries(policies as Record<string, unknown>)) {
    const spec = knobOf(specs, key);
    if (spec === undefined || !acceptedLayers(spec).includes('cycle')) continue;
    const parsed = parseConfigValue(spec.kind, raw, spec.values);
    if (parsed === null) continue;
    out[key] = parsed;
  }
  return out;
}

/** Find one line's record in state.json; an id that is not there reports `cycle_not_found`. */
async function cycleRecordOf(paths: PfPaths, cycleId: string): Promise<Record<string, unknown>> {
  const read = await readJsonFile(paths.stateJson, 'state.json');
  if (read.kind === 'missing') {
    throw new PfError('cycle_not_found', paths.stateJson, `this project's record has no cycle "${cycleId}"`);
  }
  const state = read.value;
  const cycles = state !== null && typeof state === 'object' && Array.isArray((state as Record<string, unknown>).cycles)
    ? ((state as Record<string, unknown>).cycles as unknown[])
    : [];
  for (const entry of cycles) {
    if (entry !== null && typeof entry === 'object' && (entry as Record<string, unknown>).id === cycleId) {
      return entry as Record<string, unknown>;
    }
  }
  throw new PfError('cycle_not_found', paths.stateJson, `this project's record has no cycle "${cycleId}"`);
}

/**
 * A node id that is not on this project's graph reports `node_not_found`: the node layer is never
 * created for the caller.
 *
 * On the graph means the node table *owns* the id: the table is a plain object, so a membership test
 * that walked the prototype would count `constructor`, `__proto__`, `toString` and the rest as nodes
 * that were never added — a write would mint a directory for one of them, and a read would answer from
 * a wider layer under a name the graph has never heard of.
 */
async function requireNode(paths: PfPaths, nodeId: string): Promise<void> {
  const read = await readJsonFile(paths.ideasJson, 'ideas.json');
  const node: unknown = read.kind === 'present' && read.value !== null && typeof read.value === 'object' && !Array.isArray(read.value)
    ? (read.value as Record<string, unknown>)['nodes']
    : undefined;
  const table = node !== null && typeof node === 'object' && !Array.isArray(node)
    ? (node as Record<string, unknown>)
    : {};
  if (!Object.hasOwn(table, nodeId)) {
    throw new PfError('node_not_found', paths.ideasJson, `this project's graph has no node "${nodeId}"`);
  }
}

/**
 * The one line holding this node right now: `null` when no line holds it (then the node has no
 * line-layer value and the line layer is skipped), and a refusal naming the lines when more than one
 * holds it — a record that puts one node in two lines' hands is inconsistent, and guessing which one is
 * meant would answer with a value that is not in force. The claim list is read through the engine's one
 * holder reader (`cycleHoldingIds`), so both on-disk shapes count: the canonical `[{ id, since }]` and
 * the old bare id string.
 */
async function cycleHoldingNode(paths: PfPaths, nodeId: string): Promise<string | null> {
  const read = await readJsonFile(paths.stateJson, 'state.json');
  if (read.kind === 'missing') return null;
  const state = read.value;
  const cycles = state !== null && typeof state === 'object' && Array.isArray((state as Record<string, unknown>).cycles)
    ? ((state as Record<string, unknown>).cycles as unknown[])
    : [];
  const holders: string[] = [];
  for (const entry of cycles) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (!cycleHoldingIds(record as unknown as CycleRecord).includes(nodeId)) continue;
    holders.push(typeof record.id === 'string' ? record.id : '(a line with no id)');
  }
  if (holders.length > 1) {
    throw new PfError(
      'ambiguous_holder',
      paths.stateJson,
      `the node ${JSON.stringify(nodeId)} is held by ${String(holders.length)} lines at once ` +
        `(${holders.join(', ')}): one node is held by one line at a time, so this node's reading ` +
        'cannot be placed on the line layer; nothing was read from it.',
    );
  }
  return holders[0] ?? null;
}

/**
 * The reading of the chain: the declaration's default underneath, then the wide layers (global →
 * project, unless the caller reads up to the machine layer alone) → the line layer, then the node layer,
 * each laid on top; the one laid on last takes effect, and the source follows the last layer that laid a
 * value. A node read takes the line holding that node as its line layer (see `cycleHoldingNode`).
 */
async function chainValues(
  root: string,
  options: ConfigResolutionOptions,
  narrow: { readonly cycle?: string; readonly node?: string },
  wide: readonly ConfigLayerName[] = ['global', 'project'],
  resolved?: Record<string, KnobSpec>,
): Promise<Record<string, ConfigReading>> {
  const paths = pfPaths(root);
  const specs = resolved ?? (await specsFor(root, options));
  const out: Record<string, ConfigReading> = {};
  for (const [key, spec] of Object.entries(specs)) {
    out[key] = { value: defaultOf(spec, root), source: 'builtin' };
  }
  const stated: Array<[ConfigLayerName, Record<string, ConfigValue>]> = [];
  for (const layer of wide) {
    if (layer === 'global') {
      stated.push(['global', await readLayerValues(globalConfigPath(options.homeDir), specs, 'global')]);
    } else if (layer === 'project') {
      stated.push(['project', await readLayerValues(paths.configJson, specs, 'project')]);
    }
  }
  if (narrow.cycle !== undefined) {
    const record = await cycleRecordOf(paths, narrow.cycle);
    stated.push(['cycle', cycleLayerValues(record.policies, specs)]);
  } else if (narrow.node !== undefined) {
    // The line layer of a node read is the line holding it: none means the node has no value there.
    const holder = await cycleHoldingNode(paths, narrow.node);
    if (holder !== null) {
      const record = await cycleRecordOf(paths, holder);
      stated.push(['cycle', cycleLayerValues(record.policies, specs)]);
    }
  }
  if (narrow.node !== undefined) {
    stated.push(['node', await readLayerValues(nodeConfigPath(paths, narrow.node), specs, 'node')]);
  }
  for (const [layer, values] of stated) {
    for (const [key, value] of Object.entries(values)) {
      out[key] = { value, source: layer };
    }
  }
  return out;
}

/** The chain one named layer asks for: reading up to `global` stops at the machine layer, up to `project` takes both wide layers, and the two narrow layers add themselves on top. */
function chainUpTo(at: LayerPoint | undefined): {
  narrow: { readonly cycle?: string; readonly node?: string };
  wide: readonly ConfigLayerName[];
} {
  if (at === undefined) return { narrow: {}, wide: ['global', 'project'] };
  if (at.layer === 'global') return { narrow: {}, wide: ['global'] };
  if (at.layer === 'project') return { narrow: {}, wide: ['global', 'project'] };
  return { narrow: { cycle: at.cycle, node: at.node }, wide: ['global', 'project'] };
}

/**
 * The reading of the whole chain of one project: the declaration's default underneath, global → project,
 * and the line / node layers when they are named. The namespace's `get` / `list` reach the same reading
 * through a named layer; this entry is the whole chain, for the callers inside the package.
 */
export async function resolveConfig(
  root: string,
  options: ConfigResolutionOptions = {},
): Promise<Record<string, ConfigReading>> {
  return chainValues(root, options, { cycle: options.cycle, node: options.node });
}

// ── writing: one layer at a time ────────────────────────────────────────────

/** The read-change-write of one layer file as a whole document: unknown keys are kept as they are, and a document that is not an object is rewritten as an empty table. */
async function writeLayerFile(path: string, key: string, stored: ConfigValue | null): Promise<void> {
  const read = await readJsonFile(path);
  let data: Record<string, unknown> = {};
  if (read.kind === 'present' && read.value !== null && typeof read.value === 'object' && !Array.isArray(read.value)) {
    data = read.value as Record<string, unknown>;
  }
  if (stored === null) delete data[key];
  else data[key] = stored;
  await atomicWriteJson(path, data);
}

/**
 * Writing the line layer: the `policies` slot of this line's record in `state.json`, read and rewritten as
 * a whole document, past the init gate first, holding the lock throughout. After everything is taken off,
 * the emptied `policies` slot stays on the record, and `updated_at` moves with every write.
 */
async function writeCyclePolicy(
  paths: PfPaths,
  cycleId: string,
  key: string,
  stored: ConfigValue | null,
): Promise<void> {
  assertLedgerInitialized(paths);
  await withLedgerLock(paths, async () => {
    const read = await readJsonFile(paths.stateJson, 'state.json');
    const state = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
      ? (read.value as Record<string, unknown>)
      : {};
    const cycles = Array.isArray(state.cycles)
      ? (state.cycles as Array<Record<string, unknown>>)
      : [];
    const record = cycles.find(
      (entry) => entry !== null && typeof entry === 'object' && entry.id === cycleId,
    );
    if (record === undefined) {
      throw new PfError(
        'cycle_not_found',
        paths.stateJson,
        `this project's record has no cycle "${cycleId}"`,
      );
    }
    const stated = record.policies !== null && typeof record.policies === 'object' && !Array.isArray(record.policies)
      ? (record.policies as Record<string, unknown>)
      : {};
    if (stored === null) delete stated[key];
    else stated[key] = stored;
    record.policies = stated;
    record.updated_at = nowSeconds();
    await atomicWriteJson(paths.stateJson, state, jsonOptionsForRecord('state'));
  });
}

/** Where one layer's settings land: the project file, the machine file, one line's record, one node's own file. */
function layerPathOf(paths: PfPaths, point: LayerPoint, options: ConfigNamespaceOptions): string {
  if (point.layer === 'global') return globalConfigPath(options.homeDir);
  if (point.layer === 'node') return nodeConfigPath(paths, point.node as string);
  if (point.layer === 'cycle') return paths.stateJson;
  return paths.configJson;
}

/**
 * The one gate of writing: the name is on the list, this layer takes it, the line or node it points at
 * exists, the value matches the kind — only all four open the way to a location. The merged list is worked
 * out once per call and handed in, so the name's kind and the layers it takes are read off one table.
 */
async function validated(
  root: string,
  key: string,
  value: ConfigValue | null,
  point: LayerPoint,
  specs: Readonly<Record<string, KnobSpec>>,
): Promise<{ spec: KnobSpec; stored: ConfigValue | null }> {
  const paths = pfPaths(root);
  const spec = knobOf(specs, key);
  if (spec === undefined) {
    throw new PfError(
      'unknown_key',
      paths.configJson,
      `unknown key ${JSON.stringify(key)}; configurable: ${Object.keys(specs).sort().join(', ')}`,
    );
  }
  const allowed = acceptedLayers(spec);
  if (!allowed.includes(point.layer)) {
    throw new PfError(
      'layer_not_allowed',
      paths.configJson,
      `${key} does not take the ${point.layer} layer (it takes: ${allowed.join(', ')}); nothing was written`,
    );
  }
  // The narrow layers point at a line or a node by id: an id that is not there is refused, never created.
  if (point.layer === 'cycle') await cycleRecordOf(paths, point.cycle as string);
  if (point.layer === 'node') await requireNode(paths, point.node as string);
  let stored: ConfigValue | null = null;
  if (value !== null) {
    stored = parseConfigValue(spec.kind, value, spec.values);
    if (stored !== null && (spec.kind === 'number' || spec.kind === 'integer') && typeof stored === 'number' && stored <= 0) {
      stored = null;
    }
    if (stored === null) {
      throw new PfError('invalid_value', paths.configJson, refuseMessage(key, spec, value));
    }
  }
  return { spec, stored };
}

/**
 * Land one write on exactly one layer. The project and node layers go past the init gate first and hold
 * the record tree's lock throughout; the line layer goes through the record's own writer (the same gate
 * and lock), and the machine layer is this machine's own file, outside that tree.
 *
 * The node layer is looked up again inside the lock: the check in `validated` is a read with no lock, so
 * a `dag.remove` landing between the two would otherwise have its directory brought back by the atomic
 * write (which makes the directory it writes into). Inside the lock the node is either still on the
 * graph or the write refuses with `node_not_found`.
 */
async function landWrite(
  paths: PfPaths,
  point: LayerPoint,
  key: string,
  stored: ConfigValue | null,
  options: ConfigNamespaceOptions,
): Promise<void> {
  if (point.layer === 'cycle') {
    await writeCyclePolicy(paths, point.cycle as string, key, stored);
    return;
  }
  const path = layerPathOf(paths, point, options);
  if (point.layer === 'project') {
    assertLedgerInitialized(paths);
    await withLedgerLock(paths, () => writeLayerFile(path, key, stored));
    return;
  }
  if (point.layer === 'node') {
    assertLedgerInitialized(paths);
    const nodeId = point.node as string;
    await withLedgerLock(paths, async () => {
      await requireNode(paths, nodeId);
      await writeLayerFile(path, key, stored);
    });
    return;
  }
  await writeLayerFile(path, key, stored);
}

// ── the namespace ───────────────────────────────────────────────────────────

/** Assemble the config namespace (the real implementation; home and the source of the plugin declarations are taken from its own options, and the frozen surface does not change). */
export function createConfigNamespace(
  root: string,
  options: ConfigNamespaceOptions = {},
): ConfigNamespace {
  // The merged list is worked out once per call and handed down: a caller that has a table or a reader is
  // asked one time, and every reader of the name's kind, layers and default looks at the same copy.
  const specsHere = (rootHere: string): Promise<Record<string, KnobSpec>> => specsFor(rootHere, options);

  /** The refusal of a name that is not on the list; its location is the project layer of the directory the verb was pointed at. */
  const unknownKey = (key: string, rootHere: string, specs: Readonly<Record<string, KnobSpec>>): PfError => {
    return new PfError(
      'unknown_key',
      pfPaths(rootHere).configJson,
      `unknown key ${JSON.stringify(key)}; configurable: ${Object.keys(specs).sort().join(', ')}`,
    );
  };

  /**
   * The read side's gate on a node layer, the same one a write goes through: the id is resolved against
   * the graph before anything is read, so a mistyped id is refused instead of answering with a wider
   * layer's value. A node that is on the graph but has no settings file of its own is not an error —
   * that layer yields nothing and the reading goes on below it.
   */
  const resolveReadNode = async (point: LayerPoint | undefined, rootHere: string): Promise<void> => {
    if (point !== undefined && point.layer === 'node' && point.node !== undefined) {
      await requireNode(pfPaths(rootHere), point.node);
    }
  };

  return {
    get: async (key: string, at?: ConfigLayer, dir?: string) => {
      const rootHere = rootOf(dir, root);
      const specs = await specsHere(rootHere);
      // The key side is an own-property question too: a name every object inherits is not a setting,
      // and answering it would hand back a function where `{ value, source }` belongs.
      const spec = knobOf(specs, key);
      if (spec === undefined) throw unknownKey(key, rootHere, specs);
      const point = at === undefined || at === null ? undefined : layerPointOf(at, 'get');
      if (point !== undefined && !acceptedLayers(spec).includes(point.layer)) {
        throw new PfError(
          'layer_not_allowed',
          pfPaths(rootHere).configJson,
          `${key} does not take the ${point.layer} layer (it takes: ${acceptedLayers(spec).join(', ')}); nothing was read`,
        );
      }
      await resolveReadNode(point, rootHere);
      const chain = chainUpTo(point);
      const readings = await chainValues(rootHere, options, chain.narrow, chain.wide, specs);
      return readings[key]!;
    },

    set: async (key: string, value: ConfigValue, at: ConfigLayer, dir?: string) => {
      const rootHere = rootOf(dir, root);
      const point = layerPointOf(at, 'set');
      const specs = await specsHere(rootHere);
      const { stored } = await validated(rootHere, key, value, point, specs);
      await landWrite(pfPaths(rootHere), point, key, stored, options);
    },

    unset: async (key: string, at: ConfigLayer, dir?: string) => {
      const rootHere = rootOf(dir, root);
      const point = layerPointOf(at, 'unset');
      const specs = await specsHere(rootHere);
      await validated(rootHere, key, null, point, specs);
      await landWrite(pfPaths(rootHere), point, key, null, options);
    },

    list: async (at?: ConfigLayer, dir?: string) => {
      const rootHere = rootOf(dir, root);
      const point = at === undefined || at === null ? undefined : layerPointOf(at, 'list');
      await resolveReadNode(point, rootHere);
      const chain = chainUpTo(point);
      return chainValues(rootHere, options, chain.narrow, chain.wide, await specsHere(rootHere));
    },

    keys: async (dir?: string) => {
      const specs = await specsHere(rootOf(dir, root));
      // The settings a get / set / unset answers about: every knob that takes the project layer, in the
      // order the help lists them (the names sorted). A machine-layer knob is not among them.
      return Object.keys(specs)
        .filter((name) => acceptedLayers(specs[name]!).includes('project'))
        .sort();
    },
  };
}

// ── the worktree mode: one knob read as a mode ──────────────────────────────

/** The mode this engine works in: `off` works straight on the main tree, `fork` gives every node a worktree of its own. The third mode `reuse` is refused as soon as it is read. */
export type WorktreeMode = 'off' | 'fork';

/** The options of `worktreeModeOf`: where the machine layer's home is shut in (tests shut it into a temporary directory). */
export interface WorktreeModeOptions {
  readonly homeDir?: string;
}

/**
 * This project's worktree mode right now: the `worktree_mode` knob read through the whole chain of
 * this module (the factory default is worked out per project — `fork` in a git project, `off`
 * otherwise). `reuse` is refused on the spot: this engine has the `off` and `fork` modes, and the
 * `reuse` mode is not built here yet — the mode is handed back instead of a pool being kept.
 */
export async function worktreeModeOf(
  root: string,
  options: WorktreeModeOptions = {},
): Promise<WorktreeMode> {
  const config = createConfigNamespace(root, { homeDir: options.homeDir });
  const value = (await config.get('worktree_mode')).value;
  if (value === 'off' || value === 'fork') return value;
  throw new PfError(
    'worktree_mode_unsupported',
    pfPaths(root).configJson,
    `worktree_mode is ${JSON.stringify(value)}; this engine works in the off and fork modes, and ` +
      `the reuse mode is not built here yet. Set the mode on the chain (worktree_mode off|fork) ` +
      `and run again.`,
  );
}
