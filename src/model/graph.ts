/**
 * The dependency reading: who blocks whom.
 *
 * A node's layer number takes the longest path: it stands one layer to the
 * right of its deepest prerequisite. A dependency pointing at something no
 * longer on the books is skipped here — a prerequisite that cannot be placed
 * blocks nobody; if the data loops back to the node itself, the walk stops
 * there.
 */
import type { DepsReading, GraphEdge, GraphReading, NodeReading } from './contract.ts'

/**
 * Each id's depth: the longest prerequisite path that stays inside `ids`.
 *
 * The one longest-path walk in this repo. A prerequisite outside `ids` is skipped rather than
 * counted — the universe is the caller's, and what it does not hold cannot stand to anyone's left.
 * A loop back to the id itself stops the walk there instead of recursing forever.
 *
 * @param ids - The ids to place, in the caller's own order.
 * @param up - Each id's prerequisites; an id absent from the map has none.
 */
export function depthsOf(ids: readonly string[], up: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const inside = new Set(ids)
  const depth = new Map<string, number>()
  const walking = new Set<string>()

  const walk = (id: string): number => {
    const held = depth.get(id)
    if (held !== undefined) return held
    if (walking.has(id)) return 0
    walking.add(id)
    let deepest = 0
    for (const prerequisite of up.get(id) ?? []) {
      if (!inside.has(prerequisite)) continue
      deepest = Math.max(deepest, walk(prerequisite) + 1)
    }
    walking.delete(id)
    depth.set(id, deepest)
    return deepest
  }

  for (const id of ids) walk(id)
  return depth
}

export function readGraph(nodes: readonly NodeReading[]): GraphReading {
  const depends = new Map<string, readonly string[]>()
  for (const node of nodes) depends.set(node.id, node.dependencies)

  const ids = nodes.map((node) => node.id)
  const depth = depthsOf(ids, depends)

  let maxDepth = -1
  for (const node of nodes) maxDepth = Math.max(maxDepth, depth.get(node.id) ?? 0)

  const layers: NodeReading[][] = []
  for (let level = 0; level <= maxDepth; level += 1) layers.push([])
  for (const node of nodes) layers[depth.get(node.id) ?? 0]?.push(node)

  const edges: GraphEdge[] = []
  for (const node of nodes) {
    const to = node.id
    for (const from of node.dependencies) {
      if (!depends.has(from)) continue
      edges.push({ from, to, span: (depth.get(to) ?? 0) - (depth.get(from) ?? 0) })
    }
  }

  return { layers, maxDepth, edges }
}

/**
 * What a node answers on the dependency field: ready to start, or how many
 * prerequisites are still owed.
 *
 * Ready-to-start trusts only the reading's own value — a running node's state
 * is also `todo` and its owed prerequisites may be down to none; assembling
 * the answer from other fields would print a node currently in someone's
 * hands as ready to start. Completed, running, and shelved nodes owe no such
 * answer and say nothing.
 *
 * The wording is the client's (`src/client/words.ts`): this hands over the two
 * facts and nothing else.
 */
export function readDeps(node: NodeReading): DepsReading | null {
  if (node.ready) return { ready: true, count: null }
  if (node.state !== 'todo' || node.running || node.openDependencies.length === 0) return null
  return { ready: false, count: node.openDependencies.length }
}