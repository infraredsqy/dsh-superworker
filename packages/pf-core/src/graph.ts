import { readJsonFile } from './jsonio';
import type { PfPaths } from './paths';
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
export async function readGraphSnapshot(paths: PfPaths): Promise<{ readonly nodes: Readonly<Record<string, NodeRecord>> }> {
  const read = await readJsonFile(paths.ideasJson, 'ideas.json');
  const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
    ? (read.value as Record<string, unknown>)
    : {};
  const nodes = data.nodes !== null && typeof data.nodes === 'object' && !Array.isArray(data.nodes)
    ? (data.nodes as Record<string, NodeRecord>)
    : {};
  return { nodes };
}

/** The adjacency table: {node: [the nodes it depends on, ...]}. */
export type Adjacency = Record<string, string[]>;

/**
 * Resolve an id spelling the caller gives back to a key of a table: a full id is taken as it is, and
 * a prefix long enough to be unique is taken too. A prefix matching several keys is refused (no
 * guessing), and so is one matching none. Every verb on the graph that speaks in ids shares this, so
 * one prefix gets the same verdict on every verb.
 */
export function resolveNodeId(uid: string, nodes: Readonly<Record<string, unknown>>): string {
  if (uid in nodes) return uid;
  const matches = Object.keys(nodes).filter((key) => key.startsWith(uid));
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`"${uid}" matches multiple nodes (${matches.join(', ')})`);
  }
  throw new Error(`node ${uid} not found`);
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
      if (dep in rev) rev[dep]!.push(uid);
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
    if (!(next in adj)) continue; // a dangling dependency: skip it
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
      if (dep in adj) count += 1;
    }
    inDegree[uid] = count;
  }
  const order: string[] = [];
  const queue = Object.keys(inDegree).filter((uid) => inDegree[uid] === 0);
  while (queue.length > 0) {
    const uid = queue.shift()!;
    order.push(uid);
    for (const dependent of rev[uid] ?? []) {
      if (dependent in inDegree) {
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
      const upstream = depSet[dep];
      if (upstream !== undefined) for (const item of upstream) set.add(item);
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
      const downstream = dependentSet[dependent];
      if (downstream !== undefined) for (const item of downstream) set.add(item);
    }
    dependentSet[uid] = set;
  }
  const scores: Record<string, number> = {};
  for (const [uid, set] of Object.entries(dependentSet)) scores[uid] = set.size - 1;
  return scores;
}

/** Ready means every dependency is delivered (or absent); an absent dependency counts as delivered. */
function isReady(deps: string[], allNodes: NodeMap): boolean {
  for (const dep of deps) {
    const node = allNodes[dep];
    if (node !== undefined && node.status !== 'completed') return false;
  }
  return true;
}

/** The one reading of ready: the node itself is todo and every dependency is completed (or absent). */
export function nodeReady(node: NodeRecord, allNodes: NodeMap): boolean {
  return node.status === 'todo' && isReady(node.dependencies ?? [], allNodes);
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
