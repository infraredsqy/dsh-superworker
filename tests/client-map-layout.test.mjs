/* The map's placement and its camera (src/client/map-layout.ts): behaviour only — which card comes
 * first, which island a card lands in and on which row, where the camera stands, which cards stay in
 * ink. No snapshots, no pixel values beyond the geometry the engine states itself.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readProject } from '../src/model/index.ts'
import { node, record } from './helpers/record-fixtures.mjs'
import {
  CARD_H,
  CARD_W,
  COL_GAP,
  FOCUS_SCALE,
  ISLAND_GAP,
  PAD,
  ROW_GAP,
  TITLE_AT,
  clampView,
  emphasisOf,
  fitView,
  focusView,
  lodOf,
  panBounds,
  panView,
  place,
  rankedOf,
  rubberView,
  wirePath,
  zoomAt,
} from '../src/client/map-layout.ts'

/** The reading a case starts from, cut at the fixture's moment. */
function readingOf(parts) {
  return readProject(record(parts))
}

/** The drawn ids of one placement, column by column. */
const columnsOf = (placement) => placement.columns.map((column) => [...column])

/**
 * A drawing stated by hand: a grid of `w` columns by `h` rows on the page's own pitch.
 *
 * The camera tests ask where a camera stands over a drawing of a given size, and nothing about how
 * the record became that drawing. Building the placement directly keeps those two questions apart,
 * so a change in the placement rules cannot quietly rewrite what a camera test was measuring.
 */
function grid(w, h) {
  const pos = {}
  const columns = []
  for (let c = 0; c < w; c += 1) {
    const column = []
    for (let r = 0; r < h; r += 1) {
      const id = `c${String(c)}r${String(r)}`
      column.push(id)
      pos[id] = { x: PAD + c * (CARD_W + COL_GAP) + CARD_W / 2, y: PAD + r * (CARD_H + ROW_GAP) + CARD_H / 2 }
    }
    columns.push(column)
  }
  return {
    drawn: [],
    columns,
    pos,
    width: PAD * 2 + w * CARD_W + (w - 1) * COL_GAP,
    height: PAD * 2 + h * CARD_H + (h - 1) * ROW_GAP,
    up: {},
    down: {},
  }
}

test('triage: a gate waiting on someone first, then in hand, ready, still waiting, settled last', () => {
  const reading = readingOf({
    nodes: {
      waiting: node({ dependencies: ['pending'] }),
      pending: node(),
      ready: node(),
      done: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      held: node(),
      gate: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [{ id: 'w', status: 'active', holding: [{ id: 'held', since: '2026-03-10T08:00:00.000Z' }], path: [] }],
  })

  assert.deepEqual(
    rankedOf(reading.nodes).map((item) => item.id),
    ['gate', 'held', 'pending', 'ready', 'waiting', 'done'],
    'the human gate first, in hand second, ready third, waiting fourth, delivered last: the map answers "who still owes" first',
  )
})

test('triage: within a rank, the most recent moment first; the same moment keeps the record\'s own order', () => {
  const reading = readingOf({
    nodes: {
      older: node({ completed_at: '2026-03-10T08:00:00.000Z' }),
      newest: node({ completed_at: '2026-03-10T11:00:00.000Z' }),
      middle: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      twinA: node(),
      twinB: node(),
    },
  })

  assert.deepEqual(
    rankedOf(reading.nodes).map((item) => item.id),
    ['twinA', 'twinB', 'newest', 'middle', 'older'],
    'not started sorts before delivered; within the delivered rank, moments run newest first, and cells with no moment keep the order the record gave',
  )
})

/* The card's own moment is no longer asked here: which moment a card speaks of is the model's
 * `stampAt` (pinned in `model-reading`), and this page only orders by it. */

test('an empty page: no cell, or one cell, gets a placement right away, no spinning', () => {
  const empty = place({ nodes: [], edges: [] })

  assert.deepEqual(empty.columns, [])
  assert.equal(empty.drawn.length, 0)
  assert.equal(empty.width, PAD * 2 + CARD_W, 'an empty page still has one cell of width, so the camera has somewhere to land')

  const reading = readingOf({ nodes: { only: node() } })
  assert.deepEqual(columnsOf(place({ nodes: reading.nodes, edges: [] })), [['only']])
})

test('columns: a cell\'s depth is its deepest prerequisite plus one; a prerequisite the record lacks takes no column', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      deep: node({ dependencies: ['root'] }),
      orphan: node({ dependencies: ['gone', 'root'] }),
    },
  })

  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  assert.deepEqual(columnsOf(placement), [['root'], ['deep', 'orphan']], 'both owe only root, both stand in the second column')
})

test('placement: the first column sits on the left padding, one cell per slot, one cell of space between columns', () => {
  const reading = readingOf({ nodes: { a: node(), b: node({ dependencies: ['a'] }) } })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.deepEqual(placement.pos['a'], { x: PAD + CARD_W / 2, y: PAD + CARD_H / 2 })
  assert.deepEqual(placement.pos['b'], { x: PAD + CARD_W + COL_GAP + CARD_W / 2, y: PAD + CARD_H / 2 })
  assert.equal(placement.width, PAD * 2 + CARD_W * 2 + COL_GAP)
  assert.equal(placement.height, PAD * 2 + CARD_H)
})

test('placement: a short column centers in its own height, not pinned to the top row', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      one: node({ dependencies: ['root'] }),
      two: node({ dependencies: ['root'] }),
      three: node({ dependencies: ['root'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.equal(placement.pos['root'].y, placement.pos['two'].y, 'one cell in the column, standing in the middle of the three-cell column')
  assert.ok(placement.pos['one'].x > placement.pos['root'].x, 'all three are in the right-hand column')
  assert.equal(placement.height, PAD * 2 + CARD_H * 3 + ROW_GAP * 2, 'the drawing height is set by the longest column')
})

test('islands: cards owing each other nothing do not crowd into one slot, each island keeps its own lane', () => {
  const reading = readingOf({
    nodes: {
      a: node(),
      b: node({ dependencies: ['a'] }),
      c: node(),
      d: node({ dependencies: ['c'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const ids = Object.keys(placement.pos)

  for (const left of ids) {
    for (const right of ids) {
      if (left === right) continue
      const dx = Math.abs(placement.pos[left].x - placement.pos[right].x)
      const dy = Math.abs(placement.pos[left].y - placement.pos[right].y)
      assert.ok(dx >= CARD_W - 1e-9 || dy >= CARD_H - 1e-9, `${left} and ${right} do not overlap`)
    }
  }

  /* The two chains have nothing between them, so the second starts a whole island's ground to the
   * right of the first instead of renting rows off it. */
  assert.equal(placement.pos['c'].x - placement.pos['a'].x, CARD_W * 2 + COL_GAP + ISLAND_GAP,
    'exactly one island gap of ground between the two islands, no more, no less')
  assert.equal(placement.pos['c'].y, placement.pos['a'].y, 'the two-cell islands each get a row, neither waits on the other')
})

test('islands: an island that still owes work sorts above one that is all delivered', () => {
  const reading = readingOf({
    nodes: {
      settled: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      open: node(),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.ok(placement.pos['open'].y < placement.pos['settled'].y, 'the upper band is the one still owing work')
})

test('row solving: cells of one chain land on the same row, no edge runs diagonally', () => {
  const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']
  const reading = readingOf({
    nodes: Object.fromEntries(ids.map((id, index) => [id, node(index === 0 ? {} : { dependencies: [ids[index - 1]] })])),
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  for (const edge of reading.graph.edges) {
    assert.equal(placement.pos[edge.from].y, placement.pos[edge.to].y, `${edge.from} → ${edge.to} is a flat line`)
  }
  assert.equal(placement.height, PAD * 2 + CARD_H, 'seven slots in one line, so the drawing is one cell high')
})

test('cap: only the first N cells can be drawn, and the focus with its direct neighbours is always on the drawing', () => {
  const reading = readingOf({
    nodes: {
      first: node(),
      second: node(),
      third: node(),
      fourth: node({ dependencies: ['third'] }),
    },
  })
  const withFocus = place({ nodes: reading.nodes, edges: reading.graph.edges, cap: 1, focus: 'fourth' })
  const ids = withFocus.drawn.map((item) => item.id).sort()
  assert.deepEqual(ids, ['first', 'fourth', 'third'], 'the capped cells are still drawn; the focus is added in, and so is the cell it owes')
  assert.ok(withFocus.pos['fourth'].x > withFocus.pos['third'].x, 'an added cell still takes its own column')
})

test('wires: out of the previous cell\'s right edge, into the next cell\'s left edge', () => {
  const path = wirePath({ x: 100, y: 40 }, { x: 600, y: 90 })
  const pieces = path.split(',')

  assert.match(path, /^M(\d+(\.\d+)?) 40C/u)
  assert.equal(path.slice(1).split(' ')[0], String(100 + CARD_W / 2), 'the start is the prerequisite cell\'s right edge')
  assert.equal(pieces[pieces.length - 1].trim().split(' ')[0], String(600 - CARD_W / 2), 'the end is the waiting cell\'s left edge')
})

test('inking: the focus, what it owes, what owes it, plus its own hit scope', () => {
  const reading = readingOf({
    nodes: {
      before: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      focus: node({ dependencies: ['before'] }),
      after: node({ dependencies: ['focus'] }),
      elsewhere: node(),
      gate: node({ mode: 'manual', status: 'todo' }),
    },
    cycles: [{ id: 'w', path: [{ node: 'elsewhere', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }] }],
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const global = emphasisOf(placement, 'focus', null)

  assert.deepEqual([...global.lit].sort(), ['after', 'before', 'focus', 'gate'].sort(),
    'the global kind lights the whole workspace\'s human gates, plus the focus and its direct neighbours')
  assert.equal(global.ahead.size, 0, 'global has no "future nodes" kind')

  const scoped = emphasisOf(placement, 'focus', 'w')
  assert.deepEqual([...scoped.lit].sort(), ['focus', 'elsewhere'].sort(),
    'with a cycle selected, what lights is every cell that cycle touched, plus the cell the reader pressed; gates and neighbours are no longer lit on their own')
})

test('inking: with a cycle selected, its cells are fully lit, unlined cells one step lower, other cycles take neither kind', () => {
  const reading = readingOf({
    nodes: {
      mine: node(),
      future: node(),
      other: node(),
      gate: node({ mode: 'manual', status: 'todo' }),
    },
    cycles: [
      { id: 'w', path: [{ node: 'mine', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }] },
      { id: 'v', path: [
        { node: 'other', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' },
        { node: 'gate', started_at: '2026-03-10T09:00:00.000Z', ended_at: '2026-03-10T10:00:00.000Z', result: 'completed' },
      ] },
    ],
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const emphasis = emphasisOf(placement, 'mine', 'w')

  assert.ok(emphasis.lit.has('mine'), 'this cycle\'s cells are all inked')
  assert.ok(emphasis.ahead.has('future'), 'a cell no cycle has touched yet is this cycle\'s future: one step lower')
  assert.ok(!emphasis.lit.has('other') && !emphasis.ahead.has('other'), 'cells of other cycles take neither kind')
  assert.ok(!emphasis.lit.has('gate') && !emphasis.ahead.has('gate'), 'another cycle\'s gate does not light just because it is a gate')
  assert.ok(emphasisOf(placement, 'mine', null).lit.has('gate'), 'back to global, the gates are in the ink again')
})

test('inking: a cell the cycle is holding lights with it, and one held by another cycle is not a future', () => {
  const reading = readingOf({
    nodes: {
      inhand: node(),
      elsewhere: node(),
      future: node(),
    },
    cycles: [
      { id: 'w', holding: ['inhand'] },
      { id: 'v', holding: ['elsewhere'] },
    ],
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const emphasis = emphasisOf(placement, 'future', 'w')

  assert.ok(emphasis.lit.has('inhand'), 'the held cell is this cycle\'s own work: inked, wearing its frame')
  assert.ok(!emphasis.ahead.has('inhand'), 'the held cell is not a future of this cycle')
  assert.ok(!emphasis.lit.has('elsewhere') && !emphasis.ahead.has('elsewhere'), 'a cell held by another cycle takes neither kind')
})

test('fit view: the whole drawing in the viewport, margin on the smaller side, the drawing centered on screen', () => {
  const placement = grid(6, 3)
  const size = { w: 1200, h: 760 }
  const view = fitView(size, placement)

  assert.ok(view.s <= 1, 'fit view never zooms in')
  assert.ok(placement.width * view.s <= size.w + 0.5 && placement.height * view.s <= size.h + 0.5, 'the whole drawing is in the viewport')
  assert.equal(view.tx, (size.w - placement.width * view.s) / 2, 'the smaller side centers: left and right are equally wide')
  assert.equal(view.ty, (size.h - placement.height * view.s) / 2)
})

test('the camera stays on the drawing: a direction where the drawing is larger is clamped to the edge, a smaller one centers', () => {
  const size = { w: 400, h: 300 }
  const big = grid(8, 8)
  const wide = clampView({ s: 1, tx: 999, ty: 999 }, size, big)

  assert.equal(wide.tx, 0, 'dragging to the far left puts the drawing\'s left edge against the viewport')
  assert.equal(wide.ty, 0)
  assert.equal(clampView({ s: 1, tx: -9999, ty: -9999 }, size, big).tx, size.w - big.width)
  assert.equal(clampView({ s: 1, tx: -9999, ty: -9999 }, size, big).ty, size.h - big.height)

  const small = clampView({ s: 1, tx: 999, ty: 999 }, { w: 900, h: 700 }, grid(1, 1))
  assert.equal(small.tx, (900 - (PAD * 2 + CARD_W)) / 2, 'a direction smaller than the viewport centers, not pinned to the edge')
  assert.equal(small.ty, (700 - (PAD * 2 + CARD_H)) / 2)
})

test('pan: an edge cell of the drawing can be dragged to the viewport\'s middle, both ends reachable', () => {
  const placement = grid(1, 10)
  const size = { w: 900, h: 700 }
  const box = panBounds(size, placement, 1)
  const top = panView({ s: 1, tx: 0, ty: size.h / 2 - placement.pos['c0r0'].y }, size, placement)
  const bottom = panView({ s: 1, tx: 0, ty: size.h / 2 - placement.pos['c0r9'].y }, size, placement)

  assert.ok(placement.height > size.h, 'this drawing is taller than the viewport: under the old rule an edge cell could never reach the middle')
  assert.ok(Math.abs(placement.pos['c0r0'].y + top.ty - size.h / 2) < 1e-9, 'the topmost cell stands in the middle')
  assert.ok(Math.abs(placement.pos['c0r9'].y + bottom.ty - size.h / 2) < 1e-9, 'the bottommost cell stands in the middle too')
  assert.ok(top.ty <= box.maxY && bottom.ty >= box.minY, 'both positions are within the pan range, no need to cross the boundary')
})

test('pan: likewise across, both end cells reach the middle; positions further out get clamped', () => {
  const placement = grid(6, 1)
  const size = { w: 900, h: 640 }
  const first = panView({ s: 1, tx: size.w / 2 - placement.pos['c0r0'].x, ty: 0 }, size, placement)
  const last = panView({ s: 1, tx: size.w / 2 - placement.pos['c5r0'].x, ty: 0 }, size, placement)
  const beyond = panView({ s: 1, tx: 99999, ty: -99999 }, size, placement)
  const box = panBounds(size, placement, 1)

  assert.ok(Math.abs(placement.pos['c0r0'].x + first.tx - size.w / 2) < 1e-9, 'the first cell stands in the middle')
  assert.ok(Math.abs(placement.pos['c5r0'].x + last.tx - size.w / 2) < 1e-9, 'the last cell stands in the middle')
  assert.equal(beyond.tx, box.maxX, 'dragged outward, it stops at the head of the pan range')
  assert.equal(beyond.ty, box.minY, 'dragged upward, it stops at the head of the pan range')
})

test('rubber band: crossing the edge gives only a small stretch, shorter the further it is pulled, and letting go lands exactly on the boundary', () => {
  const placement = grid(6, 6)
  const size = { w: 900, h: 640 }
  const box = panBounds(size, placement, 1)
  const pull = (by) => rubberView({ s: 1, tx: box.maxX + by, ty: box.minY - by }, size, placement)
  const small = pull(120)
  const large = pull(1200)

  assert.ok(small.tx > box.maxX && small.tx < box.maxX + 120, 'past the edge it still moves, but slower than the pointer')
  assert.ok(large.tx > small.tx, 'the further it is pulled, the more it gives')
  assert.ok(large.tx - box.maxX < size.w * 0.22, 'the stretch is capped, the drawing is not dragged entirely out of the viewport')
  assert.ok(large.ty < box.minY && box.minY - large.ty < size.h * 0.22, 'the same damping in both directions')
  assert.deepEqual(panView({ s: 1, tx: small.tx, ty: small.ty }, size, placement),
    { s: 1, tx: box.maxX, ty: box.minY }, 'letting go returns it to the boundary')
})

test('wheel: after zooming, the point under the pointer stays the same point', () => {
  const before = { s: 0.8, tx: 40, ty: 12 }
  const at = { x: 220, y: 140 }
  const canvasBefore = { x: (at.x - before.tx) / before.s, y: (at.y - before.ty) / before.s }
  const after = zoomAt(before, at, before.s * 1.5)

  assert.ok(Math.abs((at.x - after.tx) / after.s - canvasBefore.x) < 1e-9)
  assert.ok(Math.abs((at.y - after.ty) / after.s - canvasBefore.y) < 1e-9)
  assert.equal(zoomAt(before, at, 100).s, 2.4, 'zooming in is capped')
  assert.equal(zoomAt(before, at, 0.0001).s, 0.1, 'zooming out has a floor')
})

test('focus view: this cell stands in the viewport\'s middle, and the drawing\'s first and last columns reach the middle too', () => {
  const placement = grid(12, 1)
  const size = { w: 900, h: 980 }
  const screen = (focus) => {
    const view = focusView(size, placement, focus)
    return { x: placement.pos[focus].x * view.s + view.tx, y: placement.pos[focus].y * view.s + view.ty }
  }

  for (const column of placement.columns) {
    const at = screen(column[0])
    assert.ok(Math.abs(at.x - size.w / 2) < 1e-6, `${column[0]} stands in the horizontal middle`)
    assert.ok(Math.abs(at.y - size.h / 2) < 1e-6, `${column[0]} stands in the vertical middle`)
  }

  /* The reach is what makes that true at the drawing's own edge: held to the drawing's box instead,
   * the camera is pulled back to the drawing's left edge and the card lands a whole card off the
   * middle. */
  const want = {
    s: FOCUS_SCALE,
    tx: size.w / 2 - placement.pos['c0r0'].x * FOCUS_SCALE,
    ty: size.h / 2 - placement.pos['c0r0'].y * FOCUS_SCALE,
  }
  const held = clampView(want, size, placement)
  assert.equal(held.tx, 0, 'clamped to the drawing\'s own edge: to put the first column in the middle the camera is pulled back to the drawing\'s left edge')
  assert.ok(Math.abs(placement.pos['c0r0'].x * held.s + held.tx - size.w / 2) > CARD_W / 3,
    'the first column then falls on a left-hand strip — exactly the landing this attempt avoids')
})

test('focus view: the camera centers the cell itself, while the ring\'s middle sits off to one side', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      one: node({ dependencies: ['root'] }),
      two: node({ dependencies: ['root'] }),
      three: node({ dependencies: ['root'] }),
      after: node({ dependencies: ['one'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  const size = { w: 900, h: 980 }
  const view = focusView(size, placement, 'root')
  const at = placement.pos['root'].x * view.s + view.tx
  /* The ring is root and the three cards it feeds: its middle stands a whole column to the right. */
  const middle = ((placement.pos['root'].x - CARD_W / 2) + (placement.pos['one'].x + CARD_W / 2)) / 2 * view.s + view.tx

  assert.ok(middle - at > CARD_W * 0.5, 'the ring\'s middle is most of a cell to its right: centering there would keep this cell off the middle')
})

test('focus view: when the viewport cannot hold a whole cell, the camera narrows until this cell fits neatly', () => {
  const placement = grid(3, 1)
  const narrow = focusView({ w: 300, h: 260 }, placement, 'c2r0')
  const short = focusView({ w: 1200, h: 100 }, placement, 'c2r0')

  assert.equal(narrow.s, (300 - 48) / CARD_W, 'the narrow side narrows by exactly a whole cell plus its own margin')
  assert.equal(short.s, (100 - 48) / CARD_H, 'the short side likewise')
  assert.ok(narrow.s < FOCUS_SCALE && short.s < FOCUS_SCALE, 'both are smaller than the focus scale')
  assert.deepEqual(focusView({ w: 1200, h: 700 }, placement, null), fitView({ w: 1200, h: 700 }, placement), 'with no cell focused, it falls back to the fit view')
})

test('level of detail: each scale reads at its own step, and the two thresholds are those numbers', () => {
  assert.equal(lodOf(0.3), 'dot')
  assert.equal(lodOf(TITLE_AT), 'mid')
  assert.equal(lodOf(0.8), 'mid')
  assert.equal(lodOf(0.92), 'full')
})