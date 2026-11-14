/* The overview's layout, as numbers: given the window count, each window's rows, and a stage size,
 * the placement answers with boxes — and the boxes hold the two lines nothing may cross.
 *
 * Nothing here pins a formula: every assertion is an invariant a reader can check off the drawing —
 * nothing off the stage, nothing on the rail's lane, the rail's own bars never past its edge, the
 * children one column that neither overlaps the main window nor grows past its content, the main
 * window taller by exactly one row's height for one more row, and the narrow stage drawing the
 * main window alone.
 *
 *   node --test tests/overview-geom.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHILD_HEAD,
  CHILD_FOOT,
  BOX_BORDER,
  FIELD_PAD,
  GAP_Y,
  PLATE_OUT,
  RAIL_LANE,
  RAIL_LEFT,
  READING_CAPACITY,
  ROW_H,
  layoutOverview,
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

for (const stage of STAGES) {
  for (const count of COUNTS) {
    test(`${stage.name} stage, ${count.windows} window(s): every box stays on the stage and off the rail's lane`, () => {
      const p = place(stage, count.children)
      const boxes = [p.main, ...p.children]
      for (const box of boxes) {
        assert.ok(box.top >= p.fieldTop, `a window starts above the field: top ${box.top}`)
        assert.ok(box.top + box.height <= p.fieldTop + p.fieldHeight, `a window runs past the field's bottom: ${box.top + box.height}`)
        assert.ok(box.top + box.height <= stage.height, `a window runs off the stage's bottom: ${box.top + box.height}`)
        assert.ok(box.left >= RAIL_LANE, `a window sits on the rail's lane: left ${box.left}`)
        assert.ok(box.left + box.width <= stage.width - FIELD_PAD, `a window runs off the stage's right: ${box.left + box.width}`)
      }
      /* The nameplate probes left of the main window's edge, and the probe stops at the lane. */
      assert.ok(p.plateOut >= 0 && p.plateOut <= PLATE_OUT, `the probe is out of range: ${p.plateOut}`)
      assert.ok(p.main.left - p.plateOut >= RAIL_LANE, `the nameplate crosses into the rail's lane: ${p.main.left - p.plateOut}`)
    })

    test(`${stage.name} stage, ${count.windows} window(s): the children stand in one column, never over the main window`, () => {
      const p = place(stage, count.children)
      if (p.children.length === 0) return
      const n = p.children.length
      assert.equal(n, count.children, `the column draws ${n} of ${count.children} children`)
      for (let i = 1; i < n; i++) {
        const up = p.children[i - 1]
        const box = p.children[i]
        assert.equal(box.left, up.left, 'the children are not one column')
        assert.equal(box.width, up.width, 'the children do not share one width')
        assert.equal(box.top, up.top + up.height + GAP_Y, `child ${i} overlaps or drifts from the one above it`)
      }
      const first = p.children[0]
      assert.ok(first.width < p.main.width, 'a child is not narrower than the main window')
      assert.ok(first.left >= p.main.left + p.main.width, 'a child sits over the main window')
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
      const p = place(stage, count.children)
      for (const box of [p.main, ...p.children]) worst = Math.max(worst, box.rowsRoom)
    }
  }
  assert.ok(READING_CAPACITY >= worst, `the capacity ${READING_CAPACITY} cut a feed that stands ${worst} rows`)
})
