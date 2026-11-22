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
 * the records: the former is the issue plugin's own declaration of it, handed
 * in with the reading (this layer never reads it off a node's text), the latter
 * is a cycle's own `issue_pool_weight_limit`. A table that was not handed in is
 * no table: every weight reading is `null` rather than a 0 nobody wrote.
 */
import type { SuperworkerCycle, SuperworkerIssue } from './records.ts'
import type {
  IssueGroupReading,
  IssueReading,
  IssueState,
  PoolCensus,
  PoolReading,
  PoolWeights,
} from './contract.ts'
import { cutAt, field, text, toMoment, writtenBy } from './fields.ts'

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
  cycles: readonly SuperworkerCycle[],
  issues: Readonly<Record<string, SuperworkerIssue>>,
  weights: PoolWeights | null,
  at: Date,
): PoolReading {
  const line = readLine(cycles)

  const rows: IssueReading[] = []
  /* The one partition: every row lands in the pile its state names as it is read, so no later pass
   * has to walk the rows again to find out what is in a pile. */
  const piles = new Map<IssueState, IssueReading[]>()
  const pileOf = (state: IssueState): IssueReading[] => {
    const known = piles.get(state)
    if (known !== undefined) return known
    const made: IssueReading[] = []
    piles.set(state, made)
    return made
  }
  const countOf = (state: IssueState): number => piles.get(state)?.length ?? 0
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
    const row: IssueReading = {
      id,
      weight: weightOf(weights, severity),
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
    }
    rows.push(row)
    pileOf(row.status).push(row)
  }

  const groups: IssueGroupReading[] = []
  for (const pile of GROUPS) {
    const entries = [...(piles.get(pile.key) ?? [])].sort(pile.standing ? standingOrder : closedOrder)
    if (entries.length === 0) continue
    groups.push({
      key: pile.key,
      standing: pile.standing,
      entries,
      count: entries.length,
      /* Same reading as the pool's own sum below: with no table nothing in the pile could be weighed,
       * and an external-only pile would otherwise add up to 0 — a number nobody wrote. */
      weight: weights === null ? null : sumWeight(entries),
    })
  }

  /* The two piles still owed, in record order: the census counts them and the line weighs them. */
  const standing = [...(piles.get('open') ?? []), ...(piles.get('acknowledged') ?? [])]
  const census: PoolCensus = {
    total: rows.length,
    standing: standing.length,
    open: countOf('open'),
    acknowledged: countOf('acknowledged'),
    rejected: countOf('rejected'),
    resolved: countOf('resolved'),
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

/**
 * One tier's count in the table, or `null` when the table itself was not obtained.
 *
 * The two absences are different facts and read differently: no table at all is `null`, while a
 * table that was read and names no such tier counts that tier as 0 — the table did speak, and it
 * said this tier weighs nothing. `null` here is what keeps a gauge from drawing a number nobody wrote.
 */
function weightOf(weights: PoolWeights | null, severity: string | undefined): number | null {
  if (weights === null) return null
  if (severity === undefined) return 0
  return weights[severity] ?? 0
}

/**
 * The policy line: which cycle set its own `issue_pool_weight_limit`.
 */
export function readLine(cycles: readonly SuperworkerCycle[]): number | null {
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

/**
 * A pile's weighted sum: non-paying issues stay out of the sum, and a sum with a term nobody could
 * weigh is unknown (`null`) rather than short by that term — adding up what is known would print a
 * number that claims to be the pile's weight.
 */
function sumWeight(entries: readonly IssueReading[]): number | null {
  let total = 0
  for (const entry of entries) {
    if (!entry.payable) continue
    if (entry.weight === null) return null
    total += entry.weight
  }
  return total
}