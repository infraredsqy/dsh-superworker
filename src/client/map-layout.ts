/**
 * The map's drawing and its camera, as pure functions: no DOM, no React, no clock of its own.
 *
 * The reading comes in whole (nodes + edges) and one placement comes out: which columns there are,
 * where each card sits, what each card owes and what owes it. The camera is the second half — where
 * the drawing stands in a viewport of a given size — and is likewise arithmetic over a placement,
 * so both halves are measured without a browser.
 *
 * Why a placement rather than a force simulation: the same record must give the same picture on
 * every open. The record is split into its dependency islands first and each island is laid out on
 * its own, then the islands are packed as blocks: two cards that owe one another cannot be separated
 * by cards that have nothing to do with them, which is the one thing a reader needs from this
 * drawing. A simulation would drift with every frame, and a reader comparing two sessions would be
 * comparing two layouts.
 */
import type { GraphEdge, NodeReading } from '../model/index.ts'
import { belongsTo, depthsOf, ownersOf, rankOf } from '../model/index.ts'

/** One card's box, in canvas pixels. The sheet draws it from these two numbers, so they are stated once. */
export const CARD_W = 380
export const CARD_H = 96

/** The space between two columns, and between two cards of one column. */
export const COL_GAP = 110
export const ROW_GAP = 52

/** The blank margin around the drawing: without it a card at the edge loses its frame against the page. */
export const PAD = 56

/** The ground kept between two islands of one shelf, and between two shelves. */
export const ISLAND_GAP = 160
export const BAND_GAP = 220

/**
 * How wide one shelf may get before the next island starts a new one. Wide enough for the widest
 * islands this record draws plus one more; past it the overview's shape turns into a ribbon that says
 * nothing about the work, and the reader scrolls sideways for one lonely card.
 */
export const SHELF_LIMIT = 6600

/**
 * How many cards one page draws at most: the triage order's first N, then the focus's own
 * neighbours. A ceiling on what this page can be asked to draw, not on what it can read.
 */
export const CAP = 1000

/**
 * The two sizes at which a card's words can be read, as camera scales. Above the first, the title
 * is legible; above the second, the caption row is too. Below them the card keeps its box and its
 * frame, and the words leave — the same drawing, read from further away.
 */
export const TITLE_AT = 0.62
export const FULL_AT = 0.92

export const SCALE_MIN = 0.1
export const SCALE_MAX = 2.4

/** How close the camera stands to the focus: a card's title lands around 24px on screen. */
export const FOCUS_SCALE = 1.2

/** The margin kept around the focused card when the viewport is too small for it at {@link FOCUS_SCALE}. */
const FOCUS_MARGIN = 48

/**
 * How long a column may get before the ordering drops the adjacent-swap pass and keeps only the
 * barycentre order. The swap pass is what untangles a small crowded column; past this size it is the
 * barycentre alone that decides, and the swaps would only cost time.
 */
const TRANSPOSE_LIMIT = 40

/** How many sweeps the row solver takes, and how many times the columns are re-ordered against it. */
const ROW_ROUNDS = 60
const OUTER_ROUNDS = 3

export interface Point {
  readonly x: number
  readonly y: number
}

export interface Size {
  readonly w: number
  readonly h: number
}

/** The camera: a scale and where the drawing's origin lands. */
export interface View {
  readonly s: number
  readonly tx: number
  readonly ty: number
}

/** What one page holds once placed: the cards, where they sit, and who owes whom among them. */
export interface Placement {
  /** The cards drawn, in the order the page ranks them. */
  readonly drawn: readonly NodeReading[]
  /** The drawing's columns, left to right, by the order they sit on the page. Ids, top to bottom. */
  readonly columns: readonly (readonly string[])[]
  /** Where each drawn card's centre sits. */
  readonly pos: Readonly<Record<string, Point>>
  /** The drawing's own box, margin included. */
  readonly width: number
  readonly height: number
  /** Each card's prerequisites, restricted to the drawn set. */
  readonly up: Readonly<Record<string, readonly string[]>>
  /** Each card's dependents, restricted to the drawn set. */
  readonly down: Readonly<Record<string, readonly string[]>>
}

export interface PlaceInput {
  readonly nodes: readonly NodeReading[]
  readonly edges: readonly GraphEdge[]
  /** How many cards to draw at most; {@link CAP} when absent. */
  readonly cap?: number | undefined
  /** The card in focus: it and its direct neighbours are always drawn, capped or not. */
  readonly focus?: string | null | undefined
}

/**
 * The triage order: rank first, the more recent moment next, and the record's own order last so
 * that two cards of one rank and one moment never swap places between opens.
 *
 * The rank is the model's ({@link rankOf}: an order over the one bucket), and the moment is the
 * reading's own `stampAt`: which moment of a card is news is judged in the model, not here. What is
 * this page's own rule is the consequence — open work outranks delivered work. The map answers "what
 * wants a hand now"; a page whose first column is 155 delivered cards answers yesterday's question
 * in yesterday's order, and the four cards that still owe someone something read as the tail.
 */
export function rankedOf(nodes: readonly NodeReading[]): readonly NodeReading[] {
  const recordOrder = new Map(nodes.map((node, index) => [node.id, index]))
  return [...nodes].sort((left, right) => rankOf(left) - rankOf(right)
    || (right.stampAt?.getTime() ?? 0) - (left.stampAt?.getTime() ?? 0)
    || (recordOrder.get(left.id) ?? 0) - (recordOrder.get(right.id) ?? 0))
}

/** Who owes whom, both ways, over the given edges. */
function neighboursOf(edges: readonly GraphEdge[]): {
  readonly up: Map<string, string[]>
  readonly down: Map<string, string[]>
} {
  const up = new Map<string, string[]>()
  const down = new Map<string, string[]>()
  const push = (into: Map<string, string[]>, key: string, value: string): void => {
    const held = into.get(key)
    if (held === undefined) into.set(key, [value])
    else if (!held.includes(value)) held.push(value)
  }
  for (const edge of edges) {
    push(up, edge.to, edge.from)
    push(down, edge.from, edge.to)
  }
  return { up, down }
}

/**
 * The islands of the drawing: one set per connected component of the dependency edges.
 *
 * A card that owes nothing and is owed nothing is an island of one. That is not a degenerate case:
 * an item nobody has linked yet is exactly the work that is waiting for someone to say where it
 * belongs, and it belongs on the page on its own rather than hung off a stranger's row.
 */
function islandsOf(ids: readonly string[], edges: readonly GraphEdge[]): string[][] {
  const parent = new Map(ids.map((id) => [id, id]))
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    let walk = id
    while (parent.get(walk) !== root) {
      const next = parent.get(walk) as string
      parent.set(walk, root)
      walk = next
    }
    return root
  }
  for (const edge of edges) {
    if (!parent.has(edge.from) || !parent.has(edge.to)) continue
    const left = find(edge.from)
    const right = find(edge.to)
    if (left !== right) parent.set(left, right)
  }
  const groups = new Map<string, string[]>()
  for (const id of ids) {
    const root = find(id)
    const held = groups.get(root)
    if (held === undefined) groups.set(root, [id])
    else held.push(id)
  }
  return [...groups.values()]
}

/* Islands are laid out on their own, so "how deep inside this island" is asked of one island at a
 * time: the model's longest-path walk ({@link depthsOf}) with the island's members as the universe.
 * A prerequisite the island is not drawing is skipped there, which is what the columns mean — how
 * far from this island's left edge a card stands, not how far down the whole record it is. */

/** The middle of a set of rows, or `null` when the card has no neighbour to follow. */
function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const half = sorted.length >> 1
  return sorted.length % 2 === 1 ? (sorted[half] as number) : ((sorted[half - 1] as number) + (sorted[half] as number)) / 2
}

/** One island laid out on its own: where its cards sit, and the box they fill. */
interface Island {
  readonly pos: Readonly<Record<string, Point>>
  readonly width: number
  readonly height: number
  /** How many of its cards still owe someone something. */
  readonly open: number
}

/**
 * Lay one island out in its own columns and rows, from its own top-left corner.
 *
 * Columns are depth, as everywhere on this page: a card stands one column right of its deepest
 * prerequisite. Rows are the thing this island is free to decide: the order is seeded from the
 * triage and then straightened by alternating passes over the neighbours, and every card then takes
 * the median row of its neighbours, held inside the room its own column leaves it. That second pass
 * is a coordinate descent on the total vertical wire length, so it can only shorten the island, and
 * a solved row is why two cards that owe one another end up on one line instead of on whatever rows
 * the triage happened to hand them.
 */
function layoutIsland(
  members: readonly string[],
  edges: readonly GraphEdge[],
  up: ReadonlyMap<string, readonly string[]>,
  down: ReadonlyMap<string, readonly string[]>,
  rank: ReadonlyMap<string, number>,
  open: ReadonlySet<string>,
): Island {
  const inside = new Set(members)
  const wires = edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to))
  const depth = depthsOf(members, up)

  const layers: string[][] = []
  for (const id of members) {
    const at = depth.get(id) ?? 0
    while (layers.length <= at) layers.push([])
    ;(layers[at] as string[]).push(id)
  }

  /* The order: seed by the triage, then let each column follow the mean position of its neighbours,
   * alternating direction, taking any adjacent swap that removes a crossing. */
  const position = new Map<string, number>()
  const sync = (layer: readonly string[]): void => {
    const span = Math.max(1, layer.length - 1)
    layer.forEach((id, at) => position.set(id, at / span))
  }
  const orderBy = (layer: string[], toward: 'up' | 'down'): void => {
    const keyed = layer.map((id, at) => {
      const near = ((toward === 'up' ? up.get(id) : down.get(id)) ?? [])
        .filter((other) => inside.has(other))
        .map((other) => position.get(other))
        .filter((value) => value !== undefined)
      /* A card with no neighbour in that direction keeps where it stands, which is what lets the
       * passes converge instead of swapping a pair back and forth forever. */
      const mean = near.length > 0
        ? near.reduce((sum, value) => sum + value, 0) / near.length
        : (position.get(id) ?? at)
      return { id, mean, at }
    })
    keyed.sort((left, right) => left.mean - right.mean || left.at - right.at)
    layer.splice(0, layer.length, ...keyed.map((entry) => entry.id))
    sync(layer)
  }
  const crossings = (left: readonly string[], right: readonly string[]): number => {
    const order = new Map(right.map((id, at) => [id, at]))
    let count = 0
    for (let i = 0; i < left.length; i += 1) {
      for (let j = i + 1; j < left.length; j += 1) {
        for (const a of down.get(left[i] as string) ?? []) {
          for (const b of down.get(left[j] as string) ?? []) {
            if ((order.get(a) ?? 0) > (order.get(b) ?? 0)) count += 1
          }
        }
      }
    }
    return count
  }
  const transpose = (layer: string[], other: readonly string[] | undefined): void => {
    if (other === undefined) return
    /* The adjacent-swap pass costs one crossing count per pair, and a crossing count is quadratic in
     * the layer, so a long column makes it cubic. Past {@link TRANSPOSE_LIMIT} the barycentre order
     * is the whole ordering: it is the pass that does the work at that size, and a layoff of a second
     * on every open is not worth the last few crossings. */
    if (layer.length > TRANSPOSE_LIMIT) return
    for (let i = 0; i + 1 < layer.length; i += 1) {
      const before = crossings(layer, other)
      const held = layer[i] as string
      layer[i] = layer[i + 1] as string
      layer[i + 1] = held
      if (crossings(layer, other) >= before) {
        const back = layer[i] as string
        layer[i] = layer[i + 1] as string
        layer[i + 1] = back
      } else {
        sync(layer)
      }
    }
  }

  for (const layer of layers) layer.sort((left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0))
  layers.forEach(sync)
  for (let index = 1; index < layers.length; index += 1) {
    orderBy(layers[index] as string[], 'up')
    transpose(layers[index - 1] as string[], layers[index])
  }
  for (let pass = 0; pass < 6; pass += 1) {
    if (pass % 2 === 0) {
      for (let index = 1; index < layers.length; index += 1) {
        orderBy(layers[index] as string[], 'up')
        transpose(layers[index - 1] as string[], layers[index])
      }
    } else {
      for (let index = layers.length - 2; index >= 0; index -= 1) {
        orderBy(layers[index] as string[], 'down')
        transpose(layers[index + 1] as string[], layers[index])
      }
    }
  }

  const row = new Map<string, number>()
  let rows = 1
  const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))
  const resetRows = (): void => {
    rows = 1
    for (const layer of layers) rows = Math.max(rows, layer.length)
    for (const layer of layers) {
      const off = Math.round((rows - layer.length) / 2)
      layer.forEach((id, at) => row.set(id, off + at))
    }
  }
  const solveRows = (rounds: number): void => {
    for (let round = 0; round < rounds; round += 1) {
      const forward = round % 2 === 0
      const from = forward ? 1 : layers.length - 2
      const to = forward ? layers.length : -1
      const step = forward ? 1 : -1
      for (let index = from; index !== to; index += step) {
        const layer = layers[index] as string[]
        for (let at = 0; at < layer.length; at += 1) {
          const id = layer[at] as string
          const near = [...(up.get(id) ?? []), ...(down.get(id) ?? [])]
            .filter((other) => inside.has(other))
            .map((other) => row.get(other))
            .filter((value) => value !== undefined)
          const want = medianOf(near)
          if (want === null) continue
          const low = at > 0 ? (row.get(layer[at - 1] as string) ?? 0) + 1 : -Infinity
          const high = at < layer.length - 1 ? (row.get(layer[at + 1] as string) ?? 0) - 1 : Infinity
          row.set(id, clamp(Math.round(want), low, high))
        }
      }
    }
  }
  const orderByRows = (): void => {
    for (const layer of layers) {
      const values = layer.map((id) => row.get(id) ?? 0)
      const low = Math.min(...values)
      const high = Math.max(...values)
      for (const id of layer) position.set(id, high > low ? ((row.get(id) ?? 0) - low) / (high - low) : 0.5)
    }
    for (let index = 1; index < layers.length; index += 1) {
      orderBy(layers[index] as string[], 'up')
      transpose(layers[index - 1] as string[], layers[index])
    }
    for (let index = layers.length - 2; index >= 0; index -= 1) {
      orderBy(layers[index] as string[], 'down')
      transpose(layers[index + 1] as string[], layers[index])
    }
  }

  const pitch = CARD_H + ROW_GAP
  const cost = (): number => wires.reduce((sum, edge) => sum + Math.abs((row.get(edge.to) ?? 0) - (row.get(edge.from) ?? 0)), 0)
  resetRows()
  solveRows(ROW_ROUNDS)
  /* Re-ordering the columns against the rows the solver found, then solving again, is what lets a
   * crowded island untangle itself instead of keeping the order its seed gave it. Three rounds, and
   * the cheapest drawing of the four is the one kept. */
  let best = { cost: cost(), rows: new Map(row) }
  for (let round = 0; round < OUTER_ROUNDS; round += 1) {
    orderByRows()
    resetRows()
    solveRows(ROW_ROUNDS)
    const now = cost()
    if (now < best.cost) best = { cost: now, rows: new Map(row) }
  }
  if (best.cost < cost()) {
    row.clear()
    for (const [id, value] of best.rows) row.set(id, value)
  }

  let top = Infinity
  for (const value of row.values()) top = Math.min(top, value)
  const pos: Record<string, Point> = {}
  let used = 1
  for (const id of members) {
    const at = (row.get(id) ?? 0) - top
    used = Math.max(used, at + 1)
    pos[id] = {
      x: (depth.get(id) ?? 0) * (CARD_W + COL_GAP) + CARD_W / 2,
      y: at * pitch + CARD_H / 2,
    }
  }

  return {
    pos,
    width: layers.length * CARD_W + (layers.length - 1) * COL_GAP,
    height: (used - 1) * pitch + CARD_H,
    open: members.filter((id) => open.has(id)).length,
  }
}

/**
 * Place the drawing.
 *
 * The record is cut into its dependency islands, each island is laid out on its own, and the islands
 * are packed as blocks. The horizontal axis inside an island is one the record really has — a card
 * stands one column right of its deepest prerequisite — and the vertical axis is typography. What
 * the packing changes is that the two axes now describe one island at a time: an island's rows are
 * not lent to another island's cards, so a chain reads as a chain however much unrelated work the
 * record holds.
 *
 * Islands that still hold open work stand above the finished ones. The page is read from the top
 * left, and the top of the page is where someone is wanted.
 */
export function place(input: PlaceInput): Placement {
  const cap = input.cap ?? CAP
  const focus = input.focus ?? null
  const { up, down } = neighboursOf(input.edges)
  const ranked = rankedOf(input.nodes)

  /* The drawn set: the triage order's first N, then the focus and its direct neighbours — a card in
   * focus whose prerequisite is outside the cap would otherwise hang on nothing. */
  const drawn: NodeReading[] = ranked.slice(0, cap)
  const have = new Set(drawn.map((node) => node.id))
  if (focus !== null && !have.has(focus)) {
    const held = input.nodes.find((node) => node.id === focus)
    if (held !== undefined) {
      drawn.unshift(held)
      have.add(held.id)
    }
  }
  if (focus !== null) {
    for (const id of [...(up.get(focus) ?? []), ...(down.get(focus) ?? [])]) {
      if (have.has(id)) continue
      const held = input.nodes.find((node) => node.id === id)
      if (held === undefined) continue
      drawn.unshift(held)
      have.add(held.id)
    }
  }

  const inside = new Set(drawn.map((node) => node.id))
  const wires = input.edges.filter((edge) => inside.has(edge.from) && inside.has(edge.to))
  const rank = new Map(ranked.map((node, index) => [node.id, index]))
  const open = new Set(drawn.filter((node) => node.state !== 'completed').map((node) => node.id))

  const islands = islandsOf(drawn.map((node) => node.id), wires)
    .map((members) => layoutIsland(members, wires, up, down, rank, open))
    .sort((left, right) => (right.open > 0 ? 1 : 0) - (left.open > 0 ? 1 : 0)
      || right.open - left.open
      || right.width * right.height - left.width * left.height)

  /* Shelves: open islands take the top ones, finished islands fill the rest. A shelf holds one kind
   * only — a delivered island sitting in an open island's shelf would lend the live work a row it is
   * not part of, which is the whole thing this placement is avoiding. */
  const shelves: Island[][] = []
  let shelf: { width: number; open: boolean; items: Island[] } | null = null
  for (const island of islands) {
    const isOpen = island.open > 0
    if (shelf === null || shelf.open !== isOpen || shelf.width + ISLAND_GAP + island.width > SHELF_LIMIT) {
      shelf = { width: island.width, open: isOpen, items: [island] }
      shelves.push(shelf.items)
    } else {
      shelf.width += ISLAND_GAP + island.width
      shelf.items.push(island)
    }
  }

  const pos: Record<string, Point> = {}
  let top = PAD
  let width = PAD * 2 + CARD_W
  for (const items of shelves) {
    let x = PAD
    let tall = 0
    for (const island of items) {
      for (const [id, at] of Object.entries(island.pos)) pos[id] = { x: x + at.x, y: top + at.y }
      x += island.width + ISLAND_GAP
      tall = Math.max(tall, island.height)
    }
    width = Math.max(width, x - ISLAND_GAP + PAD)
    top += tall + BAND_GAP
  }
  const height = Math.max(PAD * 2 + CARD_H, top - BAND_GAP + PAD)

  /* The columns the drawing reads in: one per distinct x, top to bottom. Islands share no x axis, so
   * a column can hold cards from one island only; this is the shape a reader sees, not a grid. */
  const byX = new Map<number, { id: string; y: number }[]>()
  for (const [id, point] of Object.entries(pos)) {
    const held = byX.get(point.x)
    if (held === undefined) byX.set(point.x, [{ id, y: point.y }])
    else held.push({ id, y: point.y })
  }
  const columns = [...byX.keys()].sort((left, right) => left - right)
    .map((x) => (byX.get(x) ?? []).sort((left, right) => left.y - right.y).map((entry) => entry.id))

  return {
    drawn,
    columns,
    pos,
    width,
    height,
    /* Restricted to what is drawn: the emphasis set and the wire set are both read off this. */
    up: Object.fromEntries([...up].filter(([id]) => pos[id] !== undefined).map(([id, list]) => [id, list.filter((other) => pos[other] !== undefined)])),
    down: Object.fromEntries([...down].filter(([id]) => pos[id] !== undefined).map(([id, list]) => [id, list.filter((other) => pos[other] !== undefined)])),
  }
}

/** One wire: from the right edge of a prerequisite to the left edge of what waits on it. */
export function wirePath(from: Point, to: Point): string {
  const x1 = from.x + CARD_W / 2
  const x2 = to.x - CARD_W / 2
  const bend = Math.max(36, (x2 - x1) * 0.5)
  return `M${String(x1)} ${String(from.y)}C${String(x1 + bend)} ${String(from.y)},${String(x2 - bend)} ${String(to.y)},${String(x2)} ${String(to.y)}`
}

/**
 * How loudly each card speaks on this page.
 *
 * `lit` is the reading the page is about; `ahead` is the one step below it, and exists only once a
 * line is picked. No card outside a picked line wears a frame: a frame is this card's own state, and
 * a reader who asked for one line would otherwise hear every other line's state just as loudly. So
 * the ranks are carried by ink and ground instead — the picked line in full, the work no line has
 * picked up yet in the middle (it is still the future this line may lead to), everything else dim.
 */
export interface Emphasis {
  /** Full ink: the focus's ring, or every card the picked line has touched — the one in its hand included. */
  readonly lit: ReadonlySet<string>
  /** One step down: cards no line has picked up yet. Empty unless a line is picked. */
  readonly ahead: ReadonlySet<string>
}

/**
 * What the page holds in ink, at one scope.
 *
 * With the whole workspace in scope, this is the focus and its ring plus every gate: the triage's own
 * reading. With one line picked, the line's own cards are the reading, and a gate on another line is
 * not: the reader asked for this line. The one exception is the card the reader pressed — it stays in
 * ink wherever it belongs, because a press that changes nothing on the card the reader is looking at
 * would be a control that does not answer.
 */
export function emphasisOf(placement: Placement, focus: string | null, scope: string | null): Emphasis {
  if (scope === null) {
    const lit = new Set<string>()
    if (focus !== null && placement.pos[focus] !== undefined) {
      lit.add(focus)
      for (const id of placement.up[focus] ?? []) lit.add(id)
      for (const id of placement.down[focus] ?? []) lit.add(id)
    }
    for (const node of placement.drawn) {
      if (node.gate !== null) lit.add(node.id)
    }
    return { lit, ahead: new Set<string>() }
  }

  const lit = new Set<string>()
  const ahead = new Set<string>()
  for (const node of placement.drawn) {
    /* Whether this card belongs to the picked line is the model's one answer (`belongsTo`: every
     * line that has walked it, a re-run included, or the line holding it now) — the same criterion
     * the detail's sections and the line's own parked count read. `ahead` stays "no line has picked
     * up yet". */
    if (belongsTo(node, scope)) lit.add(node.id)
    else if (ownersOf(node).length === 0 && node.id !== focus) ahead.add(node.id)
  }
  if (focus !== null && placement.pos[focus] !== undefined) lit.add(focus)
  return { lit, ahead }
}

/**
 * The camera that keeps the drawing inside the viewport: a drawing smaller than the viewport is
 * centred on it, a larger one is held against its edges.
 *
 * Without this, a focus near the drawing's edge leaves half the viewport showing nothing, and a
 * reader who sees an empty ground concludes the drawing is gone.
 */
export function clampView(view: View, size: Size, placement: Placement): View {
  const width = placement.width * view.s
  const height = placement.height * view.s
  const tx = width <= size.w ? (size.w - width) / 2 : Math.min(0, Math.max(size.w - width, view.tx))
  const ty = height <= size.h ? (size.h - height) / 2 : Math.min(0, Math.max(size.h - height, view.ty))
  return tx === view.tx && ty === view.ty ? view : { s: view.s, tx, ty }
}

/** The range one axis of the camera may travel, in screen pixels. */
export interface Bounds {
  readonly minX: number
  readonly maxX: number
  readonly minY: number
  readonly maxY: number
}

/**
 * Where a camera the reader moves may stand: the drawing's own edges, or as far as it takes to put
 * the first or last card on either axis in the middle of the viewport.
 *
 * The second term is the whole point. A drawing taller than its viewport has its first card a short
 * way down, and holding the camera at the drawing's edge leaves that card permanently above the
 * middle: the reader pulls and the page stops. Letting the drawing travel until its edge card is
 * centred is what makes every card reachable without a zoom-out-and-back-in dance, and the term is
 * scaled by the camera, so zoomed in it is a small part of the viewport and zoomed out it is a nudge.
 *
 * A card is a box, not a point: the reach is measured to its centre, and never past the middle of
 * the viewport — a wide viewport does not hand the drawing a half-screen of travel for free.
 */
export function panBounds(size: Size, placement: Placement, s: number): Bounds {
  const width = placement.width * s
  const height = placement.height * s
  const edgeX = Math.min(PAD + CARD_W / 2, placement.width / 2, size.w / 2) * s
  const edgeY = Math.min(PAD + CARD_H / 2, placement.height / 2, size.h / 2) * s
  return {
    minX: Math.min(size.w - width, size.w / 2 - width + edgeX),
    maxX: Math.max(0, size.w / 2 - edgeX),
    minY: Math.min(size.h - height, size.h / 2 - height + edgeY),
    maxY: Math.max(0, size.h / 2 - edgeY),
  }
}

/** The camera held inside {@link panBounds}: where a drag comes to rest. */
export function panView(view: View, size: Size, placement: Placement): View {
  const box = panBounds(size, placement, view.s)
  const tx = Math.min(box.maxX, Math.max(box.minX, view.tx))
  const ty = Math.min(box.maxY, Math.max(box.minY, view.ty))
  return tx === view.tx && ty === view.ty ? view : { s: view.s, tx, ty }
}

/**
 * How far past an edge a drag may still pull, as a fraction of the viewport, and how much of the
 * pull it gives back before that. The page is elastic but not soft: past the edge it gives a little,
 * then holds, and the moment the pointer lets go it comes back to the edge. A hard stop reads as
 * "the page is finished"; this reads as "the edge is there".
 */
export const RUBBER_REACH = 0.22
export const RUBBER_GIVE = 0.55

/** One axis of a pull past its end: linear while it is small, asymptotic as it grows, so it never
 * goes further than the reach however fast the pointer throws the page. */
function rubber(over: number, reach: number): number {
  return (over * reach * RUBBER_GIVE) / (reach + over * RUBBER_GIVE)
}

/** The camera during a drag: held inside {@link panBounds}, and past it by {@link rubber}'s damped give. */
export function rubberView(view: View, size: Size, placement: Placement): View {
  const box = panBounds(size, placement, view.s)
  const reachX = size.w * RUBBER_REACH
  const reachY = size.h * RUBBER_REACH
  const tx = view.tx > box.maxX
    ? box.maxX + rubber(view.tx - box.maxX, reachX)
    : view.tx < box.minX ? box.minX - rubber(box.minX - view.tx, reachX) : view.tx
  const ty = view.ty > box.maxY
    ? box.maxY + rubber(view.ty - box.maxY, reachY)
    : view.ty < box.minY ? box.minY - rubber(box.minY - view.ty, reachY) : view.ty
  return tx === view.tx && ty === view.ty ? view : { s: view.s, tx, ty }
}

/** The whole drawing, small enough to fit: the overview. */
export function fitView(size: Size, placement: Placement): View {
  const s = Math.max(SCALE_MIN, Math.min(1, Math.min(size.w / placement.width, size.h / placement.height) * 0.96))
  return clampView({ s, tx: (size.w - placement.width * s) / 2, ty: (size.h - placement.height * s) / 2 }, size, placement)
}

/**
 * The camera at the focus: the focused card itself in the middle of the viewport, at
 * {@link FOCUS_SCALE}.
 *
 * The card is aimed at, not its ring: a ring is one prerequisite and three dependents as often as it
 * is symmetrical, so aiming at its middle leaves the card the reader pressed standing wherever the
 * arithmetic happens to put it — and the same card would land in a different spot from one open to
 * the next. What is around the card stays around it: the lit cards and their wires say what it is
 * owed and owes, and whatever does not fit is cut at the page's faded edge, to be found again by a
 * drag or a zoom.
 *
 * The camera is held by {@link panView}, not by the drawing's own edges: the page travels as far as
 * it takes to put this card in the middle, which is the same reach a drag answers to. Held to the
 * drawing's edge instead, a card near the top of a tall drawing opens in the top band of the
 * viewport — the one card the reader asked for, delivered in a corner.
 *
 * The card is shrunk only when the viewport cannot hold it whole at that scale, so what the reader
 * came to look at is never a card cut in half by the frame's own edge.
 */
export function focusView(size: Size, placement: Placement, focus: string | null): View {
  const at = focus === null ? undefined : placement.pos[focus]
  if (focus === null || at === undefined) return fitView(size, placement)

  const roomy = Math.min(FOCUS_SCALE, (size.w - FOCUS_MARGIN) / CARD_W, (size.h - FOCUS_MARGIN) / CARD_H)
  const s = Math.max(SCALE_MIN, roomy)
  return panView({ s, tx: size.w / 2 - at.x * s, ty: size.h / 2 - at.y * s }, size, placement)
}

/**
 * Zoom one step around a point of the viewport: the ground under that point stays under it.
 *
 * Zooming around the viewport's centre instead would slide whatever the reader was looking at out
 * from under the pointer, which is the one thing a wheel is expected not to do.
 */
export function zoomAt(view: View, at: Point, next: number): View {
  const s = Math.max(SCALE_MIN, Math.min(SCALE_MAX, next))
  return {
    s,
    tx: at.x - (at.x - view.tx) * (s / view.s),
    ty: at.y - (at.y - view.ty) * (s / view.s),
  }
}

/** Which words a card shows at this camera scale. */
export type Lod = 'dot' | 'mid' | 'full'

export function lodOf(s: number): Lod {
  if (s < TITLE_AT) return 'dot'
  if (s < FULL_AT) return 'mid'
  return 'full'
}

