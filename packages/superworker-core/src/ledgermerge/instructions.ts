/**
 * `instructions.json` — the standing user instructions, plus the traces a removal leaves.
 *
 * A record indexed by `id`, with the merged result written back as a list; the record also carries `removed`, the
 * tombstone table (an `id` plus a timestamp, no text). What this engine adds on top of the generic walk:
 *
 * - entries propagate deletions like the graph does: one side takes the entry off (`instruction rm`, the verb the
 *   `instruction` plugin owns) and the other leaves it alone, so it is gone. One side takes it off and the other
 *   edited it is the graph's
 *   "delete vs edit" shape: a conflict, judged by a person.
 * - removal traces are unioned by `id` — nobody takes one back, and they are the evidence that keeps two machines
 *   from minting the same id when they pull from each other. Two machines each removing the same instruction differ
 *   only in the timestamp; the earlier one wins: whoever removed it first is when it left this record.
 * - resolving (archiving / putting back) is one act: `state` / `resolved_at` are written together by one code path,
 *   so the driver judges these two as one group: if only one side changed them, take that side; if both changed
 *   them, order the two by `resolved_at` and the newer act wins as a whole group. Putting an entry back **clears**
 *   that timestamp: one side put it back while the other changed it again, and with no timestamp on either side
 *   there is nothing to order them by — a conflict. `note` deliberately stays outside the group: a sentence a person
 *   wrote is never quietly overwritten, so a `note` both sides changed is a conflict.
 * - both sides adding the same `id` with different content is an addition collision: a conflict.
 *
 * The two tables this record carries are two slots of one generic walk: same key order, same entry-by-entry walk,
 * same "drop what the rule answered `MISSING` for". Nothing of that skeleton lives here.
 */

import {
  type FieldResolver,
  type MergeReport,
  type NewerSideOptions,
  asRecord,
  get,
  indexBy,
  mergeCollection,
  mergeMapping,
  newerSideWins,
  plainField,
  stampField,
} from './generic';

/** The two fields one resolution act writes together; the driver judges them as one group. */
export const RESOLUTION_GROUP = ['state', 'resolved_at'];

/** The traces a removal leaves live under this key: only an `id` and a timestamp, no text. */
const REMOVED = 'removed';

/** The instructions record: `instructions` is walked entry by entry (deletions propagate), and the `removed` traces are unioned by id. */
export function mergeInstructions(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  return mergeCollection(base, ours, theirs, report, {
    slots: [
      {
        key: 'instructions',
        resolveEntry: mergeInstruction,
        indexOf: indexById,
        propagateDelete: true,
        asList: true,
      },
      {
        key: REMOVED,
        resolveEntry: mergeTombstone,
        indexOf: indexById,
        asList: true,
      },
    ],
  });
}

/** A group indexed by `id`: the entries themselves, or their removal traces. */
function indexById(items: unknown): Map<string, unknown> {
  return indexBy(items, (entry) => entry['id']);
}

/** One instruction: the resolution group follows its own rule, the remaining fields follow the ordinary ones. */
function mergeInstruction(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (RESOLUTION_GROUP.includes(key)) {
      return resolution(label, key, baseValue, oursValue, theirsValue, ours, theirs, report);
    }
    return plainField(label, key, baseValue, oursValue, theirsValue, report);
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/**
 * One removal trace: the id, and the moment it left.
 *
 * A trace is the record of a fact, and nothing in the engine takes one back, so the fields follow the ordinary rules
 * and the timestamp takes the **earlier** side: two machines each removing the same entry differ only in the
 * timestamp, and whoever removed it first is when it left this record.
 */
function mergeTombstone(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (key === 'at') {
      return stampField(label, key, baseValue, oursValue, theirsValue, report, 'min');
    }
    return plainField(label, key, baseValue, oursValue, theirsValue, report);
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/**
 * The resolution group: the side that acted later wins the group as a whole, and two acts that cannot be ordered need
 * a person. The moment is `resolved_at`; the two sentences are all this record adds to the shared rule.
 */
const LATER_RESOLUTION: NewerSideOptions = {
  stampOf: (entry) => get(entry, 'resolved_at'),
  winnerNote: (label, _key, winner) =>
    `${label}: both sides changed this instruction's resolution -> take the side with ` +
    `the newer resolved_at (${winner.side} ${winner.later})`,
  cannotOrderNote: (_label, _key, at) =>
    at === 'ours' || at === 'theirs'
      ? // Putting an entry back **clears** that timestamp, and a cleared timestamp only meets one with a value when both
        // sides touched this group: two owner acts on two machines, and neither record has a timestamp to order them by.
        // Say that out loud — "resolved_at cannot order the two" would send the reader looking for two timestamps.
        'one side put this entry back in force (clearing the moment it was withdrawn) while ' +
        'the other side changed it again -- two owner acts collided'
      : 'resolved_at cannot order the two',
};

/** The resolution group: the side with the newer `resolved_at` wins the group as a whole; two timestamps that cannot be ordered need a person. */
function resolution(
  label: string,
  key: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): unknown {
  return newerSideWins(
    label,
    key,
    baseValue,
    oursValue,
    theirsValue,
    { ours, theirs },
    report,
    LATER_RESOLUTION,
  );
}
