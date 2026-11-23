/**
 * The main window's choice: which one conversation the stage draws, and which
 * ask picked it.
 *
 * The rule itself — its steps and their order — is {@link mainIdOf}'s, and its
 * wording stays there. This file holds that rule and the readings it stands
 * on: the browser's own main-view marker, the sessions the pipeline record
 * names, a row's last-moved moment, and the newest-of pick those end in. What
 * comes out is a choice, the id plus the {@link OverviewMainFrom} behind it;
 * the window drawn for it and everything else on the stage is the assembly's
 * (`overview.ts`).
 */
import type { OverviewInput, OverviewSessionRow } from './overview.ts'
import { asRecord, text, toEpoch } from './fields.ts'

/**
 * How the stage's subject was chosen, which is a different fact from which window it
 * is. A person's pick and a change of the conversation the panel stands in are asks:
 * the stage takes them at once. The line's own answer is a hand-over: the page the
 * reader was reading is a step that has finished and left, and the stage moves on to
 * where the line stands now — the drawing closes the old page and opens the new one.
 */
export type OverviewMainFrom = 'pick' | 'seat' | 'line' | 'view'

/**
 * DSH's own main-view marker: the row whose `retainedBy.mainView` is over zero.
 *
 * This is a browser-side count — who holds the session open right now — and
 * says nothing about which conversation belongs to this workspace's pipeline.
 * It is read in exactly one place: a caller that hands over no record side and
 * no session of its own (see {@link OverviewInput.pipelineSessions}).
 */
function mainViewOf(rows: Readonly<Record<string, OverviewSessionRow>>): string | undefined {
  for (const row of Object.values(rows)) {
    const count = asRecord(row?.retainedBy)?.mainView
    if (typeof count !== 'number' || count <= 0) continue
    const id = row?.id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return undefined
}

/**
 * The sessions the pipeline record names, or `undefined` when the caller said
 * nothing at all (which is a different fact from "the record names none").
 */
export function pipelineOf(input: OverviewInput): ReadonlySet<string> | undefined {
  if (!Array.isArray(input.pipelineSessions)) return undefined
  const named = new Set<string>()
  for (const id of input.pipelineSessions) {
    if (typeof id === 'string' && id.length > 0) named.add(id)
  }
  return named
}

/** When the list last moved a row: epoch milliseconds, 0 when it says nothing readable. */
function movedAtOf(row: OverviewSessionRow | undefined): number {
  return toEpoch(row?.updatedAt) ?? 0
}

/**
 * The newest of these sessions: the one whose row the list moved last, ties
 * falling to the later arrival in the list's own order. Unwritten moments read
 * as 0, so a list that carries none still answers with an arrival-order pick.
 */
function latestOf(
  ids: readonly string[],
  rows: Readonly<Record<string, OverviewSessionRow>>,
  order: readonly string[],
): string | undefined {
  let best: string | undefined
  let bestMoment = Number.NEGATIVE_INFINITY
  let bestAt = Number.NEGATIVE_INFINITY
  for (const id of ids) {
    const moment = movedAtOf(rows[id])
    const at = order.indexOf(id)
    if (best === undefined || moment > bestMoment || (moment === bestMoment && at > bestAt)) {
      best = id
      bestMoment = moment
      bestAt = at
    }
  }
  return best
}

/**
 * Which conversation is the main window — the one rule, in the order it reads, and
 * the ask behind it:
 *
 * 1. the leg the reader picked on the rail, while the list still holds it — a
 *    person's pick outranks every reading here;
 * 2. the conversation the panel stands in, when the seat says which one it is:
 *    the reader's own conversation, while it is still the line's to read. A seat
 *    the record has delivered — and no gate stands on it — has said its last word
 *    (its check), so it keeps the stage only while no other step of the line is
 *    **being worked**; with one running, the stage follows it. That is what lets a
 *    reader who stayed on a finished step's page watch the line go on, and what
 *    keeps the check when the line has really stopped. A seat that says nothing is
 *    not stood in for — the browser's open conversation is no reading of the line
 *    (see {@link OverviewInput.ownSession});
 * 3. else the step the record holds **and** whose conversation still runs: where
 *    the line is being worked this moment. It leads the held-but-stopped step on
 *    purpose — a step that has finished owes the stage its check, not its page,
 *    while a sibling is still being worked;
 * 4. else the step the record holds that has not left the line (a gate, or a debt
 *    nobody is working): that stop *is* where the line stands;
 * 5. else a named session the list still calls running (the newest of them when
 *    several are);
 * 6. else the one the record names that moved last;
 * 7. else nothing — no window at all, rather than a conversation the pipeline
 *    never mentioned.
 *
 * A named session the list does not hold is no window either, and it is never
 * stood in for by one the pipeline does not name: an unknown is unknown.
 *
 * Only a caller that says nothing about the pipeline — no named set, no session
 * of its own — falls back to DSH's `retainedBy.mainView` marker, which is the
 * browser's own "who has this open" count and no reading of the record.
 */
export function mainIdOf(
  input: OverviewInput,
  rows: Readonly<Record<string, OverviewSessionRow>>,
  order: readonly string[],
  held: ReadonlySet<string>,
  left: (id: string) => boolean,
): { readonly id: string; readonly from: OverviewMainFrom } | undefined {
  /* The pick is asked of the same list as everything else: a leg that left the
     list is no pick, and the fallback answers instead of a stale id. */
  const shown = text(input.shownSession)
  if (shown !== undefined && rows[shown] !== undefined) return { id: shown, from: 'pick' }
  const named = pipelineOf(input)
  if (named === undefined) {
    const marker = mainViewOf(rows)
    return marker === undefined ? undefined : { id: marker, from: 'view' }
  }
  const candidates = [...named].filter((id) => rows[id] !== undefined)
  const self = text(input.ownSession)
  if (self !== undefined && named.has(self)) {
    if (rows[self] === undefined) return undefined
    /* A seat that has left the line hands the stage over — but only to a step that is **being
     * worked** right now, and only because that is the page the line has moved on to. Nothing of
     * the line running means the check is the last word the stage has to say, and it stays where
     * the reader is looking; a step that stopped owing work keeps its bar either way. */
    const worked = candidates.some((id) => id !== self && rows[id]?.running === true)
    if (!(left(self) && worked)) return { id: self, from: 'seat' }
  }
  /* The step being worked right now is the line's own subject: it is the one reading
     that does not wait on the browser's liveness bit or its last-moved moment. A
     held but stopped step is read after it, because a step that stopped with its
     work owed is where the line stands only while nothing of the line still moves. */
  const live = candidates.filter((id) => held.has(id) && rows[id]?.running === true)
  const liveId = latestOf(live, rows, order)
  if (liveId !== undefined) return { id: liveId, from: 'line' }
  const stuck = candidates.filter((id) => held.has(id) && !left(id))
  const stuckId = latestOf(stuck, rows, order)
  if (stuckId !== undefined) return { id: stuckId, from: 'line' }
  const running = candidates.filter((id) => rows[id]?.running === true)
  const runningId = latestOf(running, rows, order)
  if (runningId !== undefined) return { id: runningId, from: 'line' }
  const last = latestOf(candidates, rows, order)
  return last === undefined ? undefined : { id: last, from: 'line' }
}
