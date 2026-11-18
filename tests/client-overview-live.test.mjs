/* The overview's live tails on the built panel: the streaming step drawn as rows that follow the
 * animation frame, not the chunk.
 *
 * DSH streams its own conversation out as transient `assistant/live-chunk` entries beside the
 * durable log, and the overview folds those into at most two tail rows per window. The case mounts
 * the built panel the way the shell boots it, holds a sessions service whose event window carries
 * both halves, and walks a stream through it frame by frame:
 *
 * - the think and output rows are the live tails, each the buffer's newest slice: the head of a
 *   long line never renders, and the newest words move with the frames;
 * - a redraw follows the frame, not the chunk: a chunk pushed between frames moves nothing until
 *   the frame lands;
 * - a tail row is one line, and its clip crops at the head, so the newest words stay at the line's
 *   end (the sheet's own rules are pinned beside the computed ones);
 * - the step settling folds the tails into the settled rows' ordinary shape.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/client-overview-live.test.mjs`.
 */
import { readFileSync } from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { cssBlocks, stripComments } from '../tools/lib/cssrules.mjs'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** The record: one node, and the note that names m1 as that node's session. */
const record = () => ({
  '.superworker/ideas.json': json({
    nodes: {
      n0: {
        title: 'the driven node',
        description: 'the piece the main conversation drives',
        tags: [],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-08T00:00:00.000Z',
        completed_at: '2026-01-09T00:00:00.000Z',
        dependencies: [],
      },
    },
  }),
  '.superworker/state.json': json({
    cycles: [
      {
        id: 'c0',
        title: 'a line',
        status: 'active',
        tags: [],
        created_at: '2026-01-08T00:00:00.000Z',
        updated_at: '2026-01-09T00:00:00.000Z',
        policies: {},
        holding: [],
        path: [
          { node: 'n0', started_at: '2026-01-08T00:00:00.000Z', ended_at: '2026-01-09T00:00:00.000Z', result: 'delivered' },
        ],
      },
    ],
  }),
  '.superworker/instructions.json': json({ instructions: [] }),
  '.superworker/issues/issues.json': json({ version: 1, issues: {} }),
  '.superworker/meta/sessions/n0.json': json({ run: [{ session: 'm1', at: '2026-01-09T00:00:00.000Z' }] }),
})

/**
 * A stand-in for DSH's `sessions` service whose windows carry both halves: `set` moves the durable
 * log, `stream` replaces the transient live chunks beside it (DSH retires the chunks at settlement).
 */
function fakeSessionsService() {
  const windows = new Map()
  const stateOf = (id) => {
    let state = windows.get(id)
    if (state === undefined) {
      state = { entries: [], listeners: new Set() }
      windows.set(id, state)
    }
    return state
  }
  const tell = (id) => {
    for (const listener of [...stateOf(id).listeners]) listener()
  }
  return {
    windows,
    retain(id) {
      const state = stateOf(id)
      const source = {
        getSnapshot: () => ({ entries: state.entries, hasMore: false, revision: 0, change: { kind: 'replace', entries: state.entries } }),
        subscribe(listener) {
          state.listeners.add(listener)
          return () => state.listeners.delete(listener)
        },
      }
      return { sessionId: id, binding: { eventSource: source }, ready: Promise.resolve({}), release() {} }
    },
    set(id, events) {
      stateOf(id).entries = events.map((event) => ({ type: 'event', event }))
      tell(id)
    },
    stream(id, chunks) {
      const state = stateOf(id)
      const durable = state.entries.filter((entry) => entry.type === 'event')
      state.entries = [
        ...durable,
        ...chunks.map((chunk, at) => ({
          type: 'transient',
          event: {
            type: 'assistant/live-chunk',
            seq: durable.length + (at + 1) / 10,
            time: 1000 + at,
            data: { turn: 1, step: 1, attemptId: 'attempt-1', chunk },
          },
        })),
      ]
      tell(id)
    },
  }
}

const snapshot = {
  ids: ['m1'],
  byId: { m1: { id: 'm1', running: true, retainedBy: { mainView: 1 }, displayTitle: 'the main conversation' } },
}

const thinkChunk = (text) => ({ type: 'reasoning-delta', index: 0, text })
const speakChunk = (text) => ({ type: 'text-delta', index: 0, text })
/** The step's settlement: the durable message that retires the chunks. */
const settle = (reasoning, spoken) => ({
  type: 'assistant/message',
  time: 5000,
  data: {
    message: {
      content: [
        ...(reasoning === undefined ? [] : [{ type: 'reasoning', text: reasoning }]),
        ...(spoken === undefined ? [] : [{ type: 'text', text: spoken }]),
      ],
    },
  },
})

/** The stage the pane measures: jsdom has no layout engine, so the box is pinned per case. */
const stageAt = async (mounted, width, height) => {
  const body = mounted.container.querySelector('.superworker-overview')
  Object.defineProperty(body, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(body, 'clientHeight', { value: height, configurable: true })
  return mounted.rerender()
}

/** Wait `count` paint opportunities of the mounted window; the forwarding half publishes a live redraw on the third nested one. */
const frames = async (mounted, count) => {
  await mounted.act(async () => {
    await new Promise((resolve) => {
      const step = (rest) => (rest === 0 ? resolve() : mounted.window.requestAnimationFrame(() => step(rest - 1)))
      step(count)
    })
  })
}

const liveRows = (mounted) => mounted.container.querySelectorAll('[data-window="m1"] .superworker-orow.is-live')
const liveTexts = (mounted) => [...mounted.container.querySelectorAll('[data-window="m1"] .superworker-orow.is-live .superworker-orow-live')]
  .map((one) => one.textContent)

test('the streamed step draws the tail rows: the head never renders, the newest words follow the frames', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshot),
  })
  await stageAt(mounted, 1024, 720)
  assert.equal(liveRows(mounted).length, 0, 'a window with no stream drew a tail')

  /* Frame one: a reasoning line long enough that its head is past the tail cut. */
  const head = '从合并这一节往下读，注意每个插件自己声明的域。'
  await mounted.act(async () => {
    service.stream('m1', [thinkChunk(head + '覆盖与缺省要分开存，写回前再看一遍次序。'.repeat(5))])
  })
  await frames(mounted, 4)
  assert.equal(liveRows(mounted).length, 1, 'a reasoning-only stream drew more than the one think tail')
  const first = liveTexts(mounted)[0]
  assert.ok(first.startsWith('思考 · '), 'the think tail does not say its row word')
  assert.ok(!first.includes('从合并'), 'the head of the long line rendered')
  assert.ok(first.endsWith('再看一遍次序。'), 'the tail is not the buffer’s newest slice')

  /* Frame two: the stream moves on, and the spoken half joins it. */
  await mounted.act(async () => {
    service.stream('m1', [
      thinkChunk('覆盖与缺省要分开存，写回前再看一遍次序。'.repeat(5) + '这一节读完了。'),
      speakChunk('条目级合并要认出插件自己声明的域，'),
    ])
  })
  await frames(mounted, 4)
  assert.equal(liveRows(mounted).length, 2, 'the spoken tail did not join the think tail')
  const [think, spoken] = liveTexts(mounted)
  assert.ok(think.endsWith('这一节读完了。'), 'the think tail did not move to the newest words')
  assert.notEqual(think, first, 'the think tail did not change between frames')
  assert.ok(!think.includes('从合并'), 'the frame-one head appeared once the stream grew')
  assert.ok(spoken.startsWith('输出 · '), 'the spoken tail does not say its row word')
  assert.ok(spoken.endsWith('自己声明的域，'), 'the spoken tail is not the newest slice')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a redraw follows the frame, not the chunk', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshot),
  })
  await stageAt(mounted, 1024, 720)

  await mounted.act(async () => {
    service.stream('m1', [speakChunk('第一帧的尾巴。')])
  })
  await frames(mounted, 4)
  assert.ok(liveTexts(mounted)[0].endsWith('第一帧的尾巴。'))

  /* The chunk lands in the window between frames: until the frame crosses, the page still says the
   * old tail — the redraw follows the frame, exactly the cadence the conversation half publishes at. */
  service.stream('m1', [speakChunk('第一帧的尾巴。'), speakChunk('第二帧还没画。')])
  assert.ok(liveTexts(mounted)[0].endsWith('第一帧的尾巴。'), 'a chunk redrew the row before its frame')
  assert.ok(!liveTexts(mounted)[0].includes('第二帧还没画。'), 'the pending chunk rendered early')
  await frames(mounted, 4)
  assert.ok(liveTexts(mounted)[0].endsWith('第二帧还没画。'), 'the frame never carried the pending chunk')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('a tail row is one line, and its clip crops at the head', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshot),
  })
  await stageAt(mounted, 1024, 720)
  await mounted.act(async () => {
    service.stream('m1', [speakChunk('一行之内的尾巴。')])
  })
  await frames(mounted, 4)

  const clip = mounted.container.querySelector('[data-window="m1"] .superworker-orow.is-live .superworker-orow-t')
  assert.notEqual(clip, null, 'the tail row drew no clip')
  const clipStyle = mounted.window.getComputedStyle(clip)
  assert.equal(clipStyle.whiteSpace, 'nowrap', 'the tail row can wrap: it is not one line')
  assert.equal(clipStyle.overflow, 'hidden', 'the tail row does not clip')
  assert.equal(clipStyle.direction, 'rtl', 'the clip does not run the tail-first way')
  assert.equal(clipStyle.textAlign, 'left', 'the tail row lost the settled rows’ alignment')
  const tailStyle = mounted.window.getComputedStyle(clip.querySelector('.superworker-orow-live'))
  assert.equal(tailStyle.direction, 'ltr', 'the tail span does not read its own run')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the sheet says the tail row’s own rules: head-cropped, one line, the tail isolated', () => {
  const sheet = readFileSync(new URL('../src/client/styles/overview.css', import.meta.url), 'utf8')
  const rules = cssBlocks(stripComments(sheet), { descend: 'all' }).filter((block) => block.kind === 'rule')
  /* The one line is the settled row's own clip; the live variant only turns it. */
  const base = rules.find((rule) => rule.prelude.endsWith('.superworker-orow-t') && rule.at === '')
  assert.notEqual(base, undefined, 'no rule clips the feed row text')
  assert.match(base.body, /white-space:\s*nowrap/u, 'the feed row is not pinned to one line')
  assert.match(base.body, /text-overflow:\s*ellipsis/u, 'the feed row has no ellipsis to crop with')

  const clip = rules.find((rule) => rule.prelude.includes('.superworker-orow.is-live .superworker-orow-t') && rule.at === '')
  assert.notEqual(clip, undefined, 'no rule turns a live tail row’s clip')
  assert.match(clip.body, /direction:\s*rtl/u, 'the clip does not run tail-first (head cropped)')
  assert.match(clip.body, /text-align:\s*left/u, 'the clip does not keep the settled alignment')

  const tail = rules.find((rule) => rule.prelude.includes('.superworker-orow-live') && rule.at === '')
  assert.notEqual(tail, undefined, 'no rule isolates the tail run')
  assert.match(tail.body, /direction:\s*ltr/u, 'the tail run is not left-to-right')
  assert.match(tail.body, /unicode-bidi:\s*isolate/u, 'the tail run is not isolated from the flipped clip')
})

test('the step settling folds the tails into the settled rows', { skip: bundleSkip }, async () => {
  const service = fakeSessionsService()
  const mounted = await mountBuiltPanel({
    record: record(),
    sessionsService: service,
    useSessions: (select) => select(snapshot),
  })
  await stageAt(mounted, 1024, 720)
  await mounted.act(async () => {
    service.stream('m1', [thinkChunk('先读先例的最后一小段'), speakChunk('覆盖和缺省分开存的最后一小段')])
  })
  await frames(mounted, 4)
  assert.equal(liveRows(mounted).length, 2, 'the stream drew no tails to fold')

  /* The durable message lands and retires the chunks: the tails fold away into the ordinary rows,
   * whose shape does not move. */
  await mounted.act(async () => {
    service.set('m1', [settle('先读先例。', '条目级合并要认出插件自己声明的域。覆盖和缺省分开存。')])
  })
  assert.equal(liveRows(mounted).length, 0, 'a settled step kept its tails')
  const rows = mounted.container.querySelectorAll('[data-window="m1"] .superworker-orow')
  assert.equal(rows.length, 2, 'the settled rows did not stand alone after the fold')
  assert.equal(rows[0].querySelector('.superworker-orow-live'), null, 'a settled row kept the live tail markup')
  assert.ok(rows[0].textContent.includes('思考 · 先读先例。'), 'the settled think row does not read its sentence cut')
  assert.ok(rows[1].textContent.includes('条目级合并要认出插件自己声明的域。'), 'the settled output row does not read its sentence cut')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})
