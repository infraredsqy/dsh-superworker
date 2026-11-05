/**
 * `pf`: one command in front of the engine.
 *
 * Level 2 is a verb (it acts on the project or on the pipeline itself); level 3 is a noun plus the
 * verb that acts on it. The router walks the same table the help prints, so a word cannot be
 * printable and unroutable at once; a word an installed plugin declares is routed last, after the
 * words this checkout owns, and is run through the plugin contract in this process.
 *
 * Nothing here is a second implementation of anything: a word either lands on an engine action
 * (through the verbs modules) or on the plugin that declared it.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { COMMANDS, GROUPS, groupFor, rowFor, specOf, useConfigKnobs } from './spec.mjs';
import { helpText, parse, usageBlock, usageError } from './argparse.mjs';
import { BIN_DIR, REPO_ROOT, configKeys, engineProductPath, handleOf, messageOf, projectRoot, version } from './engine.mjs';
import { refuse } from './out.mjs';
import * as verbs from './verbs.mjs';

/** The words this command answers before it consults any table. */
const HELP_WORDS = ['-h', '--help', 'help'];

/** The knob names a folder with no `.pf` of its own can still be asked for: the engine's three core settings. */
const CORE_CONFIG_KEYS = ['max_agents', 'test_tier', 'worktree_mode'];

/** The words `pf` itself runs: word → the form `--help` prints, the one line of sense, the handler. */
const SELF_VERBS = [
  ['doctor', 'doctor [--fix]', 'read the health of this checkout and this project', 'doctor'],
  ['version', 'version', 'print the version and where this checkout lives', 'version'],
];

/**
 * The verbs: word → the row found in the table (its flags and values come off that one table)
 * plus the handler that answers it. This is the `pf <verb>` layer; a group's verbs live one level in.
 */
const VERB_ROUTES = {
  init: 'initVerb',
  register: 'registerVerb',
  next: 'nextVerb',
  dispatch: 'dispatchVerb',
  'clean-temp': 'cleanTempVerb',
  handoff: 'handoffVerb',
  'merge-ledger': 'mergeLedgerVerb',
};

/** The handlers of a group's verbs, by `"<group> <verb>"`. */
const GROUP_HANDLERS = {
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
function usageColumn(pairs) {
  const widest = pairs.reduce((wide, [left]) => Math.max(wide, [...left].length), 0);
  return USAGE_MARGIN + Math.max(USAGE_COLUMN - USAGE_MARGIN, widest + 1);
}

/** One sense as the lines it prints beside the word column. */
function senseLines(text, column) {
  const room = USAGE_WIDTH - column;
  if (room <= 0) return [text];
  const words = String(text).replace(/\s+/gu, ' ').trim().split(' ');
  const lines = [];
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
function usageRows(pairs) {
  const column = usageColumn(pairs);
  const out = [];
  for (const [left, right] of pairs) {
    const body = senseLines(right, column);
    out.push(`${' '.repeat(USAGE_MARGIN)}${left.padEnd(column - USAGE_MARGIN)}${body[0]}`);
    for (const line of body.slice(1)) out.push(`${' '.repeat(column)}${line}`);
  }
  return out.join('\n');
}

/** The plugin command words the installed plugins claim, or nothing when none are installed. */
async function pluginCommands() {
  try {
    const root = await projectRoot(undefined);
    const pf = await handleOf(root);
    return await pf.conductor.pluginCommands();
  } catch {
    // The listing answers even when the folder behind it cannot be read; `pf doctor` names that.
    return [];
  }
}

/** `pf --help`: the shape of the command, then every word the router walks. */
export async function topHelp() {
  const ownOf = SELF_VERBS.map(([, display, blurb]) => [display, blurb]);
  const verbsOf = Object.keys(VERB_ROUTES).map((word) => [word, '']);
  const groupsOf = Object.keys(GROUPS).map((word) => [`${word} <verb>`, '']);
  // The sense lines come off the same rows the router walks: the table's own cells are the source.
  const selfRows = ownOf;
  const verbRows = Object.keys(VERB_ROUTES).map((word) => [word, verbSense(word)]);
  const groupRows = Object.keys(GROUPS).map((word) => [`${word} <verb>`, groupSense(word)]);
  const plugins = (await pluginCommands()).filter((entry) => !(entry.name in VERB_ROUTES) && !(entry.name in GROUPS));
  let text =
    USAGE_SHAPE +
    '\n  pf itself:\n' +
    usageRows(selfRows) +
    '\n\n  verbs:    (each one hands the rest of the line to a tool)\n' +
    usageRows(verbRows) +
    "\n\n  groups:   (a group's verbs are that tool's: `pf <group> --help`)\n" +
    usageRows(groupRows);
  if (plugins.length > 0) {
    const rows = plugins.map((entry) => [entry.name, entry.summary ?? '']);
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

/** One verb's one-line sense: the sentence the table carries for that word. */
function verbSense(word) {
  return VERB_SENSE[word] ?? '';
}

/** One group's one-line sense. */
function groupSense(word) {
  return GROUP_SENSE[word] ?? '';
}

/** The verb table's own sentences, in the order the listing prints them. */
const VERB_SENSE = {
  init: 'put the ledger in place (run once per project)',
  register: "write the ledger's git merge driver into this project",
  next: 'show (or do) the next pipeline action',
  dispatch: 'start the session for the node the cycle holds',
  'clean-temp': "list (or remove) every node's temp/ directory",
  handoff: "a worker's own closing call for the line it just ran",
  'merge-ledger': 'the three-way merge driver git calls',
};

/** The group table's own sentences. */
const GROUP_SENSE = {
  cycle: 'one line of work',
  dag: 'the graph',
  config: "this machine's and this project's settings",
  instruction: 'standing user instructions',
  session: "a node's own conversations, which live on this machine only",
};

// ── the router ──────────────────────────────────────────────────────────────

/** Run one parsed line: the help word, a refusal, or the handler's answer. */
async function runRow(spec, parsed) {
  if (parsed.help === true) return { stdout: helpText(spec) };
  if (parsed.error !== undefined) {
    return { code: 2, stderr: usageError(spec, parsed.error) };
  }
  const key = spec.group === undefined ? spec.word : `${spec.group} ${spec.word}`;
  const name = GROUP_HANDLERS[key] ?? VERB_ROUTES[key];
  // The merge driver is the one word this router runs itself: it hands the argv to the engine's
  // process entry instead of reading an engine action, so it is not in the verbs module.
  const handler = name === undefined ? undefined : (verbs[name] ?? (name === 'mergeLedgerVerb' ? mergeLedgerVerb : undefined));
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
  });
}

/** The name a group's refusal prints for its sub-command: the group's own `dest`, spelled per group. */
function groupDestOf(subparsers) {
  return subparsers.dest ?? subparsers.cellName;
}

/** One group word: the group's own listing, or the verb it names — then that verb's own line. */
async function runGroupWord(groupSpec, rest) {
  const subparsers = groupSpec.actions().find((action) => action.kind === 'subparsers');
  const at = rest.findIndex((word) => !word.startsWith('-'));
  if (at < 0) {
    if (rest.some((word) => HELP_WORDS.includes(word))) return { stdout: helpText(groupSpec) };
    return {
      code: 2,
      stderr: usageError(groupSpec, `the following arguments are required: ${subparsers.cellName}`),
    };
  }
  const command = subparsers.commands.find((entry) => entry.word === rest[at]);
  if (command === undefined) {
    return {
      code: 2,
      stderr: usageError(
        groupSpec,
        `argument ${groupDestOf(subparsers)}: invalid choice: '${rest[at]}' ` +
          `(choose from ${subparsers.commands.map((entry) => `'${entry.word}'`).join(', ')})`,
      ),
    };
  }
  const parsed = parse(command, rest.slice(at + 1));
  return settle(await runRow(command, parsed));
}

/** One answer → the two streams and the exit code. */
function settle(answer) {
  const code = answer.code ?? 0;
  return { code, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
}

/** `pf merge-ledger`: hand the argv to the engine's one process entry, and keep its exit code. */
async function mergeLedgerVerb({ positionals }) {
  // Beside the engine's product, wherever this process found that: the checkout's node_modules or
  // the copy the artifact ships next to `bin/`.
  const product = engineProductPath();
  if (product === null) {
    process.stderr.write("pf: the engine's product is not on disk: neither node_modules/pf-core nor the copy beside bin/\n");
    return { code: 1 };
  }
  const binary = join(dirname(product), 'merge-ledger.mjs');
  const argv = (positionals ?? []).flatMap((words) => [...words]);
  return { code: await forward(binary, argv) };
}

/** Run one child with this process's own streams, and hand back its exit code. */
function forward(entry, argv) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [entry, ...argv], { stdio: 'inherit', windowsHide: true });
    child.on('error', (error) => {
      process.stderr.write(`pf: the merge driver could not start: ${error.message}\n`);
      settle(1);
    });
    child.on('close', (code) => settle(code ?? 1));
  });
}

/** The whole command line: argv in, exit code out. */
export async function main(argv) {
  if (argv.length === 0 || HELP_WORDS.includes(argv[0])) {
    const text = await topHelp();
    await write({ stdout: text });
    return 0;
  }
  const verb = argv[0];
  const rest = argv.slice(1);

  // The settings verbs print the knob names the engine accepts here: the list is read before the row is
  // turned into a spec, so the help, the usage line and the refusal all carry this run's own names.
  if (verb === 'config') {
    try {
      useConfigKnobs(await configKeys());
    } catch {
      // A folder with no `.pf` of its own still answers its help page, and with the names that folder
      // can really be asked for. The plugin knobs a table from another project carries are refused here, so they
      // have no place in this page.
      useConfigKnobs(CORE_CONFIG_KEYS);
    }
  }

  const own = SELF_VERBS.find(([word]) => word === verb);
  if (own !== undefined) return settleAndPrint(await settle(await selfHandler(own[3], rest)));

  const row = rowFor(verb);
  if (row !== undefined) {
    const parsed = parse(specOf(row), rest);
    if (parsed.verb !== undefined) {
      // A group: the sub-command's own row is what prints and what runs.
      return settleAndPrint(await settle(await runRow(parsed.subcommand, parsed)));
    }
    return settleAndPrint(await settle(await runRow(specOf(row), parsed)));
  }
  const group = groupFor(verb);
  if (group !== undefined) {
    const groupSpec = specOf(group);
    const answers = await runGroupWord(groupSpec, rest);
    await write(answers);
    return answers.code ?? 0;
  }
  const plugin = await pluginWord(verb);
  if (plugin !== undefined) {
    const answer = await runPluginWord(plugin, verb, rest);
    await write(answer);
    return answer.code ?? 0;
  }
  await write({
    code: 2,
    stderr: `pf: does not recognize \`${verb}\`.\n\n${await topHelp()}`,
  });
  return 2;
}

/** The plugin command one word names, or nothing (a word no installed plugin claims). */
async function pluginWord(word) {
  const root = await projectRoot(undefined);
  const pf = await handleOf(root);
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
async function runPluginWord(entry, word, rest) {
  const root = await projectRoot(undefined);
  const pf = await handleOf(root);
  const answer = await pf.conductor.pluginCommand({ word, argv: rest });
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

/** The self verbs: they print through the same door as everything else. */
async function selfHandler(name, rest) {
  if (name === 'version') return { stdout: verbs.versionVerb() };
  if (name === 'doctor') return await doctorVerb(rest);
  return refuse(`\`${name}\` is not wired`, 2);
}

/** `pf doctor [--fix]`: the engine's check-up, printed cell by cell. */
async function doctorVerb(rest) {
  const fix = rest.includes('--fix');
  const root = await projectRoot(undefined);
  const pf = await handleOf(root);
  try {
    const report = await pf.conductor.doctor({ git: (await import('./engine.mjs')).gitRunner });
    const lines = [`pf ${version()} at ${BIN_DIR}`, `tool tree: ${REPO_ROOT}`, `project root: ${root}`];
    for (const check of report.checks) {
      const mark = check.ok ? '✓' : '✗';
      const detail = (check.detail ?? '').split('\n');
      lines.push(`  ${mark} ${check.name}${detail.length === 1 && detail[0] !== '' ? `: ${detail[0]}` : ''}`);
      if (detail.length > 1 || (detail.length === 1 && detail[0] === '')) {
        for (const line of detail) lines.push(`      ${line}`);
      }
    }
    if (fix) {
      await pf.ledger.init({ git: (await import('./engine.mjs')).gitRunner });
      lines.push('  → `init` ran once to fill the layout files in (it recognizes what is already there)');
    }
    lines.push(report.ok ? 'every health check passed.' : `${report.checks.filter((check) => !check.ok).length} check(s) still red.`);
    return { stdout: lines.join('\n'), ...(report.ok ? {} : { code: 1 }) };
  } catch (error) {
    return refuse(messageOf(error), 1);
  }
}

/** Print one answer and hand its exit code back. */
async function settleAndPrint(answer) {
  await write(answer);
  return answer.code ?? 0;
}

/** The one place either stream is written. */
async function write(answer) {
  if (answer.stdout !== undefined && answer.stdout !== '') {
    process.stdout.write(answer.stdout.endsWith('\n') ? answer.stdout : `${answer.stdout}\n`);
  }
  if (answer.stderr !== undefined && answer.stderr !== '') {
    process.stderr.write(answer.stderr.endsWith('\n') ? answer.stderr : `${answer.stderr}\n`);
  }
}

export { BIN_DIR, pathToFileURL, usageBlock };