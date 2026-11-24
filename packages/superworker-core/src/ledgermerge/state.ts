/**
 * `state.json` — lines: one record per line, plus the `path` of the nodes it walked through.
 *
 * A record indexed by `id`, with the merged result written back as a list (this file is list-shaped). What this
 * engine adds on top of the generic walk:
 *
 * - `path` is append-only: when one side is a prefix of the other take the longer one, and two different tails are
 *   unioned by the order they were walked; the same node recorded twice with two different verdicts is a conflict
 *   (that rule is handed to `extendOrUnion`).
 * - legacy `status` keys left by older records are dropped on merge rather than conflicting.
 * - line entries are never deleted: neither side's engine has a command that deletes one, so an absent entry is
 *   "this side never had it" and it comes back (`propagateDelete` off).
 */

import {
  MISSING,
  type FieldResolver,
  type MergeReport,
  asRecord,
  extendOrUnion,
  indexBy,
  mergeCollection,
  mergeMapping,
  plainField,
  stampField,
  stampOf,
} from './generic';

/** The line account: the `cycles` list is walked entry by entry, the remaining fields follow the ordinary rules. */
export function mergeState(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  return mergeCollection(base, ours, theirs, report, {
    slots: [
      {
        key: 'cycles',
        resolveEntry: mergeCycle,
        indexOf: indexCycles,
        asList: true,
      },
    ],
  });
}

/** The line table read as "id → line": on disk it is a list, and a hand-written mapping is accepted too. */
function indexCycles(cycles: unknown): Map<string, unknown> {
  return indexBy(cycles, (cycle) => cycle['id']);
}

/** One line: field by field, with custom rules for path and legacy status cleanup. */
function mergeCycle(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (key === 'path') return cyclePath(label, baseValue, oursValue, theirsValue, report);
    if (key === 'status') return MISSING;
    if (key === 'updated_at') {
      return stampField(label, key, baseValue, oursValue, theirsValue, report, 'max');
    }
    if (key === 'created_at') {
      return stampField(label, key, baseValue, oursValue, theirsValue, report, 'min');
    }
    return plainField(label, key, baseValue, oursValue, theirsValue, report);
  };
  return mergeMapping(asRecord(base), asRecord(ours), asRecord(theirs), resolve);
}

/** `path` is append-only: one side being a prefix means taking the longer one, and the two tails are unioned by the order they were walked. */
function cyclePath(
  label: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
): unknown {
  return extendOrUnion(label, 'path', baseValue, oursValue, theirsValue, report, {
    identity: (step) => step['node'],
    sameAct: (previous, step) => previous['result'] === step['result'],
    orderBy: (step) => stampOf(step['ended_at']) ?? stampOf(step['started_at']) ?? '',
    sameNote: (tag, previous, step) =>
      `the same node ${tag.slice(0, 8)} has different results on the two sides` +
      ` (ours=${JSON.stringify(previous['result'])} theirs=${JSON.stringify(step['result'])})`,
  });
}
