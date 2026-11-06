import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { nowMicro } from './clock';
import { envSessionId } from './env';
import {
  atomicWriteJson,
  jsonOptionsForRecord,
  readJsonFile,
} from './jsonio';
import { assertLedgerInitialized } from './initledger';
import type {
  AddedNode,
  DagAddInput,
  DagInfo,
  DagInfoEdge,
  DagInfoOptions,
  DagListFilter,
  DagNamespace,
  DagRemoveOptions,
  DagSearchHit,
  DagSearchOptions,
  DagUpdateInput,
  DagValidationReport,
  NodeContext,
  NodeContextEntry,
  NodeSummary,
} from './ledger';
import { withLedgerLock } from './ledgerlock';
import { appendSessionNote, readSessionNote } from './sessions';
import { nodeDir, nodeSpecPath, pfPaths, sessionNotePath, type PfPaths } from './paths';
import type { MicroTimestamp, NodeMode, NodeRecord, NodeStatus, NodeWeight } from './types';
import {
  adjacency,
  canReach,
  detectCycle,
  importanceScores,
  nodeReady,
  resolveNodeId,
  reverseAdjacency,
  urgencyScores,
  type NodeMap,
} from './graph';

/**
 * The real implementation of the graph namespace: the whole command surface for nodes and edges, the three
 * states and reviving, node directories and spec paths, whole-graph validation and ordering. Behaviour and
 * on-disk bytes read like this:
 *
 * - every verb that changes the graph holds the record tree's lock through the whole "read → change → write";
 *   the init gate comes before the lock (a `.pf` that was never initialised gets not one byte — the lock's
 *   directory creation is the only trace that would be left, so the gate has to come before it).
 * - read-side verbs (get / info / context / search / list / specPath / validate) hold no lock and ask no
 *   gate: writes are atomic and what is read is one complete record; a graph that was never initialised
 *   reads as an empty graph.
 * - every rewrite touches `updated_at`; landing completed writes `completed_at` and leaving takes it off;
 *   `approved_at` only moves on an approval and is not taken off when the node leaves completed (whether an
 *   approval still counts is up to "the approval timestamp is not earlier than the completion timestamp", and
 *   the write side does not block it).
 * - ideas.json is read and rewritten as a whole document: the graph owns only the `nodes` table, and every
 *   other top-level key (manual merges, foreign sections) is carried back as it was, so one dag write never
 *   clears them.
 * - validate's isolated-node detection (no dependencies and no dependents) is an item the spec asks for
 *   explicitly: it only names them (the isolated field), and the verdict of ok still covers only cycles /
 *   dangling / duplicate edges.
 * - the node directory `<pf>/nodes/<id>/` is set up by add and holds no artifact yet; add lays down no
 *   spec.md, so the file being absent is how "the requirements are not written yet" is expressed. rm takes
 *   the directory away as a whole.
 */

const VALID_STATUSES: readonly NodeStatus[] = ['todo', 'shelved', 'completed'];
const DEFAULT_MODE: NodeMode = 'auto';
/** A missing key (or an unrecognised word) always reads as standard: better to send one person too many than to let a node skip the standard path. */
const DEFAULT_WEIGHT: NodeWeight = 'standard';

interface IdeasLedger {
  /** The whole document object of ideas.json: the graph owns only the `nodes` table, and every other top-level
   *  key (manual merges, foreign sections) is carried back as it was: missing keys are filled on read, the
   *  whole document is written back on write. */
  data: Record<string, unknown>;
  nodes: NodeMap;
}

/** Tag normalisation: trim whitespace, drop empty words, keep the given order, drop duplicates. */
function normalizeTags(raw: Iterable<string>): string[] {
  const out: string[] = [];
  for (const item of raw) {
    const tag = typeof item === 'string' ? item.trim() : '';
    if (tag && !out.includes(tag)) out.push(tag);
  }
  return out;
}

/** The tags a node carries: never tagged means an empty table (visible to every filter set). */
function tagsOf(node: NodeRecord): string[] {
  const tags = node.tags;
  if (!Array.isArray(tags)) return [];
  return tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

/** The weight reading of a node: only light ever landed on disk; everything else is standard. */
function weightOf(node: NodeRecord): NodeWeight {
  return node.weight === 'light' ? 'light' : DEFAULT_WEIGHT;
}

/** Whether this node is inside this filter set: a shared tag is a hit; a node without tags is visible everywhere. */
function inTagScope(nodeTags: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  if (nodeTags.length === 0) return true;
  return nodeTags.some((tag) => wanted.includes(tag));
}

/** Add dep to uid's dependencies and look for a cycle; a self-edge is refused, a duplicate edge comes back as false as it was (no-op), and a cycle is rolled back and refused. */
function tryAddDependency(nodes: NodeMap, uid: string, dep: string): boolean {
  if (dep === uid) throw new Error('self-dependency is not allowed');
  const deps = nodes[uid]!.dependencies;
  if (deps.includes(dep)) return false;
  deps.push(dep);
  const [found, path] = canReach(adjacency(nodes), dep, uid);
  if (found) {
    deps.pop();
    throw new Error(`cycle detected: ${[uid, ...path].join(' → ')}`);
  }
  return true;
}

/** The spec.md location: `<root>/.pf/nodes/<id>/spec.md` — the one source of the spelling is paths (`nodeSpecPath`). */
function specPathOf(paths: PfPaths, uid: string): string {
  return nodeSpecPath(paths, uid);
}

/** Build the dag namespace: one per project root. */
export function createDagNamespace(root: string): DagNamespace {
  const paths = pfPaths(root);

  async function readIdeas(): Promise<IdeasLedger> {
    const read = await readJsonFile(paths.ideasJson, 'ideas.json');
    const data = read.kind === 'present' && read.value !== null && typeof read.value === 'object'
      ? (read.value as Record<string, unknown>)
      : {};
    if (!('nodes' in data) || data.nodes === null || data.nodes === undefined) {
      data.nodes = {};
    }
    return { data, nodes: data.nodes as NodeMap };
  }

  /** Write ideas.json: the whole document is written back as it was (only the nodes table is changed), in the ideas writer's key order (sorted deeply). */
  async function writeIdeas(ledger: IdeasLedger): Promise<void> {
    mkdirSync(paths.nodesDir, { recursive: true });
    await atomicWriteJson(paths.ideasJson, ledger.data, jsonOptionsForRecord('ideas'));
  }

  /** The one gate the verbs that change the graph share: the init decision first (which creates no directory), then the lock and the read-change-write. */
  function mutate<T>(body: (ledger: IdeasLedger) => Promise<T>): Promise<T> {
    assertLedgerInitialized(paths);
    return withLedgerLock(paths, async () => {
      const ledger = await readIdeas();
      return body(ledger);
    });
  }

  return {
    async add(input: DagAddInput): Promise<AddedNode> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        if (!input.title) throw new Error('title cannot be empty');
        const uid = randomUUID();
        const now = nowMicro();
        const node: NodeRecord = {
          title: input.title,
          description: input.description ?? '',
          status: 'todo',
          mode: input.mode ?? DEFAULT_MODE,
          dependencies: [],
          created_at: now,
          updated_at: now,
        };
        // Tags and weight land as keys only when there is really something: a node with no tags and standard weight keeps today's shape, not one byte more.
        const tags = normalizeTags(input.tags ?? []);
        if (tags.length > 0) node.tags = tags;
        if (input.weight === 'light') node.weight = 'light';
        nodes[uid] = node;

        // The node directory is set up by add; spec.md is left for the one who writes the requirements, so a
        // missing file says "nothing written yet" and an empty one never has to stand in for it.
        mkdirSync(nodeDir(paths, uid), { recursive: true });

        for (const dep of normalizeTags(input.depends_on ?? [])) {
          if (!(dep in nodes)) {
            // The dependency does not exist: the node just set up is withdrawn as a whole — wiped from the record
            // (write back atomically) and its directory taken away.
            delete nodes[uid];
            await writeIdeas(ledger);
            rmSync(nodeDir(paths, uid), { recursive: true, force: true });
            throw new Error(`dependency ${dep} not found`);
          }
          // A cycle is impossible here (the new node has no dependents yet), and the check is kept as it is all the same.
          tryAddDependency(nodes, uid, dep);
        }

        await writeIdeas(ledger);
        // The session this node was born in is noted here, after the graph write: a dependency check that
        // rolled the node back leaves no note behind. It is plumbing and best effort — failing to write it
        // must not undo a node that already landed, so the error is swallowed and the switch's job is done
        // as soon as the note is on disk. The id is read at this call, never cached.
        const session = envSessionId();
        if (session !== undefined) {
          try {
            await appendSessionNote(root, uid, 'discussion', session);
          } catch {
            // The note is local corroboration that can be rebuilt from the session at hand.
          }
        }
        // The on-disk record does not carry an id (it is the key of the node table); the one handed back does, so the caller can go on with it.
        return { ...node, id: uid };
      });
    },

    async remove(id: string, options: DagRemoveOptions = {}): Promise<void> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const uid = resolveNodeId(id, nodes);
        const dependents = Object.entries(nodes)
          .filter(([, node]) => (node.dependencies ?? []).includes(uid))
          .map(([nid, node]) => [nid, node.title ?? ''] as const);
        if (dependents.length > 0 && options.force !== true) {
          const lines = dependents.map(([nid, title]) => `  ${nid}  ${title}`);
          throw new Error(
            'the following nodes depend on this node:\n' +
              `${lines.join('\n')}\n` +
              'Use --force to remove anyway.',
          );
        }
        for (const node of Object.values(nodes)) {
          const deps = node.dependencies ?? [];
          const at = deps.indexOf(uid);
          if (at >= 0) deps.splice(at, 1);
        }
        delete nodes[uid];
        await writeIdeas(ledger);
        rmSync(nodeDir(paths, uid), { recursive: true, force: true });
        // The node's session file goes with the node: a record that is gone with a session still pointing at it left behind is a dead signpost.
        rmSync(sessionNotePath(paths, uid), { force: true });
      });
    },

    async update(id: string, patch: DagUpdateInput): Promise<NodeRecord> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const node = nodes[resolveNodeId(id, nodes)]!;
        let changed = false;
        if (patch.title !== undefined) {
          node.title = patch.title;
          changed = true;
        }
        if (patch.description !== undefined) {
          node.description = patch.description;
          changed = true;
        }
        if (patch.mode !== undefined) {
          node.mode = patch.mode;
          changed = true;
        }
        if (patch.weight !== undefined) {
          // Writing standard back takes the key off: only light lands in the record, and a missing key is standard.
          if (patch.weight === 'light') node.weight = 'light';
          else delete node.weight;
          changed = true;
        }
        if (Array.isArray(patch.tags)) {
          const tags = normalizeTags(patch.tags);
          if (tags.length > 0) {
            node.tags = tags;
            changed = true;
          }
          // An empty array is not a change: use null to take all the tags off.
        } else if (patch.tags === null) {
          // Taking them all off means back to "visible to every filter set".
          delete node.tags;
          changed = true;
        }
        if (changed) {
          node.updated_at = nowMicro();
          await writeIdeas(ledger);
        }
        return node;
      });
    },

    async link(id: string, dependsOn: string): Promise<void> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const uid = resolveNodeId(id, nodes);
        const dep = resolveNodeId(dependsOn, nodes);
        // An existing edge is a no-op, but the timestamp is touched and the record is written just the same.
        tryAddDependency(nodes, uid, dep);
        nodes[uid]!.updated_at = nowMicro();
        await writeIdeas(ledger);
      });
    },

    async unlink(id: string, dependency: string): Promise<void> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const uid = resolveNodeId(id, nodes);
        const node = nodes[uid]!;
        const deps = node.dependencies ?? [];
        // Take the edge off when it is in the table; when it is not, a unique prefix hit counts too; when
        // neither holds, the id is first confirmed as a node on the graph (otherwise it is a typo and stops the
        // call), and with that confirmed there is nothing to do, so nothing is written.
        let target: string | null = null;
        if (deps.includes(dependency)) {
          target = dependency;
        } else {
          const named = deps.filter((dep) => String(dep).startsWith(dependency));
          if (named.length > 1) {
            throw new Error(`"${dependency}" matches multiple dependencies (${named.join(', ')})`);
          }
          if (named.length === 1) {
            target = named[0]!;
          } else {
            resolveNodeId(dependency, nodes);
          }
        }
        if (target !== null) {
          deps.splice(deps.indexOf(target), 1);
          node.updated_at = nowMicro();
          await writeIdeas(ledger);
        }
      });
    },

    async setStatus(id: string, status: NodeStatus): Promise<NodeRecord> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const node = nodes[resolveNodeId(id, nodes)]!;
        if (!VALID_STATUSES.includes(status)) {
          throw new Error(
            `invalid status "${String(status)}". Valid: ${[...VALID_STATUSES].sort().join(', ')}`,
          );
        }
        node.status = status;
        node.updated_at = nowMicro();
        // The completion timestamp is a fact of the node itself: landing completed writes it down, leaving takes it off.
        if (status === 'completed') node.completed_at = node.updated_at;
        else delete node.completed_at;
        await writeIdeas(ledger);
        return node;
      });
    },

    async approve(id: string, at?: MicroTimestamp): Promise<NodeRecord> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const uid = resolveNodeId(id, nodes);
        const node = nodes[uid]!;
        const delivered = node.status === 'completed' || node.completed_at !== undefined;
        if (!delivered) {
          const title = node.title ?? '';
          throw new Error(
            `node ${uid}${title ? ` (${title})` : ''} has not been delivered yet ` +
              `(status=${node.status ?? 'todo'}, and no completion moment): there is nothing ` +
              'here to approve. What an approval is about is a delivery, and that is what ' +
              'closing out the round which delivered it writes down.',
          );
        }
        // The approval is written as given (now by default), and the approval timestamp moves together with updated_at: the record changed.
        const moment = at ?? nowMicro();
        node.approved_at = moment;
        node.updated_at = moment;
        await writeIdeas(ledger);
        return node;
      });
    },

    async revive(id: string): Promise<NodeRecord> {
      return mutate(async (ledger) => {
        const { nodes } = ledger;
        const node = nodes[resolveNodeId(id, nodes)]!;
        const status = node.status;
        if (status !== 'shelved') {
          throw new Error(
            `node is not shelved (status=${JSON.stringify(status ?? null)}); ` +
              'use "status <id> todo" to change it',
          );
        }
        node.status = 'todo';
        node.updated_at = nowMicro();
        await writeIdeas(ledger);
        return node;
      });
    },

    async get(id: string): Promise<NodeRecord | null> {
      const { nodes } = await readIdeas();
      if (id in nodes) return nodes[id]!;
      const matches = Object.keys(nodes).filter((key) => key.startsWith(id));
      if (matches.length === 1) return nodes[matches[0]!]!;
      if (matches.length > 1) {
        throw new Error(`"${id}" matches multiple nodes (${matches.join(', ')})`);
      }
      return null;
    },

    /**
     * One node's detail: the record plus what only the graph can answer. Read-only, like `get`: no lock,
     * no init gate, and a record that is not on the graph stops on the spot.
     *
     * The two readings (urgency, importance) are computed on the unfinished subgraph — the same
     * algorithm `list` uses, never a second copy — and a shelved node is not ranked, so both read 0.
     * A dependency the graph no longer holds still shows up: it reads `(unknown)`, and it counts as
     * delivered for `ready` (the one readiness rule of the graph layer).
     *
     * The session lists come from this machine's note file, read through the one session-note reading:
     * the key is absent when both lists are empty, so "a key that is not here was never written" holds.
     */
    async info(id: string, options: DagInfoOptions = {}): Promise<DagInfo> {
      const verbose = options.verbose === true;
      const { nodes } = await readIdeas();
      const uid = resolveNodeId(id, nodes);
      const node = nodes[uid]!;

      // Upstream: the edges this node's own record names, in the order the record has them. A dependency
      // the graph no longer holds reads (unknown) — the same two defaults the read side always gives.
      const dependsOn: DagInfoEdge[] = [];
      for (const depId of node.dependencies ?? []) {
        const dep = nodes[depId];
        const edge: DagInfoEdge = { id: depId, title: dep?.title ?? '(unknown)' };
        if (verbose) edge.status = dep?.status ?? '(unknown)';
        dependsOn.push(edge);
      }

      // Downstream: every node on the graph whose record names this one, in table order. A dependent
      // without a title / status word reads the empty string, not the dependency's (unknown) default.
      const dependedBy: DagInfoEdge[] = [];
      for (const [otherId, other] of Object.entries(nodes)) {
        if (!(other.dependencies ?? []).includes(uid)) continue;
        const edge: DagInfoEdge = { id: otherId, title: other.title ?? '' };
        if (verbose) edge.status = other.status ?? '';
        dependedBy.push(edge);
      }

      // Both readings are the graph layer's own (non-completed subgraph), exactly as `list` computes them.
      const notCompleted: NodeMap = {};
      for (const [otherId, other] of Object.entries(nodes)) {
        if (other.status !== 'completed') notCompleted[otherId] = other;
      }
      const adj = adjacency(notCompleted);
      const urgency = urgencyScores(adj);
      const importance = importanceScores(adj);
      // A shelved node is out of play: it is not ranked and both readings are 0.
      const blocked = (node.status ?? 'todo') === 'shelved';

      const info: DagInfo = {
        id: uid,
        title: node.title ?? '',
        // The read side's own default: a record that says nothing reads `todo` (as `api.md` states),
        // exactly as readiness below already reads an absent status as todo.
        status: node.status ?? 'todo',
        mode: node.mode ?? DEFAULT_MODE,
        description: node.description ?? '',
        depends_on: dependsOn,
        depended_by: dependedBy,
        ready: nodeReady(node, nodes),
        urgency_level: blocked ? 0 : (urgency[uid] ?? 0),
        importance_score: blocked ? 0 : (importance[uid] ?? 0),
      };
      if (weightOf(node) === 'light') info.weight = 'light';
      if (verbose) {
        // The two timestamps keep their cells under `verbose` even when the record wrote none: the
        // read side's own default is the empty string, so the shape does not depend on the writer.
        info.created_at = node.created_at ?? '';
        info.updated_at = node.updated_at ?? '';
      }
      // The session note is read off the record itself: the host column is this engine's own host,
      // and there is no machine layer to consult for it.
      const note = await readSessionNote(root, uid);
      if (note.discussion.length > 0 || note.run.length > 0) {
        info.sessions = { discussion: note.discussion, run: note.run };
      }
      if (node.completed_at !== undefined) info.completed_at = node.completed_at;
      if (node.approved_at !== undefined) info.approved_at = node.approved_at;
      return info;
    },

    async context(id: string): Promise<NodeContext> {
      const { nodes } = await readIdeas();
      const uid = resolveNodeId(id, nodes);
      const node = nodes[uid]!;
      const rev = reverseAdjacency(adjacency(nodes));

      // Upstream follows dependency edges, downstream follows reverse edges, one breadth-first pass each; a missing node enters the list as (unknown).
      const upstream: NodeContextEntry[] = [];
      const visitedUp = new Set<string>([uid]);
      const upQueue: Array<[string, number]> = (node.dependencies ?? []).map((dep) => [dep, 1]);
      while (upQueue.length > 0) {
        const [depId, depth] = upQueue.shift()!;
        if (visitedUp.has(depId)) continue;
        visitedUp.add(depId);
        const depNode = nodes[depId];
        upstream.push({
          id: depId,
          title: depNode?.title ?? '(unknown)',
          status: depNode?.status ?? '(unknown)',
          depth,
        });
        for (const grand of depNode?.dependencies ?? []) {
          if (!visitedUp.has(grand)) upQueue.push([grand, depth + 1]);
        }
      }

      const downstream: NodeContextEntry[] = [];
      const visitedDown = new Set<string>([uid]);
      const downQueue: Array<[string, number]> = (rev[uid] ?? []).map((did) => [did, 1]);
      while (downQueue.length > 0) {
        const [did, depth] = downQueue.shift()!;
        if (visitedDown.has(did)) continue;
        visitedDown.add(did);
        const dependent = nodes[did];
        downstream.push({
          id: did,
          title: dependent?.title ?? '(unknown)',
          status: dependent?.status ?? '(unknown)',
          depth,
        });
        for (const grand of rev[did] ?? []) {
          if (!visitedDown.has(grand)) downQueue.push([grand, depth + 1]);
        }
      }

      return { id: uid, title: node.title ?? '', status: node.status, upstream, downstream };
    },

    async search(query: string, options: DagSearchOptions = {}): Promise<DagSearchHit[]> {
      const { nodes } = await readIdeas();
      const selected: NodeMap = options.activeOnly === true
        ? Object.fromEntries(
            Object.entries(nodes).filter(([, node]) => node.status !== 'completed'),
          )
        : nodes;
      let pattern: RegExp;
      let counter: RegExp;
      try {
        pattern = new RegExp(query, 'i');
        counter = new RegExp(query, 'gi');
      } catch (error) {
        throw new Error(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
      }

      /** A window of twenty characters either side of the first hit; an ellipsis is added at whichever end was cut. */
      const snippet = (description: string): string => {
        const PAD = 20;
        const pos = description.search(pattern);
        const start = Math.max(0, pos - PAD);
        const end = Math.min(description.length, pos + PAD);
        let out = description.slice(start, end);
        if (start > 0) out = `...${out}`;
        if (end < description.length) out = `${out}...`;
        return out;
      };

      const titleHits: DagSearchHit[] = [];
      const descriptionHits: DagSearchHit[] = [];
      for (const [uid, node] of Object.entries(selected)) {
        const title = node.title ?? '';
        const description = node.description ?? '';
        const inTitle = pattern.test(title);
        const inDescription = pattern.test(description);
        if (!inTitle && !inDescription) continue;
        const hit: DagSearchHit = {
          id: uid,
          title,
          status: node.status,
          ready: nodeReady(node, nodes),
        };
        if (description !== '') {
          if (inTitle) hit.description = description;
          else {
            const occurrences = [...description.matchAll(counter)].length;
            hit.description = occurrences >= 2 ? description : snippet(description);
          }
        }
        (inTitle ? titleHits : descriptionHits).push(hit);
      }
      // Title hits come first; the default limit is 5, and a zero or negative one means no ceiling.
      const result = [...titleHits, ...descriptionHits];
      const limit = options.limit ?? 5;
      return limit > 0 ? result.slice(0, limit) : result;
    },

    async list(filter: DagListFilter = {}): Promise<NodeSummary[]> {
      const { nodes } = await readIdeas();

      const selected: NodeMap = {};
      for (const [uid, node] of Object.entries(nodes)) {
        if (filter.status === undefined || filter.status.includes(node.status)) {
          selected[uid] = node;
        }
      }

      // Urgency and importance are computed only on the unfinished subgraph (completed nodes sink); filtering only drops rows, it does not change what the ordering is computed on.
      const notCompleted: NodeMap = {};
      for (const [uid, node] of Object.entries(nodes)) {
        if (node.status !== 'completed') notCompleted[uid] = node;
      }
      const adj = adjacency(notCompleted);
      const urgency = urgencyScores(adj);
      const importance = importanceScores(adj);

      const rows: NodeSummary[] = [];
      for (const [uid, node] of Object.entries(selected)) {
        const status = node.status;
        const blocked = status === 'shelved';
        const entry: NodeSummary = {
          id: uid,
          title: node.title ?? '',
          status,
          mode: node.mode ?? DEFAULT_MODE,
          ready: nodeReady(node, nodes),
        };
        const tags = tagsOf(node);
        if (tags.length > 0) entry.tags = tags;
        if (weightOf(node) === 'light') entry.weight = 'light';
        if (status !== 'completed' && !blocked) {
          entry.urgency_level = urgency[uid] ?? 0;
          entry.importance_score = importance[uid] ?? 0;
        }
        rows.push(entry);
      }

      const wanted = normalizeTags(filter.tags ?? []);
      const filtered = rows
        .filter((entry) => filter.ready !== true || entry.ready)
        .filter((entry) => inTagScope(entry.tags ?? [], wanted));

      // The Eisenhower reading: importance first, urgency after; the ones with no score (completed and shelved) sink.
      filtered.sort(
        (a, b) =>
          (b.importance_score ?? 0) - (a.importance_score ?? 0) ||
          (b.urgency_level ?? 0) - (a.urgency_level ?? 0),
      );

      const limit = filter.limit ?? 0;
      return limit > 0 ? filtered.slice(0, limit) : filtered;
    },

    async specPath(id: string): Promise<string> {
      const { nodes } = await readIdeas();
      const uid = resolveNodeId(id, nodes);
      return specPathOf(paths, uid);
    },

    async validate(): Promise<DagValidationReport> {
      const { nodes } = await readIdeas();
      const total = Object.keys(nodes).length;

      const statusCounts: Record<string, number> = {};
      for (const node of Object.values(nodes)) {
        const status = node.status ?? 'unknown';
        statusCounts[status] = (statusCounts[status] ?? 0) + 1;
      }

      const problems: string[] = [];
      const [hasCycle, cyclePath] = detectCycle(adjacency(nodes));
      if (hasCycle) {
        problems.push(
          `FAIL  check=no_cycles  reason="cycle detected: ${cyclePath.join(' → ')}"  nodes=${total}`,
        );
      }
      const seenEdges = new Set<string>();
      for (const [uid, node] of Object.entries(nodes)) {
        for (const dep of node.dependencies ?? []) {
          if (!(dep in nodes)) {
            problems.push(`FAIL  check=no_dangling  node=${uid}  references=${dep}`);
          }
          const edge = `${uid}->${dep}`;
          if (seenEdges.has(edge)) {
            problems.push(`FAIL  check=no_duplicate_edges  node=${uid}  references=${dep}`);
          }
          seenEdges.add(edge);
        }
      }

      // Isolated nodes: nodes with no dependencies and no dependents. The scope of the spec asks for them to be
      // detectable explicitly, so the spec governs here; they are only named (the isolated field) and the
      // verdict of ok does not change (the completion criteria report FAIL only for cycles / dangling /
      // duplicate edges).
      const isolated: string[] = [];
      const dependentsOf = reverseAdjacency(adjacency(nodes));
      for (const [uid, node] of Object.entries(nodes)) {
        if ((node.dependencies ?? []).length > 0) continue;
        if ((dependentsOf[uid] ?? []).length === 0) isolated.push(uid);
      }

      const report: DagValidationReport = {
        ok: problems.length === 0,
        total,
        status_counts: statusCounts,
        problems,
      };
      if (isolated.length > 0) report.isolated = isolated;
      return report;
    },
  };
}
