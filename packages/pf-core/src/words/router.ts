/**
 * The router: one command line in, one answer out — the two streams and the exit code, spelled the
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
 * belong to the transport layer that carries this library and are not routed here.
 */
import { useConfigKnobs, specOf, rowFor, groupFor } from './spec';
import { helpText, parse, usageError } from './argparse';
import { handleOf, projectRootOf, refuse } from './out';
import * as verbs from './verbs';
import type { WordRow, WordSpec } from './types';
import type { WordsIO } from './types';

/** The words this layer answers before it consults any table. */
const HELP_WORDS = ['-h', '--help', 'help'];

/** The knob names a folder with no `.pf` of its own can still be asked for: the engine's three core settings. */
const CORE_CONFIG_KEYS = ['max_agents', 'test_tier', 'worktree_mode'];

/** The words `pf` itself runs: word → the form `--help` prints, the one line of sense, the handler. */
const SELF_VERBS: ReadonlyArray<readonly [string, string, string]> = [
  ['doctor', 'doctor [--fix]', 'read the health of this checkout and this project'],
  ['version', 'version', 'print the version and where this checkout lives'],
];

/**
 * The verbs: word → the row found in the table (its flags and values come off that one table)
 * plus the handler that answers it. This is the `pf <verb>` layer; a group's verbs live one level in.
 * The merge driver's process hand-off is the transport layer's own word; it prints in the listing and
 * is answered there.
 */
const VERB_ROUTES: Record<string, string> = {
  init: 'initVerb',
  register: 'registerVerb',
  next: 'nextVerb',
  dispatch: 'dispatchVerb',
  'clean-temp': 'cleanTempVerb',
  handoff: 'handoffVerb',
};

/** The handlers of a group's verbs, by `"<group> <verb>"`. */
const GROUP_HANDLERS: Record<string, string> = {
  'cycle create': 'cycleCreateVerb',
  'cycle start': 'cycleStartVerb',
  'cycle rename': 'cycleRenameVerb',
  'cycle status': 'cycleStatusVerb',
  'cycle policy': 'cyclePolicyVerb',
  'cycle list': 'cycleListVerb',
  'cycle current': 'cycleCurrentVerb',
  'cycle show': 'cycleShowVerb',
  'cycle hold': 'cycleHoldVerb',
  'cycle close': 'cycleCloseVerb',
  'cycle retry': 'cycleRetryVerb',
  'dag add': 'dagAddVerb',
  'dag rm': 'dagRmVerb',
  'dag update': 'dagUpdateVerb',
  'dag depend': 'dagDependVerb',
  'dag undepend': 'dagUndependVerb',
  'dag status': 'dagStatusVerb',
  'dag approve': 'dagApproveVerb',
  'dag revive': 'dagReviveVerb',
  'dag list': 'dagListVerb',
  'dag info': 'dagInfoVerb',
  'dag context': 'dagContextVerb',
  'dag search': 'dagSearchVerb',
  'dag open': 'dagOpenVerb',
  'dag validate': 'dagValidateVerb',
  'dag help': 'dagHelpVerb',
  'config get': 'configGetVerb',
  'config set': 'configSetVerb',
  'config unset': 'configUnsetVerb',
  'config list': 'configListVerb',
  'instruction add': 'instructionAddVerb',
  'instruction list': 'instructionListVerb',
  'instruction resolve': 'instructionResolveVerb',
  'instruction rm': 'instructionRmVerb',
  'instruction revive': 'instructionReviveVerb',
  'session show': 'sessionShowVerb',
  'session list': 'sessionListVerb',
};

// ── the top-level listing ───────────────────────────────────────────────────

/** The listing's numbers: where the word column opens, its floor, and where the sense wraps. */
const USAGE_MARGIN = 12;
const USAGE_COLUMN = 42;
const USAGE_WIDTH = 100;

/** The shape description printed above the tables, then the tables grown from the router's rows. */
const USAGE_SHAPE = `pf -- the agent pipeline's own command

  Level 2 is a verb: it acts on the project or on the pipeline itself. Level 3 is a noun -- a record
  with an identity -- plus the verb that acts on it. So \`pf init\` and \`pf next\` are verbs, and
  \`pf cycle list\`, \`pf dag add\` are a group's verbs.

  An argument carrying shell punctuation is safest handed over as \`-o @path\` or \`-o -\`, and
  \`node <checkout>/bin/pf.mjs …\` answers the same as the installed command where a shell does eat it.

`;

/** Where one table's sense column opens: the widest word of that table plus one blank. */
function usageColumn(pairs: ReadonlyArray<readonly [string, string]>): number {
  const widest = pairs.reduce((wide, [left]) => Math.max(wide, [...left].length), 0);
  return USAGE_MARGIN + Math.max(USAGE_COLUMN - USAGE_MARGIN, widest + 1);
}

/** One sense as the lines it prints beside the word column. */
function senseLines(text: unknown, column: number): string[] {
  const room = USAGE_WIDTH - column;
  if (room <= 0) return [String(text)];
  const words = String(text).replace(/\s+/gu, ' ').trim().split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line === '') {
      line = word;
      continue;
    }
    if ([...line].length + 1 + [...word].length <= room) {
      line += ` ${word}`;
      continue;
    }
    lines.push(line);
    line = word;
  }
  if (line !== '') lines.push(line);
  return lines.length === 0 ? [''] : lines;
}

/** The word column and the sense column of one table. */
function usageRows(pairs: ReadonlyArray<readonly [string, string]>): string {
  const column = usageColumn(pairs);
  const out: string[] = [];
  for (const [left, right] of pairs) {
    const body = senseLines(right, column);
    out.push(`${' '.repeat(USAGE_MARGIN)}${left.padEnd(column - USAGE_MARGIN)}${body[0]}`);
    for (const line of body.slice(1)) out.push(`${' '.repeat(column)}${line}`);
  }
  return out.join('\n');
}

/** The plugin command words the installed plugins claim, or nothing when none are installed. */
async function pluginCommands(io: WordsIO) {
  try {
    const root = projectRootOf(undefined, io.root);
    const pf = await handleOf(root, io);
    return await pf.conductor.pluginCommands();
  } catch {
    // The listing answers even when the folder behind it cannot be read; `pf doctor` names that.
    return [];
  }
}

/** The verb table's own sentences, in the order the listing prints them. */
const VERB_SENSE: Record<string, string> = {
  init: 'put the ledger in place (run once per project)',
  register: "write the ledger's git merge driver into this project",
  next: 'show (or do) the next pipeline action',
  dispatch: 'start the session for the node the cycle holds',
  'clean-temp': "list (or remove) every node's temp/ directory",
  handoff: "a worker's own closing call for the line it just ran",
  'merge-ledger': 'the three-way merge driver git calls',
};

/** The group table's own sentences. */
const GROUP_SENSE: Record<string, string> = {
  cycle: 'one line of work',
  dag: 'the graph',
  config: "this machine's and this project's settings",
  instruction: 'standing user instructions',
  session: "a node's own conversations, which live on this machine only",
};

/** One verb's one-line sense: the sentence the table carries for that word. */
function verbSense(word: string): string {
  return VERB_SENSE[word] ?? '';
}

/** One group's one-line sense. */
function groupSense(word: string): string {
  return GROUP_SENSE[word] ?? '';
}

/** The listing rows of the words this layer carries, static part. */
export interface WordsIndex {
  /** The shape description printed above the tables. */
  readonly shape: string;
  /** The words about this checkout itself (`pf doctor`, `pf version`), as the listing prints them. */
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
 * The plugin words are a project's own reading (`answer(["--help"])` carries them); everything here is
 * the layer's own table.
 */
export function describe(): WordsIndex {
  return {
    shape: USAGE_SHAPE,
    self: SELF_VERBS.map(([, display, blurb]) => [display, blurb] as const),
    verbs: ['init', 'register', 'next', 'dispatch', 'clean-temp', 'handoff', 'merge-ledger'].map(
      (word) => [word, verbSense(word)] as const,
    ),
    groups: ['cycle', 'dag', 'config', 'instruction', 'session'].map((word) => [word, groupSense(word)] as const),
    layout: { margin: USAGE_MARGIN, column: USAGE_COLUMN, width: USAGE_WIDTH },
  };
}

/** `pf --help`: the shape of the command, then every word the router walks. */
export async function topHelp(io: WordsIO): Promise<string> {
  const index = describe();
  const verbRows = index.verbs.map(([word]) => [word, verbSense(word)] as const);
  const groupRows = index.groups.map(([word]) => [`${word} <verb>`, groupSense(word)] as const);
  const plugins = (await pluginCommands(io)).filter(
    (entry: { name: string }) => !(entry.name in VERB_ROUTES) && !(entry.name in GROUP_SENSE),
  );
  let text =
    USAGE_SHAPE +
    '\n  pf itself:\n' +
    usageRows(index.self) +
    '\n\n  verbs:    (each one hands the rest of the line to a tool)\n' +
    usageRows(verbRows) +
    "\n\n  groups:   (a group's verbs are that tool's: `pf <group> --help`)\n" +
    usageRows(groupRows);
  if (plugins.length > 0) {
    const rows = plugins.map((entry) => [entry.name, entry.summary ?? ''] as const);
    const column = usageColumn(rows);
    const title =
      '(a word an installed plugin contributes, answered by that plugin: `pf <word> --help`\n' +
      senseLines('is its own, and `pf doctor` lists what is installed)', column)
        .map((line) => `${' '.repeat(column)}${line}`)
        .join('\n');
    text += `\n\n  plugins:  ${title}\n${usageRows(rows)}`;
  }
  return (
    text +
    "\n\n  Run `pf <verb> --help` for the verb's own flags and values, or `pf <group> --help`\n" +
    // The listing closes on one blank line.
    "  for a group's verbs.\n\n"
  );
}

// ── the router ──────────────────────────────────────────────────────────────

/** The routing table's word → handler wiring, read once. */
function handlerOf(name: string | undefined): ((call: any) => any) | undefined {
  if (name === undefined) return undefined;
  return (verbs as unknown as Record<string, ((call: any) => any) | undefined>)[name];
}

/** Run one parsed line: the help word, a refusal, or the handler's answer. */
async function runRow(spec: WordSpec, parsed: any, io: WordsIO) {
  if (parsed.help === true) return { stdout: helpText(spec) };
  if (parsed.error !== undefined) {
    return { code: 2, stderr: usageError(spec, parsed.error) };
  }
  const key = spec.group === undefined ? spec.word : `${spec.group} ${spec.word}`;
  const name = GROUP_HANDLERS[key] ?? VERB_ROUTES[key];
  const handler = handlerOf(name);
  if (handler === undefined) {
    return refuse(`\`${key}\` is not wired to an engine action yet`, 2);
  }
  return handler({
    values: parsed.values ?? {},
    positionals: parsed.positionals ?? [],
    spec,
    helpText,
    specOf,
    groupFor,
    io,
  });
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
function settle(answer: { code?: number; stdout?: string; stderr?: string }) {
  return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
}

/** The plugin command one word names, or nothing (a word no installed plugin claims). */
async function pluginWord(word: string, io: WordsIO) {
  const root = projectRootOf(undefined, io.root);
  const pf = await handleOf(root, io);
  const entries = await pf.conductor.pluginCommands();
  return entries.find((entry) => entry.name === word);
}

/**
 * One plugin word: the rest of the line goes to the plugin that declares it, in this process, through
 * the plugin contract. Whatever the plugin answers comes back as it answered it — the text, and the
 * exit code a plugin that says how its run ended hands back (`main` may answer a number). A plugin
 * that cannot be run is one sentence on stderr naming the plugin, with the non-zero code a failure
 * answers with; the plugin's own streams went out from this same process, so
 * nothing of its stderr is swallowed here.
 */
async function runPluginWord(entry: { plugin: string }, word: string, rest: readonly string[], io: WordsIO) {
  const root = projectRootOf(undefined, io.root);
  const pf = await handleOf(root, io);
  const answer = await pf.conductor.pluginCommand({ word, argv: [...rest] });
  if (!answer.ran) {
    if (answer.error !== null) return { code: 1, stderr: `plugin '${entry.plugin}': main failed: ${answer.error}\n` };
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

/** The knob names in force for this run: read once, before any settings page is built. */
async function configKeysOf(io: WordsIO): Promise<string[]> {
  try {
    const root = projectRootOf(undefined, io.root);
    const pf = await handleOf(root, io);
    return await pf.config.keys();
  } catch {
    // A folder with no `.pf` of its own still answers its help page, and with the names that folder
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
 * The whole command line: argv in, one answer out. The words about this process itself — the
 * checkout's doctor, its version, the merge driver's hand-off to the engine's process entry — are the
 * transport layer's own; everything else answers here.
 */
export async function answer(argv: readonly string[], io: WordsIO): Promise<{ code: number; stdout: string; stderr: string }> {
  if (argv.length === 0 || HELP_WORDS.includes(argv[0] ?? '')) {
    return { code: 0, stdout: await topHelp(io), stderr: '' };
  }
  const verb = argv[0]!;
  const rest = argv.slice(1);

  // The settings verbs print the knob names the engine accepts here: the list is read before the row is
  // turned into a spec, so the help, the usage line and the refusal all carry this run's own names.
  if (verb === 'config') {
    useConfigKnobs(await configKeysOf(io));
  }

  const row: WordRow | undefined = rowFor(verb);
  if (row !== undefined) {
    const parsed = parse(specOf(row), rest);
    if (parsed.verb !== undefined) {
      // A group: the sub-command's own row is what prints and what runs.
      return settle2(await runRow(parsed.subcommand!, parsed, io));
    }
    return settle2(await runRow(specOf(row), parsed, io));
  }
  const group = groupFor(verb);
  if (group !== undefined) {
    const groupSpec = specOf(group);
    const answers = await runGroupWord(groupSpec, rest, io);
    return normalize(answers);
  }
  const plugin = await pluginWord(verb, io);
  if (plugin !== undefined) {
    const answer = await runPluginWord(plugin as { plugin: string }, verb, rest, io);
    return normalize(answer);
  }
  return normalize({
    code: 2,
    stderr: `pf: does not recognize \`${verb}\`.\n\n${await topHelp(io)}`,
  });
}

/** The answer of one routed word, with its streams spelled the way the transport writes them. */
function settle2(answer: { code?: number; stdout?: string; stderr?: string }) {
  return normalize(settle(answer));
}

/** Normalize one answer's two streams (non-empty, newline-terminated) and keep its exit code. */
function normalize(answer: { code?: number; stdout?: string; stderr?: string }) {
  return {
    code: answer.code ?? 0,
    stdout: streamText(answer.stdout),
    stderr: streamText(answer.stderr),
  };
}
