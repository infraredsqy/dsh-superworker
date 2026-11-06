/**
 * `ideas.json` — the graph: node status, text fields, and the dependency edges between nodes.
 *
 * One node per row, keyed by uuid. What this engine adds on top of the generic walk:
 *
 * - if both sides moved `status`, the higher rung wins (`todo < shelved < completed`); a word outside the
 *   vocabulary is a conflict, never a guess.
 * - `dependencies` takes the union, but only when **neither side removed an edge**: an edge one side cut and the
 *   other added is a disagreement about the same edge, and nobody but a person can judge it.
 * - `title` / `description` / `mode` / `tags` follow "the later write wins", on the evidence of `updated_at` (the
 *   timestamp every writer touches); when the two timestamps cannot be ordered, it is a conflict.
 * - one side takes the node off the graph and the other leaves it alone: it stays off (this is the one record whose
 *   deletions propagate); one side takes it off and the other edited it: a conflict.
 * - after the merge, an edge left in the result whose target node is not there records a conflict
 *   (`flagBrokenDependency`) — the pipeline reads a dangling edge as **already satisfied**.
 */

import {
  MISSING,
  UNDECIDED,
  type FieldResolver,
  type MergeReport,
  type NewerSideOptions,
  asRecord,
  fmt,
  get,
  indexBy,
  isRecord,
  mergeCollection,
  mergeMapping,
  newerSideWins,
  plainField,
  sameValue,
  stampField,
  threeWay,
} from './generic';

/** The three rungs, low to high: how far each of the graph's three words has got. */
export const NODE_STATUS_ORDER = ['todo', 'shelved', 'completed'] as const;

/** Fields written by people, judged by "the later write wins" (on the evidence of `updated_at`). */
const TEXT_FIELDS = ['title', 'description', 'mode', 'tags'];

/** The graph's file: the node table is walked entry by entry (deletions propagate), the remaining fields follow the ordinary rules. */
export function mergeIdeas(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  return mergeCollection(base, ours, theirs, report, {
    slots: [
      {
        key: 'nodes',
        resolveEntry: mergeNode,
        indexOf: indexNodes,
        propagateDelete: true,
      },
    ],
    after: flagBrokenDependency,
  });
}

/**
 * Record an edge **this merge broke**: it stays in the result and the node it points at is not there.
 *
 * Taking a node off on one machine tears its dependency edges down along with it (otherwise it refuses the
 * removal), so a dangling reference is exactly what a cross-machine merge can still produce: one side deletes X
 * (cleaning up its own edges), the other side's newly added edge points at X, and no single record was changed by
 * both sides.
 *
 * It is worth stopping for, because nothing else would find it: `ledger.dag.validate` reports dangling references,
 * and until then this edge reads as satisfied, so the nodes depending on it can be dispatched — a node whose
 * premise was deleted would quietly start running. Only what this merge broke is recorded: an edge that was already
 * dangling on one side is that side's own business.
 */
function flagBrokenDependency(
  merged: Record<string, unknown>,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): void {
  const nodesValue = merged['nodes'];
  const mergedNodes = isRecord(nodesValue) ? nodesValue : {};
  const ids = new Set(Object.keys(mergedNodes));
  for (const [id, row] of Object.entries(mergedNodes)) {
    if (!isRecord(row)) continue;
    const dependencies = row['dependencies'];
    if (!Array.isArray(dependencies)) continue;
    for (const dependency of dependencies) {
      const target = String(dependency);
      if (ids.has(target) || wasBroken(ours, id, dependency) || wasBroken(theirs, id, dependency)) {
        continue;
      }
      report.conflict(
        `Node ${id.slice(0, 8)} (a dependency was deleted by the merge)`,
        'dependencies',
        dependencies,
        dependency,
        `the merge deleted ${target.slice(0, 8)}, while this slot's edge still points at it: ` +
          `\`ledger.dag.unlink\` takes that edge off, or put the deleted node back. ` +
          '`ledger.dag.validate` reports the dangling edge, and until then the edge reads as ' +
          'satisfied (the node shows ready)',
      );
    }
  }
}

/** In this side's own file, was the edge `id -> dependency` dangling all along (the edge is there, the node is not)? */
function wasBroken(side: unknown, id: string, dependency: unknown): boolean {
  const nodes = indexNodes(get(side, 'nodes'));
  const row = nodes.get(id);
  if (!isRecord(row)) return false;
  const dependencies = row['dependencies'];
  return (
    Array.isArray(dependencies) &&
    dependencies.some((item) => sameValue(item, dependency)) &&
    !nodes.has(String(dependency))
  );
}

/** The node table read as "uuid → node"; a hand-written list shape is indexed by each entry's own id. */
function indexNodes(nodes: unknown): Map<string, unknown> {
  return indexBy(nodes, (node) => node['id'] || node['uuid']);
}

/** One node: field by field, with three rules of its own and the direction of two timestamps. */
function mergeNode(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
): Record<string, unknown> {
  const resolve: FieldResolver = (key, baseValue, oursValue, theirsValue) => {
    if (key === 'status') return nodeStatus(label, baseValue, oursValue, theirsValue, report);
    if (key === 'dependencies') {
      return dependencies(label, baseValue, oursValue, theirsValue, report);
    }
    if (TEXT_FIELDS.includes(key)) {
      return textField(label, key, baseValue, oursValue, theirsValue, ours, theirs, report);
    }
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

/** Status: if both sides moved it, the higher rung wins; a word outside the vocabulary is a conflict. */
function nodeStatus(
  label: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  const oursRank = rankOfStatus(oursValue);
  const theirsRank = rankOfStatus(theirsValue);
  if (oursRank >= 0 && theirsRank >= 0) {
    const higher = oursRank >= theirsRank ? oursValue : theirsValue;
    report.decide(
      `${label}: status takes the higher rung ${JSON.stringify(higher)}` +
        ` (ours=${JSON.stringify(oursValue)} theirs=${JSON.stringify(theirsValue)})`,
    );
    return higher;
  }
  report.conflict(
    label,
    'status',
    oursValue,
    theirsValue,
    'status is not in the vocabulary; the rung order cannot trim it',
  );
  return MISSING;
}

function rankOfStatus(value: unknown): number {
  return typeof value === 'string'
    ? (NODE_STATUS_ORDER as readonly string[]).indexOf(value)
    : -1;
}

/** Dependency edges: if both sides only added edges, take the union; if either side cut one, a person has to judge (a disagreement about the same edge). */
function dependencies(
  label: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  if (!Array.isArray(oursValue) || !Array.isArray(theirsValue)) {
    report.conflict(label, 'dependencies', oursValue, theirsValue, 'not a list, cannot trim');
    return MISSING;
  }
  if (!Array.isArray(baseValue)) {
    report.conflict(
      label,
      'dependencies',
      oursValue,
      theirsValue,
      'no base (both sides added), so an added edge cannot be told from a removed one',
    );
    return MISSING;
  }
  const addedOurs = oursValue.filter((dep) => !contains(baseValue, dep));
  const removedOurs = baseValue.filter((dep) => !contains(oursValue, dep));
  const addedTheirs = theirsValue.filter((dep) => !contains(baseValue, dep));
  const removedTheirs = baseValue.filter((dep) => !contains(theirsValue, dep));
  if (removedOurs.length === 0 && removedTheirs.length === 0) {
    const merged = [...oursValue, ...theirsValue.filter((dep) => !contains(oursValue, dep))];
    report.decide(
      `${label}: dependencies both sides only added edges -> take the union ${fmt(merged)}`,
    );
    return merged;
  }
  report.conflict(
    label,
    'dependencies',
    oursValue,
    theirsValue,
    `ours added ${fmt(addedOurs)} removed ${fmt(removedOurs)}; ` +
      `theirs added ${fmt(addedTheirs)} removed ${fmt(removedTheirs)}`,
  );
  return MISSING;
}

function contains(list: readonly unknown[], value: unknown): boolean {
  return list.some((item) => sameValue(item, value));
}

/** The three fields people write: both sides changed one, and the side with the later `updated_at` is the later write. */
const LATER_WRITE: NewerSideOptions = {
  stampOf: (node) => get(node, 'updated_at'),
  winnerNote: (label, key, winner) =>
    `${label}: ${key} both sides changed it -> take the side with the newer updated_at ` +
    `(${winner.side} ${winner.later})`,
  cannotOrderNote: () => 'updated_at cannot order the two',
};

function textField(
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
    LATER_WRITE,
  );
}
