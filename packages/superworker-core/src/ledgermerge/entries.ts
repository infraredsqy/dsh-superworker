/**
 * The one rule that has no domain: a record the driver cannot name, merged by the shape it does have — one
 * collection key, every entry carrying its own `id` — joined on that id.
 *
 * Why a rule with no domain is right here
 * --------------------------------------
 * The four engines beside this file each know one record's fields: a node's `status`, an instruction's resolution
 * group, a ticket's terminal words. A record written by a plugin the driver has never heard of has none of that,
 * and the driver must not guess at it. What such a record does say is its own shape: one table, and every entry of
 * it carrying an `id`. That is enough for one honest rule and no more:
 *
 *   one side has the entry            take it as it is (an addition, or the other side's side of a deletion the
 *                                     driver cannot see: it has no owner's vocabulary to tell them apart)
 *   both sides have it                field by field: agree, take it; one side changed, take that side;
 *                                     both sides changed it to two different values, a person decides
 *
 * What it deliberately does not do: it propagates no deletions (no owner's command says an entry was taken away),
 * it orders no two writes (no timestamp of its own), and it knows no vocabulary (`status` is just a field). So two
 * machines each editing the same entry is a conflict rather than a quiet coin toss between them — and an entry only
 * one machine ever added comes back in the merged record, which loses nobody's work.
 *
 * Which table it walks is `entryTableKey`: one collection key whose entries all carry `id` — a list, or a table
 * keyed by that same id. Two such collections, none, a table whose key is not the id its entry carries, or two sides
 * naming two different keys are not this shape, and the driver refuses those before ever getting here.
 */

import {
  MISSING,
  UNDECIDED,
  type EntryIndex,
  type MergeReport,
  entryIdOf,
  entryTableKey,
  get,
  isRecord,
  mergeCollection,
  mergeMapping,
  plainField,
  threeWay,
} from './generic';

/** One record the driver cannot name, merged by the rule above. */
export function mergeEntryRecord(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const key = entryTableKey(ours) ?? entryTableKey(theirs) ?? entryTableKey(base);
  if (key === null) {
    // Unreachable through the driver (the shape is asked before an engine is picked), and said plainly anyway: a
    // table nobody could name is a person's call, not a quiet "both sides added this".
    report.conflict(
      '(the whole record)',
      '(the collection)',
      ours,
      theirs,
      'no single collection of id-carrying entries could be found on any side',
    );
    return {};
  }
  return mergeCollection(base, ours, theirs, report, {
    slots: [
      {
        key,
        // The collection lands back in the shape of the side it is written into: a list stays a list, a table
        // keyed by id stays one. The driver owns none of this record, so it does not reshape it either.
        asList: landsAsList(key, ours, theirs, base),
        indexOf: indexByOwnId,
        resolveEntry: mergeEntry,
      },
    ],
  });
}

/**
 * Whether the merged collection goes back as a list.
 *
 * The shape of the side the result is written into decides; the other two only stand in when this one does not
 * carry the collection at all (a `%P`-named record whose whole table was added on the other side).
 */
function landsAsList(key: string, ...sides: readonly unknown[]): boolean {
  for (const side of sides) {
    const collection = get(side, key);
    if (Array.isArray(collection)) return true;
    if (isRecord(collection)) return false;
  }
  return true;
}

/**
 * One side's collection read as "the id an entry carries -> entry", keeping the on-disk order.
 *
 * Both spellings read the same way: the identity is the entry's own `id`, whether it sits in a list or under a
 * table key that repeats it (the key is that same id, `isEntryTable` refused anything else).
 */
function indexByOwnId(items: unknown): EntryIndex {
  const out: EntryIndex = new Map();
  const entries = Array.isArray(items) ? items : isRecord(items) ? Object.values(items) : [];
  for (const entry of entries) {
    const id = entryIdOf(entry);
    if (id !== null) out.set(id, entry);
  }
  return out;
}

/**
 * One entry present on both sides: field by field under the ordinary rule, so the conflict lines land on the fields
 * that really disagree ("which record, which entry, which field, what each side says") instead of on the entry as a
 * whole.
 */
function mergeEntry(
  label: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
): unknown {
  if (isRecord(oursValue) && isRecord(theirsValue)) {
    return mergeMapping(baseValue, oursValue, theirsValue, (field, baseField, oursField, theirsField) =>
      plainField(label, field, baseField, oursField, theirsField, report),
    );
  }
  // One side's entry is not an object (a hand-written file): two objects cannot be compared field by field, so the
  // whole entry is judged at once.
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  report.conflict(
    label,
    '(the whole entry)',
    oursValue,
    theirsValue,
    'both sides changed this entry, and one of them is not an object',
  );
  return MISSING;
}
