/**
 * One handoff ticket under `.pf/signals/<line>/<node>.json` — the whole file is one record.
 *
 * A ticket is a report of one attempt: the two sides are two tries at the same node, and the later
 * try is the one that happened.
 *
 * - `status`: a terminal word (`completed` / `failed` / `stopped`) beats a non-terminal one
 *   (`pending` is the marker a re-run leaves), whatever the timestamps say.
 * - for every other field, when both sides changed one, the ticket carrying the **later
 *   `timestamp`** wins: the record says when it was written, and that is the only ordering that
 *   has anything to do with the two attempts. The driver is handed git's own temporary files, whose
 *   modification times say when git wrote those files and nothing about which attempt is later.
 * - when the two sides cannot be ordered — one of them carries no `timestamp`, or both carry the
 *   same one — nothing is guessed: it is a conflict for a person.
 * - two identical tickets are identical: a field only one side touched is asked about by nobody.
 */

import {
  UNDECIDED,
  type FieldResolver,
  type MergeReport,
  type NewerSideOptions,
  asRecord,
  mergeMapping,
  newerSideWins,
  stampOf,
  threeWay,
} from './generic';

/**
 * Terminal: the work of this cell has a verdict — `completed` delivered, `failed` / `stopped` did not.
 * `pending` is the marker of "no verdict yet" (left by a re-run) and never enters this table.
 */
export const TERMINAL_SIGNAL_STATUSES = ['completed', 'failed', 'stopped'];

/**
 * The ticket's own `timestamp` orders every field of the record: the later attempt wins whole, and the two sentences
 * below are the only thing this record adds (`note` is what a ticket is called on a conflict line).
 */
const LATER_TICKET: NewerSideOptions = {
  stampOf: (ticket) => stampOf(asRecord(ticket)['timestamp']),
  winnerNote: (label, what, winner) =>
    `${label}: ${what} both sides changed it -> take the later ticket by its own timestamp ` +
    `(${winner.side}; ${String(winner.moments.ours)} vs ${String(winner.moments.theirs)})`,
  cannotOrderNote: (_label, _what, at, moments) =>
    at === 'same'
      ? `both attempts carry the timestamp ${String(moments.ours)}, so they cannot be ordered`
      : `${at === 'ours' ? 'this side carries no timestamp' : at === 'theirs' ? 'the other side carries no timestamp' : 'neither side carries a timestamp'}, so the two attempts cannot be ordered`,
};

/** One handoff ticket: the later attempt wins, and a terminal status wins over a non-terminal one. */
export function mergeSignal(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (key === 'status') {
      return signalStatus(baseValue, oursValue, theirsValue, { ours, theirs }, report);
    }
    return newerSideWins(
      'note',
      key,
      baseValue,
      oursValue,
      theirsValue,
      { ours, theirs },
      report,
      LATER_TICKET,
    );
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/** Status: terminal beats non-terminal; only within the same tier does the ticket's own timestamp decide. */
function signalStatus(
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  tickets: { readonly ours: unknown; readonly theirs: unknown },
  report: MergeReport,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  const oursTerminal = isTerminal(oursValue);
  const theirsTerminal = isTerminal(theirsValue);
  if (oursTerminal !== theirsTerminal) {
    const winner = oursTerminal ? oursValue : theirsValue;
    report.decide(
      `note: status terminal beats non-terminal -> ${JSON.stringify(winner)}` +
        ` (ours=${JSON.stringify(oursValue)} theirs=${JSON.stringify(theirsValue)})`,
    );
    return winner;
  }
  return newerSideWins(
    'note',
    'status, same tier',
    baseValue,
    oursValue,
    theirsValue,
    tickets,
    report,
    LATER_TICKET,
  );
}

function isTerminal(value: unknown): boolean {
  return typeof value === 'string' && TERMINAL_SIGNAL_STATUSES.includes(value);
}
