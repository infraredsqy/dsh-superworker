/* The map's gesture wiring (src/client/map.tsx): one finger on the field pans the drawing and holds
 * the gesture; two fingers pinch — the camera scales around the midpoint and rides its travel.
 *
 * Rendered from the built panel, then the map pane is opened and the field and the canvas are read
 * off it: this is the map's touch road, and it is judged by two readings only — the move is
 * prevented (an unprevented move is the browser handing the finger to its own scroll or page zoom,
 * which is how a pan dies mid-drag on iPad Safari), and the camera actually moved. A tap sends no
 * touchmove, so pressing a card stays a press; that road is walked by hand on a real touch screen.
 * What the drawing says is `map-layout`'s business, not this file's.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/` without that build and
 * this file skips itself, saying so.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** Two cells on one line, the first delivered: a drawing to pan and pinch. */
const record = () => ({
  '.superworker/ideas.json': json({
    nodes: {
      n1: {
        title: 'the starting cell',
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-02T00:00:00.000Z',
        dependencies: [],
      },
      n2: {
        title: 'the cell waiting on it',
        mode: 'auto',
        status: 'todo',
        created_at: '2026-01-04T00:00:00.000Z',
        dependencies: ['n1'],
      },
    },
  }),
  '.superworker/state.json': json({
    cycles: [
      {
        id: 'c1',
        status: 'active',
        updated_at: '2026-01-06T00:00:00.000Z',
        holding: [],
        path: [{ node: 'n1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-02T00:00:00.000Z', result: 'delivered' }],
      },
    ],
  }),
})

/** One touch event carrying the given fingers (`[identifier, [x, y]]` each), the way a browser announces a touch. */
function touchAt(window, type, fingers) {
  const event = new window.Event(type, { bubbles: true, cancelable: true })
  const at = (identifier, [x, y]) => ({ identifier, clientX: x, clientY: y })
  const touches = fingers.map(([identifier, point]) => at(identifier, point))
  Object.defineProperty(event, 'touches', { value: touches })
  Object.defineProperty(event, 'changedTouches', { value: type === 'touchmove' ? [] : touches })
  return event
}

/** The map's two surfaces, after opening the board: the field the gestures land on, and the canvas they move. */
async function fieldAndCanvas(mounted) {
  const { window, act, container, settle } = mounted
  const boardTab = mounted.tabs().find((tab) => tab.getAttribute('aria-controls') === 'pane-nodes')
  assert.notEqual(boardTab, undefined, 'the board tab is not in the tab strip')
  await act(async () => { boardTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const field = container.querySelector('.superworker-field')
  const canvas = container.querySelector('.superworker-canvas')
  assert.notEqual(field, null, 'the map field is missing')
  assert.notEqual(canvas, null, 'the map canvas is missing')
  return { field, canvas }
}

test('a one-finger drag: the drawing follows and the move is prevented', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  try {
    const { field, canvas } = await fieldAndCanvas(mounted)
    const cameraBefore = canvas.style.transform

    /* A drag carries the drawing and holds the gesture: the touchmove is prevented, which is what
     * keeps iPad Safari from handing the same finger to its own scroll and cancelling the pan a few
     * moves in. */
    let gestureHeld
    await mounted.act(async () => {
      field.dispatchEvent(touchAt(mounted.window, 'touchstart', [[7, [40, 40]]]))
      gestureHeld = field.dispatchEvent(touchAt(mounted.window, 'touchmove', [[7, [160, 40]]]))
      field.dispatchEvent(touchAt(mounted.window, 'touchend', [[7, [160, 40]]]))
    })
    assert.equal(gestureHeld, false, 'touchmove was not prevented (preventDefault not called): the browser gesture takes the finger mid-drag')
    assert.notEqual(canvas.style.transform, cameraBefore, 'a touch drag happened but the canvas did not move')
  } finally {
    await mounted.unmount()
  }
})

/**
 * Lay the field out where a real page holds it. jsdom measures every element as a zero box, and this
 * drawing is not at the page's corner: the page's own gutter stands to its left, so a field laid out
 * here is the everyday iPad case, and the one a pinch has to answer to.
 */
function laidOut(field, { left, top, width = 800, height = 600 }) {
  const box = { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }
  field.getBoundingClientRect = () => box
}

/** The camera the canvas is carrying: `translate(tx, ty) scale(s)`, in the field's own coordinates. */
function cameraOf(canvas) {
  const found = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(canvas.style.transform)
  assert.notEqual(found, null, `the canvas carries no camera: ${canvas.style.transform}`)
  return { tx: Number(found[1]), ty: Number(found[2]), s: Number(found[3]) }
}

test('a pinch pivots on the fingers wherever the field stands on the page', { skip: bundleSkip }, async () => {
  /* The camera holds the drawing from the field's own origin, so the fingers have to be read there
   * too. Read in the page's coordinates instead — the field's `left` left in — and the pivot lands a
   * field-offset away from the fingers: the drawing slides out from under the pinch as it opens,
   * which is the whole of "the zoom is not centred on my fingers". */
  const mounted = await mountBuiltPanel({ record: record() })
  try {
    const boardTab = mounted.tabs().find((tab) => tab.getAttribute('aria-controls') === 'pane-nodes')
    const field = mounted.container.querySelector('.superworker-field')
    assert.notEqual(field, null, 'the map field is missing')
    /* Laid out before the tab is pressed: the drawing measures itself when it becomes the visible
     * one. The 194 is the page's gutter plus the canvas's own inset; any non-zero left is the point,
     * and this one is the everyday width. */
    const fieldBox = { left: 194, top: 72 }
    laidOut(field, fieldBox)
    await mounted.act(async () => { boardTab.dispatchEvent(new mounted.window.MouseEvent('click', { bubbles: true })) })
    await mounted.settle()
    const canvas = mounted.container.querySelector('.superworker-canvas')

    const before = cameraOf(canvas)
    assert.ok(before.s > 0, 'the pane opened with no camera')
    /* The fingers' midpoint, and the ground of the drawing that stands under it, both in the page's
     * coordinates — the one frame in which "under the fingers" means anything. */
    const mid = { x: 494, y: 372 }
    const under = (mid.x - fieldBox.left - before.tx) / before.s

    await mounted.act(async () => {
      field.dispatchEvent(touchAt(mounted.window, 'touchstart', [[3, [394, 372]], [4, [594, 372]]]))
      field.dispatchEvent(touchAt(mounted.window, 'touchmove', [[3, [294, 372]], [4, [694, 372]]]))
      field.dispatchEvent(touchAt(mounted.window, 'touchend', [[3, [294, 372]], [4, [694, 372]]]))
    })
    const after = cameraOf(canvas)
    assert.ok(after.s > before.s, `the spread did not zoom in: ${String(before.s)} → ${String(after.s)}`)

    /* The same ground, where the camera puts it now: it must still be under the fingers. The axis
     * pinned here is the horizontal one — the one the field's own left edge offsets, and the one
     * every iPad session has — because at this drawing's size the camera's own bounds hold the
     * vertical one still. */
    const landed = fieldBox.left + under * after.s + after.tx
    assert.ok(Math.abs(landed - mid.x) < 0.5, `the zoom pivoted ${(landed - mid.x).toFixed(1)}px off the fingers: the ground they pinched slid sideways`)
  } finally {
    await mounted.unmount()
  }
})

test('a two-finger spread: the camera scales around the midpoint and the move is prevented', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  try {
    const { field, canvas } = await fieldAndCanvas(mounted)
    const cameraBefore = canvas.style.transform

    let spreadHeld
    await mounted.act(async () => {
      field.dispatchEvent(touchAt(mounted.window, 'touchstart', [[3, [200, 200]], [4, [280, 200]]]))
      spreadHeld = field.dispatchEvent(touchAt(mounted.window, 'touchmove', [[3, [160, 200]], [4, [320, 200]]]))
      field.dispatchEvent(touchAt(mounted.window, 'touchend', [[3, [160, 200]], [4, [320, 200]]]))
    })
    assert.equal(spreadHeld, false, 'the pinch touchmove was not prevented: the browser page zoom would take it')
    assert.notEqual(canvas.style.transform, cameraBefore, 'a two-finger spread happened but the camera did not scale')
  } finally {
    await mounted.unmount()
  }
})
