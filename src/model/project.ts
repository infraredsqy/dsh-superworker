/**
 * The project reading at that moment: nodes, cycles, and each of the reading
 * columns.
 *
 * What each entry looks like at that moment is stated by its own fields:
 * moments are cut by that moment, the record's own word counts only if it was
 * written before the record's own last-modified moment, and a moment absent
 * from the records stays empty — never filled with 0. Running is judged by
 * the cycle records' holdings: who is working a node is recorded on the cycle
 * side, and the card's own fields only answer "completed or not".
 */
import type { PathfinderCycle, PathfinderNode, PathfinderStep } from './records.ts'
import type {
  ColumnReadings,
  CycleReading,
  GateReading,
  HoldingReading,
  NodeReading,
  NodeState,
  ProjectReading,
  RecordsAtMoment,
  StepReading,
} from './contract.ts'
import { cutAt, field, happenedAt, secondsBetween, text, toMoment, writtenBy } from './fields.ts'
import { readGraph } from './graph.ts'
import { readInstructions } from './instructions.ts'
import { readPool } from './pool.ts'
import { belongsTo } from './reading.ts'

/** The two verdicts that mean not completed: on a card, the node is shelved. */
const PARKED_RESULTS = new Set(['failed', 'stopped'])

/** In service / not in service: the record's own two words. */
const ACTIVE = 'active'
const INACTIVE = 'inactive'

/** A step on a cycle, together with which node it walked (the step's own fields carry it too; a ready copy is kept here for piling nodes). */
interface CutStep {
  readonly nodeId: string | null
  readonly reading: StepReading
}

/** A hold on a cycle: which cycle holds, and whom. */
interface CutHolding {
  readonly cycleId: string
  readonly holding: HoldingReading
}

/** A cycle at that moment, with "its parked nodes" not yet filled in (that waits for the node readings). */
interface CutCycle {
  readonly id: string
  readonly title: string | undefined
  readonly recordStatus: string | undefined
  readonly inService: boolean
  readonly holding: readonly CutHolding[]
  readonly path: readonly StepReading[]
  readonly lastStep: StepReading | null
  readonly steps: readonly CutStep[]
}

/** One node's own facts, in one batch: the two dependency columns wait until the whole batch's states are out, then come down with the facts. */
interface NodeFacts {
  readonly id: string
  readonly node: PathfinderNode
  readonly state: NodeState
  readonly steps: readonly StepReading[]
  readonly walkedBy: readonly string[]
  readonly held: readonly CutHolding[]
  readonly firstStep: StepReading | undefined
  /** The last step that came to rest, with its own verdict; absent when no step has come to rest. */
  readonly lastVerdict: StepReading | undefined
  /** This node's dependencies that nobody in the batch has completed: the batch's one completed set decided them. */
  readonly openDependencies: readonly string[]
}

/** One node's facts before the batch-wide completed set is out. */
type NodeSeed = Omit<NodeFacts, 'openDependencies'>

/**
 * @throws A TypeError when the input is not a moment: with an unspeakable moment, no word of the reading counts.
 */
export function readProject(input: RecordsAtMoment): ProjectReading {
  const at = input.at
  if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
    throw new TypeError('读到哪一刻：进来的不是一个时刻')
  }

  const cut = input.cycles.map((cycle) => cutCycle(cycle, at))
  const facts = readFacts(input.nodes, cut, at)
  const nodes = facts.map((item) => readNode(item, at))
  const nodeById = Object.fromEntries(nodes.map((node) => [node.id, node]))
  const cycles = cut.map((item) => finishCycle(item, nodes))
  const cycleById = Object.fromEntries(cycles.map((cycle) => [cycle.id, cycle]))

  return {
    at,
    nodes,
    nodeById,
    columns: columnsOf(nodes),
    cycles,
    cycleById,
    instructions: readInstructions(input.instructions, nodeById, cycleById, at),
    graph: readGraph(nodes),
    pool: readPool(input.nodes, input.cycles, input.issues, at),
  }
}

function cutCycle(cycle: PathfinderCycle, at: Date): CutCycle {
  const id = text(cycle.id) ?? ''
  const steps: CutStep[] = []
  const path: StepReading[] = []
  for (const step of cycle.path ?? []) {
    const cut = cutStep(step, id, at)
    if (cut === null) continue
    steps.push(cut)
    /* A step counts as walked only once it has come to rest. The step not yet at rest at that moment is "being walked" and stays out of the walked list. */
    if (cut.reading.endedAt !== null) path.push(cut.reading)
  }
  const recordStatus = text(cycle.status)
  const holding = readHolding(cycle, at)
  return {
    id,
    title: text(cycle.title),
    recordStatus,
    inService: inServiceOf(cycle, recordStatus, holding, at),
    holding,
    path,
    lastStep: path.length > 0 ? (path[path.length - 1] ?? null) : null,
    steps,
  }
}

/** Whether the cycle is in service: use the record's word when it has been written down; until then, read it by whom it currently holds. */
function inServiceOf(
  cycle: PathfinderCycle,
  recordStatus: string | undefined,
  holding: readonly CutHolding[],
  at: Date,
): boolean {
  const stated = recordStatus === ACTIVE || recordStatus === INACTIVE
  if (stated && writtenBy(toMoment(cycle.updated_at), at)) return recordStatus === ACTIVE
  /* At that moment the word was not yet written down (or the record has no such word): a cycle holding nothing reads as not in service. */
  return holding.length > 0
}

/** Whom a cycle holds at that moment: both the list and the single-value spellings are read. */
function readHolding(cycle: PathfinderCycle, at: Date): readonly CutHolding[] {
  const id = text(cycle.id) ?? ''
  const out: CutHolding[] = []
  for (const entry of cycle.holding ?? []) {
    const holding = holdingOf(entry, at)
    if (holding !== null) out.push({ cycleId: id, holding })
  }
  if (out.length > 0) return out
  const current = text(cycle.current_node)
  if (current === undefined) return out
  const startedAt = toMoment(cycle.current_started_at)
  /* A hold not yet picked up at that moment: at that time it was not held. */
  if (startedAt !== null && !happenedAt(startedAt, at)) return out
  return [{ cycleId: id, holding: { nodeId: current, since: startedAt } }]
}

/** One entry of a hold: written as an object, or as a bare id. */
function holdingOf(entry: unknown, at: Date): HoldingReading | null {
  if (typeof entry === 'string') return entry.length > 0 ? { nodeId: entry, since: null } : null
  if (typeof entry !== 'object' || entry === null) return null
  const fields = entry as { readonly id?: unknown; readonly since?: unknown }
  const nodeId = text(fields.id)
  if (nodeId === undefined) return null
  const since = toMoment(fields.since)
  /* The record says this hold was picked up only at a moment still ahead: at that time it was not held. */
  if (since !== null && !happenedAt(since, at)) return null
  return { nodeId, since }
}

/** A step on a cycle: a step not yet laid out at that moment stays out of the reading. */
function cutStep(step: PathfinderStep, cycleId: string, at: Date): CutStep | null {
  const rawStart = toMoment(step.started_at)
  const rawEnd = toMoment(step.ended_at)
  /* The record places this step after that moment: at that moment it had not been laid out yet. A step with no start moment is placed by its end moment. */
  const placed = rawStart !== null ? happenedAt(rawStart, at) : rawEnd === null || happenedAt(rawEnd, at)
  if (!placed) return null
  const startedAt = cutAt(rawStart, at)
  const endedAt = cutAt(rawEnd, at)
  const nodeId = text(step.node) ?? null
  const result = text(step.result)
  return {
    nodeId,
    reading: {
      cycleId,
      startedAt,
      endedAt,
      seconds: secondsBetween(startedAt, endedAt),
      ...field('node', nodeId),
      ...field('result', result),
    },
  }
}

/** A node's state at that moment: the record's own word speaks first; before that word is written down, the steps it has walked decide. */
function stateOf(node: PathfinderNode, lastVerdict: StepReading | undefined, at: Date): NodeState {
  const word = text(node.status)
  const wordAtCut = writtenBy(toMoment(node.updated_at), at)
  const deliveredAt = cutAt(toMoment(node.completed_at), at)
  /* The completion moment having arrived means completed; only when the record never wrote this moment does its own word count. */
  if (deliveredAt !== null) return 'completed'
  if (toMoment(node.completed_at) === null && word === 'completed' && wordAtCut) return 'completed'
  if (wordAtCut && word === 'shelved') return 'shelved'
  if (wordAtCut && word === 'todo') return 'todo'
  /* The word not yet written down (or not one of these three): read by the verdict of its last step at rest — the node is parked only if that step came back with one of the two not-completed words; having come to rest with completed, it is back in play. */
  return lastVerdict !== undefined && PARKED_RESULTS.has(lastVerdict.result ?? '') ? 'shelved' : 'todo'
}

/** Each node's own facts, in record order; the completed set is taken once here, not once per node. */
function readFacts(
  source: Readonly<Record<string, PathfinderNode>>,
  cut: readonly CutCycle[],
  at: Date,
): readonly NodeFacts[] {
  const stepsOf = new Map<string, StepReading[]>()
  const walkedBy = new Map<string, string[]>()
  const heldOf = new Map<string, CutHolding[]>()
  for (const cycle of cut) {
    for (const step of cycle.steps) {
      if (step.nodeId === null) continue
      collect(stepsOf, step.nodeId, step.reading)
      const walkers = walkedBy.get(step.nodeId)
      if (walkers === undefined) walkedBy.set(step.nodeId, [cycle.id])
      else if (!walkers.includes(cycle.id)) walkers.push(cycle.id)
    }
    for (const holding of cycle.holding) collect(heldOf, holding.holding.nodeId, holding)
  }

  const seeds: readonly NodeSeed[] = Object.entries(source).map(([id, node]) => {
    const steps = stepsOf.get(id) ?? []
    /* Its own step: the first step walked in the records. A re-run node has two steps; the first one is its own. */
    const firstStep = steps[0]
    /* The last step at rest: for a re-run node, the re-run's verdict overrides the earlier pass's. A step not yet at rest at that moment carries no verdict and can stop nothing. */
    let lastVerdict: StepReading | undefined
    for (const step of steps) {
      if (step.endedAt !== null) lastVerdict = step
    }
    return {
      id,
      node,
      state: stateOf(node, lastVerdict, at),
      steps,
      walkedBy: walkedBy.get(id) ?? [],
      held: heldOf.get(id) ?? [],
      firstStep,
      lastVerdict,
    }
  })

  /* The batch's one completed set: every node reads its open dependencies off this, so the answer is the same for all of them and costs one walk. */
  const completed = new Set(seeds.filter((seed) => seed.state === 'completed').map((seed) => seed.id))
  return seeds.map((seed) => ({
    ...seed,
    openDependencies: (seed.node.dependencies ?? []).filter((dependency) => !completed.has(dependency)),
  }))
}

function readNode(facts: NodeFacts, at: Date): NodeReading {
  const { id, node, state, steps, held, firstStep, lastVerdict, openDependencies } = facts
  const completedAt = cutAt(toMoment(node.completed_at), at)
  const approvedAt = cutAt(toMoment(node.approved_at), at)
  const startedAt = firstStep?.startedAt ?? null
  const endedAt = firstStep?.endedAt ?? null
  const heldByIDs: string[] = []
  const holdMoments: Date[] = []
  for (const item of held) {
    if (!heldByIDs.includes(item.cycleId)) heldByIDs.push(item.cycleId)
    if (item.holding.since !== null) holdMoments.push(item.holding.since)
  }
  const running = state === 'todo' && heldByIDs.length > 0
  const recordStatus = text(node.status)
  const mode = text(node.mode)
  const title = text(node.title)
  const session = text(node.dsh_session)
  const parkedSince = state === 'shelved' && lastVerdict !== undefined ? lastVerdict.endedAt : null
  const gate = gateOf({
    state,
    mode,
    parkedSince,
    startedAt,
    completedAt,
    approvedAt,
  })
  /* The one moment this card speaks of: the gate's, else the pick-up, else the step's end, else the
   * delivery, else the creation. Judged here so a board prints it instead of picking again. */
  const heldSince = holdMoments.length > 0 ? new Date(Math.min(...holdMoments.map((d) => d.getTime()))) : null
  const createdAt = cutAt(toMoment(node.created_at), at)
  const stampAt = gate?.since ?? heldSince ?? endedAt ?? completedAt ?? createdAt
  return {
    id,
    state,
    running,
    ready: state === 'todo' && openDependencies.length === 0 && !running,
    dependencies: [...(node.dependencies ?? [])],
    openDependencies,
    heldBy: heldByIDs,
    /* The moment it was picked up: the earliest hold; empty when the record has none. */
    heldSince,
    createdAt,
    completedAt,
    startedAt,
    endedAt,
    seconds: firstStep?.seconds ?? null,
    elapsedSeconds: running && startedAt !== null ? secondsBetween(startedAt, at) : null,
    parkedSince,
    steps,
    cycleIds: [...facts.walkedBy],
    gate,
    stampAt,
    ...field('title', title),
    ...field('recordStatus', recordStatus),
    ...field('mode', mode),
    ...field('session', session),
  }
}

/**
 * Whether this node needs a person: which kind of gate plus a moment. All
 * criteria in the records; a node needing nobody has no gate at all.
 *
 * The kind is the whole answer — what a reader calls it is the client's word.
 */
function gateOf(facts: {
  readonly state: NodeState
  readonly mode: string | undefined
  readonly parkedSince: Date | null
  readonly startedAt: Date | null
  readonly completedAt: Date | null
  readonly approvedAt: Date | null
}): GateReading | null {
  if (facts.state === 'shelved') {
    return { kind: 'shelved', since: facts.parkedSince }
  }
  if (facts.mode === 'manual' && facts.state !== 'completed') {
    return { kind: 'manual', since: facts.startedAt }
  }
  /* A checkpoint's gate reads this node's own record only: delivered, and this delivery not approved. Where the line has walked since says nothing about it. */
  if (facts.mode === 'checkpoint' && facts.state === 'completed' && !approvedDelivery(facts.completedAt, facts.approvedAt)) {
    return { kind: 'checkpoint', since: facts.completedAt }
  }
  return null
}

/**
 * Whether that delivery has been approved: both moments written down, and the
 * approval not earlier than the delivery — compared as moments, since one
 * record writes two shapes of timestamp text. Without a delivery moment there
 * is no delivery for an approval to be about.
 */
function approvedDelivery(completedAt: Date | null, approvedAt: Date | null): boolean {
  if (completedAt === null || approvedAt === null) return false
  return approvedAt.getTime() >= completedAt.getTime()
}

function finishCycle(cycle: CutCycle, nodes: readonly NodeReading[]): CycleReading {
  const parked = nodes.filter((node) => node.state === 'shelved' && belongsTo(node, cycle.id)).map((node) => node.id)
  return {
    id: cycle.id,
    inService: cycle.inService,
    holding: cycle.holding.map((item) => item.holding),
    path: cycle.path,
    lastStep: cycle.lastStep,
    parked,
    ...field('title', cycle.title),
    ...field('recordStatus', cycle.recordStatus),
  }
}

/** Each of the reading columns: mutually exclusive, a node appears in exactly one. */
function columnsOf(nodes: readonly NodeReading[]): ColumnReadings {
  const completed: NodeReading[] = []
  const running: NodeReading[] = []
  const shelved: NodeReading[] = []
  const todo: NodeReading[] = []
  const ready: NodeReading[] = []
  const blocked: NodeReading[] = []
  for (const node of nodes) {
    if (node.state === 'completed') completed.push(node)
    else if (node.state === 'shelved') shelved.push(node)
    else if (node.running) running.push(node)
    else {
      todo.push(node)
      if (node.ready) ready.push(node)
      else blocked.push(node)
    }
  }
  return { completed, running, shelved, todo, ready, blocked }
}

function collect<T>(into: Map<string, T[]>, key: string, value: T): void {
  const known = into.get(key)
  if (known === undefined) into.set(key, [value])
  else known.push(value)
}