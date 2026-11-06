/**
 * The words layer's own shapes: the table row and its cells, the spec a row becomes, the parse
 * result, the call a verb receives, and the answer the layer hands back. Nothing here is a second
 * spelling of a record type — these are the words layer's own.
 */

/** One option cell of a table row (the help word included). */
export interface OptionCell {
  readonly flags: readonly string[];
  readonly help?: string;
  readonly metavar?: string;
  readonly nargs?: string;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  /** Where the parser writes the value; the flags' own spelling by default. */
  readonly dest?: string;
  /** A repeated option's usage prints the metavar twice; the first flag is the one it names. */
  readonly usageFlag?: string;
}

/** One positional cell of a table row. */
export interface PositionalCell {
  readonly name: string;
  readonly metavar?: string;
  readonly required?: boolean;
  readonly nargs?: string;
  readonly choices?: readonly string[];
  readonly help?: string;
  /**
   * The name a refusal prints for this cell (`argument <dest>: invalid choice …`). A cell whose
   * `name` spells its choices (`{active,inactive}`) still prints the role it stands for (`status`);
   * absent, the name is the role.
   */
  readonly dest?: string;
}

/** One mutually exclusive group of flags on a table row. */
export type ExclusiveCell = readonly string[];

/** One leaf word's row (a group's verb carries its `group`). */
export interface WordRow {
  readonly word: string;
  readonly prog: string;
  readonly group?: string;
  readonly description?: string | null;
  readonly epilog?: string | null;
  readonly positionals?: readonly PositionalCell[];
  readonly options?: readonly OptionCell[];
  readonly exclusive?: readonly ExclusiveCell[];
  /** A group row's verbs, each the row it prints and runs. */
  readonly commands?: readonly WordRow[];
  /** A group row's sub-command metavar (`<command>` by default). */
  readonly metavar?: string;
  /** The name a group's refusal prints for its sub-command (`cycle_command`, `dag_command`, …). */
  readonly dest?: string;
  /** A group verb's one-line sense, where the row carries no help cell of its own. */
  readonly summary?: string;
  /** A group verb's listing sense, where the row carries one. */
  readonly help?: string;
}

/** The top of the table: the program name and the two listings' order. */
export interface TableTop {
  readonly prog: string;
  readonly verbs: readonly string[];
  readonly groups: readonly string[];
}

/** One cell of a spec's action list (a row laid out for the printer and the parser). */
export interface SpecAction {
  readonly kind: 'option' | 'positional' | 'subparsers';
  readonly flags?: readonly string[];
  readonly help?: string;
  readonly metavar?: string;
  readonly nargs?: string;
  readonly required?: boolean;
  readonly choices?: readonly string[];
  readonly isHelp?: boolean;
  readonly usageFlag?: string;
  readonly exclusive?: { readonly title: string; readonly position: number };
  readonly name?: string;
  readonly dest?: string;
  readonly cellName?: string;
  readonly commands?: readonly (WordSpec & { readonly word: string; readonly help?: string })[];
  /** The action list the printer and the parser walk. */
}

/** One command as the printer and the parser read it: a row turned into an action list. */
export interface WordSpec {
  readonly word: string;
  readonly group?: string;
  readonly prog: string;
  readonly description?: string;
  readonly epilog?: string;
  actions(): readonly SpecAction[];
}

/** One parsed line of words: values by dest, positionals as word lists, or a help word / a refusal. */
export interface ParsedLine {
  readonly help?: boolean;
  readonly error?: string;
  readonly verb?: string;
  readonly subcommand?: WordSpec;
  readonly values?: Record<string, any>;
  readonly positionals?: readonly (readonly string[])[];
}

/** The seams one call is handed in from outside: explicit, never read off this process. */
export interface WordsIO {
  /** The directory the caller stands in; a word that names no `--project` reads the project here. */
  readonly root: string;
  /** The executor handed to every handle this call opens (a process that opens no sessions still answers the read words). */
  readonly executor?: Executor;
  /** The git capability handed to the calls that ask git (`init`, `register`, `doctor`). */
  readonly git?: GitRunner;
  /** The machine layer's home (`<home>/.pf/config.json`). */
  readonly homeDir?: string;
  /** The plugin folder the handles scan; the engine's default (`<root>/plugins`) when absent. */
  readonly pluginsDir?: string;
  /** Whether this call may really open a session (`dispatch` and `advance` answer honestly without one). */
  readonly openerAvailable?: boolean;
  /**
   * The bytes a word asked to read `-` takes as its input (`handoff -o -`). The caller's own source,
   * handed in like every other seam: a call without one refuses `-` by name, because a word answered
   * inside a long-lived process has no stream here that ever ends.
   */
  readonly readInput?: () => Promise<string>;
  /**
   * The package root this call answers from: the words about this checkout (`version`, and the first
   * line of `doctor`) print it. A caller that knows where it is deployed hands it in; absent, the
   * package this module sits in answers, which is the engine product's own root.
   */
  readonly packageRoot?: string;
}

import type { Executor } from '../executor';
import type { GitRunner } from '../git';

/** What one verb answers with: the two streams and the exit code. */
export interface VerbAnswer {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** The cells the router hands one verb: the parsed line, the printer's pieces, and the caller's seams. */
export interface VerbCall {
  readonly values: Record<string, any>;
  readonly positionals: readonly (readonly string[])[];
  readonly spec: WordSpec;
  readonly helpText: (spec: WordSpec) => string;
  readonly specOf: (row: WordRow, knobs?: readonly string[]) => WordSpec;
  readonly groupFor: (word: string) => WordRow | undefined;
  readonly io: WordsIO;
  /**
   * The knob names in force for this call, read once from the engine before any settings page is
   * built: the settings verbs print and refuse against this list. Passed in with the call, never kept
   * in a module-level cell — one long-lived process answers for several projects.
   */
  readonly configKnobs?: readonly string[];
}
