import type { ConfigKind, ConfigValue } from '../config';
import type { NodeRecord } from '../types';

/**
 * The declaration surface and the runtime contract of plugins: the kinds, the timings, the actions, the closed
 * sets of declaration keys, the shape of an offer / gate / command, and the context the host hands to an
 * implementation. The closed sets and vocabularies are fixed cell by cell:
 *
 * - **four kinds and no others** (number / integer / word / switch): a declared kind cell may only use these
 *   four, and a fifth would be a change to the core that must not come in with a plugin.
 * - **two timings** (close / dispatch) and **two actions** (insert / block), the two axes making one cell: the
 *   cells the core really serves are only (close, insert) and (dispatch, block). A declaration outside that table
 *   is refused as a declaration problem, so every cell the vocabulary accepts is one a gate really asks about.
 * - **a declaration is a pure data file**: listing, help and the check-up all read it, and loading never
 *   executes it; the implementation (the impl entry) is another thing in the folder, called only by a timing's
 *   gate.
 * - the seam has only two timings: the close insertion and the dispatch block. A timing the runtime never asks
 *   about is not in the vocabulary at all — the vocabulary and the table above are one set, not two, so no
 *   declaration passes the check on a cell that can never fire.
 */

/** The kind of a declared knob cell: the same four as the settings chain, plugins add no kind. */
export type PluginKnobKind = ConfigKind;

/** The timing a plugin may act at: close / dispatch. */
export type PluginTiming = 'close' | 'dispatch';

/** What a plugin may do at a timing: put a node into the graph, or block a gate. */
export type PluginAction = 'insert' | 'block';

/** The (timing, action) cells the core really serves; a declaration outside this table is a declaration problem. */
export const TIMING_ACTION_CELLS: ReadonlyArray<readonly [PluginTiming, PluginAction]> = [
  ['close', 'insert'],
  ['dispatch', 'block'],
];

/** The reading source the core ships with: the number a worker reports under outputs.reading of its ticket. Other sources are the ones a declaration claims. */
export const CORE_READING_SOURCES: readonly string[] = ['ticket'];

/** The closed set of top-level declaration keys; a key outside this set is a declaration problem (an unknown key is refused). */
export const DECLARATION_KEYS: readonly string[] = [
  'name',
  'summary',
  'enable_knob',
  'timing',
  'action',
  'commands',
  'sources',
  'files',
  'knobs',
  'readings',
  'metrics',
];

/** The closed set of keys of a knob cell (an unknown key is refused). `default` is on the list and is always stated: `null` is the one spelling for "no factory value". */
export const KNOB_CELL_KEYS: readonly string[] = ['kind', 'default', 'values', 'layers', 'summary'];

/** The closed set of keys of a reading cell. */
export const READING_CELL_KEYS: readonly string[] = ['source', 'ask', 'when_knob'];

/** The closed set of keys of a metric cell. */
export const METRIC_CELL_KEYS: readonly string[] = ['line', 'tag', 'method'];

/** The closed set of keys of a source cell: a claimed source names the implementation function that computes this number. */
export const SOURCE_CELL_KEYS: readonly string[] = ['by'];

/** The closed set of keys of a command cell: the one line printed by `--help`, and whether the command word travels with argv. */
export const COMMAND_CELL_KEYS: readonly string[] = ['summary', 'keep_name'];

/**
 * One declared knob cell: the kind and the default are required, the rest follows the kind (a word's
 * vocabulary, narrowed layers, one-line description). `default` is always stated and takes `null` as the
 * one spelling for "no factory value at all"; leaving the key out is a declaration problem, and a plugin
 * with a declaration problem takes no part at all.
 */
export interface PluginKnobCell {
  readonly kind?: unknown;
  readonly default: unknown;
  readonly values?: unknown;
  readonly layers?: unknown;
  readonly summary?: unknown;
}

/** One declared reading cell: which source the number comes from (the core's ticket, or one the plugin claims), when it is asked, and the question it asks. */
export interface PluginReadingCell {
  readonly source?: unknown;
  readonly ask?: unknown;
  readonly when_knob?: unknown;
}

/** One declared metric cell: which line it is compared against, what dedupe tag to write, and what the skill method is called. */
export interface PluginMetricCell {
  readonly line?: unknown;
  readonly tag?: unknown;
  readonly method?: unknown;
}

/** One claimed reading source: `by` names the function in the impl entry that computes this number. */
export interface PluginSourceCell {
  readonly by?: unknown;
}

/** One declared command: a one-line description (required), and whether the command word travels with argv (it does by default). */
export interface PluginCommandCell {
  readonly summary?: unknown;
  readonly keep_name?: unknown;
}

/** One declaration (the content of plugin.json). Read-only once parsed; a cell key outside its own closed set is a declaration problem. */
export interface PluginDeclaration {
  readonly name?: unknown;
  readonly summary?: unknown;
  readonly enable_knob?: unknown;
  readonly timing?: unknown;
  readonly action?: unknown;
  readonly commands?: unknown;
  readonly sources?: unknown;
  readonly files?: unknown;
  readonly knobs?: unknown;
  readonly readings?: unknown;
  readonly metrics?: unknown;
}

/** One cell of the load scan: a plugin folder, whose folder name is its identity. When the declaration cannot be read, decl is null and problems says why. */
export interface PluginFolder {
  /** The folder name: the plugin's identity; the name in the declaration must match it. */
  readonly name: string;
  /** The absolute path of the folder. */
  readonly folder: string;
  /** The parsed declaration; null when it cannot be read. */
  readonly decl: PluginDeclaration | null;
  /** The problems of reading the declaration (no declaration, bad bytes, does not parse, not an object); an empty table means the declaration is readable. */
  readonly problems: readonly string[];
}

/** The name in the declaration and, when the declaration is readable, its summary — what doctor lists. */
export interface PluginListing {
  readonly name: string;
  readonly summary: string;
}

/** The insertion wish a plugin hands back: one node declared (title, tags, body builder) together with its own words (why, a one-line account, its own data). */
export interface PluginOffer {
  /** The node title: a non-empty string. */
  readonly title: string;
  /** The node tags: a table of strings, not one string (a single string would be taken as a tag per character). */
  readonly tags?: readonly string[];
  /** The node body: a builder taking the node id (the uuid does not exist before the node is set up, so a placeholder stands in first). */
  readonly spec_of: (nodeId: string) => string | Promise<string>;
  /** The plugin's own data, which the core carries along as it is and does not interpret; keys that collide with the action's own are taken off (with a warning). */
  readonly fields?: Record<string, unknown>;
  /** A one-line account (prose, carried to the reader as it is). */
  readonly note?: string;
  /** The plugin's own reason sentence (prose, printed as it is). */
  readonly why?: string;
}

/** The insertion wish after shape validation (the host's internal shape: spec_of has settled into a function, defaults filled in). */
export interface NormalizedOffer {
  readonly plugin: string;
  readonly title: string;
  readonly tags: string[];
  readonly specOf: (nodeId: string) => string | Promise<string>;
  readonly fields: Record<string, unknown>;
  readonly note: string;
  readonly why: string;
}

/**
 * The shape of a plugin implementation entry: an insert timing asks offer, a block timing asks check, and a command hands argv to main.
 *
 * **A timing also owes its rehearsal.** A plugin that wants to act at a timing must ship the preview of that
 * action beside it (`offer_preview` / `check_preview`), answering the same question on a context that may read
 * but must not write. A plugin without one still works at the real timing; in a rehearsal (`--dry-run`) it is
 * skipped and the round carries one WARNING naming it, because a preview that skipped it silently would be a
 * picture that lies by omission.
 */
export interface PluginImplModule {
  /** The gate of the insert timing: hand back a PluginOffer, or "I have nothing to say this round" (null / empty). */
  offer?: (ctx: PluginContext) => unknown | Promise<unknown>;
  /** The rehearsal of the insert gate: what this timing would offer, on a context that may read but must not write. */
  offer_preview?: (ctx: PluginContext) => unknown | Promise<unknown>;
  /** The gate of the block timing: hand back the blocking reason sentence, or an empty value to let it through. */
  check?: (ctx: PluginContext) => unknown | Promise<unknown>;
  /** The rehearsal of the block gate: what it would say now, on a context that may read but must not write. */
  check_preview?: (ctx: PluginContext) => unknown | Promise<unknown>;
  /** The gate of a command: run this word in this process and hand back an output string, an exit code, or just do the work. */
  main?: (argv: readonly string[], ctx: PluginContext) => unknown | Promise<unknown>;
  /** The computing function of a claimed source: its name comes from the declaration's sources.<name>.by. */
  [key: string]: unknown;
}

/** The graph reading handed to a plugin: the node table snapshot the caller already read (a plugin cannot bypass it and read the records again). */
export interface PluginGraphSnapshot {
  readonly nodes: Readonly<Record<string, NodeRecord>>;
}

/** Where a plugin inserts at close time: behind the node being closed, before the node originally picked. */
export interface PluginInsertTarget {
  readonly id?: string;
  readonly title?: string;
}

/**
 * The host context: everything a plugin can see at one timing, and nothing outside this surface.
 * What it gets is the scene the caller has already read — the line record, the node in hand, the ticket, the
 * graph snapshot — and not the path of the record directory, nor any gate that would read the records again;
 * a plugin therefore cannot read behind the project.
 */
export interface PluginContext {
  /** The project root (the spelling open received, as it is). */
  readonly root: string;
  /** Whether this round is a rehearsal (`--dry-run`), and the door being asked is its preview: the context can read, and `run` refuses. */
  readonly preview?: boolean;
  /** This line's record (the scene of a close / dispatch); an empty object when there is no line. */
  readonly cycle: Readonly<Record<string, unknown>>;
  /** The id of the node in hand (the one being closed, at close time); null when there is none. */
  readonly nodeId: string | null;
  /** This node's handoff record (outputs.reading of the ticket is where the ticket reading comes from); null when there is none. */
  readonly sig: unknown;
  /** The graph snapshot: the node table the caller already read. */
  readonly dag: PluginGraphSnapshot;
  /** Where the insertion lands (the node originally picked); the closing seam has no picking step, so it is always null (the shape is left for downstream). */
  readonly target: PluginInsertTarget | null;
  /** The chain-wide effective value of one knob; null when nobody on the chain says anything and there is no factory value. */
  knob(name: string): Promise<ConfigValue | null>;
  /** One reading's number: the one the ticket reports, or the one computed by a claimed source; null when there is none. */
  reading(key: string): Promise<number | null>;
  /** The ids of the nodes still open (todo) and carrying this tag, handed back sorted. */
  nodesWithTag(tag: string): string[];
  /** Run one plugin command in this process and hand back the text it answers; null when there is no answer (no such command, a failure, not text). */
  capture(argv: readonly string[]): Promise<string | null>;
  /**
   * Run one plugin command in this process, where the effect is the point, and hand back whether it really
   * ran: `false` for a word nobody routes, for a routed command whose implementation has no `main()`, and for
   * a command that threw (a failure leaves one warning besides); `true` for a command that ran to its end,
   * whether or not it answered any text. In a rehearsal (`preview`) this refuses — `false`, and one WARNING
   * line naming the command: an effect belongs to the real timing.
   */
  run(argv: readonly string[]): Promise<boolean>;
  /** The location of one node's spec.md (this tree's own layout, told to the plugin as it is). */
  specPath(nodeId: string): string;
}

/** One plugin command in the routing table: the word, the owning plugin, whether the word travels with argv, and the one line of `--help`. */
export interface PluginCommandEntry {
  readonly name: string;
  readonly plugin: string;
  readonly keepName: boolean;
  readonly summary: string;
}

/** One row of the merged reading table: which plugin's which key, from what source, and which function computes it when the source is a claimed one. */
export interface PluginReadingEntry {
  readonly plugin: string;
  readonly key: string;
  readonly source: string;
  /** The implementation function name of a claimed source; an empty string for the core's own ticket source. */
  readonly by: string;
  readonly ask: string;
  readonly whenKnob: string;
}

/** One cell of a plugin's own skill in the doctor listing: the language, the method name, the skill folder. */
export interface PluginSkillFolder {
  readonly lang: string;
  readonly method: string;
  readonly folder: string;
}
