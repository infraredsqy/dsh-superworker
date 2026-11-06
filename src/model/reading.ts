/**
 * Two judgments the panel needs before it can put words on the screen: whether
 * the four sources all landed on the same outcome, and which nodes a cycle's
 * detail section collects.
 *
 * Judging belongs to this layer; the drawing layer only consumes the results:
 * these two take readings only and touch no DOM, so they can be measured and
 * pinned down here and nowhere else.
 */
import type { PathfinderReading, PathfinderSourceState } from './records.ts'
import type { CycleReading, NodeBucket, NodeRank, NodeReading, ProjectReading } from './contract.ts'

export type { NodeBucket, NodeRank }

/** The keys of the detail's five groups: shelved, running, ready, not started, completed. */
export type DetailGroupKey = 'shelved' | 'run' | 'ready' | 'wait' | 'done'

/**
 * The one bucket a card sits in: the per-node reading the boards' marks are all drawn from.
 *
 * The gate decides first — a cell that wants a person wants one whatever else it is also doing.
 * The shelved verdict is its own bucket (the mark for waiting); a manual or checkpoint gate is the
 * gate bucket. Then the line's hold, then the card's own state: `todo` and `done` never meet, so
 * their order judges nothing.
 *
 * The criteria are the vocabulary's, judged here and nowhere else: which class a bucket wears on
 * each board is the drawing layer's own mapping.
 */
export function bucketOf(node: NodeReading): NodeBucket {
  if (node.gate !== null) return node.gate.kind === 'shelved' ? 'shelved' : 'gate'
  if (node.running) return 'run'
  return node.state === 'completed' ? 'done' : 'todo'
}

/**
 * Where a card stands in the triage order: the bucket's own order, with the two halves of `todo`
 * kept apart — what may start outranks what still owes a prerequisite.
 *
 * The order is read off {@link bucketOf} rather than judged a second time, so the two readings of
 * one card cannot drift apart. It is an order and not a priority: a delivered card is not
 * unimportant, it is finished.
 */
export function rankOf(node: NodeReading): NodeRank {
  const bucket = bucketOf(node)
  if (bucket === 'gate' || bucket === 'shelved') return 0
  if (bucket === 'run') return 1
  if (bucket === 'todo') return node.ready ? 2 : 3
  return 4
}

/**
 * Which lines a cell belongs to: every line that has walked it, in record order, plus any line holding
 * it right now.
 *
 * One criterion, judged here and consumed everywhere the question comes up — the detail's sections,
 * the line's own parked count, and the map's ink all read this and not `cycleIds` / `heldBy` on
 * their own. The record lists the walkers in the order they came, so the line the cell happened
 * before stands first; a re-run leaves a second walker, and that line walked the cell too. A hold
 * has not landed in `cycleIds` yet, so a line in whose hand the cell is belongs to it as well.
 */
export function ownersOf(node: NodeReading): readonly string[] {
  const owners = [...node.cycleIds]
  for (const holder of node.heldBy) {
    if (!owners.includes(holder)) owners.push(holder)
  }
  return owners
}

/** Whether that line has this cell: see {@link ownersOf}. */
export function belongsTo(node: NodeReading, cycleId: string): boolean {
  return node.cycleIds.includes(cycleId) || node.heldBy.includes(cycleId)
}

/**
 * A line's own state, in one word: owing a person (it parked a cell), in service, or stopped.
 *
 * Both the word the rail and the detail print and the class the line's mark wears come from this
 * one answer, so the spinner and the sentence cannot disagree about the same line.
 */
export type CycleState = 'blocked' | 'run' | 'stopped'

export function lineStateOf(cycle: CycleReading): CycleState {
  if (cycle.parked.length > 0) return 'blocked'
  return cycle.inService ? 'run' : 'stopped'
}

/**
 * Whether all four sources landed on the same outcome.
 *
 * When there is not a single source (this reading has not listed any yet), it
 * does not count: the empty set and "all of them are" are two different
 * things — the former has not been read, the latter is the conclusion drawn
 * from reading.
 */
export function everySourceIs(reading: PathfinderReading, state: PathfinderSourceState): boolean {
  const states = Object.values(reading.sources)
  return states.length > 0 && states.every((one) => one === state)
}

/**
 * Which nodes a cycle's own detail section collects: those it walked through,
 * and those it is holding right now.
 *
 * The completed section sorts newest completion first — reading top to
 * bottom, the reader goes from just-finished to finished long ago.
 */
export function nodesOf(key: DetailGroupKey, cycle: CycleReading, project: ProjectReading): readonly NodeReading[] {
  const mine = (list: readonly NodeReading[]): readonly NodeReading[] =>
    list.filter((node) => belongsTo(node, cycle.id))
  if (key === 'shelved') return mine(project.columns.shelved)
  if (key === 'run') return mine(project.columns.running)
  if (key === 'ready') return mine(project.columns.ready)
  if (key === 'wait') return mine(project.columns.blocked)
  return mine(project.columns.completed)
    .slice()
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
}
