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

test('分诊：等人那一格先，然后在手、可开工、还在等，落定的最后', () => {
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
    '人闸先，在手其次，可开工第三，等的第四，已经交付的最后：地图先答「谁还欠着」',
  )
})

test('分诊：同一档里最近的那一刻先，同一刻按记录自己的次序', () => {
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
    '还没开工的排在交付之前；交付那一档里按时刻倒排，一刻都没有的保持记录给的次序',
  )
})

/* The card's own moment is no longer asked here: which moment a card speaks of is the model's
 * `stampAt` (pinned in `model-reading`), and this page only orders by it. */

test('空页：一格都没有、或只有一格，当场给出点位，不空转', () => {
  const empty = place({ nodes: [], edges: [] })

  assert.deepEqual(empty.columns, [])
  assert.equal(empty.drawn.length, 0)
  assert.equal(empty.width, PAD * 2 + CARD_W, '空页也有一格的宽度，镜头才有地方落脚')

  const reading = readingOf({ nodes: { only: node() } })
  assert.deepEqual(columnsOf(place({ nodes: reading.nodes, edges: [] })), [['only']])
})

test('纵列：一格的深度是它最深的前置再加一层，记录里没有的前置不占一列', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      deep: node({ dependencies: ['root'] }),
      orphan: node({ dependencies: ['gone', 'root'] }),
    },
  })

  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })
  assert.equal(placement.columns.length, 2, '两条链并排：两列')
  assert.deepEqual(columnsOf(placement), [['root'], ['deep', 'orphan']], '两个都只欠 root，站在第二列')
})

test('点位：第一列落在左边距上，一格一个格位，列间拉开一格的空', () => {
  const reading = readingOf({ nodes: { a: node(), b: node({ dependencies: ['a'] }) } })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.deepEqual(placement.pos['a'], { x: PAD + CARD_W / 2, y: PAD + CARD_H / 2 })
  assert.deepEqual(placement.pos['b'], { x: PAD + CARD_W + COL_GAP + CARD_W / 2, y: PAD + CARD_H / 2 })
  assert.equal(placement.width, PAD * 2 + CARD_W * 2 + COL_GAP)
  assert.equal(placement.height, PAD * 2 + CARD_H)
})

test('点位：短的那一列在自己的高度里居中，不贴着顶排', () => {
  const reading = readingOf({
    nodes: {
      root: node(),
      one: node({ dependencies: ['root'] }),
      two: node({ dependencies: ['root'] }),
      three: node({ dependencies: ['root'] }),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.equal(placement.pos['root'].y, placement.pos['two'].y, '一列一格，落在三格那一列的正中间')
  assert.ok(placement.pos['one'].x > placement.pos['root'].x, '三个都在右边那一列')
  assert.equal(placement.height, PAD * 2 + CARD_H * 3 + ROW_GAP * 2, '整张图的高由最长的那一列定')
})

test('分岛：不欠彼此的卡不挤在一格里，岛与岛各行其道', () => {
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
      assert.ok(dx >= CARD_W - 1e-9 || dy >= CARD_H - 1e-9, `${left} 与 ${right} 不重叠`)
    }
  }

  /* The two chains have nothing between them, so the second starts a whole island's ground to the
   * right of the first instead of renting rows off it. */
  assert.equal(placement.pos['c'].x - placement.pos['a'].x, CARD_W * 2 + COL_GAP + ISLAND_GAP,
    '两座岛之间正好是一段岛间的地，不多不少')
  assert.equal(placement.pos['c'].y, placement.pos['a'].y, '两格的岛各自一行，谁也不用等谁')
})

test('分岛：还欠着活的岛排在交付完了的岛上面', () => {
  const reading = readingOf({
    nodes: {
      settled: node({ completed_at: '2026-03-10T09:00:00.000Z' }),
      open: node(),
    },
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  assert.ok(placement.pos['open'].y < placement.pos['settled'].y, '上面那一带是还欠着活的')
})

test('行解：一条链上的格子落在同一行，一条边也不斜着走', () => {
  const ids = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']
  const reading = readingOf({
    nodes: Object.fromEntries(ids.map((id, index) => [id, node(index === 0 ? {} : { dependencies: [ids[index - 1]] })])),
  })
  const placement = place({ nodes: reading.nodes, edges: reading.graph.edges })

  for (const edge of reading.graph.edges) {
    assert.equal(placement.pos[edge.from].y, placement.pos[edge.to].y, `${edge.from} → ${edge.to} 是一条平线`)
  }
  assert.equal(placement.height, PAD * 2 + CARD_H, '七个格位排成一条线，图就一格高')
})

test('上限：只画得出前 N 格，焦点和它的直接前后永远在图上', () => {
  const reading = readingOf({
    nodes: {
      first: node(),
      second: node(),
      third: node(),
      fourth: node({ dependencies: ['third'] }),
    },
  })
  const capped = place({ nodes: reading.nodes, edges: reading.graph.edges, cap: 2 })
  assert.equal(capped.drawn.length, 2, 'cap 就是画几格的上限')

  const withFocus = place({ nodes: reading.nodes, edges: reading.graph.edges, cap: 1, focus: 'fourth' })
  const ids = withFocus.drawn.map((item) => item.id).sort()
  assert.deepEqual(ids, ['first', 'fourth', 'third'], '上限那一格照画；焦点补进来，它欠的那一格也补进来')
  assert.ok(withFocus.pos['fourth'].x > withFocus.pos['third'].x, '补进来的那一格照样占它自己那一列')
})

test('线：从上一格的右边出，落到下一格的左边', () => {
  const path = wirePath({ x: 100, y: 40 }, { x: 600, y: 90 })
  const pieces = path.split(',')

  assert.match(path, /^M(\d+(\.\d+)?) 40C/u)
  assert.equal(path.slice(1).split(' ')[0], String(100 + CARD_W / 2), '起点是前置那一格的右边缘')
  assert.equal(pieces[pieces.length - 1].trim().split(' ')[0], String(600 - CARD_W / 2), '终点是等它的那一格的左边缘')
})

test('上墨：焦点、它欠的、欠它的，再加命中范围自己那一段', () => {
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
    '全局这一档点亮的是全工作区的人闸，加上焦点和它的直接前后')
  assert.equal(global.ahead.size, 0, '全局没有「未来的节点」这一档')

  const scoped = emphasisOf(placement, 'focus', 'w')
  assert.deepEqual([...scoped.lit].sort(), ['focus', 'elsewhere'].sort(),
    '选中一条线时点亮的是那条线碰过的格子，加上读者自己按过的那一格；人闸和前后不再单独点亮')
})

test('上墨：选中一条线，线上的全亮，没有线的低一档，别的线一档都不占', () => {
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

  assert.ok(emphasis.lit.has('mine'), '这条线上的格子全在墨里')
  assert.ok(emphasis.ahead.has('future'), '哪条线都还没碰过的，是这条线的未来：低一档')
  assert.ok(!emphasis.lit.has('other') && !emphasis.ahead.has('other'), '别的线上的格子两档都不占')
  assert.ok(!emphasis.lit.has('gate') && !emphasis.ahead.has('gate'), '别的线的人闸不因为它是人闸就亮起来')
  assert.ok(emphasisOf(placement, 'mine', null).lit.has('gate'), '退回全局，人闸又回到墨里')
})

test('上墨：线正握着的格子随这条线亮，握在别的线手里的不算未来', () => {
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

  assert.ok(emphasis.lit.has('inhand'), '线手里那一格是这条线自己的活：在墨里，戴着它的框')
  assert.ok(!emphasis.ahead.has('inhand'), '手里那一格不是这条线的未来')
  assert.ok(!emphasis.lit.has('elsewhere') && !emphasis.ahead.has('elsewhere'), '别的线握着的格子，两档都不占')
})

test('全览：整张图放进视口，小的那一边留出余量，图上屏是居中的', () => {
  const placement = grid(6, 3)
  const size = { w: 1200, h: 760 }
  const view = fitView(size, placement)

  assert.ok(view.s <= 1, '全览不放大')
  assert.ok(placement.width * view.s <= size.w + 0.5 && placement.height * view.s <= size.h + 0.5, '整张图在视口里')
  assert.equal(view.tx, (size.w - placement.width * view.s) / 2, '小的那边居中：左边与右边一样宽')
  assert.equal(view.ty, (size.h - placement.height * view.s) / 2)
})

test('相机不越出图：图比视口大的方向被夹在边上，比视口小的方向居中', () => {
  const size = { w: 400, h: 300 }
  const big = grid(8, 8)
  const wide = clampView({ s: 1, tx: 999, ty: 999 }, size, big)

  assert.equal(wide.tx, 0, '拖到最左边就是图的左边贴住视口')
  assert.equal(wide.ty, 0)
  assert.equal(clampView({ s: 1, tx: -9999, ty: -9999 }, size, big).tx, size.w - big.width)
  assert.equal(clampView({ s: 1, tx: -9999, ty: -9999 }, size, big).ty, size.h - big.height)

  const small = clampView({ s: 1, tx: 999, ty: 999 }, { w: 900, h: 700 }, grid(1, 1))
  assert.equal(small.tx, (900 - (PAD * 2 + CARD_W)) / 2, '比视口小的方向居中，不贴着边')
  assert.equal(small.ty, (700 - (PAD * 2 + CARD_H)) / 2)
})

test('平移：图边上那一格也能被拖到视口正中，上下两头都到得了', () => {
  const placement = grid(1, 10)
  const size = { w: 900, h: 700 }
  const box = panBounds(size, placement, 1)
  const top = panView({ s: 1, tx: 0, ty: size.h / 2 - placement.pos['c0r0'].y }, size, placement)
  const bottom = panView({ s: 1, tx: 0, ty: size.h / 2 - placement.pos['c0r9'].y }, size, placement)

  assert.ok(placement.height > size.h, '这张图比视口高：旧规则下边上的格子永远到不了正中')
  assert.ok(Math.abs(placement.pos['c0r0'].y + top.ty - size.h / 2) < 1e-9, '最上面那一格站在正中')
  assert.ok(Math.abs(placement.pos['c0r9'].y + bottom.ty - size.h / 2) < 1e-9, '最下面那一格也站在正中')
  assert.ok(top.ty <= box.maxY && bottom.ty >= box.minY, '这两个位置都在平移范围里，不用越过边界')
})

test('平移：横向同理，左右两头的格子都到得了正中；再往外的位置被夹住', () => {
  const placement = grid(6, 1)
  const size = { w: 900, h: 640 }
  const first = panView({ s: 1, tx: size.w / 2 - placement.pos['c0r0'].x, ty: 0 }, size, placement)
  const last = panView({ s: 1, tx: size.w / 2 - placement.pos['c5r0'].x, ty: 0 }, size, placement)
  const beyond = panView({ s: 1, tx: 99999, ty: -99999 }, size, placement)
  const box = panBounds(size, placement, 1)

  assert.ok(Math.abs(placement.pos['c0r0'].x + first.tx - size.w / 2) < 1e-9, '第一格站到正中')
  assert.ok(Math.abs(placement.pos['c5r0'].x + last.tx - size.w / 2) < 1e-9, '最后一格站到正中')
  assert.equal(beyond.tx, box.maxX, '往外拖，停在平移范围的头上')
  assert.equal(beyond.ty, box.minY, '往上拖，停在平移范围的头上')
})

test('橡皮筋：越界只让出一小截，越拉越短，松手的落点就是边界', () => {
  const placement = grid(6, 6)
  const size = { w: 900, h: 640 }
  const box = panBounds(size, placement, 1)
  const pull = (by) => rubberView({ s: 1, tx: box.maxX + by, ty: box.minY - by }, size, placement)
  const small = pull(120)
  const large = pull(1200)

  assert.ok(small.tx > box.maxX && small.tx < box.maxX + 120, '越界之后还在动，但没有指针走得快')
  assert.ok(large.tx > small.tx, '拉得越远让得越多')
  assert.ok(large.tx - box.maxX < size.w * 0.22, '让出的那一截有上限，图不会被整张拖出视口')
  assert.ok(large.ty < box.minY && box.minY - large.ty < size.h * 0.22, '两个方向同一套阻尼')
  assert.deepEqual(panView({ s: 1, tx: small.tx, ty: small.ty }, size, placement),
    { s: 1, tx: box.maxX, ty: box.minY }, '松手回到边界上')
})

test('滚轮：缩放之后，指针底下那一点还是原来那一点', () => {
  const before = { s: 0.8, tx: 40, ty: 12 }
  const at = { x: 220, y: 140 }
  const canvasBefore = { x: (at.x - before.tx) / before.s, y: (at.y - before.ty) / before.s }
  const after = zoomAt(before, at, before.s * 1.5)

  assert.ok(Math.abs((at.x - after.tx) / after.s - canvasBefore.x) < 1e-9)
  assert.ok(Math.abs((at.y - after.ty) / after.s - canvasBefore.y) < 1e-9)
  assert.equal(zoomAt(before, at, 100).s, 2.4, '放大有上限')
  assert.equal(zoomAt(before, at, 0.0001).s, 0.1, '缩小有下限')
})

test('对准焦点：这一格站在视口正中，图的第一列和最后一列也站得到正中', () => {
  const placement = grid(12, 1)
  const size = { w: 900, h: 980 }
  const screen = (focus) => {
    const view = focusView(size, placement, focus)
    return { x: placement.pos[focus].x * view.s + view.tx, y: placement.pos[focus].y * view.s + view.ty }
  }

  for (const column of placement.columns) {
    const at = screen(column[0])
    assert.ok(Math.abs(at.x - size.w / 2) < 1e-6, `${column[0]} 站在横向正中`)
    assert.ok(Math.abs(at.y - size.h / 2) < 1e-6, `${column[0]} 站在纵向正中`)
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
  assert.equal(held.tx, 0, '夹在图自己的边上：想让第一列站到正中，镜头被拽回图的左边缘')
  assert.ok(Math.abs(placement.pos['c0r0'].x * held.s + held.tx - size.w / 2) > CARD_W / 3,
    '第一列只好落在左边一条带上——正是这次不要的那种落法')
})

test('对准焦点：镜头对准这一格自己，圈的正中偏在一边', () => {
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

  assert.ok(middle - at > CARD_W * 0.5, '圈的正中在它右边大半格：对着那里，这一格就站不在正中了')
})

test('对准焦点：视口装不下一整格的时候，镜头收到这一格整整齐齐地放得下', () => {
  const placement = grid(3, 1)
  const narrow = focusView({ w: 300, h: 260 }, placement, 'c2r0')
  const short = focusView({ w: 1200, h: 100 }, placement, 'c2r0')

  assert.equal(narrow.s, (300 - 48) / CARD_W, '窄的那一边收的正好是整格加上它自己的余量')
  assert.equal(short.s, (100 - 48) / CARD_H, '矮的那一边同理')
  assert.ok(narrow.s < FOCUS_SCALE && short.s < FOCUS_SCALE, '都比焦距那一档小')
  assert.deepEqual(focusView({ w: 1200, h: 700 }, placement, null), fitView({ w: 1200, h: 700 }, placement), '一格都没对准，退回全览')
})

test('字号：缩到哪一档就读哪一档，两档的界就是那两个数', () => {
  assert.equal(lodOf(0.3), 'dot')
  assert.equal(lodOf(TITLE_AT), 'mid')
  assert.equal(lodOf(0.8), 'mid')
  assert.equal(lodOf(0.92), 'full')
})