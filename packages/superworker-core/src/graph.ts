import { readJsonFile } from './jsonio';
import type { RecordPaths } from './paths';
import type { NodeRecord } from './types';

/**
 * Graph algorithms: adjacency, reverse adjacency, reachability, ordering, urgency and importance
 * scores, cycles, readiness. Pure functions, no disk, no locks: the caller hands in the existing
 * node table and gets answers back. Handling of dangling references is included — a dangling
 * dependency does not count as in-degree, is skipped on unreachable paths, and counts as delivered
 * in the readiness decision.
 *
 * The one exception is `readGraphSnapshot`, which reads the node table off the record: the graph is
 * where the node table lives, so the reader of that record sits here, and a caller that wants a
 * snapshot hands it in to the plugin seam instead of the seam reading the record itself.
 */

/** The node table: the `nodes` table of ideas.json, keyed by node id. */
export type NodeMap = Record<string, NodeRecord>;

/**
 * The node table as one snapshot: the records read once by the caller (absent or unreadable means an
 * empty graph). The plugin seam takes this shape and never reads ideas.json itself.
 */
export async function readGraphSnapshot(paths: RecordPaths): Promise<{ readonly nodes: Readonly<Record<string, NodeRecord>> }> {
  const read = await readJsonFile(paths.ideasJson, 'ideas.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  const nodes = data.nodes !== null && typeof data.nodes === 'object' && !Array.isArray(data.nodes)
    ? (data.nodes as Record<string, NodeRecord>)
    : {};
  return { nodes };
}

// ── tags ─────────────────────────────────────────────────────────────────────
// The one reading of a tag list and of a picking range: a tag is a word with the blanks taken off,
// the empty word is not a tag, and a node without tags is visible to every range. Every reader
// (the graph's own filter, a line's picking range, the plan's rows) goes through these two.

/** Normalise a tag list: trim each word, drop the empty ones, keep the given order, drop duplicates. */
export function normalizeTags(raw: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const tag = typeof item === 'string' ? item.trim() : '';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The tags one record carries, normalised; a record with no tags (or none spelled as words) carries none. */
export function tagsOf(node: { tags?: unknown }): string[] {
  return normalizeTags(Array.isArray(node.tags) ? (node.tags as unknown[]) : []);
}

/** Whether a node's tags fall inside a picking range: a shared tag is a hit, and a node without tags is visible everywhere. Both sides are normalised first, so a tag spelled with blanks meets one spelled without. */
export function inTagScope(nodeTags: readonly string[], range: readonly string[]): boolean {
  const wanted = normalizeTags(range);
  if (wanted.length === 0) return true;
  const tags = normalizeTags(nodeTags);
  if (tags.length === 0) return true;
  return tags.some((tag) => wanted.includes(tag));
}

/** The adjacency table: {node: [the nodes it depends on, ...]}. */
export type Adjacency = Record<string, string[]>;

/**
 * The short spelling of an id: the eight characters the plan, the receipt and a line record cite a
 * node by. The one definition of the width: `words/out`'s printer and the other print faces of the
 * word layer cite this rule rather than slicing an id themselves; the merge driver's own id cells
 * (`ledgermerge/`) are a separate face and still spell their own.
 */
export function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * Whether a keyed table owns this name itself: the node table and the adjacency tables are plain
 * objects, so a membership test that walked the prototype would read `constructor`, `toString`,
 * `__proto__` and their kin as members of a graph that never heard of them — a read would answer
 * from a wider layer under a name the graph has never heard of, and a write would mint an edge to
 * one. The one membership test of the node table and the adjacency tables; the settings chain
 * gates its own tables the same way (`Object.hasOwn` in `config.ts`).
 */
export function ownsKey(table: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.hasOwn(table, key);
}

/**
 * The key one id spelling names on the node table: a full id is taken as it is, and a prefix long
 * enough to be unique is taken too. A prefix matching several keys is refused (no guessing), and
 * one matching none comes back as `null` — `resolveNodeId` throws that absence, `dag.get` folds it
 * into `null`. The one matching of an id spelling: every verb on the graph that speaks in ids
 * shares it, so one prefix gets the same verdict on every verb.
 */
export function resolveNodeKey(uid: string, nodes: Readonly<Record<string, unknown>>): string | null {
  if (ownsKey(nodes, uid)) return uid;
  const matches = Object.keys(nodes).filter((key) => key.startsWith(uid));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`"${uid}" matches multiple nodes (${matches.join(', ')})`);
  }
  return null;
}

/** The id spelling resolved all the way: the key `resolveNodeKey` names, refused when it names nothing. */
export function resolveNodeId(uid: string, nodes: Readonly<Record<string, unknown>>): string {
  const key = resolveNodeKey(uid, nodes);
  if (key === null) throw new Error(`node ${uid} not found`);
  return key;
}

export function adjacency(nodes: NodeMap): Adjacency {
  const adj: Adjacency = {};
  for (const [uid, node] of Object.entries(nodes)) {
    adj[uid] = [...(node.dependencies ?? [])];
  }
  return adj;
}

/** The reverse adjacency table: {node: [the nodes that depend on it, ...]}; edges pointing outside the adjacency table do not enter it. */
export function reverseAdjacency(adj: Adjacency): Adjacency {
  const rev: Adjacency = {};
  for (const uid of Object.keys(adj)) rev[uid] = [];
  for (const [uid, deps] of Object.entries(adj)) {
    for (const dep of deps) {
      if (ownsKey(rev, dep)) rev[dep]!.push(uid);
    }
  }
  return rev;
}

/** Whether start can reach target along dependency edges; if so the path comes back with it (both ends are in the path). */
export function canReach(
  adj: Adjacency,
  start: string,
  target: string,
  visited: Set<string> = new Set(),
): [boolean, string[]] {
  if (start === target) return [true, [target]];
  if (visited.has(start)) return [false, []];
  visited.add(start);
  for (const next of adj[start] ?? []) {
    if (!ownsKey(adj, next)) continue; // a dangling dependency: skip it
    const [found, path] = canReach(adj, next, target, visited);
    if (found) return [true, [start, ...path]];
  }
  return [false, []];
}

/** Kahn topological order: dependencies first, dependents after; nodes left on a cycle are appended at the end in their original order. */
export function topologicalOrder(adj: Adjacency): string[] {
  const rev = reverseAdjacency(adj);
  const inDegree: Record<string, number> = {};
  for (const [uid, deps] of Object.entries(adj)) {
    let count = 0;
    for (const dep of deps) {
      if (ownsKey(adj, dep)) count += 1;
    }
    inDegree[uid] = count;
  }
  const order: string[] = [];
  const queue = Object.keys(inDegree).filter((uid) => inDegree[uid] === 0);
  while (queue.length > 0) {
    const uid = queue.shift()!;
    order.push(uid);
    for (const dependent of rev[uid] ?? []) {
      if (ownsKey(inDegree, dependent)) {
        inDegree[dependent] -= 1;
        if (inDegree[dependent] === 0) queue.push(dependent);
      }
    }
  }
  for (const uid of Object.keys(adj)) {
    if (!order.includes(uid)) order.push(uid);
  }
  return order;
}

/**
 * The urgency score: the fewer unfinished downstream blocks a node has, the more urgent it is.
 * Normalised by the size of the transitive dependency set, so the least urgent node on the graph
 * gets 0.
 */
export function urgencyScores(adj: Adjacency): Record<string, number> {
  const topo = topologicalOrder(adj);
  const depSet: Record<string, Set<string>> = {};
  for (const uid of topo) {
    const set = new Set<string>([uid]);
    for (const dep of adj[uid] ?? []) {
      // The dep-set table is keyed by node id and owns its keys: a dependency naming an inherited key
      // has no set of its own (the same membership test as the tables above).
      if (!ownsKey(depSet, dep)) continue;
      for (const item of depSet[dep]!) set.add(item);
    }
    depSet[uid] = set;
  }
  const raw: Record<string, number> = {};
  for (const [uid, set] of Object.entries(depSet)) raw[uid] = -(set.size - 1);
  const values = Object.values(raw);
  if (values.length === 0) return raw;
  const offset = -Math.min(...values);
  const scores: Record<string, number> = {};
  for (const [uid, value] of Object.entries(raw)) scores[uid] = value + offset;
  return scores;
}

/** The importance score: count the transitive dependents (itself excluded); the more nodes depend on it, the more important it is. */
export function importanceScores(adj: Adjacency): Record<string, number> {
  const topo = topologicalOrder(adj);
  const rev = reverseAdjacency(adj);
  const dependentSet: Record<string, Set<string>> = {};
  for (const uid of [...topo].reverse()) {
    const set = new Set<string>([uid]);
    for (const dependent of rev[uid] ?? []) {
      // The same membership test as the dep-set table above: an inherited key is no member.
      if (!ownsKey(dependentSet, dependent)) continue;
      for (const item of dependentSet[dependent]!) set.add(item);
    }
    dependentSet[uid] = set;
  }
  const scores: Record<string, number> = {};
  for (const [uid, set] of Object.entries(dependentSet)) scores[uid] = set.size - 1;
  return scores;
}

// ── the ordering of the unfinished subgraph ──────────────────────────────────

/** The two readings of the unfinished subgraph (completed nodes are not ranked), computed once for everything that orders by them. */
export interface RankScores {
  readonly urgency: Record<string, number>;
  readonly importance: Record<string, number>;
}

/** Read urgency and importance off the unfinished subgraph: the one place either score is computed. */
export function rankScores(nodes: NodeMap): RankScores {
  const notCompleted: NodeMap = {};
  for (const [uid, node] of Object.entries(nodes)) {
    if (node.status !== 'completed') notCompleted[uid] = node;
  }
  const adj = adjacency(notCompleted);
  return { urgency: urgencyScores(adj), importance: importanceScores(adj) };
}

/**
 * The Eisenhower ordering of a set of ids: importance first, urgency after. An id with no score
 * (completed, shelved, or absent from the table) counts as 0, and ties keep the order the ids came
 * in — `Array.prototype.sort` is stable. The one ordering rule of the graph layer: `dag.list`,
 * `dag.info` and a line's ranking all read from here.
 */
export function eisenhowerOrder(ids: readonly string[], scores: RankScores): string[] {
  const order = [...ids];
  order.sort(
    (a, b) =>
      (scores.importance[b] ?? 0) - (scores.importance[a] ?? 0) ||
      (scores.urgency[b] ?? 0) - (scores.urgency[a] ?? 0),
  );
  return order;
}

// ── ready ────────────────────────────────────────────────────────────────────

/**
 * The one reading of ready: **the node itself is todo** (an absent status reads todo, as `api.md`
 * says; only a node that left todo is out of the game), **every dependency is delivered** (a
 * dangling dependency counts as delivered — that is what `validate` should name, and it must not
 * stall the whole line), and — when the caller names the closing moment — a node in
 * `assumeCompleted` reads as already delivered.
 *
 * `assumeCompleted` is the closing reading: the node being closed has not been written back to its
 * status yet, so counting it delivered is what shows the downstream it just unlocked; the same set
 * also drops the closing node itself from the ready set. The criterion is not copied anywhere else:
 * `dag.list` / `dag.search` / `dag.info`, a line's ranking and the planner all call this.
 */
export function nodeReady(uid: string, allNodes: NodeMap, options: ReadyOptions = {}): boolean {
  const assumed = options.assumeCompleted;
  if (assumed !== undefined && assumed.has(uid)) return false;
  const node = allNodes[uid];
  if (node === undefined) return false;
  if ((node.status ?? 'todo') !== 'todo') return false;
  for (const dep of node.dependencies ?? []) {
    if (!ownsKey(allNodes, dep)) continue; // a dangling dependency: delivered
    if (assumed !== undefined && assumed.has(dep)) continue;
    if ((allNodes[dep]!.status ?? 'todo') !== 'completed') return false;
  }
  return true;
}

/** The reading of ready a caller may narrow: the nodes of the closing moment, which count as delivered. */
export interface ReadyOptions {
  readonly assumeCompleted?: ReadonlySet<string>;
}

/** Three-colour DFS for cycles; on finding one it returns (true, cycle path), whose ends are the same node. */
export function detectCycle(adj: Adjacency): [boolean, string[]] {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const colour: Record<string, number> = {};
  for (const uid of Object.keys(adj)) colour[uid] = WHITE;
  const parent: Record<string, string> = {};
  const outPath: string[] = [];

  const visit = (uid: string): boolean => {
    colour[uid] = GRAY;
    for (const next of adj[uid] ?? []) {
      if (!(next in colour)) continue;
      if (colour[next] === GRAY) {
        const path: string[] = [next];
        let current: string | undefined = uid;
        while (current !== next && current !== undefined) {
          path.push(current);
          current = parent[current];
        }
        path.push(next);
        path.reverse();
        outPath.push(...path);
        return true;
      }
      if (colour[next] === WHITE) {
        parent[next] = uid;
        if (visit(next)) return true;
      }
    }
    colour[uid] = BLACK;
    return false;
  };

  for (const uid of Object.keys(adj)) {
    if (colour[uid] === WHITE && visit(uid)) return [true, outPath];
  }
  return [false, []];
}
