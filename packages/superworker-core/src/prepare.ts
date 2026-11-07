import { readFile } from 'node:fs/promises';
import { resolveConfig, createConfigNamespace } from './config';
import type { ConfigValue } from './config';
import type { ConductorTarget } from './conductor';
import { createCyclesNamespace, cycleHoldingIds, cyclePolicy } from './cycles';
import { createDagNamespace } from './dag';
import { isExistingPath } from './fs-helpers';
import { entryScope, visibleInstructionRows } from './instruct';
import { assertLedgerInitialized } from './initledger';
import { atomicWriteBytes, exclusiveCreateBytes, EOL } from './jsonio';
import { launchPromptPath, nodeRunDocPath, nodeSpecPath, recordPaths } from './paths';
import type { RecordPaths } from './paths';
import { planNext, promptTextOf, pyList, short, stringCellOf } from './planner';
import { loadPlugins, pluginsDirOf } from './plugins/scan';
import { declaredKnobSpecs, readingsOf } from './plugins/tables';
import type { PluginAssembly } from './plugins/assembly';
import type { PluginFolder } from './plugins/types';
import type { CycleRecord, InstructionRecord, NodeRecord } from './types';

/**
 * Dispatch preparation: the first half of `conductor.dispatch` — the material for one run, all of it
 * settled here.
 *
 * - **The prompt**: what dispatch hands to the session is one line of invocation
 *   (`/sw-conduct <node id> [pipeline]`, spelled byte for byte). Nothing comes after that line, and
 *   nothing may be padded in front of it: the node's mode, title and spec path are read by the session
 *   itself from the node record, the closing command and the ticket shape belong to the skill being
 *   called, and the standing instructions are read by the session itself with `instruction list` —
 *   none of that is in the prompt. It lands in the matching
 *   `<record>/meta/launch/<line>/<node>/prompt.txt`, atomic write, whole file overwritten (idempotent).
 * - **The run doc**: this round's run document, landing in the node directory
 *   (`<record>/nodes/<node>/run.md`). Its sections follow the run.md reading — "what was done",
 *   "self-decisions", "known unresolved", "verified facts" are the four fixed sections; this
 *   preparation step fills in "verified facts" (the node's mode/weight/tags, the spec's location and
 *   its `method:` line, this line's status/tags/policies/holding, three settings readings, and the
 *   instructions in force that are visible from the current position), and the other three sections
 *   are left for this round's session to write. Every word comes from records and the spec, nothing is
 *   improvised; the first preparation sets the document up by exclusive creation and later ones
 *   leave it alone (once written it belongs to the session), and a repeated preparation does not
 *   produce a second one.
 * - **The handoff template**: what this line wants, and which verdict words there are. The fields and
 *   verdict words follow the fixed shape (`handoff --form` prints: `deliverable` / `acceptance` /
 *   `touched`, verdicts `completed | failed | stopped`); nothing here prints a command line (this
 *   library has none), so the template is a piece of text handed back with the
 *   rest of the material and not landed on disk.
 * - **Only dispatch plans are accepted**: preparation reads a read-only plan first; when what the plan
 *   hands back is not a dispatch (the line has no node to pin, the sessions were all opened already, the
 *   ticket is not in yet), there is no material to prepare and it says so on the spot, writing not one
 *   byte. Pinning (`open_node`'s claim) and handing the request to the executor are the other two
 *   write-side steps and are not in this half of the action.
 *
 * The runtime export surface reaches this block through `conductor.prepare` (the material landed, no
 * session opened); `conductor.dispatch` is the same block behind its own gates, followed by the
 * executor and the claim — and it skips the block altogether when the prompt it would land is already
 * on disk, because then the pinning step landed it and there is nothing left to prepare.
 */
export interface PrepareOptions {
  /**
   * The home where the machine-layer settings land (`<home>/.superworker/config.json`). This machine's user home
   * directory by default; tests shut it into a temporary directory so the reading does not depend on the
   * real machine.
   */
  readonly homeDir?: string;
  /** The location of the plugin directory; `<root>/plugins` by default, one folder per plugin (the template's reading cell comes from here). */
  readonly pluginsDir?: string;
  /**
   * The plugin directory already assembled by the caller (the dispatch reads it for its gate before it gets
   * here): handed in, the same copy answers here and the folder is not read a second time in one dispatch.
   */
  readonly assembly?: PluginAssembly;
}

/** The material of one node in one dispatch: the prompt, the run doc and the handoff template, handed back together with their locations. */
export interface PreparedNode {
  readonly node_id: string;
  readonly node_title: string;
  readonly mode: NodeRecord['mode'];
  /** Where this node's prompt lands (`<record>/meta/launch/<line>/<node>/prompt.txt`). */
  readonly prompt: string;
  /** The one line to write into that file (the same spelling the plan hands back as `prompt_text`). */
  readonly prompt_text: string;
  /** Where the run doc lands (`<record>/nodes/<node>/run.md`). */
  readonly run_doc: string;
  /** The handoff template: what this line wants, and which verdict words there are (a text product, not landed on disk). */
  readonly handoff_template: string;
}

/** The material of one dispatch: which line, and one entry per node of it that is to be dispatched. */
export interface PreparedDispatch {
  readonly cycle: string;
  readonly nodes: readonly PreparedNode[];
}

/** The bytes of a text product before landing: the line ending follows the platform (the same convention as the record writer). */
const encoder = new TextEncoder();

function textBytes(text: string): Uint8Array {
  return encoder.encode(text.replace(/\n/g, EOL));
}

/** How one settings reading looks to a person: nobody set it, so it is written as null, honestly. */
function shown(value: ConfigValue | null): string {
  return value === null ? 'null' : String(value);
}

/** The binding word of an instruction: global; `cycle <line>`; `node <eight-digit short id>`. */
function scopeWord(entry: InstructionRecord): string {
  const scope = entryScope(entry);
  if (scope === 'cycle') return `cycle ${typeof entry.cycle === 'string' ? entry.cycle : '?'}`;
  if (scope === 'node') return `node ${typeof entry.node === 'string' ? short(entry.node) : '?'}`;
  return 'global';
}

/** One instruction in the run doc's "verified facts": its text followed by the binding and (if any) the stopping boundary. */
function instructionLine(entry: InstructionRecord, index: number): string {
  const words = [scopeWord(entry)];
  if (entry.target === 'boundary') words.push('boundary');
  if (typeof entry.stop_after_nodes === 'number') {
    words.push(`stop_after_nodes=${entry.stop_after_nodes}`);
  }
  return `  ${index + 1}. ${stringCellOf((entry as { text?: unknown }).text)} (${words.join(', ')})`;
}

/**
 * The handoff template: the fields this line wants and the verdict words, as one block of text.
 *
 * The fields and verdict words follow the shape `handoff --form` prints, word for word (the three cells
 * `deliverable` / `acceptance` / `touched`, the verdicts `completed | failed | stopped`); nothing in
 * this library prints a command line (the engine has none), so the same sheet is written as text here
 * from the library's three
 * inputs (the verdict, a one-line account, the outputs object). `readings` are the cells this line is
 * configured to measure (a plugin-declared reading with `source: ticket`, where `when_knob` has a value
 * in force on the chain); when there are any, one more
 * cell `"reading"` is carried at the end in declaration order — nothing to measure means nobody reports a
 * number (`_reading_slots`: the question in the cell comes from the declaration's own `ask`, and the key
 * name is used when it states none).
 */
export function handoffTemplate(
  cycleId: string,
  nodeId?: string | null,
  readings: ReadonlyArray<{ readonly key: string; readonly ask: string }> = [],
): string {
  const outputs =
    '"deliverable":"<path to the thing this node is meant to produce>",' +
    '"acceptance":["<key acceptance point 1>","<key acceptance point 2>"],' +
    '"touched":["<files you changed under this node>"]' +
    (readings.length > 0
      ? ',"reading":{' +
        readings.map((slot) => `"${slot.key}":<${slot.ask !== '' ? slot.ask : slot.key}>`).join(',') +
        '}'
      : '');
  const who = nodeId ? ` (${nodeId})` : '';
  return (
    `the ticket this line (${cycleId}) asks for${who}:\n\n` +
    'status: completed | failed | stopped\n' +
    'summary: "<one-line summary>"\n' +
    `outputs: {${outputs}}\n`
  );
}

/**
 * The cells this line is configured to measure: the readings declared with `source: ticket` (only the
 * session that ran the verification can measure those) whose `when_knob` has a value in force on the whole
 * chain, in declaration order. The gate on values follows `ticket_readings`: written on some layer, or the
 * declaration gives a factory default — both count as "in force"; when nobody on the chain says anything and
 * there is no default, measuring it would be judged by no one, so it is not asked.
 */
export async function ticketReadings(
  root: string,
  folders: readonly PluginFolder[],
  options: { readonly homeDir?: string; readonly cycle: string; readonly node?: string },
): Promise<Array<{ readonly key: string; readonly ask: string }>> {
  const entries = readingsOf(folders).filter((entry) => entry.source === 'ticket');
  if (entries.length === 0) return [];
  if (entries.every((entry) => entry.whenKnob === '')) {
    return entries.map((entry) => ({ key: entry.key, ask: entry.ask }));
  }
  const effective = await resolveConfig(root, {
    homeDir: options.homeDir,
    declaredKnobs: declaredKnobSpecs(folders),
    cycle: options.cycle,
    node: options.node,
  });
  const out: Array<{ key: string; ask: string }> = [];
  for (const entry of entries) {
    if (entry.whenKnob !== '') {
      const reading = effective[entry.whenKnob];
      if (reading === undefined || reading.value === null || reading.value === undefined) continue;
    }
    out.push({ key: entry.key, ask: entry.ask });
  }
  return out;
}

/** The `method: <skill name>` line in the spec text; a missing or unreadable file has no such line to cite. */
async function readSpecMethod(specPath: string): Promise<string | null> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(specPath);
  } catch {
    return null;
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  const match = /^[ \t]*method:[ \t]*(\S[^\r\n]*)$/m.exec(text);
  return match === null ? null : match[1]!.trim();
}

/** The body of the run doc: four fixed sections, "verified facts" filled from the record readings, the other three left for this round's session. */
function buildRunDoc(input: {
  readonly cycle: CycleRecord;
  readonly node: NodeRecord | null;
  readonly nodeId: string;
  readonly specPath: string;
  readonly method: string | null;
  readonly instructions: readonly InstructionRecord[];
  readonly knobs: {
    readonly test_tier: ConfigValue | null;
    readonly worktree_mode: ConfigValue | null;
    readonly max_agents: ConfigValue | null;
  };
}): string {
  const { cycle, node, nodeId, specPath, method, instructions, knobs } = input;
  const title = typeof node?.title === 'string' ? node.title : '';
  const mode = typeof node?.mode === 'string' ? node.mode : 'auto';
  const weight = node?.weight ?? 'standard';
  const tags = Array.isArray(node?.tags)
    ? node.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const cycleTags = Array.isArray(cycle.tags)
    ? cycle.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  // The policy line is spelled like the Policy line of `cycle current`: defaults underneath, what was written
  // on the line laid on top, as `k=v, k=v` in the key order of the effective set.
  const policyText = Object.entries(cyclePolicy(cycle))
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(', ');
  const holding = cycleHoldingIds(cycle).map(short);
  const lines = [
    `# run.md — node ${short(nodeId)} (cycle ${cycle.id}: ${title})`,
    '',
    '## What I did',
    '',
    '## Autonomous decisions',
    '',
    '## Known unresolved',
    '',
    '## Facts checked',
    '',
    `- node: ${short(nodeId)} (mode=${mode}, weight=${weight}, tags=${pyList(tags)})`,
    `- spec: ${specPath}`,
    ...(method === null ? [] : [`- method: ${method}`]),
    `- cycle ${cycle.id}: ${cycle.status}, tags=${pyList(cycleTags)}, Policy: ${policyText}, ` +
      `holding=${pyList(holding)}`,
    `- test_tier=${shown(knobs.test_tier)}`,
    `- worktree_mode=${shown(knobs.worktree_mode)}`,
    `- max_agents=${shown(knobs.max_agents)}`,
    instructions.length > 0 ? '- User instructions in effect:' : '- User instructions in effect: (none)',
    ...instructions.map(instructionLine),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Prepare the material of one dispatch. It reads a read-only plan first: only when the plan hands back a
 * dispatch does it land the prompt of every node in hand that has no session open yet at that prompt's
 * location (atomic write, the same bytes on a repeated preparation, no second copy), set up this round's run
 * doc in the node directory (the first preparation writes it, and once written it belongs to the session),
 * and hand the handoff template back with the material. When the plan hands back something other than a
 * dispatch it says so on the spot with nothing written — read `conductor.next`'s answer first.
 */
export async function prepareDispatch(
  root: string,
  target: ConductorTarget = {},
  options: PrepareOptions = {},
): Promise<PreparedDispatch> {
  const paths: RecordPaths = recordPaths(root);
  const plan = await planNext(root, { cycle: target.cycle });
  if (plan.action !== 'dispatch') {
    throw new Error(
      `the preparation of conductor.dispatch only accepts a dispatch plan; the plan hands back ${plan.action} right now. ` +
        'Read the answer of conductor.next first: the line has to have pinned nodes and no session opened yet, ' +
        'and only then is there material to prepare.',
    );
  }
  const slots =
    target.node === undefined || target.node === null
      ? plan.nodes
      : plan.nodes.filter((entry) => entry.node_id === target.node);
  if (slots.length === 0) {
    throw new Error(
      `node ${JSON.stringify(String(target.node))} is not on the list of this dispatch: it is not on the ` +
        'dispatch cell the plan names (not in hand, its session was already opened, or its handoff ticket ' +
        'is already in).',
    );
  }
  assertLedgerInitialized(paths);
  const dag = createDagNamespace(root);
  const config = createConfigNamespace(
    root,
    options.homeDir === undefined ? {} : { homeDir: options.homeDir },
  );
  const cycle = await createCyclesNamespace(root).show(plan.cycle);
  // The template's reading cells come from the plugin declarations (the `source: ticket` ones); with no plugins installed this cell never appears.
  const folders = options.assembly === undefined
    ? (await loadPlugins(pluginsDirOf(root, options.pluginsDir))).folders
    : await options.assembly.folders();
  const prepared: PreparedNode[] = [];
  for (const entry of slots) {
    const record = await dag.get(entry.node_id);
    const specPath = nodeSpecPath(paths, entry.node_id);
    const method = await readSpecMethod(specPath);
    const doc = buildRunDoc({
      cycle,
      node: record,
      nodeId: entry.node_id,
      specPath,
      method,
      instructions: await visibleInstructionRows(root, { node: entry.node_id }),
      knobs: {
        test_tier: (await config.get('test_tier')).value,
        worktree_mode: (await config.get('worktree_mode')).value,
        max_agents: (await config.get('max_agents')).value,
      },
    });
    // The run doc: exclusive creation — the first preparation lands it whole; one already on disk
    // (the session is writing into it) is refused with Node's own EEXIST and stays as it is, not
    // touched by one byte. That "already there" is the one disk answer this step folds away: the
    // doc, once written, belongs to the session, and no later preparation overwrites it.
    const runDocPath = nodeRunDocPath(paths, entry.node_id);
    try {
      await exclusiveCreateBytes(runDocPath, textBytes(doc));
    } catch (error) {
      if (!isExistingPath(error)) throw error;
    }
    // The prompt: the "waiting to be picked up" marker of the dispatch material, overwritten as a whole file on every preparation (the same bytes, idempotent).
    const promptPath = launchPromptPath(paths, plan.cycle, entry.node_id);
    await atomicWriteBytes(promptPath, textBytes(promptTextOf(entry.node_id)));
    const readings = await ticketReadings(root, folders, {
      homeDir: options.homeDir,
      cycle: plan.cycle,
      node: entry.node_id,
    });
    prepared.push({
      node_id: entry.node_id,
      node_title: entry.node_title,
      mode: entry.mode,
      prompt: promptPath,
      prompt_text: entry.prompt_text,
      run_doc: runDocPath,
      handoff_template: handoffTemplate(plan.cycle, entry.node_id, readings),
    });
  }
  return { cycle: plan.cycle, nodes: prepared };
}
