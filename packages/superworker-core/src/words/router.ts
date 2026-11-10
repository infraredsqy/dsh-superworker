/**
 * The router: one line of words in, one answer out — the two streams and the exit code, spelled the
 * same way the transport layer in front of the engine writes them.
 *
 * Level 2 is a verb (it acts on the project or on the pipeline itself); level 3 is a noun plus the
 * verb that acts on it. The router walks the same table the help prints, so a word cannot be
 * printable and unroutable at once; a word an installed plugin declares is routed last, after the
 * words this layer owns, and is run through the plugin contract in this process.
 *
 * Nothing here is a second implementation of anything: a word either lands on an engine action
 * (through the verbs modules) or on the plugin that declared it. The three words that are answers
 * about the *process* — the checkout's doctor, its version, and the merge driver's process hand-off —
 * are routed here like every other word; what the transport in front of this layer decides is whether
 * it carries them, not whether this table does.
 */
import { specOf, rowFor, groupFor } from './spec';
import { CORE_COMMAND_WORDS, CORE_HELP_WORDS, CORE_SELF_VERBS } from './core-words';
import { helpText, listingBlock, parse, senseColumnOf, usageError, wrap } from './argparse';
import type { ListingGeometry } from './argparse';
import { handleOf, projectRootOf, refuse } from './out';
import type { VerbHandler } from './out';
import { TABLE_TOP } from './table';
import * as verbs from './verbs';
import { planVerb } from './plan';
import { settleVerb } from './settle';
import { advanceVerb, dispatchVerb } from './advance';
import type { VerbAnswer, VerbCall, WordRow, WordSpec, WordsIO } from './types';

/** The words this layer answers before it consults any table: the listing and the two help flags (one spelling, shared with the core's own word set). */
const HELP_WORDS = CORE_HELP_WORDS;

/** The knob names a folder with no `.superworker` of its own can still be asked for: the engine's three core settings. */
const CORE_CONFIG_KEYS = ['max_agents', 'test_tier', 'worktree_mode'];

/** The words the tool itself runs: word → the form `--help` prints, the one line of sense (one home, shared with the core's own word set). */
const SELF_VERBS = CORE_SELF_VERBS;

/**
 * Every routed word and the handler that answers it: the top-level verbs by their word, a group's
 * verbs as `"<group> <verb>"`. The references are typed, so a renamed handler is a compile error
 * rather than a word that only degrades to "not wired" at run time.
 */
const HANDLERS: Record<string, VerbHandler> = {
  init: verbs.initVerb,
  register: verbs.registerVerb,
  migrate: verbs.migrateVerb,
  plan: planVerb,
  hold: verbs.holdVerb,
  settle: settleVerb,
  advance: advanceVerb,
  dispatch: dispatchVerb,
  'clean-temp': verbs.cleanTempVerb,
  handoff: verbs.handoffVerb,
  doctor: verbs.doctorVerb,
  version: verbs.versionVerb,
  'merge-ledger': verbs.mergeLedgerVerb,
  'cycle create': verbs.cycleCreateVerb,
  'cycle start': verbs.cycleStartVerb,
  'cycle rename': verbs.cycleRenameVerb,
  'cycle status': verbs.cycleStatusVerb,
  'cycle policy': verbs.cyclePolicyVerb,
  'cycle list': verbs.cycleListVerb,
  'cycle current': verbs.cycleCurrentVerb,
  'cycle show': verbs.cycleShowVerb,
  'cycle close': verbs.cycleCloseVerb,
  'cycle retry': verbs.cycleRetryVerb,
  'dag add': verbs.dagAddVerb,
  'dag rm': verbs.dagRmVerb,
  'dag update': verbs.dagUpdateVerb,
  'dag depend': verbs.dagDependVerb,
  'dag undepend': verbs.dagUndependVerb,
  'dag status': verbs.dagStatusVerb,
  'dag approve': verbs.dagApproveVerb,
  'dag revive': verbs.dagReviveVerb,
  'dag list': verbs.dagListVerb,
  'dag info': verbs.dagInfoVerb,
  'dag context': verbs.dagContextVerb,
  'dag search': verbs.dagSearchVerb,
  'dag open': verbs.dagOpenVerb,
  'dag validate': verbs.dagValidateVerb,
  'dag help': verbs.dagHelpVerb,
  'config get': verbs.configGetVerb,
  'config set': verbs.configSetVerb,
  'config unset': verbs.configUnsetVerb,
  'config list': verbs.configListVerb,
  'session show': verbs.sessionShowVerb,
  'session list': verbs.sessionListVerb,
} satisfies Record<string, VerbHandler>;

// ── the top-level listing ───────────────────────────────────────────────────

/**
 * The listing's own geometry: twelve spaces in, a hundred columns wide, one blank between the word
 * cell and its sense, and a sense column that never opens left of 42. The rows are laid out by the
 * same printer the help pages use (`listingBlock`), only with these numbers.
 */
const LISTING: ListingGeometry = {
  margin: 12,
  width: 100,
  gap: 1,
  floor: 42,
  ceiling: Number.POSITIVE_INFINITY,
};

/** The shape description printed above the tables, then the tables grown from the router's rows. */
const USAGE_SHAPE = `superworker -- the agent pipeline's own words

  Level 2 is a verb: it acts on the project or on the pipeline itself. Level 3 is a noun -- a record
  with an identity -- plus the verb that acts on it. So \`plan\` and \`settle\` are verbs, and
  \`cycle list\`, \`dag add\` are a group's verbs.
`;

/** The plugin command words the installed plugins claim, or nothing when none are installed. */
async function pluginCommands(io: WordsIO) {
  try {
    const root = projectRootOf(undefined, io.root);
    const superworker = handleOf(root, io);
    return await superworker.conductor.pluginCommands();
  } catch {
    // The listing answers even when the folder behind it cannot be read; `doctor` names that.
    return [];
  }
}

/** One pair of the listing as the printer's row: the word column and the sense beside it. */
function rowOf([invocation, sense]: readonly [string, string]): { invocation: string; sense: string } {
  return { invocation, sense };
}

/** One table of the listing, laid out by the shared printer. */
function listingText(rows: ReadonlyArray<readonly [string, string]>): string {
  const cells = rows.map(rowOf);
  return listingBlock(cells, senseColumnOf(cells, LISTING), LISTING).join('\n');
}

/** The listing rows of the words this layer carries, static part. */
export interface WordsIndex {
  /** The shape description printed above the tables. */
  readonly shape: string;
  /** The words about this checkout itself (`doctor`, `version`), as the listing prints them. */
  readonly self: ReadonlyArray<readonly [string, string]>;
  /** The verbs, with their one-line senses. */
  readonly verbs: ReadonlyArray<readonly [string, string]>;
  /** The groups, with their one-line senses. */
  readonly groups: ReadonlyArray<readonly [string, string]>;
  /** The listing's layout constants, for a caller that renders the same table its own way. */
  readonly layout: { readonly margin: number; readonly column: number; readonly width: number };
}

/**
 * The static index of the words: the data both the top listing and the agent-facing help page render.
 * The word order is the table's top, and each line of sense is the row's own `summary` — one home per
 * fact, so adding a word is adding a row. The plugin words are a project's own reading
 * (`answer(["--help"])` carries them); everything here is the layer's own table.
 */
export function describe(): WordsIndex {
  return {
    shape: USAGE_SHAPE,
    self: SELF_VERBS.map(([, display, blurb]) => [display, blurb] as const),
    verbs: TABLE_TOP.verbs.map((word) => [word, rowFor(word)?.summary ?? ''] as const),
    groups: TABLE_TOP.groups.map((word) => [word, groupFor(word)?.summary ?? ''] as const),
    layout: { margin: LISTING.margin, column: LISTING.floor, width: LISTING.width },
  };
}

/** `--help`: the shape of the listing, then every word the router walks. */
export async function topHelp(io: WordsIO): Promise<string> {
  const index = describe();
  const groupRows = index.groups.map(([word, sense]) => [`${word} <verb>`, sense] as const);
  const plugins = (await pluginCommands(io)).filter((entry) => !CORE_COMMAND_WORDS.has(entry.name));
  let text =
    USAGE_SHAPE +
    '\n  the tool itself:\n' +
    listingText(index.self) +
    '\n\n  verbs:    (each one takes the rest of the line as `args`)\n' +
    listingText(index.verbs) +
    "\n\n  groups:   (a group's verbs are the group's own: `help` with the group answers them)\n" +
    listingText(groupRows);
  if (plugins.length > 0) {
    const rows = plugins.map((entry) => [entry.name, entry.summary ?? ''] as const);
    const cells = rows.map(rowOf);
    const column = senseColumnOf(cells, LISTING);
    const title =
      '(a word an installed plugin contributes, answered by that plugin: `help` with the word\n' +
      wrap('answers its own page, and `doctor` lists what is installed)', Math.max(LISTING.width - column, 11))
        .map((line) => `${' '.repeat(column)}${line}`)
        .join('\n');
    text += `\n\n  plugins:  ${title}\n${listingText(rows)}`;
  }
  return (
    text +
    "\n\n  `word` takes the first word of a line, `args` takes the rest; `help` answers that word's page,\n" +
    // The listing closes on one blank line.
    "  and a word with its `args` and no `help` runs it.\n\n"
  );
}

// ── the router ──────────────────────────────────────────────────────────────

/** Run one parsed line: the help word, a refusal, or the handler's answer. */
async function runRow(spec: WordSpec, parsed: any, io: WordsIO, knobs?: readonly string[]) {
  if (parsed.help === true) return { stdout: helpText(spec) };
  if (parsed.error !== undefined) {
    return { code: 2, stderr: usageError(spec, parsed.error) };
  }
  const key = spec.group === undefined ? spec.word : `${spec.group} ${spec.word}`;
  const handler = HANDLERS[key];
  if (handler === undefined) {
    return refuse(`\`${key}\` is not wired to an engine action yet`, 2);
  }
  const call: VerbCall = {
    values: parsed.values ?? {},
    positionals: parsed.positionals ?? [],
    spec,
    helpText,
    specOf,
    groupFor,
    io,
    ...(knobs === undefined ? {} : { configKnobs: knobs }),
  };
  return handler(call);
}

/** The name a group's refusal prints for its sub-command: the group's own `dest`, spelled per group. */
function groupDestOf(subparsers: any): string {
  return subparsers.dest ?? subparsers.cellName;
}

/** One group word: the group's own listing, or the verb it names — then that verb's own line. */
async function runGroupWord(groupSpec: WordSpec, rest: readonly string[], io: WordsIO) {
  const subparsers = groupSpec.actions().find((action) => action.kind === 'subparsers');
  const at = rest.findIndex((word) => !word.startsWith('-'));
  if (at < 0) {
    if (rest.some((word) => HELP_WORDS.includes(word))) return { stdout: helpText(groupSpec) };
    return {
      code: 2,
      stderr: usageError(groupSpec, `the following arguments are required: ${subparsers!.cellName}`),
    };
  }
  const command = subparsers!.commands!.find((entry) => entry.word === rest[at]);
  if (command === undefined) {
    return {
      code: 2,
      stderr: usageError(
        groupSpec,
        `argument ${groupDestOf(subparsers)}: invalid choice: '${rest[at]}' ` +
          `(choose from ${subparsers!.commands!.map((entry) => `'${entry.word}'`).join(', ')})`,
      ),
    };
  }
  const parsed = parse(command, rest.slice(at + 1));
  return settle(await runRow(command, parsed, io));
}

/** One answer → the two streams and the exit code. */
function settle(answer: VerbAnswer) {
  return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
}

/** The plugin command one word names, or nothing (a word no installed plugin claims). */
async function pluginWord(word: string, io: WordsIO) {
  const root = projectRootOf(undefined, io.root);
  const superworker = handleOf(root, io);
  const entries = await superworker.conductor.pluginCommands();
  return entries.find((entry) => entry.name === word);
}

/**
 * One plugin word: the rest of the line goes to the plugin that declares it, in this process, through
 * the plugin contract. Whatever the plugin answers comes back as it answered it — the text, and the
 * exit code a plugin that says how its run ended hands back (`main` may answer a number, and a thrown
 * refusal may carry one: a usage error carries 2, the code the core's own parser answers a refused
 * line with). A throw that carries no code is the failure this layer names `main failed` at 1. A
 * plugin that cannot be run is one sentence on stderr naming the plugin, with the non-zero code a
 * failure answers with; the plugin's own streams went out from this same process, so nothing of its
 * stderr is swallowed here.
 */
async function runPluginWord(entry: { plugin: string }, word: string, rest: readonly string[], io: WordsIO) {
  const root = projectRootOf(undefined, io.root);
  const superworker = handleOf(root, io);
  const answer = await superworker.conductor.pluginCommand({ word, argv: [...rest] });
  if (!answer.ran) {
    if (answer.error !== null) {
      return { code: answer.code ?? 1, stderr: `${pluginRefusal(entry.plugin, answer.error, answer.code)}\n` };
    }
    return {
      code: 1,
      stderr: `plugin '${entry.plugin}': the command \`${word}\` could not be run\n`,
    };
  }
  return {
    stdout: answer.text ?? '',
    ...(typeof answer.code === 'number' ? { code: answer.code } : {}),
  };
}

/** The line a plugin word that did not run leaves: a refusal that named its own code is answered as it is, anything else is a failure at 1. */
function pluginRefusal(plugin: string, error: string, code: number | null): string {
  return code === null ? `plugin '${plugin}': main failed: ${error}` : `plugin '${plugin}': ${error}`;
}

/** The knob names in force for this run: read once, before any settings page is built. */
async function configKeysOf(io: WordsIO): Promise<string[]> {
  try {
    const root = projectRootOf(undefined, io.root);
    const superworker = handleOf(root, io);
    return await superworker.config.keys();
  } catch {
    // A folder with no `.superworker` of its own still answers its help page, and with the names that folder
    // can really be asked for. The plugin knobs a table from another project carries are refused here, so they
    // have no place in this page.
    return CORE_CONFIG_KEYS;
  }
}

/** One answer's bytes as the streams get them: only non-empty text, always newline-terminated. */
function streamText(text: string | undefined): string {
  if (text === undefined || text === '') return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * The whole line of words: argv in, one answer out. Every word in the table answers here, the three
 * about this checkout included — a transport that answers one of them itself simply never asks.
 */
export async function answer(argv: readonly string[], io: WordsIO): Promise<{ code: number; stdout: string; stderr: string }> {
  if (argv.length === 0 || HELP_WORDS.includes(argv[0] ?? '')) {
    return { code: 0, stdout: await topHelp(io), stderr: '' };
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);

  // The settings verbs print the knob names the engine accepts here: the list is read before the row is
  // turned into a spec, so the help, the usage line and the refusal all carry this run's own names. It
  // travels with the call (never through module state): one long-lived process answers several projects.
  const knobs = verb === 'config' ? await configKeysOf(io) : undefined;

  const row: WordRow | undefined = rowFor(verb);
  if (row !== undefined) {
    const parsed = parse(specOf(row, knobs), rest);
    if (parsed.verb !== undefined) {
      // A group: the sub-command's own row is what prints and what runs.
      return normalize(settle(await runRow(parsed.subcommand!, parsed, io)));
    }
    return normalize(settle(await runRow(specOf(row, knobs), parsed, io, knobs)));
  }
  const group = groupFor(verb);
  if (group !== undefined) {
    const answers = await runGroupWord(specOf(group, knobs), rest, io);
    return normalize(answers);
  }
  const plugin = await pluginWord(verb, io);
  if (plugin !== undefined) {
    const answer = await runPluginWord(plugin as { plugin: string }, verb, rest, io);
    return normalize(answer);
  }
  return normalize({
    code: 2,
    stderr: `no word \`${verb}\` in this table.\n\n${await topHelp(io)}`,
  });
}

/** Normalize one answer's two streams (non-empty, newline-terminated) and keep its exit code. */
function normalize(answer: VerbAnswer) {
  return {
    code: answer.code ?? 0,
    stdout: streamText(answer.stdout),
    stderr: streamText(answer.stderr),
  };
}
