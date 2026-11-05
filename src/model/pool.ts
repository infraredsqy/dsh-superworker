/**
 * The issue pool's reading: how a ledger gets read.
 *
 * On the books or not depends on whether its discovery moment has arrived;
 * which state it sits in takes the record's own word, and that word belongs
 * to the moment it was written — before the last-modified moment it reads as
 * not yet closed (`open`); weight multiplies by its tier in the weight table,
 * and the issues judged `external` stay on the books and still count as
 * standing, just left out of the weighted sum.
 *
 * Neither the weight table nor the policy line sits on a ready-made field in
 * the records: the former is written in some maintenance node's own
 * description (`P3/P2/P1/P0 = 1/2/4/8`), the latter is a cycle's own
 * `issue_pool_weight_limit`.
 */
import type { PathfinderCycle, PathfinderIssue, PathfinderNode } from './records.ts'
import type {
  IssueGroupReading,
  IssueReading,
  IssueState,
  PoolCensus,
  PoolReading,
  PoolWeights,
} from './contract.ts'
import { cutAt, field, text, toMoment, writtenBy } from './fields.ts'

/** The weight table's sentence: how many times each tier counts. */
const WEIGHT_MAP = /P3\s*\/\s*P2\s*\/\s*P1\s*\/\s*P0\s*=\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)\s*\/\s*(\d+)/u

/** The policy line's setting name, verbatim as the tool spells it. */
const WEIGHT_LIMIT = 'issue_pool_weight_limit'

/** The order of the four tiers in the weight table, heaviest first; a tier missing from the table sorts last. */
const SEVERITY_RANK: Readonly<Record<string, number>> = { P0: 0, P1: 1, P2: 2, P3: 3 }

/**
 * The piles' order, along with whether each counts as still owed by the pool.
 *
 * Only the key and the standing flag: what a pile is called is a word, and words belong to the
 * client's dictionary (`src/client/words.ts`), where the reader's language decides them.
 */
const GROUPS: readonly { readonly key: IssueState; readonly standing: boolean }[] = [
  { key: 'open', standing: true },
  { key: 'acknowledged', standing: true },
  { key: 'rejected', standing: false },
  { key: 'resolved', standing: false },
]

export function readPool(
  nodes: Readonly<Record<string, PathfinderNode>>,
  cycles: readonly PathfinderCycle[],
  issues: Readonly<Record<string, PathfinderIssue>>,
  at: Date,
): PoolReading {
  const weights = readWeights(nodes)
  const line = readLine(cycles)

  const rows: IssueReading[] = []
  for (const entry of Object.values(issues)) {
    const discoveredAt = cutAt(toMoment(entry.discovered), at)
    /* An issue not yet discovered is not on the books: the ledger only records what has been registered. */
    if (discoveredAt === null) continue
    const written = toMoment(entry.updated_at)
    const updatedAt = cutAt(written, at)
    const recordStatus = text(entry.status)
    const severity = text(entry.severity)
    const decision = text(entry.decision)
    const id = text(entry.id) ?? ''
    /* Whether it weighs on the line is the verdict's own call: issues judged `external` drop out of the weighted sum — counted in, they would be a floor nobody could move and the threshold could never dip below, which is exactly how the pool's canonical reading `issue weight` treats them. The count follows a different measure (the tool's `status`): still on the books, still standing, just not weighing on the line. */
    const payable = decision !== 'external'
    rows.push({
      id,
      weight: severity === undefined ? 0 : (weights?.[severity] ?? 0),
      status: statusOf(recordStatus, written, at),
      discoveredAt,
      updatedAt,
      checkCount: typeof entry.check_count === 'number' ? entry.check_count : null,
      files: [...(entry.files ?? [])],
      payable,
      ...field('title', text(entry.title)),
      ...field('severity', severity),
      ...field('recordStatus', recordStatus),
      ...field('module', text(entry.module)),
      ...field('source', text(entry.source)),
      ...field('decision', decision),
      ...field('description', text(entry.description)),
      ...field('suggestion', text(entry.suggestion)),
      ...field('reason', text(entry.reason)),
      ...field('planPath', text(entry.plan_path)),
    })
  }

  const groups: IssueGroupReading[] = []
  for (const pile of GROUPS) {
    const entries = rows
      .filter((row) => row.status === pile.key)
      .sort(pile.standing ? standingOrder : closedOrder)
    if (entries.length === 0) continue
    groups.push({
      key: pile.key,
      standing: pile.standing,
      entries,
      count: entries.length,
      weight: sumWeight(entries),
    })
  }

  const open = rows.filter((row) => row.status === 'open')
  const acknowledged = rows.filter((row) => row.status === 'acknowledged')
  const standing = [...open, ...acknowledged]
  const census: PoolCensus = {
    total: rows.length,
    standing: standing.length,
    open: open.length,
    acknowledged: acknowledged.length,
    rejected: rows.filter((row) => row.status === 'rejected').length,
    resolved: rows.filter((row) => row.status === 'resolved').length,
  }

  return {
    line,
    weights,
    rows,
    groups,
    standing,
    weight: weights === null ? null : sumWeight(standing),
    census,
  }
}

export function readWeights(nodes: Readonly<Record<string, PathfinderNode>>): PoolWeights | null {
  for (const node of Object.values(nodes)) {
    const said = `${node.title ?? ''} ${node.description ?? ''}`
    const found = WEIGHT_MAP.exec(said)
    if (found !== null) {
      return { P3: Number(found[1]), P2: Number(found[2]), P1: Number(found[3]), P0: Number(found[4]) }
    }
  }
  return null
}

/**
 * The policy line: which cycle set its own `issue_pool_weight_limit`.
 */
export function readLine(cycles: readonly PathfinderCycle[]): number | null {
  for (const cycle of cycles) {
    const held = cycle.policies?.[WEIGHT_LIMIT]
    if (typeof held === 'number') return held
  }
  return null
}

/**
 * Which state this issue sits in at that moment.
 *
 * The record's own word belongs to the moment it was written: before the
 * last-modified moment, that word has not taken effect and the issue reads as
 * not yet closed. A word in the records that is not one of the four (or no
 * word at all) also reads as not yet closed — nobody has closed it.
 */
function statusOf(recordStatus: string | undefined, written: Date | null, at: Date): IssueState {
  if (recordStatus === undefined || !writtenBy(written, at)) return 'open'
  return recordStatus === 'acknowledged' || recordStatus === 'rejected' || recordStatus === 'resolved'
    ? recordStatus
    : 'open'
}

/** The standing order: heaviest first, longer-parked first within a tier. */
function standingOrder(left: IssueReading, right: IssueReading): number {
  const rank = SEVERITY_RANK[left.severity ?? ''] ?? 9
  const other = SEVERITY_RANK[right.severity ?? ''] ?? 9
  if (rank !== other) return rank - other
  return (left.discoveredAt?.getTime() ?? 0) - (right.discoveredAt?.getTime() ?? 0)
}

/** The closed order: recently touched first. */
function closedOrder(left: IssueReading, right: IssueReading): number {
  return touchedAt(right) - touchedAt(left)
}

/** The moment this issue was last touched: when the record has no last-modified, its discovery moment is taken. */
function touchedAt(row: IssueReading): number {
  return (row.updatedAt ?? row.discoveredAt)?.getTime() ?? 0
}

/** A pile's weighted sum: non-paying issues stay out of the sum. */
function sumWeight(entries: readonly IssueReading[]): number {
  return entries.filter((entry) => entry.payable).reduce((total, entry) => total + entry.weight, 0)
}