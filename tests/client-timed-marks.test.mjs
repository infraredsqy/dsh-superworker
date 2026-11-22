/* The overview's timed-mark registry, run by itself: what one hold promises, and what it may never do.
 *
 * The stations declare a mark and a span; the registry keeps the marks, runs the timers, sheds each
 * mark when its span has run, and clears every timer at the unmount — the cleanup no station writes.
 * What the cases hold down: a mark stands in the very render that arms it and sheds at its span; a
 * re-arm never strips a standing mark and never sheds it at the old span; `shed` and `end` take marks
 * back with nothing that waits on expiry firing; a deadline re-armed at the same moment idles, and
 * one re-armed at a moved moment restarts; and a pane that unmounts mid-span leaves no timer behind.
 *
 * Spans are real clock waits, kept to a few hundred milliseconds; the waits that prove a shed are
 * bounded polls, so a slow machine proves the arrival rather than racing the clock.
 *
 * Runs the panel's own module directly, over a bare page: the registry needs a document to render
 * against, not the built panel. `node --test tests/client-timed-marks.test.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { until } from './helpers/wait.mjs'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://127.0.0.1/', pretendToBeVisual: true })
for (const name of ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage', 'SVGElement', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, name, { value: dom.window[name], configurable: true, writable: true })
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

const { default: React } = await import('react')
const { createRoot } = await import('react-dom/client')
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { act } = React
const { useTimedMarks } = await import('../src/client/timed-marks.ts')

/** One station rendered against the registry: the api, the ids standing at every draw, and the ids expiry answered, each with its moment. */
function station() {
  const fired = []
  const drawn = []
  let live = null
  function Station() {
    const marks = useTimedMarks((id) => { fired.push({ id, at: Date.now() }) })
    live = marks
    drawn.push([...marks.held])
    return null
  }
  const seat = document.createElement('div')
  document.body.appendChild(seat)
  let root = null
  return {
    fired,
    drawn,
    marks: () => live,
    async mount() {
      root = createRoot(seat)
      await act(async () => { root.render(React.createElement(Station)) })
    },
    async unmount() {
      await act(async () => { root.unmount() })
      seat.remove()
    },
    /** Hold, shed or end inside an act, so the draw the call lands reads it. */
    async run(step) {
      await act(async () => { step(live) })
    },
  }
}

/** Wait `ms` of wall clock inside an act: the timers that come due during the wait fire and draw. */
const during = async (station, ms) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
  return station
}

/**
 * Wait for a shed the way `client-overview`'s `across` does: while the poll runs, the flag that
 * names this a test-only act environment stands down — the shed the registry's own timer lands is
 * production work, not an act, and React would otherwise report the update as one outside the act.
 */
const across = async (check, what) => {
  const actEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT
  globalThis.IS_REACT_ACT_ENVIRONMENT = false
  try {
    await until(check, what)
  } finally {
    globalThis.IS_REACT_ACT_ENVIRONMENT = actEnvironment
  }
}

test('a mark stands in the draw that arms it and sheds when its span has run', async () => {
  const one = station()
  await one.mount()
  await one.run((marks) => marks.hold(['a'], 200))
  assert.deepEqual([...one.marks().held], ['a'], 'the armed mark was not standing in the very next draw')
  await during(one, 100)
  assert.ok(one.marks().held.has('a'), 'the mark fell off before its span had run')
  await across(() => !one.marks().held.has('a'), 'the mark to shed at its span')
  assert.deepEqual(one.fired.map((one) => one.id), ['a'], 'expiry did not answer with the shed id')
  await during(one, 100)
  await one.unmount()
  assert.deepEqual(one.drawn.at(-1), [], 'the shed mark was still standing at the last draw')
})

test('a re-arm never strips a standing mark, and the span starts over', async () => {
  const one = station()
  await one.mount()
  await one.run((marks) => marks.hold(['a'], 200))
  await during(one, 80)
  await one.run((marks) => marks.hold(['a'], 200))
  /* The first span's end has gone by: a re-arm that shed at the old span, or stripped the mark on
   * the way, would have lost it here. */
  await during(one, 160)
  assert.ok(one.marks().held.has('a'), 'the re-arm stripped a standing mark or shed it at the old span')
  assert.equal(one.fired.length, 0, 'expiry answered for a mark that never shed')
  await across(() => !one.marks().held.has('a'), 'the re-armed mark to shed at its own span')
  assert.deepEqual(one.fired.map((one) => one.id), ['a'], 'the re-arm shed twice or never')
  await one.unmount()
  /* Every draw between the arm and the shed carried the mark: a re-arm blinks nothing. */
  const sinceArm = one.drawn.slice(1, -1)
  assert.ok(sinceArm.length > 0, 'the mark never drew')
  assert.ok(sinceArm.every((held) => held.includes('a')), `a draw between arm and shed lost the mark: ${JSON.stringify(one.drawn)}`)
})

test('shed and end take marks back with nothing that waits on expiry firing', async () => {
  const one = station()
  await one.mount()
  await one.run((marks) => { marks.hold(['a'], 400); marks.hold(['b'], 400) })
  await during(one, 60)
  await one.run((marks) => marks.shed(['a']))
  assert.ok(!one.marks().held.has('a'), 'the shed mark kept standing')
  assert.ok(one.marks().held.has('b'), 'shedding one mark took its neighbour with it')
  await one.run((marks) => marks.end())
  assert.deepEqual([...one.marks().held], [], 'end left marks standing')
  await during(one, 420)
  assert.equal(one.fired.length, 0, 'expiry answered for marks that were taken back, not shed by their spans')
  await one.unmount()
})

test('holdUntil idles at the moment it already waits on, and restarts when the moment moves', async () => {
  const one = station()
  await one.mount()
  /* The timer-only face: the wait's shed answers expiry, and the standing is the station's own
   * reading — `held` names the marks `hold` keeps. */
  const armAt = Date.now()
  const fixed = armAt + 250
  await one.run((marks) => marks.holdUntil(['a'], () => fixed))
  await during(one, 90)
  await one.run((marks) => marks.holdUntil(['a'], () => fixed))
  /* The re-arm drew under the wait naming the same moment: an idle re-arm sheds at the first arm's
   * moment; a re-arm that restarted would shed past 340 — the bound only an idle re-arm meets. */
  await across(() => one.fired.length === 1, 'the wait to shed at the moment it was first armed for')
  assert.ok(one.fired[0].at - armAt < 340, `the re-arm restarted an idle wait: shed at ${String(one.fired[0].at - armAt)}ms`)

  const restartAt = Date.now()
  const moved = restartAt + 300
  await one.run((marks) => marks.holdUntil(['a'], () => moved))
  await during(one, 200)
  assert.equal(one.fired.length, 1, 'the moved wait shed before its moved moment')
  await across(() => one.fired.length === 2, 'the moved wait to shed at its moved moment')
  assert.ok(one.fired[1].at - restartAt >= 280, `the moved wait shed early: ${String(one.fired[1].at - restartAt)}ms after it moved`)
  await one.unmount()
})

test('a station that unmounts mid-span leaves no timer behind', async () => {
  const one = station()
  await one.mount()
  await one.run((marks) => { marks.hold(['a'], 300); marks.hold(['b'], 600); marks.holdUntil(['c'], () => Date.now() + 500) })
  await during(one, 80)
  await one.unmount()
  await during(one, 620)
  assert.equal(one.fired.length, 0, 'a timer outlived its pane: expiry answered after the unmount')
})
