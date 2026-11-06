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
  '.pf/ideas.json': json({
    nodes: {
      n1: {
        title: '起头那一格',
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-02T00:00:00.000Z',
        dependencies: [],
      },
      n2: {
        title: '等它那一格',
        mode: 'auto',
        status: 'todo',
        created_at: '2026-01-04T00:00:00.000Z',
        dependencies: ['n1'],
      },
    },
  }),
  '.pf/state.json': json({
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

/** The map's two surfaces, after pressing its tab: the pane the gestures land on, and the canvas they move. */
async function fieldAndCanvas(mounted) {
  const { window, act, container, settle } = mounted
  const mapTab = mounted.tabs().find((tab) => tab.getAttribute('aria-controls') === 'pane-map')
  assert.notEqual(mapTab, undefined, '地图那一格不在标签栏上')
  await act(async () => { mapTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const field = container.querySelector('.pf-field')
  const canvas = container.querySelector('.pf-canvas')
  assert.notEqual(field, null, '地图的画布区不在')
  assert.notEqual(canvas, null, '地图的画布不在')
  return { field, canvas }
}

test('触摸拖一下：画布跟着走，这一下也被拦下', { skip: bundleSkip }, async () => {
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
    assert.equal(gestureHeld, false, 'touchmove 没被拦下（preventDefault 没调）：浏览器的手势会半路夺走这根手指')
    assert.notEqual(canvas.style.transform, cameraBefore, '触摸拖了一下，画布没动')
  } finally {
    await mounted.unmount()
  }
})

test('双指张开：镜头缩放且跟着两指中点走，这一下也被拦下', { skip: bundleSkip }, async () => {
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
    assert.equal(spreadHeld, false, '捏合的 touchmove 没被拦下：浏览器的页面缩放会把它抢走')
    assert.notEqual(canvas.style.transform, cameraBefore, '双指张开，镜头没有缩放')
  } finally {
    await mounted.unmount()
  }
})
