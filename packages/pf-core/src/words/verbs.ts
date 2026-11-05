/**
 * The verbs: one handler per word, each a thin reading of engine answers into the line a person
 * reads. No record is ever written here — every write goes through the engine handle — and no word
 * has a second implementation elsewhere.
 *
 * The conventions the lines follow: the same field order in a JSON reading, the same two-space
 * indent, the same short id (the first eight characters) when a longer one would only make the line
 * longer.
 */
import { join } from 'node:path';
import type { ConfigLayer, ConfigValue } from '../config';
import type { CyclePolicyValue, InstructionReaderRow } from '../ledger';
import type { CycleStatus, InstructionRecord, NodeResult, NodeStatus } from '../types';
import {
  guarded,
  handleOf,
  messageOf,
  posix,
  project,
  projectRootOf,
  pyCompact,
  pyIndented,
  pyList,
  pyScalar,
  readCount,
  readPolicyValue,
  refuse,
  short,
  splitTags,
} from './out';
import type { VerbCall } from './types';

// ═══ the pipeline verbs ══════════════════════════════════════════════════════

/**
 * `pf init`: put the record directory in place. The engine's report is the reading; the lines below
 * are that reading spelled out (what was written, what was skipped and why).
 */
export const initVerb = guarded(async (call: VerbCall) => {
  const { values, io } = call;
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  const layout = values.commit === true ? 'in-repo' : 'own-repo';
  // The record directory gets a repository of its own in the own-repo layout, unless the line said
  // `--no-own-repo`: that is the default, and `--own-repo` is the flag on the other side.
  const ownRepoAsked = layout === 'own-repo' && values.no_own_repo !== true;
  const report = await pf.ledger.init({ layout, ownRepo: ownRepoAsked, git: io.git });
  const lines: string[] = [];
  lines.push(`Ledger: ${join(root, '.pf')}`);
  lines.push(
    report.layout === 'own-repo'
      ? 'Mode: this machine only (.pf/ does not enter the team repository)'
      : 'Mode: into the version repository with the project',
  );
  const configFile = join(root, '.pf', 'config.json');
  lines.push(
    report.written.includes('config.json')
      ? `Config file: ${configFile} (written; empty = all factory defaults, and \`pf config set\` is how to change one)`
      : `Config file: ${configFile} (already there, left alone; empty = all factory defaults, and \`pf config set\` is how to change one)`,
  );
  const exclude = {
    written: 'the ignore line is in place in this repository\'s info/exclude',
    removed: 'the ignore line was taken out of this repository\'s info/exclude',
    'skipped-not-a-checkout': 'this project is not a git checkout: there is no ignore line to speak of',
    'skipped-not-own-repo': 'the record directory travels with the project: no ignore line is written',
    failed: 'the ignore line could not be written',
  }[report.exclude];
  if (exclude !== undefined) lines.push(exclude);
  // The two own-repo sentences printed when a repository was asked for (and the two
  // nothing is printed for: `--no-own-repo`, and the in-repo layout, which never creates one).
  const ownRepo = ownRepoAsked
    ? ({
        created: `Gave ${join(root, '.pf')} a repository of its own: local history starts here, and once a remote is attached to it, it can travel to another machine on its own.`,
        present: `${join(root, '.pf')} already has a repository of its own; it was left alone.`,
      } as Record<string, string | undefined>)[report.ownRepo]
    : undefined;
  if (ownRepo !== undefined) lines.push(ownRepo);
  if (report.mergeDriverCommand !== null) {
    // What this run left in `merge.pf.driver`: the string it wrote, or the working registration it kept.
    lines.push(`Merge driver registered: merge.pf.driver = ${report.mergeDriverCommand}`);
  }
  for (const warning of report.warnings) lines.push(`Warning: ${warning}`);
  return { stdout: lines.join('\n') };
}, 1);

/** `pf register`: write the merge driver's two keys, nothing else. */
export const registerVerb = guarded(async (call: VerbCall) => {
  const { values, io } = call;
  const root = projectRootOf(values.project, io.root);
  const pf = await handleOf(root, io);
  const command = await pf.ledger.register({ git: io.git });
  if (command === null) {
    return {
      stdout:
        'The merge driver was not registered: there is no git config to write here (this project is not a git checkout).',
    };
  }
  return { stdout: command };
}, 1);

/** `pf clean-temp`: list (or with `--yes`, remove) every node's `temp/` directory. */
export const cleanTempVerb = guarded(async (call: VerbCall) => {
  const { values } = call;
  const { pf } = await project(values.project, call.io);
  const report = await pf.ledger.cleanTemp({
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
}, 1);

/** `pf handoff`: the ticket shape, or one ticket written. */
export const handoffVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const root = projectRootOf(values.project, call.io.root);
  const pf = await handleOf(root, call.io);
  const [cycle, node, status] = positionals.map((words) => words[0]);
  if (values.form === true) {
    if (cycle === undefined) {
      return refuse('the form needs <cycle>: `pf handoff --form <cycle>`', 2);
    }
    const form = await pf.conductor.handoffForm({ cycle, ...(node === undefined ? {} : { node }) });
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
      `pf handoff ${form.cycle} ${node ?? '<node id>'} completed -s "<one-line summary>" -o '{${fields.join(',')}}'`,
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
      2,
    );
  }
  const outputs = await readOutputs(values.outputs);
  if (outputs.error !== undefined) return refuse(outputs.error, 1);
  const ticket = await pf.conductor.handoff({
    cycle: cycle,
    node,
    status: status as NodeResult,
    summary: values.summary,
    outputs: outputs.value,
  });
  return {
    stdout:
      `handoff: ${ticket.node} ticket written; the node is not closed yet -- finish it with ` +
      `\`pf next --after ${ticket.node} --json\` (no session was opened)`,
  };
}, 2);

/** The `-o` cell: an inline object, `@path`, or stdin (`-`). */
async function readOutputs(raw: unknown): Promise<{ error?: string; value?: Record<string, unknown> }> {
  const text = raw === undefined ? '{}' : String(raw);
  let payload = text;
  if (text === '-') {
    payload = await new Promise((settle) => {
      let held = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => {
        held += chunk;
      });
      process.stdin.on('end', () => settle(held));
    });
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
    `pf cycle ${verb} must be given --tags (the range this line picks from). For example: ` +
      `pf cycle ${verb} <slug> --tags coding. Known words: writing/coding/art ` +
      '(a word outside the vocabulary is fine too; it is taken as given). Every pick this line ' +
      'makes, and which plugins may react to it, reads this one range.',
    2,
  );
}

/** `cycle create`. */
export const cycleCreateVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  if (values.tags === undefined || splitTags(values.tags).length === 0) {
    return noTagsRefusal('create');
  }
  const { pf } = await project(values.project, call.io);
  const record = await pf.ledger.cycles.create({
    id,
    ...(values.title === undefined ? {} : { title: values.title }),
    tags: splitTags(values.tags),
    ...(values.force === true ? { force: true } : {}),
  });
  const tags = Array.isArray(record.tags) ? record.tags : [];
  return { stdout: `CREATED: cycle "${record.id}"${tags.length > 0 ? ` (tags=${pyList(tags)})` : ''}` };
}, 1);

/** `cycle start`: create and pin the opening node — two lines, the creation and the pinning. */
export const cycleStartVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  if (values.tags === undefined || splitTags(values.tags).length === 0) {
    return noTagsRefusal('start');
  }
  const { pf } = await project(values.project, call.io);
  const record = await pf.ledger.cycles.start({
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
    : String((await pf.ledger.dag.get(pin.id))?.title ?? '');
  return {
    stdout:
      `CREATED: cycle "${record.id}"${tags.length > 0 ? ` (tags=${pyList(tags)})` : ''}\n` +
      `STARTED: cycle "${record.id}" → ${title}` +
      (holding.length > 1 ? `  (${holding.length} node(s) pinned)` : ''),
  };
}, 1);

/** `cycle rename`. */
export const cycleRenameVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const record = await pf.ledger.cycles.rename(id, values.title);
  return { stdout: `RENAMED: "${record.id}" → "${record.title}"` };
}, 1);

/** `cycle status`. */
export const cycleStatusVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const [id, status] = positionals.map((words) => words[0]);
  const { pf } = await project(undefined, call.io);
  const record = await pf.ledger.cycles.setStatus(id, status as CycleStatus);
  return { stdout: `CYCLE_STATUS: "${record.id}" → ${record.status}` };
}, 1);

/** `cycle policy`. */
export const cyclePolicyVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const [id, key, value] = positionals.map((words) => words[0]);
  const { pf } = await project(undefined, call.io);
  const effective = await pf.ledger.cycles.setPolicy(id, key, readPolicyValue(value) as CyclePolicyValue);
  return {
    stdout: `POLICY: "${id}" → ${Object.entries(effective).map(([name, held]) => `${name}=${pyScalar(held)}`).join(', ')}`,
  };
}, 1);

/** `cycle list`. */
export const cycleListVerb = guarded(async (call: VerbCall) => {
  const { pf } = await project(undefined, call.io);
  const cycles = await pf.ledger.cycles.list();
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
}, 1);

/** `cycle current`: the lines in service, and every line still holding a node. */
export const cycleCurrentVerb = guarded(async (call: VerbCall) => {
  const { pf } = await project(undefined, call.io);
  const cycles = await pf.ledger.cycles.list();
  const lines = cycles.filter(
    (cycle) => cycle.status === 'active' || (Array.isArray(cycle.holding) ? cycle.holding : []).length > 0,
  );
  if (lines.length === 0) return { stdout: 'No active cycles.' };
  const out: string[] = [];
  for (const cycle of lines) {
    const mark = cycle.status === 'active' ? '●' : '○';
    const tags = Array.isArray(cycle.tags) && cycle.tags.length > 0 ? cycle.tags.join(',') : '(none)';
    const policy = await pf.ledger.cycles.policies(String(cycle.id));
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
}, 1);

/** `cycle show`: one node's standing in one line — the one word with a different meaning here. */
export const cycleShowVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const [id, node] = positionals.map((words) => words[0]);
  const { pf } = await project(undefined, call.io);
  const standing = await pf.ledger.cycles.standing(id, node);
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
}, 1);

/** `cycle hold`. */
export const cycleHoldVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const [id, node] = positionals.map((words) => words[0]);
  const { pf } = await project(undefined, call.io);
  await pf.ledger.cycles.hold(id, node);
  return { stdout: `CURRENT_NODE: ${id} → ${node}` };
}, 1);

/** `cycle close`. */
export const cycleCloseVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const [id, node] = positionals.map((words) => words[0]);
  const { pf } = await project(undefined, call.io);
  const record = await pf.ledger.cycles.close(id, { node, result: values.result });
  return {
    stdout: `NODE_CLOSED: ${id} → ${node} ${values.result} (path is now ${(record.path ?? []).length} step(s))`,
  };
}, 1);

/**
 * `cycle retry`: the old ticket is taken down (and, with `--drop`, so is the claim). The two lines
 * name the ticket file; its location is the engine's own layout, spelled here only for the reader.
 */
export const cycleRetryVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const [id, node] = positionals.map((words) => words[0]);
  const { root, pf } = await project(undefined, call.io);
  await pf.ledger.cycles.retry(id, node, {
    ...(values.drop === true ? { drop: true } : {}),
    ...(values.summary === undefined ? {} : { summary: values.summary }),
  });
  const ticket = join(root, '.pf', 'signals', id, `${node}.json`);
  return {
    stdout:
      values.drop === true
        ? `Signal dropped (no ticket left): ${ticket}`
        : `Signal cleared and rewritten as pending: ${ticket}`,
  };
}, 1);

// ═══ dag: the graph ══════════════════════════════════════════════════════════

/** `dag add`. */
export const dagAddVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const title = positionals[0]![0] ?? '';
  const description = (positionals[1] ?? []).join(' ') || values.desc;
  const { pf } = await project(values.project, call.io);
  const node = await pf.ledger.dag.add({
    title,
    ...(description === undefined || description === '' ? {} : { description }),
    ...(values.mode === undefined ? {} : { mode: values.mode }),
    ...(values.weight === undefined ? {} : { weight: values.weight }),
    ...(values.tags === undefined ? {} : { tags: splitTags(values.tags) }),
    ...(values.depends_on === undefined ? {} : { depends_on: splitTags(values.depends_on) }),
  });
  const spec = await pf.ledger.dag.specPath(node.id);
  return { stdout: `Node created: ${node.id}\nSpec path (nonexistent): ${posix(spec)}` };
}, 1);

/** `dag rm`. */
export const dagRmVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  await pf.ledger.dag.remove(id, { ...(values.force === true ? { force: true } : {}) });
  return { stdout: `Removed ${id}` };
}, 1);

/** `dag update`. */
export const dagUpdateVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const patch: Record<string, unknown> = {};
  if (values.title !== undefined) patch.title = values.title;
  if (values.desc !== undefined) patch.description = values.desc;
  if (values.mode !== undefined) patch.mode = values.mode;
  if (values.weight !== undefined) patch.weight = values.weight;
  if (values.tags !== undefined) patch.tags = splitTags(values.tags);
  if (values.clear_tags === true) patch.tags = null;
  if (Object.keys(patch).length === 0) {
    return { stderr: 'No changes: provide --title, --desc, --mode, --weight, --tags and/or --clear-tags' };
  }
  await pf.ledger.dag.update(id, patch);
  return {};
}, 1);

/** `dag depend` / `dag undepend`: the edge edits, silent on success. */
export const dagDependVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  await pf.ledger.dag.link(id, values.on);
  return {};
}, 1);

export const dagUndependVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const [dep] = (positionals[1] ?? []);
  const { pf } = await project(values.project, call.io);
  const dependency = dep ?? values.from;
  if (dependency === undefined) {
    return refuse('specify dependency to remove via positional arg or --from', 2);
  }
  await pf.ledger.dag.unlink(id, dependency);
  return {};
}, 1);

/** `dag status`. */
export const dagStatusVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const [id, status] = positionals.map((words) => words[0]);
  const { pf } = await project(undefined, call.io);
  await pf.ledger.dag.setStatus(id, status as NodeStatus);
  return {};
}, 1);

/** `dag approve`. */
export const dagApproveVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const node = await pf.ledger.dag.approve(id, values.at);
  return { stdout: `APPROVED: ${id} at ${node.approved_at ?? values.at}` };
}, 1);

/** `dag revive`. */
export const dagReviveVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(undefined, call.io);
  const node = await pf.ledger.dag.revive(id);
  return { stdout: `REVIVED: ${node.title ?? ''} -> todo` };
}, 1);

/** `dag list`: the rows as one JSON line (the compact spelling). */
export const dagListVerb = guarded(async (call: VerbCall) => {
  const { values } = call;
  const { pf } = await project(values.project, call.io);
  const filter: Record<string, unknown> = {};
  if (values.ready === true) filter.ready = true;
  if (values.status !== undefined && values.status.length > 0) filter.status = values.status;
  if (values.tags !== undefined) filter.tags = splitTags(values.tags);
  if (values.limit !== undefined) filter.limit = Number(values.limit);
  const rows = await pf.ledger.dag.list(filter);
  return { stdout: pyCompact(values.verbose === true ? await verboseList(pf, rows) : rows) };
}, 1);

/** `dag list --verbose`: each row grows its two dependency lists, spelled the same way. */
async function verboseList(pf: Awaited<ReturnType<typeof handleOf>>, rows: readonly unknown[]): Promise<unknown[]> {
  const out: unknown[] = [];
  for (const row of rows) {
    const one = row as { id: string };
    const info = await pf.ledger.dag.info(one.id, { verbose: true });
    out.push({
      ...one,
      deps: info.depends_on.map((edge) => edge.id),
      dependents: info.depended_by.map((edge) => edge.id),
    });
  }
  return out;
}

/** `dag info`. */
export const dagInfoVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const info = await pf.ledger.dag.info(id, { ...(values.verbose === true ? { verbose: true } : {}) });
  return { stdout: pyCompact(info) };
}, 1);

/** `dag context`. */
export const dagContextVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(undefined, call.io);
  return { stdout: pyCompact(await pf.ledger.dag.context(id)) };
}, 1);

/** `dag search`. */
export const dagSearchVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const query = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const hits = await pf.ledger.dag.search(query, {
    ...(values.limit === undefined ? {} : { limit: Number(values.limit) }),
    ...(values.active_only === true ? { activeOnly: true } : {}),
  });
  return { stdout: pyCompact(hits) };
}, 1);

/** `dag open`: the absolute spec path, forward slashes. */
export const dagOpenVerb = guarded(async (call: VerbCall) => {
  const { positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(undefined, call.io);
  return { stdout: posix(await pf.ledger.dag.specPath(id)) };
}, 1);

/** `dag validate`: the two checks, then the count and the status histogram. */
export const dagValidateVerb = guarded(async (call: VerbCall) => {
  const { pf } = await project(undefined, call.io);
  const report = await pf.ledger.dag.validate();
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
}, 1);

/** `dag help`: the group's own listing, which is the full usage reference of this layer. */
export async function dagHelpVerb(call: VerbCall) {
  return { stdout: call.helpText(call.specOf(call.groupFor('dag')!)) };
}

// ═══ config: one chain ═══════════════════════════════════════════════════════

/** One layer's printed label. */
function layerLabel(source: unknown, cycle: unknown, node: unknown): string {
  if (source === 'cycle') return `cycle ${typeof cycle === 'string' ? cycle : (cycle as { id?: unknown } | undefined)?.id ?? '?'}`;
  if (source === 'node') return `node ${String(node ?? '?').slice(0, 8)}`;
  if (source === 'builtin') return 'factory default';
  if (source === 'project') return 'project .pf/config.json';
  if (source === 'global') return 'global ~/.pf/config.json';
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
export const configListVerb = guarded(async (call: VerbCall) => {
  const { values } = call;
  const { pf } = await project(values.project, call.io);
  const at = readLayerOf(values);
  const readings = await pf.config.list(at);
  const keys = Object.keys(readings);
  const width = keys.reduce((wide, key) => Math.max(wide, key.length), 0);
  return {
    stdout: keys
      .map((key) => `${key.padEnd(width)} = ${shownValue(readings[key]!.value)} (${layerLabel(readings[key]!.source, values.cycle, values.node)})`)
      .join('\n'),
  };
}, 1);

/** `config get`: one value, and nothing else. */
export const configGetVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const key = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const reading = await pf.config.get(key, readLayerOf(values));
  return { stdout: shownValue(reading.value) };
}, 1);

/** `config set`: one value into exactly one layer, then the effective reading again. */
export const configSetVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const [key, raw] = positionals.map((words) => words[0]);
  const { pf } = await project(values.project, call.io);
  const target = targetLayer(values);
  const stored = readConfigValue(raw) as ConfigValue;
  await pf.config.set(key, stored, target.at);
  const reading = await pf.config.get(key, target.at);
  return {
    stdout:
      `CONFIG: ${key} = ${pyScalar(stored)} (written to ${layerLabel(target.layer, values.cycle, values.node)})\n` +
      `CONFIG: effective ${key} = ${shownValue(reading.value)} (from ${layerLabel(reading.source, values.cycle, values.node)})`,
  };
}, 1);

/** `config unset`. */
export const configUnsetVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const key = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const target = targetLayer(values);
  await pf.config.unset(key, target.at);
  const reading = await pf.config.get(key, target.at);
  return {
    stdout:
      `CONFIG: ${key} override dropped from ${layerLabel(target.layer, values.cycle, values.node)}\n` +
      `CONFIG: effective ${key} = ${shownValue(reading.value)} (from ${layerLabel(reading.source, values.cycle, values.node)})`,
  };
}, 1);

/** A written value as its kind reads it: `on` / `off` are switches, digits are numbers. */
function readConfigValue(raw: unknown): unknown {
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  if (typeof raw === 'string' && raw !== '' && Number.isFinite(Number(raw)) && String(Number(raw)) === raw) return Number(raw);
  return raw;
}

// ═══ instruction: the user's standing words ══════════════════════════════════

/** The scope words a reader sees (the account's own vocabulary, spelled out). */
const SCOPE_WORDS: Record<string, string> = {
  global: 'global (counts anywhere)',
  cycle: 'for this run (it stops counting once this run ends)',
  node: 'this node only (it stops counting once this node is done)',
};

/** `instruction add`. */
export const instructionAddVerb = guarded(async (call: VerbCall) => {
  const { values } = call;
  const { pf } = await project(values.project, call.io);
  const entry = await pf.ledger.instructions.add({
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
}, 1);

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
async function instructionTotals(pf: Awaited<ReturnType<typeof handleOf>>) {
  const all = await pf.ledger.instructions.list({ all: true });
  const global = await pf.ledger.instructions.list({ all: true, scope: 'global' });
  return { total: all.length, globalTotal: global.length };
}

/** `instruction list`: the reader-facing view by default, the account when asked for it. */
export const instructionListVerb = guarded(async (call: VerbCall) => {
  const { values } = call;
  const { pf } = await project(values.project, call.io);
  const accountView = values.all === true || values.live === true || values.scope !== undefined;
  const filter = {
    ...(values.all === true ? { all: true } : {}),
    ...(values.live === true ? { live: true } : {}),
    ...(values.scope === undefined ? {} : { scope: values.scope }),
    ...(values.node === undefined ? {} : { node: values.node }),
  };
  const rows = await pf.ledger.instructions.list(Object.keys(filter).length === 0 ? undefined : filter);
  const asJson = (cells: readonly unknown[]) =>
    pyIndented(cells.map(({ id, text, scope, target }: any) => ({ id, text, scope, target })));
  if (!accountView) {
    const visible = rows as readonly InstructionReaderRow[];
    if (values.json === true) return { stdout: asJson(visible) };
    if (visible.length === 0) {
      // Two silences with two meanings: no record at all, or a record whose entries cannot reach this
      // step. The account's own count is what tells them apart.
      const { total } = await instructionTotals(pf);
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
    const { total, globalTotal } = await instructionTotals(pf);
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
}, 1);

/** `instruction resolve`: archive one entry, with the note the owner put on it when one is given. */
export const instructionResolveVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  await pf.ledger.instructions.resolve(id, values.note === undefined ? undefined : { note: values.note });
  return { stdout: `INSTRUCTION ${id} → ${values.state}` };
}, 1);

/** `instruction rm`: the sentence is printed first, then it goes. */
export const instructionRmVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const before = await pf.ledger.instructions.list({ all: true });
  const hit = before.find((entry) => entry.id === id);
  const head =
    hit === undefined
      ? ''
      : `INSTRUCTION ${hit.id}: [${hit.scope}/${hit.target ?? 'stage'}] ${hit.text}\n`;
  await pf.ledger.instructions.remove(id);
  return { stdout: `${head}REMOVED ${id}` };
}, 1);

/** `instruction revive`. */
export const instructionReviveVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  await pf.ledger.instructions.revive(id);
  return { stdout: `INSTRUCTION ${id} → live` };
}, 1);

// ═══ session: a node's own conversations, on this machine only ═══════════════

/** `session show`: one node's note; an empty note is an answer, not an error. */
export const sessionShowVerb = guarded(async (call: VerbCall) => {
  const { values, positionals } = call;
  const id = positionals[0]![0];
  const { pf } = await project(values.project, call.io);
  const shown = await pf.sessions.show(id);
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
}, 1);

/** `session list`: every note this machine holds, keyed by node id. */
export const sessionListVerb = guarded(async (call: VerbCall) => {
  const { values } = call;
  const { root, pf } = await project(values.project, call.io);
  const notes = await pf.sessions.list();
  if (values.json === true) {
    const table: Record<string, unknown> = {};
    for (const row of notes) table[row.node] = { v: 1, discussion: row.note.discussion, run: row.note.run };
    // The machine view stays a JSON object in every state, the empty one included.
    return { stdout: pyIndented(table) };
  }
  if (notes.length === 0) {
    return { stdout: `no session notes under ${join(root, '.pf', 'meta', 'sessions')}` };
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
}, 1);

export { nextVerb, dispatchVerb } from './next';
