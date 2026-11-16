/* The overview's layout, as numbers: given the window count, each window's rows, and a stage size,
 * the placement answers with boxes — and the boxes hold the two lines nothing may cross.
 *
 * Nothing here pins a formula: every assertion is an invariant a reader can check off the drawing —
 * nothing off the stage, nothing on the lane the state keeps, the rail's own bars never past its
 * edge, the group on the stage's own middle with equal gutters, the children one column that
 * neither overlaps the main window nor grows past its content, no empty column for no child, the
 * main window taller by exactly one row's height for one more row, the narrow stage drawing the
 * main window alone, and a short stage keeping every box between its two edges.
 *
 *   node --test tests/overview-geom.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHILD_HEAD,
  CHILD_FOOT,
  BOX_BORDER,
  FEED_LEFT,
  FEED_RIGHT,
  FIELD_MAX_H,
  FIELD_PAD,
  GAP_Y,
  LINK_BEND,
  MAIN_FOOT,
  MAIN_HEAD,
  MARK_CHECK,
  MARK_CHECK_STROKE,
  MARK_FAIL,
  MARK_FAIL_STROKE,
  PLATE_OUT,
  RAIL_LANE,
  RAIL_LEFT,
  READING_CAPACITY,
  RING_CELL,
  RING_RIGHT,
  RING_SIZE,
  RING_TOP,
  ROW_H,
  SPILL_GAP,
  SPILL_H,
  layoutLink,
  layoutMark,
  layoutOverview,
  layoutRing,
  layoutSpill,
  railBarWidth,
} from '../src/client/overview-geom.ts'

const STAGES = [
  { name: 'narrow', width: 640, height: 480 },
  { name: 'mid', width: 1024, height: 720 },
  { name: 'wide', width: 1440, height: 900 },
]

/** Window counts 1, 2, 5, 6: the main window plus 0, 1, 4, 5 running children. */
const COUNTS = [
  { windows: 1, children: 0 },
  { windows: 2, children: 1 },
  { windows: 5, children: 4 },
  { windows: 6, children: 5 },
]

const rowsFor = (children) => Array.from({ length: children }, (_, i) => 2 + (i % 3))

const place = (stage, children, rows = 6) =>
  layoutOverview({ stage: { width: stage.width, height: stage.height }, mainRows: rows, childRows: rowsFor(children) })

/** The ground this state keeps at each side: the rail's lane while the rail stands, else the stage's own blank. */
const sideOf = (p) => Math.max(p.railVisible ? RAIL_LANE : 0, FIELD_PAD)

/** The 24px strip one row is drawn in: counted up from the pane's bottom edge — its 0.5px hairline,
 * its foot, then the rows under it — because the feed stands bottom-justified and whatever blank a
 * cut leaves sits at the top of the stack. */
const bandOf = (box, rowIndex, rowCount) => {
  const bottom = box.top + box.height - 0.5 - MAIN_FOOT - (rowCount - 1 - rowIndex) * ROW_H
  return { top: bottom - ROW_H, bottom }
}

for (const stage of STAGES) {
  for (const count of COUNTS) {
    test(`${stage.name} stage, ${count.windows} window(s): every box stays on the stage and off the lane this state keeps`, () => {
      const p = place(stage, count.children)
      const side = sideOf(p)
      const boxes = [p.main, ...p.children]
      for (const box of boxes) {
        assert.ok(box.top >= p.fieldTop, `a window starts above the field: top ${box.top}`)
        assert.ok(box.top + box.height <= p.fieldTop + p.fieldHeight, `a window runs past the field's bottom: ${box.top + box.height}`)
        assert.ok(box.top + box.height <= stage.height, `a window runs off the stage's bottom: ${box.top + box.height}`)
        assert.ok(box.left >= side, `a window sits on the ${side} the state keeps at the stage's left: left ${box.left}`)
        assert.ok(box.left + box.width <= stage.width - FIELD_PAD, `a window runs off the stage's right: ${box.left + box.width}`)
      }
      /* The nameplate probes left of the main window's edge, and the probe stops at the lane. */
      assert.ok(p.plateOut >= 0 && p.plateOut <= PLATE_OUT, `the probe is out of range: ${p.plateOut}`)
      assert.ok(p.main.left - p.plateOut >= side, `the nameplate crosses into the ${side} kept at the stage's left: ${p.main.left - p.plateOut}`)
      assert.ok(p.main.left - p.plateOut >= 0, `the nameplate is off the stage's left edge: ${p.main.left - p.plateOut}`)
    })

    test(`${stage.name} stage, ${count.windows} window(s): the group is centred on the stage, gutters equal`, () => {
      const p = place(stage, count.children)
      const side = sideOf(p)
      const left = p.fieldLeft
      const right = p.fieldLeft + p.fieldWidth
      /* A whole group, gutters and all, sits on the stage's own middle — not on the room the rail
         leaves over, and not on a band that starts where the lane ends. */
      assert.ok(
        Math.abs((left + right) / 2 - stage.width / 2) <= 1,
        `the group's middle is ${(left + right) / 2}, the stage's ${stage.width / 2}`,
      )
      assert.ok(
        Math.abs(left - (stage.width - right)) <= 1,
        `the gutters are ${left} and ${stage.width - right}, not a pair`,
      )
      /* The right edge stops at the stage less the ground the state keeps — the lane on both sides
         when the rail stands. */
      assert.ok(right <= stage.width - side, `the group's right edge ${right} passed ${stage.width} less ${side}`)
      for (const box of [p.main, ...p.children]) {
        assert.ok(box.left + box.width <= stage.width - side, `a window's right edge ${box.left + box.width} passed ${stage.width - side}`)
      }
      /* No child, no column: the field is exactly the main window's width. */
      if (count.children === 0) {
        assert.equal(p.fieldWidth, p.main.width, `the field kept a column for no child: ${p.fieldWidth} over ${p.main.width}`)
      }
    })

    test(`${stage.name} stage, ${count.windows} window(s): the group is centred vertically, the children column with it`, () => {
      const p = place(stage, count.children)
      const boxes = [p.main, ...p.children]
      /* The main window's middle is the stage's middle. */
      assert.ok(
        Math.abs(p.main.top + p.main.height / 2 - stage.height / 2) <= 1,
        `the main window's middle is ${p.main.top + p.main.height / 2}, the stage's ${stage.height / 2}`,
      )
      /* The column is centred as one group, not each child on its own: only the column's own middle
         can be the stage's when it holds more than two children. */
      const top = Math.min(...boxes.map((box) => box.top))
      const bottom = Math.max(...boxes.map((box) => box.top + box.height))
      assert.ok(
        Math.abs((top + bottom) / 2 - stage.height / 2) <= 1,
        `the group's vertical middle is ${(top + bottom) / 2}, the stage's ${stage.height / 2}`,
      )
      for (const box of boxes) {
        assert.ok(box.top >= 0, `a window starts above the stage: top ${box.top}`)
        assert.ok(box.top + box.height <= stage.height, `a window runs off the stage's bottom: ${box.top + box.height}`)
      }
    })

    test(`${stage.name} stage, ${count.windows} window(s): the children stand in one column, never over the main window`, () => {
      const p = place(stage, count.children)
      if (p.children.length === 0) return
      const n = p.children.length
      const stack = p.children.reduce((sum, box) => sum + box.height, 0)
      /* The field holds the column at the design's own ground; a field too short for it takes one
         shorter ground, the same one between every pair, rather than letting the column run past. */
      const roomy = stack + GAP_Y * (n - 1) <= p.fieldHeight
      assert.equal(n, count.children, `the column draws ${n} of ${count.children} children`)
      for (let i = 1; i < n; i++) {
        const up = p.children[i - 1]
        const box = p.children[i]
        assert.equal(box.left, up.left, 'the children are not one column')
        assert.equal(box.width, up.width, 'the children do not share one width')
        const ground = box.top - (up.top + up.height)
        assert.ok(ground >= 0, `child ${i} overlaps the one above it by ${-ground}`)
        assert.ok(ground <= GAP_Y, `child ${i} stands ${ground} off the one above it, past ${GAP_Y}`)
        assert.equal(ground, p.children[1].top - (p.children[0].top + p.children[0].height), 'the column keeps two different grounds')
        if (roomy) assert.equal(ground, GAP_Y, `child ${i} gave up the design's ground ${GAP_Y} for ${ground}`)
      }
      const first = p.children[0]
      assert.ok(first.width < p.main.width, 'a child is not narrower than the main window')
      assert.ok(first.left >= p.main.left + p.main.width, 'a child sits over the main window')
    })

    test(`${stage.name} stage, ${count.windows} window(s): every line leaves its own row and reaches its own child`, () => {
      const p = place(stage, count.children)
      p.children.forEach((child, i) => {
        const gap = child.left - (p.main.left + p.main.width)
        const link = layoutLink({ main: p.main, child, rowIndex: i, rowCount: 6, gap })
        assert.notEqual(link, undefined, `child ${i} drew no line`)
        /* The start is the main window's right edge, on the strip the anchored row is drawn in. */
        assert.equal(link.fromX, p.main.left + p.main.width, `line ${i} leaves at x ${link.fromX}`)
        const band = bandOf(p.main, i, 6)
        assert.ok(
          link.fromY > band.top && link.fromY < band.bottom,
          `line ${i} leaves at y ${link.fromY}, outside its row's strip ${band.top}..${band.bottom}`,
        )
        /* The end is the child's own left edge, on its own middle. */
        assert.equal(link.toX, child.left, `line ${i} arrives at x ${link.toX}`)
        assert.equal(link.toY, child.top + child.height / 2, `line ${i} arrives at y ${link.toY}`)
        assert.ok(link.d.startsWith(`M${link.fromX} ${link.fromY}`), `line ${i} does not start on its anchor: ${link.d}`)
        assert.ok(link.d.endsWith(`H${link.toX}`), `line ${i} does not run into the child's edge: ${link.d}`)
        assert.ok(
          link.fromY === link.toY || link.d.includes(`V${link.toY}`),
          `line ${i} does not turn into the child's height: ${link.d}`,
        )
        /* Both ends stand on the stage. */
        for (const [x, y] of [[link.fromX, link.fromY], [link.toX, link.toY]]) {
          assert.ok(x >= 0 && x <= stage.width, `a line end runs off the stage's width: ${x}`)
          assert.ok(y >= 0 && y <= stage.height, `a line end runs off the stage's height: ${y}`)
        }
        /* The row it leaves is one the feed actually shows. */
        assert.ok(link.fromY >= p.main.top + MAIN_HEAD, `line ${i} starts above the feed: ${link.fromY}`)
        assert.ok(link.fromY <= p.main.top + p.main.height - MAIN_FOOT, `line ${i} starts below the feed: ${link.fromY}`)
      })
    })

    test(`${stage.name} stage, ${count.windows} window(s): no feed holds more rows than the caller's capacity`, () => {
      const p = place(stage, count.children)
      for (const box of [p.main, ...p.children]) {
        assert.ok(box.rowsRoom <= READING_CAPACITY, `a feed's room ${box.rowsRoom} passed the capacity`)
        assert.ok(box.rowsRoom >= 1, 'a window with no room for one row')
      }
    })
  }
}

/* ---- the lines between windows ------------------------------------------- */

test('three children anchored on three rows: three lines, each on its own row and its own window', () => {
  const stage = STAGES[2]
  const p = place(stage, 3)
  assert.equal(p.children.length, 3, `the wide stage drew ${p.children.length} of three children`)
  const gap = p.children[0].left - (p.main.left + p.main.width)
  const links = p.children.map((child, i) => layoutLink({ main: p.main, child, rowIndex: i, rowCount: 6, gap }))
  assert.equal(links.filter((one) => one !== undefined).length, 3, 'a line went missing')
  const bands = [0, 1, 2].map((i) => bandOf(p.main, i, 6))
  links.forEach((one, i) => {
    assert.ok(
      one.fromY > bands[i].top && one.fromY < bands[i].bottom,
      `line ${i} leaves at ${one.fromY}, outside its own row's strip ${bands[i].top}..${bands[i].bottom}`,
    )
  })
  assert.equal(links[1].fromY - links[0].fromY, ROW_H, 'the first two lines are not one row apart')
  assert.equal(links[2].fromY - links[1].fromY, ROW_H, 'the last two lines are not one row apart')
  assert.deepEqual(
    links.map((one) => one.toY),
    p.children.map((child) => child.top + child.height / 2),
    'a line does not arrive on its own window',
  )
  assert.equal(new Set(links.map((one) => one.fromY)).size, 3, 'two lines left the same row')
  assert.equal(new Set(links.map((one) => one.toY)).size, 3, 'two lines arrived at the same height')
})

test('the corner turns at the middle of the ground, and never wider than the bend', () => {
  const p = place(STAGES[2], 1)
  const child = p.children[0]
  const gap = child.left - (p.main.left + p.main.width)
  const link = layoutLink({ main: p.main, child, rowIndex: 0, rowCount: 6, gap })
  assert.notEqual(link, undefined)
  const mid = link.fromX + gap / 2
  assert.ok(link.d.includes(`H${mid - LINK_BEND}`), `the run does not reach the corner's own start: ${link.d}`)
  assert.ok(link.d.includes(`Q${mid} ${link.fromY} ${mid} ${link.fromY + LINK_BEND}`), `the corner is not the demo's bend: ${link.d}`)
})

test('no anchor, no line: an absent row, a row off the drawn list, a row cut by the room, a window not drawn', () => {
  const p = place(STAGES[1], 5)
  const child = p.children[0]
  const gap = child.left - (p.main.left + p.main.width)
  const base = { main: p.main, child, gap, rowCount: 6 }
  assert.equal(layoutLink({ ...base, rowIndex: undefined }), undefined, 'a child with no anchor drew a line')
  assert.equal(layoutLink({ ...base, rowIndex: -1 }), undefined, 'row -1 drew a line')
  assert.equal(layoutLink({ ...base, rowIndex: 6 }), undefined, 'a row past the drawn rows drew a line')
  assert.equal(layoutLink({ ...base, rowIndex: 1.5 }), undefined, 'a fractional row drew a line')
  /* Ten rows drawn into a box with room for six: the first four are the cut, and no line may point
     into them — while a row still on the screen keeps its line. */
  assert.equal(layoutLink({ ...base, rowIndex: 1, rowCount: 10 }), undefined, 'a row cut by the room drew a line')
  const deep = layoutLink({ ...base, rowIndex: 9, rowCount: 10 })
  assert.notEqual(deep, undefined, 'a row still on the screen lost its line')
  /* It is the bottom row of the stack: its middle is half a row above the feed's own end. */
  assert.equal(deep.fromY, p.main.top + p.main.height - 0.5 - MAIN_FOOT - ROW_H / 2, 'the row on screen was placed as if it were cut')
  /* The column left the drawing: a box with no width is no window to reach. */
  assert.equal(layoutLink({ ...base, rowIndex: 0, child: { ...child, width: 0 } }), undefined, 'a window that is not drawn was reached')
  /* A child box standing on the main window is no child of the column. */
  assert.equal(layoutLink({ ...base, rowIndex: 0, child: { ...child, left: p.main.left } }), undefined, 'a line ran backwards into the main window')
})

/* ---- the dot stands on the row it names, counted up from the pane's bottom -------------- */

/* The feed is bottom-justified inside the pane's foot. A window the stage cuts leaves a blank at the
 * top of the stack, and a reading counted down from the window's head drifts by exactly that blank.
 * The expectations below are stated as numbers worked out from the pane's own bottom edge, never by
 * running the layout's own formula again. */

test('1024x900, a feed at the capacity: the window hugs its ten rows, and the dot stands on the row it names', () => {
  const p = layoutOverview({ stage: { width: 1024, height: 900 }, mainRows: READING_CAPACITY, childRows: [3] })
  /* The main window is the tallest frame the capacity allows it: 96 (head) + 10 × 24 (the rows) + 20
     (foot) + 2 (the frame) = 358 — twenty-two short of the field's own 380, and one row more would
     have to hang past that end, which is why the capacity stops at ten. */
  assert.equal(p.main.height, 358, `the window came out ${p.main.height}`)
  assert.ok(p.main.height + ROW_H > FIELD_MAX_H, `a ${p.main.height}px window still holds one row more under a ${FIELD_MAX_H}px field`)
  assert.equal(p.main.rowsRoom, 10, `the window's room came out ${p.main.rowsRoom}`)
  const child = p.children[0]
  const gap = child.left - (p.main.left + p.main.width)
  const rowCount = READING_CAPACITY
  /* The top row's middle, counted up from the feed's end: 358 − 0.5 (hairline) − 20 (foot) − 9*24
     − 12 = 109.5 below the pane's top. */
  const first = layoutLink({ main: p.main, child, rowIndex: 0, rowCount, gap })
  assert.notEqual(first, undefined, 'the top row drew no line')
  assert.ok(Math.abs(first.fromY - (p.main.top + 109.5)) <= 1, `the dot stands at ${first.fromY}, its row's middle is ${p.main.top + 109.5}`)
  /* Counting down from the head lands 1.5px higher — the frame's own blank over the stack — and this
     is the assertion that says the count starts at the pane's bottom. */
  assert.ok(Math.abs(first.fromY - (p.main.top + 108)) > 1, `the dot stands where counting from the head put it: ${first.fromY}`)
  /* The bottom row's middle is half a row above the feed's end: 358 − 0.5 − 20 − 12 = 325.5. */
  const last = layoutLink({ main: p.main, child, rowIndex: rowCount - 1, rowCount, gap })
  assert.notEqual(last, undefined, 'the bottom row drew no line')
  assert.ok(Math.abs(last.fromY - (p.main.top + 325.5)) <= 1, `the bottom dot stands at ${last.fromY}, not ${p.main.top + 325.5}`)
})

test('1024x300, a capacity feed cut by a short stage: the stack keeps its blank, and the dot stands on the first row it shows', () => {
  const p = layoutOverview({ stage: { width: 1024, height: 300 }, mainRows: READING_CAPACITY, childRows: [3] })
  /* The stage gives the field 300 − 2×8 = 284 and no more: the window takes all of it, so ten rows
     asked for and six fit. */
  assert.equal(p.fieldHeight, 284, `the field came out ${p.fieldHeight}`)
  assert.equal(p.main.height, 284, `the window was not cut to the field: ${p.main.height}`)
  assert.equal(p.main.rowsRoom, 6, `the window's room came out ${p.main.rowsRoom}`)
  const child = p.children[0]
  const gap = child.left - (p.main.left + p.main.width)
  const rowCount = READING_CAPACITY
  /* Four of the ten are the cut. The first row still on the screen: 284 − 0.5 − 20 − 5*24 − 12 =
     131.5 below the pane's top. */
  const first = layoutLink({ main: p.main, child, rowIndex: rowCount - 6, rowCount, gap })
  assert.notEqual(first, undefined, 'the first row on screen drew no line')
  assert.ok(Math.abs(first.fromY - (p.main.top + 131.5)) <= 1, `the dot stands at ${first.fromY}, its row's middle is ${p.main.top + 131.5}`)
  /* The row above it stands a whole row higher: a dot that drifted up by the blank the cut left
     lands there, and this is the assertion that says so out loud. */
  assert.ok(Math.abs(first.fromY - (p.main.top + 131.5 - ROW_H)) > 1, `the dot stands on the row above: ${first.fromY}, that row's middle is ${p.main.top + 131.5 - ROW_H}`)
  /* The stack's own end: the bottom row's middle is 284 − 0.5 − 20 − 12 = 251.5 below the pane's
     top, and a stack counted down from the head would have ended it on 96 + 5*24 + 12 = 228 —
     23.5px, the blank the cut left, is what separates the two. */
  const last = layoutLink({ main: p.main, child, rowIndex: rowCount - 1, rowCount, gap })
  assert.notEqual(last, undefined, 'the bottom row drew no line')
  assert.ok(Math.abs(last.fromY - (p.main.top + 251.5)) <= 1, `the bottom dot stands at ${last.fromY}, not ${p.main.top + 251.5}`)
  assert.ok(Math.abs(last.fromY - (p.main.top + MAIN_HEAD + 5 * ROW_H + ROW_H / 2)) > 1, `the dot stands where counting from the head put it: ${last.fromY}`)
  assert.equal(layoutLink({ main: p.main, child, rowIndex: 0, rowCount, gap }), undefined, 'a row the cut removed drew a line')
})

test('a feed with room to spare: the same bottom-counted middle, and not the head-counted one', () => {
  const p = layoutOverview({ stage: { width: 1024, height: 720 }, mainRows: 6, childRows: [3] })
  assert.equal(p.main.rowsRoom, 6, `the window's room came out ${p.main.rowsRoom}`)
  const child = p.children[0]
  const gap = child.left - (p.main.left + p.main.width)
  /* Six rows in a box that holds six: 262 − 0.5 − 20 − 5*24 − 12 = 109.5 below the pane's top. */
  const first = layoutLink({ main: p.main, child, rowIndex: 0, rowCount: 6, gap })
  assert.notEqual(first, undefined, 'the first row drew no line')
  assert.ok(Math.abs(first.fromY - (p.main.top + 109.5)) <= 1, `the dot stands at ${first.fromY}, its row's middle is ${p.main.top + 109.5}`)
  /* Head-counting would have said 96 + 12 = 108 below the top: the frame and the foot leave that
     1.5px blank at the top of the stack even when nothing is cut. */
  assert.ok(Math.abs(first.fromY - (p.main.top + 108)) > 1, 'the dot still stands where counting from the head put it')
  const strip = bandOf(p.main, 0, 6)
  assert.ok(first.fromY > strip.top && first.fromY < strip.bottom, `the dot is outside its row's strip ${strip.top}..${strip.bottom}`)
})

/* ---- the narrowest stages ---------------------------------------------------------------- */

for (const width of [200, 256, 320]) {
  for (const children of [0, 2]) {
    test(`a ${width}px stage with ${children} child(ren): every window narrows with the stage and stays on it`, () => {
      const p = layoutOverview({ stage: { width, height: 720 }, mainRows: 6, childRows: rowsFor(children) })
      const side = sideOf(p)
      for (const box of [p.main, ...p.children]) {
        assert.ok(box.width >= 0, `a window has a negative width: ${box.width}`)
        assert.ok(box.left >= 0, `a window starts left of the stage: ${box.left}`)
        assert.ok(box.left + box.width <= width, `a window runs off the stage's right: ${box.left + box.width} > ${width}`)
        assert.ok(box.top >= 0 && box.top + box.height <= 720, `a window runs off the stage's height: ${box.top}..${box.top + box.height}`)
      }
      const left = p.fieldLeft
      const right = p.fieldLeft + p.fieldWidth
      assert.ok(left >= side, `the group stands at ${left}, on the ${side} it keeps`)
      assert.ok(right <= width - side, `the group runs to ${right}, past ${width - side}`)
      assert.ok(Math.abs((left + right) / 2 - width / 2) <= 1, `the group's middle is ${(left + right) / 2}, the stage's ${width / 2}`)
      assert.ok(Math.abs(left - (width - right)) <= 1, `the gutters are ${left} and ${width - right}, not a pair`)
      /* The window took what the stage had rather than overflowing: never wider than the room it has. */
      assert.ok(p.main.width <= Math.max(0, width - side * 2), `the main window is ${p.main.width} wide in ${width - side * 2} of room`)
      assert.ok(p.main.width > 0, 'the main window vanished')
    })
  }
}

/* ---- the count above the column ----------------------------------------- */

test('the count stands on the column top, its right edge on the column right edge, clear of every window', () => {
  const stage = STAGES[2]
  const p = layoutOverview({ stage: { width: stage.width, height: stage.height }, mainRows: 6, childRows: rowsFor(5) })
  assert.equal(p.children.length, 5, `the column drew ${p.children.length} of five children`)
  const spill = layoutSpill({ children: p.children, hiddenChildren: 2 })
  assert.notEqual(spill, undefined, 'the count was not drawn')
  const columnTop = p.children[0].top
  const columnRight = p.children[0].left + p.children[0].width
  assert.equal(spill.left + spill.width, columnRight, `the count's right edge is ${spill.left + spill.width}, the column's is ${columnRight}`)
  assert.equal(spill.top + spill.height, columnTop - SPILL_GAP, `the count does not keep its ground above the column: ${spill.top + spill.height}`)
  assert.ok(spill.width > 0 && spill.height > 0, `the count has no box: ${spill.width}x${spill.height}`)
  /* On the stage, and clear of every window — the main one included. */
  assert.ok(spill.left >= 0 && spill.top >= 0, `the count starts off the stage: ${spill.left},${spill.top}`)
  assert.ok(spill.left + spill.width <= stage.width, `the count runs off the stage's right: ${spill.left + spill.width}`)
  assert.ok(spill.top + spill.height <= stage.height, `the count runs off the stage's bottom: ${spill.top + spill.height}`)
  for (const box of [p.main, ...p.children]) {
    const apart = spill.left + spill.width <= box.left
      || box.left + box.width <= spill.left
      || spill.top + spill.height <= box.top
      || box.top + box.height <= spill.top
    assert.ok(apart, `the count lies across a window at ${box.left},${box.top}`)
  }
})

test('no count to say, no column to stand on, no ground above it: no badge', () => {
  const p = layoutOverview({ stage: { width: 1440, height: 900 }, mainRows: 6, childRows: rowsFor(5) })
  assert.equal(layoutSpill({ children: p.children, hiddenChildren: 0 }), undefined, 'a badge stood with nothing folded away')
  assert.equal(layoutSpill({ children: [], hiddenChildren: 3 }), undefined, 'a badge stood with no column under it')
  /* The column stood, but the stage gave it less than the badge needs above itself: drawing one there
     would lay it across the first window. */
  const short = layoutOverview({ stage: { width: 1024, height: 200 }, mainRows: 6, childRows: rowsFor(5) })
  assert.ok(short.children.length > 0, 'the short stage drew no column at all')
  assert.ok(short.children[0].top < SPILL_GAP + SPILL_H, `the short stage left ${short.children[0].top} above the column`)
  assert.equal(layoutSpill({ children: short.children, hiddenChildren: 2 }), undefined, 'the badge lay across the first window')
})

test('the main window grows by exactly one row for one more row, and hugs its content while it fits', () => {
  const stage = STAGES[1]
  const three = place(stage, 1, 3)
  const five = place(stage, 1, 5)
  assert.equal(five.main.height - three.main.height, 2 * ROW_H, 'two more rows did not cost exactly two rows of height')
  assert.ok(three.main.rowsRoom >= 3, 'the main window has no room for the rows it was given')
})

test('a child never grows past the rows it actually holds', () => {
  const stage = STAGES[2]
  const p = place(stage, 4)
  const capped = layoutOverview({ stage: { width: stage.width, height: stage.height }, mainRows: 6, childRows: [1, 9, 9, 9] })
  /* The one-row child is shorter than its equal-share siblings, and both keep their rows inside the box. */
  assert.ok(capped.children[0].height < p.children[0].height, 'a one-row child took a share it cannot fill')
  for (const box of capped.children) {
    assert.ok(box.height <= p.children[0].height + 8 * ROW_H, 'a child grew past any content it could have')
    assert.ok(CHILD_HEAD + CHILD_FOOT + BOX_BORDER <= box.height, 'a child lost its own title line')
  }
})

test('a stage too narrow for two windows draws the main window alone', () => {
  const p = place(STAGES[0], 5)
  assert.deepEqual(p.children, [], 'the children column did not leave')
  assert.ok(p.main.width >= 200, 'the main window collapsed')
  /* The rail is a fact about the running children, not about the drawing: five are out, so it exists. */
  assert.equal(p.railVisible, true, 'five running children left no node rail')
})

/* The stage heights a short window gives the pane — below the field's tallest, and below what its
 * old floor assumed: the field takes what the stage gives and not one pixel more. */
const SHORT_HEIGHTS = [200, 260, 300]
const SHORT_WIDTHS = [640, 1024]

for (const width of SHORT_WIDTHS) {
  for (const height of SHORT_HEIGHTS) {
    for (const count of COUNTS) {
      test(`a ${width}x${height} stage, ${count.windows} window(s): the field and every box stay between the stage's two edges`, () => {
        const p = layoutOverview({ stage: { width, height }, mainRows: 6, childRows: rowsFor(count.children) })
        assert.ok(p.fieldHeight <= height, `the field is ${p.fieldHeight} tall on a ${height}px stage`)
        assert.ok(p.fieldTop >= 0, `the field starts above the stage: ${p.fieldTop}`)
        assert.ok(p.fieldTop + p.fieldHeight <= height, `the field ends at ${p.fieldTop + p.fieldHeight}, past ${height}`)
        for (const box of [p.main, ...p.children]) {
          assert.ok(box.height >= 0, `a window has a negative height: ${box.height}`)
          assert.ok(box.top >= 0, `a window starts above the stage: top ${box.top}`)
          assert.ok(box.top + box.height <= height, `a window ends at ${box.top + box.height}, past the stage's ${height}`)
          assert.ok(box.top >= p.fieldTop, `a window starts above the field: top ${box.top}`)
          assert.ok(box.top + box.height <= p.fieldTop + p.fieldHeight, `a window runs past the field's bottom: ${box.top + box.height}`)
        }
        /* The main window still stands on the stage's middle, however short the stage is. */
        assert.ok(
          Math.abs(p.main.top + p.main.height / 2 - height / 2) <= 1,
          `the main window's middle is ${p.main.top + p.main.height / 2}, the stage's ${height / 2}`,
        )
      })
    }
  }
}

test('the node rail exists from two running children, and not before', () => {
  const stage = STAGES[1]
  assert.equal(place(stage, 0).railVisible, false, 'one window alone drew a node rail')
  assert.equal(place(stage, 1).railVisible, false, 'one child drew a node rail')
  assert.equal(place(stage, 2).railVisible, true, 'two children drew no node rail')
})

test('mid stage: no rail bar, at any row count up to the capacity, reaches past the field', () => {
  const p = place(STAGES[1], 2)
  for (let rows = 1; rows <= READING_CAPACITY; rows++) {
    for (const lit of [true, false]) {
      const right = RAIL_LEFT + railBarWidth(rows, lit)
      assert.ok(right <= p.fieldLeft, `a ${lit ? 'lit' : 'dim'} bar of ${rows} rows reaches ${right}, past the field's left edge ${p.fieldLeft}`)
    }
  }
})

test('the widest feed any stage can stand is the capacity the reading is cut to', () => {
  let worst = 1
  for (const stage of STAGES) {
    for (const count of COUNTS) {
      /* The reading hands every window the capacity — the most it may ever hold — so the boxes here
         stand as tall as a feed ever does. If one of them had room for a row more, the capacity
         would be cutting a feed that stands: that is exactly the line this asserts. */
      const p = layoutOverview({
        stage: { width: stage.width, height: stage.height },
        mainRows: READING_CAPACITY,
        childRows: Array.from({ length: count.children }, () => READING_CAPACITY),
      })
      for (const box of [p.main, ...p.children]) worst = Math.max(worst, box.rowsRoom)
    }
  }
  assert.equal(READING_CAPACITY, worst, `a feed stands ${worst} rows, the reading is cut to ${READING_CAPACITY}`)
})

/* ---- the two marks a window's head can carry ---------------------------- */

/** The two window sizes the marks stand on: the main window with its band from 96 to 290, a child from 32 to 130. */
const MARKED = [
  { name: 'main', width: 440, height: 310, head: MAIN_HEAD, foot: MAIN_FOOT },
  { name: 'child', width: 420, height: 142, head: CHILD_HEAD, foot: CHILD_FOOT },
]

test("the completed window's mark stands on the process band's middle, whichever size it takes", () => {
  for (const box of MARKED) {
    /* The band is the process rows' box: from the head to the window's own foot. */
    const bandMiddle = box.head + (box.height - box.foot - box.head) / 2
    const bandMiddleX = (FEED_LEFT + (box.width - FEED_RIGHT)) / 2
    for (const [size, stroke] of [[MARK_CHECK, MARK_CHECK_STROKE], [MARK_FAIL, MARK_FAIL_STROKE]]) {
      const mark = layoutMark({ ...box, size, stroke })
      assert.equal(mark.size, size, `${box.name}: the mark took ${mark.size}, not ${size}`)
      assert.equal(mark.stroke, stroke, `${box.name}: the mark is stroked ${mark.stroke}, not ${stroke}`)
      assert.equal(mark.top + size / 2, bandMiddle, `${box.name}: the mark's middle is ${mark.top + size / 2}, the band's is ${bandMiddle}`)
      assert.equal(mark.left + size / 2, bandMiddleX, `${box.name}: the mark's middle is ${mark.left + size / 2}, the band's is ${bandMiddleX}`)
      assert.ok(mark.left >= 0 && mark.left + size <= box.width, `${box.name}: the mark runs off the pane's width: ${mark.left}..${mark.left + size}`)
      assert.ok(mark.top >= 0 && mark.top + size <= box.height, `${box.name}: the mark runs off the pane's height: ${mark.top}..${mark.top + size}`)
    }
  }
})

test('the two pens read as the design table\'s pixels on screen', () => {
  /* The glyph is drawn in a 12-unit box, so the stroke that lands on screen is stroke × size / 12:
   * the check's 4px at 44 and the failed mark's 2.5px at 20. */
  const pen = (size, stroke) => (stroke * size) / 12
  assert.ok(Math.abs(pen(MARK_CHECK, MARK_CHECK_STROKE) - 4) < 0.05, `the check's pen is ${pen(MARK_CHECK, MARK_CHECK_STROKE)}px, not 4px`)
  assert.equal(pen(MARK_FAIL, MARK_FAIL_STROKE), 2.5, `the failed mark's pen is ${pen(MARK_FAIL, MARK_FAIL_STROKE)}px, not 2.5px`)
})

test("the running ring turns in the child's title-line cell, on the same centre a check would take", () => {
  const ring = layoutRing({ width: 420 })
  const cellMiddleX = 420 - RING_RIGHT - RING_CELL / 2
  const cellMiddleY = RING_TOP + RING_CELL / 2
  assert.equal(ring.size, RING_SIZE, `the ring is ${ring.size} across, not ${RING_SIZE}`)
  assert.equal(ring.left + RING_SIZE / 2, cellMiddleX, `the ring's middle is ${ring.left + RING_SIZE / 2}, the cell's is ${cellMiddleX}`)
  assert.equal(ring.top + RING_SIZE / 2, cellMiddleY, `the ring's middle is ${ring.top + RING_SIZE / 2}, the cell's is ${cellMiddleY}`)
  /* A pane narrower than its own cell keeps the ring inside itself rather than hanging off it. */
  for (const width of [420, 88, 10, 0]) {
    const held = layoutRing({ width })
    assert.ok(held.left >= 0, `the ring starts at ${held.left} on a ${width}px pane`)
    assert.ok(held.left + held.size <= Math.max(width, held.size), `the ring ends at ${held.left + held.size} on a ${width}px pane`)
  }
})
