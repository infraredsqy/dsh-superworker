/**
 * The verbs: one handler per word, each a thin reading of engine answers into the line a person
 * reads. No record is ever written here — every write goes through the engine handle — and no word
 * has a second implementation elsewhere.
 *
 * The conventions the lines follow: the same field order in a JSON reading, the same two-space
 * indent, the same short id (the first eight characters) when a longer one would only make the line
 * longer.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ConfigLayer } from '../config';
import type { CyclePolicyValue, DagAddManyRow, InstructionReaderRow } from '../ledger';
import { runMergeDriver } from '../ledgermerge/driver';
import type { CycleStatus, InstructionRecord, NodeResult, NodeStatus } from '../types';
import { usageError } from './argparse';
import {
  EXIT,
  messageOf,
  posix,
  pyCompact,
  pyIndented,
  pyList,
  pyScalar,
  readCount,
  readPolicyValue,
  refuse,
  run,
  short,
  splitTags,
} from './out';
import type { Superworker } from '../open';
import type { WordsIO } from './types';

// ═══ the pipeline verbs ══════════════════════════════════════════════════════

/**
 * `init`: put the record directory in place. The engine's report is the reading; the lines below
 * are that reading spelled out (what was written, what was skipped and why). There is one layout:
 * the records stay out of the project repository, and a tracked record directory is `init`'s own
 * refusal, thrown before a byte lands.
 */
export const initVerb = run("init", async (call) => {
  const { values, io, superworker } = call;
  // The record tree's own locations are the engine's read: this layer prints them, it does not spell them.
  const { recordDir, configJson } = superworker.locations.paths;
  // The record directory gets a repository of its own unless the line said `--no-own-repo`: that is
  // the default, and `--own-repo` is the flag on the other side.
  const ownRepoAsked = values.no_own_repo !== true;
  const report = await superworker.ledger.init({ ownRepo: ownRepoAsked, git: io.git });
  const lines: string[] = [];
  lines.push(`Ledger: ${recordDir}`);
  const configFile = configJson;
  lines.push(
    report.written.includes('config.json')
      ? `Config file: ${configFile} (written; empty = all factory defaults, and \`config set\` is how to change one)`
      : `Config file: ${configFile} (already there, left alone; empty = all factory defaults, and \`config set\` is how to change one)`,
  );
  const exclude = {
    written: 'the ignore line is in place in this repository\'s info/exclude',
    'skipped-not-a-checkout': 'this project is not a git checkout: there is no ignore line to speak of',
    failed: 'the ignore line could not be written',
  }[report.exclude];
  if (exclude !== undefined) lines.push(exclude);
  // The two own-repo sentences printed when a repository was asked for (and nothing is printed for
  // `--no-own-repo`, which is the caller saying "plain files on purpose").
  const ownRepo = ownRepoAsked
    ? ({
        created: `Gave ${recordDir} a repository of its own: local history starts here, and once a remote is attached to it, it can travel to another machine on its own.`,
        present: `${recordDir} already has a repository of its own; it was left alone.`,
      } as Record<string, string | undefined>)[report.ownRepo]
    : undefined;
  if (ownRepo !== undefined) lines.push(ownRepo);
  if (report.mergeDriverCommand !== null) {
    // What this run left in `merge.superworker.driver`: the string it wrote, or the working registration it kept.
    lines.push(`Merge driver registered: merge.superworker.driver = ${report.mergeDriverCommand}`);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return { stdout: lines.join('\n') };
});

/** `register`: write the merge driver's two keys, nothing else. */
export const registerVerb = run("register", async (call) => {
  const { io, superworker } = call;
  const command = await superworker.ledger.register({ git: io.git });
  if (command === null) {
    return {
      stdout:
        'The merge driver was not registered: there is no git config to write here (this project is not a git checkout).',
    };
  }
  return { stdout: command };
});

/**
 * `migrate`: move a 0.1.x workspace's records into `.superworker/`. The engine's report is the
 * reading, spelled out the way `init`'s is — what moved, what was skipped and why. A refused
 * migration arrives here as the engine's own thrown sentence (the word carries it as it is), and
 * the listing question — no generation named — is answered from the report's own list.
 */
export const migrateVerb = run("migrate", async (call) => {
  const { values, positionals, io, superworker } = call;
  const generation = (positionals[0] ?? [])[0];
  const report = await superworker.ledger.migrate(generation, {
    git: io.git,
    ...(io.homeDir === undefined ? {} : { homeDir: io.homeDir }),
  });
  if (values.json === true) return { stdout: pyIndented(report) };
  if (generation === undefined) {
    // The listing question: the engine named what it can move and moved nothing.
    const lines = [
      'Known generations:',
      ...(report.known ?? []).map((entry) => `  ${entry.id} — ${entry.label}`),
      '',
      'Name one to move this workspace\'s records into `.superworker/`; with none named, nothing was done.',
    ];
    return { stdout: lines.join('\n') };
  }
  if (!report.moved) {
    return {
      stdout:
        'Nothing to move: this workspace holds no old record directory (re-running a finished migration is empty work).',
    };
  }
  const lines: string[] = [];
  lines.push(`Ledger: ${report.to} (moved from ${report.from})`);
  const exclude = {
    written: 'the old ignore line is out of this repository\'s info/exclude and the new one is in place',
    'skipped-not-a-checkout': 'this project is not a git checkout: no ignore line was touched',
    skipped: 'no ignore line was touched',
    failed: 'the ignore line could not be rewritten (the warning below names why)',
  }[report.exclude];
  if (exclude !== undefined) lines.push(`Exclude: ${exclude}.`);
  const gitattributes = {
    rewritten: 'the record directory\'s .gitattributes now names the current driver',
    unchanged: 'the record directory\'s .gitattributes already named the current driver',
    skipped: 'the record directory\'s .gitattributes was not touched',
    failed: 'the record directory\'s .gitattributes could not be rewritten (the warning below names why)',
  }[report.gitattributes];
  if (gitattributes !== undefined) lines.push(`Driver attribute: ${gitattributes}.`);
  if (report.mergeDriverCommand !== null) {
    // What this run left in `merge.superworker.driver`: the migration writes the registration, it does not keep an old one.
    lines.push(`Merge driver registered: merge.superworker.driver = ${report.mergeDriverCommand}`);
  }
  const machineLayer = {
    copied: 'the machine layer\'s settings were copied to the new home; the old machine layer was left as it was',
    'skipped-target-present': 'the machine layer already holds its settings; nothing was copied and the old copy was left alone',
    'skipped-no-source': 'the old machine layer held no settings file; nothing was copied',
    skipped: 'the machine layer was not looked at',
    failed: 'the machine layer\'s settings could not be copied (the warning below names why)',
  }[report.machineLayer];
  if (machineLayer !== undefined) lines.push(`Machine layer: ${machineLayer}.`);
  if (report.planPathsRewritten > 0) {
    lines.push(`Issue pool: ${report.planPathsRewritten} plan_path value(s) rewritten to the new record directory.`);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return { stdout: lines.join('\n') };
});

/** `clean-temp`: list (or with `--yes`, remove) every node's `temp/` directory. */
export const cleanTempVerb = run("clean-temp", async (call) => {
  const { values, superworker } = call;
  const report = await superworker.ledger.cleanTemp({
    ...(values.node === undefined ? {} : { node: values.node }),
    ...(values.yes === true ? { remove: true } : {}),
    ...(values.force === true ? { force: true } : {}),
  });
  const lines: string[] = [];
  if (report.targets.length === 0 && report.running.length === 0) {
    return { stdout: 'There is no temp directory to clear.' };
  }
  for (const entry of report.running) lines.push(`${short(entry.name)}  held by a cycle right now; skipped`);
  for (const entry of report.targets) {
    lines.push(`${short(entry.name)}  ${String(entry.files).padStart(4)} files  ${(entry.bytes / 1024).toFixed(1).padStart(8)} KB`);
  }
  lines.push(
    `${report.targets.length} temp directories can be cleared` +
      (report.running.length > 0
        ? `; another ${report.running.length} are working right now and skipped.`
        : '.'),
  );
  if (values.yes !== true) {
    lines.push('Add --yes to delete (no per-file judgement: the whole directory goes).');
  } else {
    lines.push(`Removed ${report.removed.length} temp directories.`);
  }
  return { stdout: lines.join('\n') };
});

/** `handoff`: the ticket shape, or one ticket written. */
export const handoffVerb = run("handoff", async (call) => {
  const { values, positionals, superworker } = call;
  const [cycle, node, status] = positionals.map((words) => words[0]);
  if (values.form === true) {
    if (cycle === undefined) {
      return refuse('the form needs <cycle>: `handoff --form <cycle>`', EXIT.refused);
    }
    const form = await superworker.conductor.handoffForm({ cycle, ...(node === undefined ? {} : { node }) });
    const fields = [
      '"deliverable":"<path to the thing this node is meant to produce>"',
      '"acceptance":["<key acceptance point 1>","<key acceptance point 2>"]',
      '"touched":["<files you changed under this node>"]',
    ];
    if (form.readings.length > 0) {
      fields.push(
        `"reading":{${form.readings
          .map((slot) => `"${slot.key}":<${slot.ask !== '' ? slot.ask : slot.key}>`)
          .join(',')}}`,
      );
    }
    const lines = [
      `the ticket this line (${form.cycle}) asks for:`,
      '',
      `handoff ${form.cycle} ${node ?? '<node id>'} completed -s "<one-line summary>" -o '{${fields.join(',')}}'`,
    ];
    if (form.readings.length > 0) {
      lines.push(
        '',
        'drop the key of any reading you did not measure: a missing number reads as "this run does not know", a 0 reads as "measured zero".',
      );
    }
    return { stdout: lines.join('\n') };
  }
  if (node === undefined || status === undefined || values.summary === undefined) {
    return refuse(
      'a ticket needs <node> <status> -s "<one-line summary>"; `--form <cycle>` prints the shape',
      EXIT.refused,
    );
  }
  const outputs = await readOutputs(values.outputs, call.io);
  if (outputs.error !== undefined) return refuse(outputs.error, EXIT.failed);
  const ticket = await superworker.conductor.handoff({
    cycle: cycle,
    node,
    status: status as NodeResult,
    summary: values.summary,
    outputs: outputs.value,
  });
  return {
    stdout:
      `handoff: ${ticket.node} ticket written; the node is not closed yet -- record it with ` +
      `\`settle ${ticket.node}\` (no session is opened by that)`,
  };
});

/** The `-o` cell: an inline object, `@path`, or the caller's own input source (`-`). */
async function readOutputs(
  raw: unknown,
  io: WordsIO,
): Promise<{ error?: string; value?: Record<string, unknown> }> {
  const text = raw === undefined ? '{}' : String(raw);
  let payload = text;
  if (text === '-') {
    // The input comes in through the seam and nowhere else: this layer reads no stream of its own
    // (`WordsIO` says so), because a call answered inside a long-lived process has no stdin whose
    // end ever arrives — waiting on one is how `-o -` used to hang the whole call. A call that hands
    // in no source is refused here, by name, instead of waiting.
    if (io.readInput === undefined) {
      return {
        error:
          '`-o -` takes the caller\'s input, and this call gave no input source; ' +
          'name a file with `-o @path` (or give the object inline)',
      };
    }
    try {
      payload = await io.readInput();
    } catch (error) {
      return {
        error:
          `\`-o -\` could not read the caller's input (${messageOf(error)}); ` +
          'name a file with `-o @path`',
      };
    }
  } else if (text.startsWith('@')) {
    const { readFile } = await import('node:fs/promises');
    payload = await readFile(text.slice(1), 'utf8');
  }
  try {
    const value = JSON.parse(payload);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { error: '-o must be a JSON object' };
    }
    return { value };
  } catch (error) {
    return { error: `-o is not valid JSON: ${messageOf(error)}` };
  }
}

// ═══ cycle: one line of work ═════════════════════════════════════════════════

/** The refusal of a line that names no picking range: the range is required, so it is refused here. */
function noTagsRefusal(verb: string) {
  return refuse(
    `cycle ${verb} must be given --tags (the range this line picks from). For example: ` +
      `cycle ${verb} <slug> --tags coding. Known words: writing/coding/art ` +
      '(a word outside the vocabulary is fine too; it is taken as given). Every pick this line ' +
      'makes, and which plugins may react to it, reads this one range.',
    EXIT.refused,
  );
}

/** `cycle create`. */
export const cycleCreateVerb = run("cycle create", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  if (values.tags === undefined || splitTags(values.tags).length === 0) {
    return noTagsRefusal('create');
  }
  const record = await superworker.ledger.cycles.create({
    id,
    ...(values.title === undefined ? {} : { title: values.title }),
    tags: splitTags(values.tags),
    ...(values.force === true ? { force: true } : {}),
  });
  const tags = Array.isArray(record.tags) ? record.tags : [];
  return { stdout: `CREATED: cycle "${record.id}"${tags.length > 0 ? ` (tags=${pyList(tags)})` : ''}` };
});

/** `cycle start`: create and pin the opening node — two lines, the creation and the pinning. */
export const cycleStartVerb = run("cycle start", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  if (values.tags === undefined || splitTags(values.tags).length === 0) {
    return noTagsRefusal('start');
  }
  const record = await superworker.ledger.cycles.start({
    id,
    ...(values.title === undefined ? {} : { title: values.title }),
    tags: splitTags(values.tags),
    ...(values.force === true ? { force: true } : {}),
    ...(values.parallel === undefined ? {} : { parallel: readCount(values.parallel) as number }),
  });
  const holding = Array.isArray(record.holding) ? record.holding : [];
  const tags = Array.isArray(record.tags) ? record.tags : [];
  const pin = holding[0];
  const title = pin === undefined
    ? ''
    : String((await superworker.ledger.dag.get(pin.id))?.title ?? '');
  return {
    stdout:
      `CREATED: cycle "${record.id}"${tags.length > 0 ? ` (tags=${pyList(tags)})` : ''}\n` +
      `STARTED: cycle "${record.id}" → ${title}` +
      (holding.length > 1 ? `  (${holding.length} node(s) pinned)` : ''),
  };
});

/** `cycle rename`. */
export const cycleRenameVerb = run("cycle rename", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  const record = await superworker.ledger.cycles.rename(id, values.title);
  return { stdout: `RENAMED: "${record.id}" → "${record.title}"` };
});

/** `cycle status`. */
export const cycleStatusVerb = run("cycle status", async (call) => {
  const { positionals, superworker } = call;
  const [id, status] = positionals.map((words) => words[0]);
  const record = await superworker.ledger.cycles.setStatus(id, status as CycleStatus);
  return { stdout: `CYCLE_STATUS: "${record.id}" → ${record.status}` };
});

/** `cycle policy`. */
export const cyclePolicyVerb = run("cycle policy", async (call) => {
  const { positionals, superworker } = call;
  const [id, key, value] = positionals.map((words) => words[0]);
  const effective = await superworker.ledger.cycles.setPolicy(id, key, readPolicyValue(value) as CyclePolicyValue);
  return {
    stdout: `POLICY: "${id}" → ${Object.entries(effective).map(([name, held]) => `${name}=${pyScalar(held)}`).join(', ')}`,
  };
});

/** `cycle list`. */
export const cycleListVerb = run("cycle list", async (call) => {
  const { superworker } = call;
  const cycles = await superworker.ledger.cycles.list();
  if (cycles.length === 0) return { stdout: 'No cycles found.' };
  const lines: string[] = [
    `${'ID'.padEnd(22)} ${'Title'.padEnd(34)} ${'Status'.padEnd(12)} ${'Steps'.padEnd(6)} ${'Node'.padEnd(10)} ${'Tags'.padEnd(14)}`,
    '-'.repeat(108),
  ];
  for (const cycle of cycles) {
    const holding = Array.isArray(cycle.holding) ? cycle.holding : [];
    let node = holding.length === 0 ? '-' : short(holding[0]!.id);
    if (holding.length > 1) node += `+${holding.length - 1}`;
    const tags = Array.isArray(cycle.tags) && cycle.tags.length > 0 ? cycle.tags.join(',') : '-';
    const steps = String((cycle.path ?? []).length);
    lines.push(
      `${String(cycle.id).padEnd(22)} ${String(cycle.title ?? '?').padEnd(34)} ` +
        `${String(cycle.status ?? '?').padEnd(12)} ${steps.padEnd(6)} ${node.padEnd(10)} ${tags.padEnd(14)}`,
    );
  }
  return { stdout: lines.join('\n') };
});

/** `cycle current`: the lines in service, and every line still holding a node. */
export const cycleCurrentVerb = run("cycle current", async (call) => {
  const { superworker } = call;
  const cycles = await superworker.ledger.cycles.list();
  const lines = cycles.filter(
    (cycle) => cycle.status === 'active' || (Array.isArray(cycle.holding) ? cycle.holding : []).length > 0,
  );
  if (lines.length === 0) return { stdout: 'No active cycles.' };
  const out: string[] = [];
  for (const cycle of lines) {
    const mark = cycle.status === 'active' ? '●' : '○';
    const tags = Array.isArray(cycle.tags) && cycle.tags.length > 0 ? cycle.tags.join(',') : '(none)';
    const policy = await superworker.ledger.cycles.policies(String(cycle.id));
    out.push(`${mark} ${cycle.id} — ${cycle.title ?? ''}  [${cycle.status ?? '?'}]  tags: ${tags}`);
    out.push(
      `  Policy: ${Object.entries(policy).map(([name, held]) => `${name}=${pyScalar(held)}`).join(', ')}  ` +
        `Steps walked: ${(cycle.path ?? []).length}`,
    );
    const holding = Array.isArray(cycle.holding) ? cycle.holding : [];
    if (holding.length === 0) out.push('  Node: (none in hand)');
    for (const item of holding) out.push(`  Node: ${item.id}  (since ${item.since ?? '?'})`);
  }
  return { stdout: out.join('\n') };
});

/** `cycle show`: one node's standing in one line — the one word with a different meaning here. */
export const cycleShowVerb = run("cycle show", async (call) => {
  const { positionals, superworker } = call;
  const [id, node] = positionals.map((words) => words[0]);
  const standing = await superworker.ledger.cycles.standing(id, node);
  const lines: string[] = [];
  if (standing.standing === 'holding') {
    lines.push(`cycle ${standing.cycle}: holding ${standing.node} since ${standing.since ?? '?'}`);
  } else if (standing.standing === 'walked' && standing.step !== undefined) {
    lines.push(
      `cycle ${standing.cycle}: walked ${standing.node} → ${standing.step.result} ` +
        `(${standing.step.started_at} .. ${standing.step.ended_at})`,
    );
  } else {
    lines.push(`cycle ${standing.cycle}: nothing about ${standing.node} (not in hand, not in the path)`);
  }
  if (standing.signal === null) {
    lines.push('  signal: (none)');
  } else {
    lines.push(`  signal: ${standing.signal.status}  ${standing.signal.summary}`);
    if (standing.signal.outputs !== null && Object.keys(standing.signal.outputs).length > 0) {
      lines.push(`  outputs: ${pyCompact(standing.signal.outputs)}`);
    }
  }
  return { stdout: lines.join('\n') };
});

/**
 * `hold`: the claim step. The nodes are the operand and the line is where they are held — without
 * `--cycle` the single active line is taken. The words are written in one record, so a batch lands
 * whole or not at all, and the answer is the line's hand after the write: the head as `CURRENT_NODE`
 * (the cell a dispatch would send first) and the rest as `HOLDING`.
 */
export const holdVerb = run("hold", async (call) => {
  const { values, positionals, superworker } = call;
  const nodes = (positionals[0] ?? []).filter((node) => node !== '');
  if (nodes.length === 0) {
    return refuse('hold names at least one node. Nothing was changed.', EXIT.refused);
  }
  let cycleId: string | undefined = values.cycle;
  if (cycleId === undefined) {
    const line = await superworker.ledger.cycles.current();
    if (line === null) {
      return refuse(
        `hold needs the line to put ${nodes.map(short).join(', ')} in hand, and no cycle is active. ` +
          'Name one with `--cycle <id>`, or read them with `cycle list`.',
        EXIT.refused,
      );
    }
    cycleId = String(line.id);
  }
  const record = await superworker.ledger.cycles.hold(cycleId, nodes);
  const holding = Array.isArray(record.holding) ? record.holding : [];
  const lines = holding.map((item, index) =>
    `${index === 0 ? 'CURRENT_NODE' : 'HOLDING   '}: ${cycleId} → ${item.id}`,
  );
  return { stdout: lines.join('\n') };
});

/** `cycle close`. */
export const cycleCloseVerb = run("cycle close", async (call) => {
  const { values, positionals, superworker } = call;
  const [id, node] = positionals.map((words) => words[0]);
  const record = await superworker.ledger.cycles.close(id, { node, result: values.result });
  return {
    stdout: `NODE_CLOSED: ${id} → ${node} ${values.result} (path is now ${(record.path ?? []).length} step(s))`,
  };
});

/**
 * `cycle retry`: the old ticket is taken down (and, with `--drop`, so is the claim). The two lines
 * name the ticket file, whose location is the engine's own read.
 */
export const cycleRetryVerb = run("cycle retry", async (call) => {
  const { values, positionals, superworker } = call;
  const [id, node] = positionals.map((words) => words[0]);
  await superworker.ledger.cycles.retry(id, node, {
    ...(values.drop === true ? { drop: true } : {}),
    ...(values.summary === undefined ? {} : { summary: values.summary }),
  });
  const ticket = superworker.locations.signal(String(id), String(node));
  return {
    stdout:
      values.drop === true
        ? `Signal dropped (no ticket left): ${ticket}`
        : `Signal cleared and rewritten as pending: ${ticket}`,
  };
});

// ═══ dag: the graph ══════════════════════════════════════════════════════════

/**
 * `dag add`: one node from a title, or a whole batch from a file. The file form is the same graph
 * write for every row: each row prints its id (and its `ref`, when it carried one) and where its
 * spec.md would go.
 */
export const dagAddVerb = run("dag add", async (call) => {
  const { values, positionals, superworker, root } = call;
  const titleWords = positionals[0] ?? [];
  const title = titleWords[0] ?? '';
  const description = (positionals[1] ?? []).join(' ') || values.desc;
  if (values.from_file === undefined && titleWords.length === 0) {
    // The title cell is optional on the row because the file form carries the titles instead: a call
    // with neither is refused with the same sentence the required cell used to answer with.
    return { code: 2, stderr: usageError(call.spec, 'the following arguments are required: title') };
  }
  if (values.from_file !== undefined) {
    if (titleWords.length > 0) return refuse('give either a title or --from-file', 2);
    // A batch carries the rows' own fields: a per-node option alongside it has nothing to shape.
    const alongside = ['desc', 'mode', 'weight', 'tags', 'depends_on']
      .filter((cell) => values[cell] !== undefined)
      .map((cell) => `--${cell.replace(/_/gu, '-')}`);
    if (alongside.length > 0) {
      return refuse(
        `--from-file takes the rows' own fields; drop ${alongside.join(', ')} (the rows carry them)`,
        2,
      );
    }
    const file = resolve(root, String(values.from_file));
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (error) {
      return refuse(`--from-file ${file} could not be read (${messageOf(error)})`);
    }
    let rows: unknown;
    try {
      rows = JSON.parse(text);
    } catch (error) {
      return refuse(`--from-file ${file} is not valid JSON (${messageOf(error)})`);
    }
    if (!Array.isArray(rows)) {
      return refuse(`--from-file ${file} must hold a JSON array of rows (one object per node)`);
    }
    const added = await superworker.ledger.dag.addMany(rows as DagAddManyRow[]);
    const lines: string[] = [];
    for (const node of added) {
      lines.push(
        node.ref === undefined
          ? `Node created: ${node.id}`
          : `Node created: ${node.id}  (ref ${node.ref})`,
      );
      lines.push(`Spec path (nonexistent): ${posix(await superworker.ledger.dag.specPath(node.id))}`);
    }
    return { stdout: lines.join('\n') };
  }
  const node = await superworker.ledger.dag.add({
    title,
    ...(description === undefined || description === '' ? {} : { description }),
    ...(values.mode === undefined ? {} : { mode: values.mode }),
    ...(values.weight === undefined ? {} : { weight: values.weight }),
    ...(values.tags === undefined ? {} : { tags: splitTags(values.tags) }),
    ...(values.depends_on === undefined ? {} : { depends_on: splitTags(values.depends_on) }),
  });
  const spec = await superworker.ledger.dag.specPath(node.id);
  return { stdout: `Node created: ${node.id}\nSpec path (nonexistent): ${posix(spec)}` };
});

/** `dag rm`. */
export const dagRmVerb = run("dag rm", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  await superworker.ledger.dag.remove(id, { ...(values.force === true ? { force: true } : {}) });
  return { stdout: `Removed ${id}` };
});

/** `dag update`. */
export const dagUpdateVerb = run("dag update", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  const patch: Record<string, unknown> = {};
  if (values.title !== undefined) patch.title = values.title;
  if (values.desc !== undefined) patch.description = values.desc;
  if (values.mode !== undefined) patch.mode = values.mode;
  if (values.weight !== undefined) patch.weight = values.weight;
  if (values.tags !== undefined) patch.tags = splitTags(values.tags);
  if (values.clear_tags === true) patch.tags = null;
  if (Object.keys(patch).length === 0) {
    // A call that names no change is a line this word cannot take, and it answers like one: the
    // sentence on stderr, and the refusal's own code (never a success code with an error sentence).
    return refuse(
      'No changes: provide --title, --desc, --mode, --weight, --tags and/or --clear-tags',
      EXIT.refused,
    );
  }
  await superworker.ledger.dag.update(id, patch);
  return { stdout: `Updated ${short(id)}` };
});

/**
 * `dag depend` / `dag undepend`: the edge edits. `--on` takes a comma-separated list: the whole list
 * is one batch and one graph write, so a missing id refuses every edge of it. One edge stays silent
 * as it always was; a list answers the receipt a batch needs, since the whole call is one write and
 * there is otherwise nothing to confirm it landed.
 */
export const dagDependVerb = run("dag depend", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  const deps = splitTags(values.on);
  if (deps.length === 0) {
    return refuse('dag depend needs --on with at least one dependency id: `--on a,b,c`', EXIT.refused);
  }
  await superworker.ledger.dag.link(id, deps);
  if (deps.length === 1) return {};
  return { stdout: `Linked ${short(id)} → ${deps.length} dependencies: ${deps.map(short).join(', ')}` };
});

export const dagUndependVerb = run("dag undepend", async (call) => {
  const { values, positionals, superworker } = call;
  const id = call.at(0)!;
  const [dep] = (positionals[1] ?? []);
  const dependency = dep ?? values.from;
  if (dependency === undefined) {
    return refuse('specify dependency to remove via positional arg or --from', EXIT.refused);
  }
  await superworker.ledger.dag.unlink(id, dependency);
  return { stdout: `UNLINKED: ${short(id)} → ${short(dependency)}` };
});

/** `dag status`. */
export const dagStatusVerb = run("dag status", async (call) => {
  const { positionals, superworker } = call;
  const [id, status] = positionals.map((words) => words[0]);
  await superworker.ledger.dag.setStatus(id, status as NodeStatus);
  return { stdout: `STATUS: ${short(id)} → ${status}` };
});

/** `dag approve`. */
export const dagApproveVerb = run("dag approve", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  const node = await superworker.ledger.dag.approve(id, values.at);
  return { stdout: `APPROVED: ${id} at ${node.approved_at ?? values.at}` };
});

/** `dag revive`. */
export const dagReviveVerb = run("dag revive", async (call) => {
  const { superworker } = call;
  const id = call.at(0)!;
  const node = await superworker.ledger.dag.revive(id);
  return { stdout: `REVIVED: ${node.title ?? ''} -> todo` };
});

/** `dag list`: the rows as one JSON line (the compact spelling). */
export const dagListVerb = run("dag list", async (call) => {
  const { values, superworker } = call;
  const filter: Record<string, unknown> = {};
  if (values.ready === true) filter.ready = true;
  if (values.status !== undefined && values.status.length > 0) filter.status = values.status;
  if (values.tags !== undefined) filter.tags = splitTags(values.tags);
  if (values.limit !== undefined) filter.limit = Number(values.limit);
  const rows = await superworker.ledger.dag.list(filter);
  return { stdout: pyCompact(values.verbose === true ? await verboseList(superworker, rows) : rows) };
});

/** `dag list --verbose`: each row grows its two dependency lists, spelled the same way. */
async function verboseList(superworker: Superworker, rows: readonly unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const row of rows) {
    const one = row as { id: string };
    const info = await superworker.ledger.dag.info(one.id, { verbose: true });
    out.push({
      ...one,
      deps: info.depends_on.map((edge) => edge.id),
      dependents: info.depended_by.map((edge) => edge.id),
    });
  }
  return out;
}

/** `dag info`. */
export const dagInfoVerb = run("dag info", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  const info = await superworker.ledger.dag.info(id, { ...(values.verbose === true ? { verbose: true } : {}) });
  return { stdout: pyCompact(info) };
});

/** `dag context`. */
export const dagContextVerb = run("dag context", async (call) => {
  const { superworker } = call;
  const id = call.at(0)!;
  return { stdout: pyCompact(await superworker.ledger.dag.context(id)) };
});

/** `dag search`. */
export const dagSearchVerb = run("dag search", async (call) => {
  const { values, superworker } = call;
  const query = call.at(0)!;
  const hits = await superworker.ledger.dag.search(query, {
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(values.active_only === true ? { activeOnly: true } : {}),
  });
  return { stdout: pyCompact(hits) };
});

/** `dag open`: the absolute spec path, forward slashes. */
export const dagOpenVerb = run("dag open", async (call) => {
  const { superworker } = call;
  const id = call.at(0)!;
  return { stdout: posix(await superworker.ledger.dag.specPath(id)) };
});

/** `dag validate`: the two checks, then the count and the status histogram. */
export const dagValidateVerb = run("dag validate", async (call) => {
  const { superworker } = call;
  const report = await superworker.ledger.dag.validate();
  const lines: string[] = [];
  const cycleLines = report.problems.filter((problem) => problem.includes('check=no_cycles'));
  const danglingLines = report.problems.filter((problem) => problem.includes('check=no_dangling'));
  const otherLines = report.problems.filter(
    (problem) => !problem.includes('check=no_cycles') && !problem.includes('check=no_dangling'),
  );
  if (cycleLines.length === 0) lines.push(`PASS  check=no_cycles  nodes=${report.total}`);
  else lines.push(...cycleLines);
  if (danglingLines.length === 0) lines.push('PASS  check=no_dangling');
  else lines.push(...danglingLines);
  lines.push(...otherLines);
  lines.push(`Total nodes: ${report.total}`);
  for (const [status, count] of Object.entries(report.status_counts).sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`  ${status}: ${count}`);
  }
  return { stdout: lines.join('\n'), ...(report.ok ? {} : { code: 1 }) };
});

/** `dag help`: the group's own listing, which is the full usage reference of this layer. */
export const dagHelpVerb = run('dag help', async (call) => {
  return { stdout: call.helpText(call.specOf(call.groupFor('dag')!)) };
});

// ═══ config: one chain ═══════════════════════════════════════════════════════

/** One layer's printed label. */
function layerLabel(source: unknown, cycle: unknown, node: unknown): string {
  if (source === 'cycle') return `cycle ${typeof cycle === 'string' ? cycle : (cycle as { id?: unknown } | undefined)?.id ?? '?'}`;
  if (source === 'node') return `node ${short(node ?? '?')}`;
  if (source === 'builtin') return 'factory default';
  if (source === 'project') return 'project .superworker/config.json';
  if (source === 'global') return 'global ~/.superworker/config.json';
  return String(source);
}

/** One value as a line prints it: an unstated value is a dash. */
const shownValue = (value: unknown): string => (value === null || value === undefined ? '-' : pyScalar(value));

/** The layer a `set` / `unset` names, out of the line's own cells. */
function targetLayer(values: Record<string, any>): { layer: string; at: ConfigLayer } {
  if (values.global === true) return { layer: 'global', at: { global: true } };
  if (values.cycle !== undefined) return { layer: 'cycle', at: { cycle: values.cycle } };
  if (values.node !== undefined) return { layer: 'node', at: { node: values.node } };
  return { layer: 'project', at: { project: true } };
}

/** The layer cells a read names, when the line names any: `undefined` reads the two wide layers. */
function readLayerOf(values: Record<string, any>): ConfigLayer | undefined {
  const at: Record<string, string> = {
    ...(values.cycle === undefined ? {} : { cycle: values.cycle }),
    ...(values.node === undefined ? {} : { node: values.node }),
  };
  return Object.keys(at).length === 0 ? undefined : (at as ConfigLayer);
}

/** `config list`. */
export const configListVerb = run("config list", async (call) => {
  const { values, superworker } = call;
  const at = readLayerOf(values);
  const readings = await superworker.config.list(at);
  const keys = Object.keys(readings);
  const width = keys.reduce((wide, key) => Math.max(wide, key.length), 0);
  return {
    stdout: keys
      .map((key) => `${key.padEnd(width)} = ${shownValue(readings[key]!.value)} (${layerLabel(readings[key]!.source, values.cycle, values.node)})`)
      .join('\n'),
  };
});

/** `config get`: one value, and nothing else. */
export const configGetVerb = run("config get", async (call) => {
  const { values, superworker } = call;
  const key = call.at(0)!;
  const reading = await superworker.config.get(key, readLayerOf(values));
  return { stdout: shownValue(reading.value) };
});

/** `config set`: one value into exactly one layer, then the effective reading again. */
export const configSetVerb = run("config set", async (call) => {
  const { values, positionals, superworker } = call;
  const [key, raw] = positionals.map((words) => words[0]);
  const target = targetLayer(values);
  // The word travels to the gate exactly as typed: the gate parses it by the knob's kind, which is
  // where a switch's two strings `on` / `off` belong. The first line prints that same word, so
  // `max_agents 1_000` reads back as typed while the effective cell shows the parsed 1000.
  await superworker.config.set(key, raw, target.at);
  const reading = await superworker.config.get(key, target.at);
  return {
    stdout:
      `CONFIG: ${key} = ${pyScalar(raw)} (written to ${layerLabel(target.layer, values.cycle, values.node)})\n` +
      `CONFIG: effective ${key} = ${shownValue(reading.value)} (from ${layerLabel(reading.source, values.cycle, values.node)})`,
  };
});

/** `config unset`. */
export const configUnsetVerb = run("config unset", async (call) => {
  const { values, superworker } = call;
  const key = call.at(0)!;
  const target = targetLayer(values);
  await superworker.config.unset(key, target.at);
  const reading = await superworker.config.get(key, target.at);
  return {
    stdout:
      `CONFIG: ${key} override dropped from ${layerLabel(target.layer, values.cycle, values.node)}\n` +
      `CONFIG: effective ${key} = ${shownValue(reading.value)} (from ${layerLabel(reading.source, values.cycle, values.node)})`,
  };
});

// ═══ instruction: the user's standing words ══════════════════════════════════

/** The scope words a reader sees (the account's own vocabulary, spelled out). */
const SCOPE_WORDS: Record<string, string> = {
  global: 'global (counts anywhere)',
  cycle: 'for this run (it stops counting once this run ends)',
  node: 'this node only (it stops counting once this node is done)',
};

/** `instruction add`. */
export const instructionAddVerb = run("instruction add", async (call) => {
  const { values, superworker } = call;
  const entry = await superworker.ledger.instructions.add({
    text: values.text,
    scope: values.scope ?? 'global',
    ...(values.target === undefined ? {} : { target: values.target }),
    ...(values.cycle === undefined ? {} : { cycle: values.cycle }),
    ...(values.node === undefined ? {} : { node: values.node }),
    ...(values.said_by === undefined ? {} : { said_by: values.said_by }),
    ...(values.note === undefined ? {} : { note: values.note }),
    ...(values.stop_after_nodes === undefined ? {} : { stop_after_nodes: Number(values.stop_after_nodes) }),
  });
  const scope = String(entry.scope ?? values.scope ?? 'global');
  const target = String(entry.target ?? 'stage');
  // The binding as a reader sees it: the line's id, and the node's short form. A global entry records
  // where it was said, and the printed line leaves that bookkeeping on the account.
  const where = scope === 'global'
    ? []
    : [entry.cycle, typeof entry.node === 'string' && entry.node !== '' ? short(entry.node) : undefined]
      .filter((cell) => typeof cell === 'string' && cell !== '');
  return {
    stdout:
      `INSTRUCTION ${entry.id}: [${scope}/${target}] ${entry.text}` +
      (where.length > 0 ? `   @ ${where.join(' / ')}` : ''),
  };
});

/**
 * The two sentences a project with no entries at all reads: the account is absent, and that state is
 * an answer rather than a failure. The same pair is printed by the reader's view and the account
 * views — both places say "no record", so a reader cannot mistake it for
 * "there is a record and you are not seeing it".
 */
const NO_RECORD_LINES = [
  'This project has no instruction record at all.',
  'That is not an error: work can start as usual.',
];

/** The reader's view found nothing while the account holds entries: the count, and why silence is not a green light. */
function nothingVisibleLines(total: number): string[] {
  return [
    'No instruction is visible from this step.',
    `(The instruction record has ${total} entries: they are bound to another cycle or another node, or they are no longer in force. When the position cannot be pinned down these entries are still read out -- reading as empty means they really cannot reach this step.)`,
  ];
}

/** One of the account views (`--all` / `--live` / `--scope`) found nothing: say which of the four states this is. */
function emptyAccountLines(total: number, scope: string | undefined, globalTotal: number): string[] {
  if (total === 0) return NO_RECORD_LINES;
  if (scope !== undefined) {
    return [
      `No instruction with scope=${scope} is still in force.`,
      `(The instruction record has ${total} entries.)`,
    ];
  }
  if (globalTotal === 0) {
    return [
      'This project has no global instruction.',
      `(The instruction record has ${total} entries, and none of them is global.)`,
    ];
  }
  return [
    'No instruction record is in force right now.',
    `(The instruction record has ${total} entries, and none of them is in force. Only the owner can archive an instruction.)`,
  ];
}

/** The account's own two counts: every entry, and how many of them read global. Both come off the engine's account view. */
async function instructionTotals(superworker: Superworker) {
  const all = await superworker.ledger.instructions.list({ all: true });
  const global = await superworker.ledger.instructions.list({ all: true, scope: 'global' });
  return { total: all.length, globalTotal: global.length };
}

/** `instruction list`: the reader-facing view by default, the account when asked for it. */
export const instructionListVerb = run("instruction list", async (call) => {
  const { values, superworker } = call;
  const accountView = values.all === true || values.live === true || values.scope !== undefined;
  const filter = {
    ...(values.all === true ? { all: true } : {}),
    ...(values.live === true ? { live: true } : {}),
    ...(values.scope === undefined ? {} : { scope: values.scope }),
    ...(values.node === undefined ? {} : { node: values.node }),
  };
  const rows = await superworker.ledger.instructions.list(Object.keys(filter).length === 0 ? undefined : filter);
  const asJson = (cells: readonly unknown[]) =>
    pyIndented(cells.map(({ id, text, scope, target }: any) => ({ id, text, scope, target })));
  if (!accountView) {
    const visible = rows as readonly InstructionReaderRow[];
    if (values.json === true) return { stdout: asJson(visible) };
    if (visible.length === 0) {
      // Two silences with two meanings: no record at all, or a record whose entries cannot reach this
      // step. The account's own count is what tells them apart.
      const { total } = await instructionTotals(superworker);
      return { stdout: (total === 0 ? NO_RECORD_LINES : nothingVisibleLines(total)).join('\n') };
    }
    const lines: string[] = [`This project has ${visible.length} instruction(s) visible from this step:`];
    for (const [index, row] of visible.entries()) {
      lines.push('');
      lines.push(`${index + 1}. ${row.text}`);
      if (row.scope) lines.push(`   visibility: ${SCOPE_WORDS[row.scope] ?? row.scope}`);
      const reach = ({ stage: 'every node', boundary: 'read only at the close' } as Record<string, string>)[row.reach];
      if (reach !== undefined) lines.push(`   reach: ${reach}`);
    }
    // The listing closes on a blank line, so the last entry's block ends where the next one begins.
    lines.push('');
    return { stdout: `${lines.join('\n')}\n` };
  }
  const cells = rows as readonly InstructionRecord[];
  if (values.json === true) return { stdout: pyIndented(cells) };
  if (cells.length === 0) {
    const { total, globalTotal } = await instructionTotals(superworker);
    return { stdout: emptyAccountLines(total, values.scope, globalTotal).join('\n') };
  }
  const marks: Record<string, string> = { live: '●', withdrawn: '✗' };
  const lines: string[] = [];
  for (const entry of cells) {
    const mark = marks[String(entry.state)] ?? '✗';
    const deliver = ({ stage: 'visible while working', boundary: 'read only when closing out' } as Record<string, string>)[String(entry.target)] ?? '?';
    lines.push(`${mark} ${entry.id}  [${entry.scope}/${deliver}]  ${entry.text ?? ''}`);
    if (typeof entry.note === 'string' && entry.note !== '') lines.push(`      note: ${entry.note}`);
  }
  return { stdout: lines.join('\n') };
});

/** `instruction resolve`: archive one entry, with the note the owner put on it when one is given. */
export const instructionResolveVerb = run("instruction resolve", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  await superworker.ledger.instructions.resolve(id, values.note === undefined ? undefined : { note: values.note });
  return { stdout: `INSTRUCTION ${id} → ${values.state}` };
});

/** `instruction rm`: the sentence is printed first, then it goes. */
export const instructionRmVerb = run("instruction rm", async (call) => {
  const { superworker } = call;
  const id = call.at(0)!;
  const before = await superworker.ledger.instructions.list({ all: true });
  const hit = before.find((entry) => entry.id === id);
  const head =
    hit === undefined
      ? ''
      : `INSTRUCTION ${hit.id}: [${hit.scope}/${hit.target ?? 'stage'}] ${hit.text}\n`;
  await superworker.ledger.instructions.remove(id);
  return { stdout: `${head}REMOVED ${id}` };
});

/** `instruction revive`. */
export const instructionReviveVerb = run("instruction revive", async (call) => {
  const { superworker } = call;
  const id = call.at(0)!;
  await superworker.ledger.instructions.revive(id);
  return { stdout: `INSTRUCTION ${id} → live` };
});

// ═══ session: a node's own conversations, on this machine only ═══════════════

/** `session show`: one node's note; an empty note is an answer, not an error. */
export const sessionShowVerb = run("session show", async (call) => {
  const { values, superworker } = call;
  const id = call.at(0)!;
  const shown = await superworker.sessions.show(id);
  if (values.json === true) {
    return { stdout: pyIndented({ node: shown.node, v: shown.v, discussion: shown.discussion, run: shown.run }) };
  }
  const lines: string[] = [`${shown.node}  ${shown.title}`.trimEnd()];
  const entries = [...shown.discussion.map((entry) => ['discussion', entry] as const), ...shown.run.map((entry) => ['run', entry] as const)];
  if (entries.length === 0) {
    lines.push('  no session note: this machine did not record a discussion or a run for it');
    return { stdout: lines.join('\n') };
  }
  for (const [role, entry] of entries) {
    lines.push(`  ${String(role).padEnd(10)} ${entry.session}  ${entry.host ?? '?'}  ${entry.at ?? 'time unknown'}`);
  }
  return { stdout: lines.join('\n') };
});

/** `session list`: every note this machine holds, keyed by node id. */
export const sessionListVerb = run("session list", async (call) => {
  const { values, superworker } = call;
  const notes = await superworker.sessions.list();
  if (values.json === true) {
    const table: Record<string, unknown> = {};
    for (const row of notes) table[row.node] = { v: 1, discussion: row.note.discussion, run: row.note.run };
    // The machine view stays a JSON object in every state, the empty one included.
    return { stdout: pyIndented(table) };
  }
  if (notes.length === 0) {
    return { stdout: `no session notes under ${superworker.locations.paths.sessionsDir}` };
  }
  const lines: string[] = [];
  for (const row of notes) {
    const stamps = [...row.note.discussion, ...row.note.run]
      .map((entry) => entry.at)
      .filter((at) => typeof at === 'string' && at !== '');
    const latest = stamps.length === 0 ? 'time unknown' : stamps.sort().at(-1);
    lines.push(
      `${row.node}  discussion ${row.note.discussion.length}  run ${row.note.run.length}  ` +
        `latest ${latest}  ${row.title ?? ''}`.trimEnd(),
    );
  }
  return { stdout: lines.join('\n') };
});

// ═══ the words about where this is standing ══════════════════════════════════

/**
 * The package root this module answers from, when the call handed in no seam of its own: the nearest
 * ancestor that carries a manifest. `WordsIO.packageRoot` is the seam; this is its documented default.
 */
function packageRoot(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolve(dir, '..'),
    resolve(dir, '..', '..'),
    resolve(dir, '..', '..', '..'),
  ]) {
    try {
      JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'));
      return candidate;
    } catch {
      // Not this one: the bundle sits two levels above its module, the engine product three.
    }
  }
  return resolve(dir, '..', '..');
}

/** The one line `version` prints, and the first line `doctor` prints: the package root this call was handed, or this module's own. */
function standingLine(io: WordsIO): string {
  const root = io.packageRoot ?? packageRoot();
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string; version?: string };
    return `${manifest.name ?? 'superworker-core'} ${manifest.version ?? '0.0.0'} at ${root}`;
  } catch {
    // A tree with no readable manifest still answers where it stands.
    return `superworker-core 0.0.0 at ${root}`;
  }
}

/** `version`: which package this is, its version, and the directory it was read from. */
export const versionVerb = run('version', async (call) => ({ stdout: standingLine(call.io) }));

/**
 * `doctor [--fix]`: the engine's check-up, printed cell by cell. With `--fix` it runs `init` once
 * afterwards — `init` recognizes what is already there, so the cell a missing layout file turned
 * red comes back green without a second setup act.
 */
export const doctorVerb = run("doctor", async (call) => {
  const { values, io, root, superworker } = call;
  const report = await superworker.conductor.doctor({ git: io.git });
  const lines: string[] = [standingLine(io), `project root: ${root}`];
  for (const check of report.checks) {
    const detail = (check.detail ?? '').split('\n');
    const one = detail.length === 1 && detail[0] !== '';
    lines.push(`  ${check.ok ? '✓' : '✗'} ${check.name}${one ? `: ${detail[0]}` : ''}`);
    if (!one) for (const line of detail) lines.push(`      ${line}`);
  }
  if (values.fix === true) {
    await superworker.ledger.init({ git: io.git });
    lines.push('  → `init` ran once to fill the layout files in (it recognizes what is already there)');
  }
  lines.push(report.ok ? 'every health check passed.' : `${report.checks.filter((check) => !check.ok).length} check(s) still red.`);
  return { stdout: lines.join('\n'), ...(report.ok ? {} : { code: 1 }) };
});

/**
 * `merge-ledger`: the record merge driver git calls, answered in this process. The rule itself is
 * the driver's own (`ledgermerge/`); this word only hands the four paths over and carries the exit
 * code back out.
 */
export const mergeLedgerVerb = run("merge-ledger", async (call) => {
  const [base, ours, theirs, path] = (call.positionals ?? []).flatMap((words) => [...words]);
  if (base === undefined || ours === undefined || theirs === undefined) {
    return refuse(
      'the merge driver takes four paths (%O %A %B %P: the common side, this side, the other side, and the path in the repository)',
      EXIT.refused,
    );
  }
  const out: string[] = [];
  const err: string[] = [];
  const code = await runMergeDriver(
    { base, ours, theirs, path: path ?? ours },
    { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
  );
  return { code, stdout: out.join(''), stderr: err.join('') };
});
;
