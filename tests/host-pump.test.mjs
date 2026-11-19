/* The panel's one channel (`src/host/pump.ts`): what wakes it, what it sends, and what it will not
 * send twice.
 *
 * What is pinned here is the contract every pane leans on — the first frame arrives without anything
 * changing, a change to the records sends exactly one more, an unchanged reading sends nothing even
 * when a notice fires, a failed read rides its refusal on a frame instead of killing the stream, and
 * cancelling the stream gives the workspace back. Nothing here polls: every wait is a fact arriving
 * (or, for the negative one, an honest stretch of "still nothing").
 *
 *   node --test tests/
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecordsPump } from '../src/host/pump.ts'
import { drainFor, until } from './helpers/wait.mjs'

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** A workspace with a record directory to watch: the watcher needs the directory to exist to arm. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'superworker-pump-'))
  roots.push(root)
  const dir = join(root, '.superworker')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ideas.json'), '{"nodes":{},"edges":[]}')
  return { root, dir }
}

/** The host's event surface, as far as the pump listens to it: `on`, and a way to fire. */
function fakeBus() {
  const listeners = new Map()
  return {
    ctx: {
      on(event, listener) {
        const held = listeners.get(event)
        if (held === undefined) listeners.set(event, [listener])
        else held.push(listener)
        return () => undefined
      },
    },
    fire(event) {
      for (const listener of listeners.get(event) ?? []) listener({ id: 'session-x' }, { type: event })
    },
  }
}

/**
 * A reader whose answer the case steers: `state.mark` is what the frame carries, `state.fails` makes
 * the read refuse. The stamp the pump compares is built from the frame, so a case can prove "one more
 * frame" without touching the disk, and prove the filesystem wake in a case of its own.
 */
function steered(root, state) {
  return async () => {
    if (state.fails) throw new Error('the records could not be read')
    return { workspaceRoot: root, at: Date.now(), reading: { mark: state.mark }, sessions: null }
  }
}

test('the first frame goes out before anything changes, and a real file change sends exactly one more', async () => {
  const { root, dir } = workspace()
  const { ctx } = fakeBus()
  const pump = new RecordsPump(ctx)
  const controller = new AbortController()
  writeFileSync(join(dir, 'mark.txt'), 'one')
  /* This reader answers off the disk, which is the whole point of the case: the wake under test is the
   * directory watch, and a reading that ignored the file could never show it arrived. */
  const read = async () => ({ workspaceRoot: root, at: Date.now(), reading: { mark: readFileSync(join(dir, 'mark.txt'), 'utf8') }, sessions: null })
  const frames = []
  const run = (async () => {
    for await (const frame of pump.follow(root, read, controller.signal)) frames.push(frame)
  })()
  try {
    await until(() => frames.length === 1, 'the first frame, sent without waiting for a change')
    assert.equal(frames[0].reading.mark, 'one')
    /* A word writing a record: the directory watch is the one signal that speaks for any writer. */
    writeFileSync(join(dir, 'mark.txt'), 'two')
    await until(() => frames.length === 2, 'a frame after the records changed on disk')
    assert.equal(frames[1].reading.mark, 'two', 'the frame did not carry the changed reading')
    await drainFor(300)
    assert.equal(frames.length, 2, 'an unchanged reading sent a second frame')
  } finally {
    controller.abort()
    await run
    pump.dispose()
  }
})

test('a session notice wakes it, and a reading that did not change sends nothing', async () => {
  const { root } = workspace()
  const bus = fakeBus()
  const pump = new RecordsPump(bus.ctx)
  const controller = new AbortController()
  const state = { mark: 'one', fails: false }
  const frames = []
  const run = (async () => {
    for await (const frame of pump.follow(root, steered(root, state), controller.signal)) frames.push(frame)
  })()
  try {
    await until(() => frames.length === 1, 'the first frame')
    /* The same reading, woken on purpose: the panel must not redraw for a notice that changed nothing. */
    bus.fire('session/event')
    await drainFor(300)
    assert.equal(frames.length, 1, 'a notice that left the reading the same sent a frame anyway')
    state.mark = 'two'
    bus.fire('session/event')
    await until(() => frames.length === 2, 'a frame after the reading really changed')
    assert.equal(frames[1].reading.mark, 'two')
  } finally {
    controller.abort()
    await run
    pump.dispose()
  }
})

test('a read that refuses is one frame carrying the refusal, and the stream stays open', async () => {
  const { root } = workspace()
  const bus = fakeBus()
  const pump = new RecordsPump(bus.ctx)
  const controller = new AbortController()
  const state = { mark: 'one', fails: false }
  const frames = []
  const run = (async () => {
    for await (const frame of pump.follow(root, steered(root, state), controller.signal)) frames.push(frame)
  })()
  try {
    await until(() => frames.length === 1, 'the first frame')
    state.fails = true
    bus.fire('session/disposed')
    await until(() => frames.length === 2, 'a refusal frame')
    assert.equal(frames[1].reading, null, 'a refused read answered with a reading')
    assert.equal(frames[1].failure.code, 'unreadable')
    assert.match(frames[1].failure.detail, /could not be read/, 'the far side\'s own words did not ride the frame')
    /* The stream does not die on one bad read: the next notice reads again. */
    state.fails = false
    state.mark = 'back'
    bus.fire('session/event')
    await until(() => frames.length === 3, 'a frame after the read could happen again')
    assert.equal(frames[2].reading.mark, 'back')
  } finally {
    controller.abort()
    await run
    pump.dispose()
  }
})

test('cancelling the stream ends the loop and gives the workspace back', async () => {
  const { root } = workspace()
  const { ctx } = fakeBus()
  const pump = new RecordsPump(ctx)
  const controller = new AbortController()
  const state = { mark: 'one', fails: false }
  const frames = []
  const run = (async () => {
    for await (const frame of pump.follow(root, steered(root, state), controller.signal)) frames.push(frame)
  })()
  await until(() => frames.length === 1, 'the first frame')
  controller.abort()
  await run
  await drainFor(200)
  assert.equal(frames.length, 1, 'a frame arrived after the stream was cancelled')
})

/**
 * A frame held the way the carrier holds one: the consumer takes it and does not come back for the
 * next until the gate opens. That stretch is where a real frame is crossing to the browser, and the
 * follower is registered as a waiter for none of it — so it is the one window a notice can fall
 * into. `for await` alone never opens this window: it asks for the next frame on the same beat.
 */
function heldConsumer(pump, root, read, signal) {
  const frames = []
  let open
  const shipped = new Promise((resolve) => {
    open = resolve
  })
  let holding = false
  const run = (async () => {
    for await (const frame of pump.follow(root, read, signal)) {
      frames.push(frame)
      if (!holding) {
        holding = true
        await shipped
      }
    }
  })()
  return { frames, run, ship: () => open() }
}

test('a notice that lands while a frame is in flight is not lost: the follower finds it on the way back', async () => {
  const { root } = workspace()
  const bus = fakeBus()
  const pump = new RecordsPump(bus.ctx)
  const controller = new AbortController()
  const state = { mark: 'one', fails: false }
  const held = heldConsumer(pump, root, steered(root, state), controller.signal)
  try {
    await until(() => held.frames.length === 1, 'the first frame')
    /* The panel is holding that first frame. The pipeline writes its records right now — which is
     * exactly what happens to a panel opened while a run is starting. */
    state.mark = 'two'
    pump.stir(root)
    /* Long enough for the coalesce timer to fire while nobody is registered as a waiter at all. */
    await drainFor(300)
    assert.equal(held.frames.length, 1, 'a frame arrived while the consumer had not asked for one')
    /* The frame finished crossing; the follower comes back for the next one. */
    held.ship()
    await until(() => held.frames.length === 2, 'the notice that landed mid-frame, answered on the way back')
    assert.equal(held.frames[1].reading.mark, 'two', 'the follower slept through a notice it was not awake for')
  } finally {
    controller.abort()
    held.ship()
    await held.run
    pump.dispose()
  }
})

test('two panels on one workspace both stay current, even when one is mid-frame as the notice lands', async () => {
  const { root } = workspace()
  const bus = fakeBus()
  const pump = new RecordsPump(bus.ctx)
  const controller = new AbortController()
  const state = { mark: 'one', fails: false }
  /* One window holding a frame, one window idle and waiting: a wake reaches the waiting one, and
   * the holding one has to find the notice itself. Both are the same workspace and the same root. */
  const held = heldConsumer(pump, root, steered(root, state), controller.signal)
  const idle = []
  const other = (async () => {
    for await (const frame of pump.follow(root, steered(root, state), controller.signal)) idle.push(frame)
  })()
  try {
    await until(() => held.frames.length === 1 && idle.length === 1, 'the first frame in both windows')
    state.mark = 'two'
    bus.fire('session/event')
    await until(() => idle.length === 2, 'the waiting window saw the change')
    held.ship()
    await until(() => held.frames.length === 2, 'the window that was mid-frame saw the change too')
    assert.equal(held.frames[1].reading.mark, 'two', 'one window got the notice and the other lost it')
  } finally {
    controller.abort()
    held.ship()
    await Promise.all([held.run, other])
    pump.dispose()
  }
})

test('disposing the pump stops every wake, so an unloaded line leaves nothing armed', async () => {
  const { root, dir } = workspace()
  const { ctx } = fakeBus()
  const pump = new RecordsPump(ctx)
  const controller = new AbortController()
  const state = { mark: 'one', fails: false }
  const frames = []
  const run = (async () => {
    for await (const frame of pump.follow(root, steered(root, state), controller.signal)) frames.push(frame)
  })()
  await until(() => frames.length === 1, 'the first frame')
  pump.dispose()
  writeFileSync(join(dir, 'cycles.json'), '{"cycles":[]}')
  await drainFor(250)
  assert.equal(frames.length, 1, 'the watcher was still armed after the pump was disposed')
  controller.abort()
  await run
})
