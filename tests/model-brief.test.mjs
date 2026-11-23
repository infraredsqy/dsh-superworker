/* The concise drawing's reading: which rows become one step, and which become one answer.
 *
 * What comes in is the rows the full feed already draws plus whether the conversation still runs;
 * what comes out is one line per run of work and one per answer. The cases below pin the rules the
 * drawing rests on: a step is a run of adjacent process rows and an answer or a prompt closes it;
 * its categories are DSH's own classification, ranked by count and then by first appearance; a
 * failure and a run's output join the step without adding a category; a prompt draws no line at all;
 * and the last step of a conversation that still runs is open, which is the one fact that makes its
 * words the running ones.
 *
 *   node --test tests/model-brief.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { briefRowsOf } from '../src/model/index.ts'

/* ---- the rows, shaped the way the fold writes them ------------------------ */

/** A settled reasoning row. */
function think(text, at) {
  return { kind: 'think', text, full: text, at }
}

/** A settled call: the tool it names, and the category DSH's classification reads off that name. */
function call(kind, name, at, callId = `call-${at}`) {
  return { kind, text: name, full: name, name, at, callId }
}

/** A settled answer. */
function said(text, at) {
  return { kind: 'output', text, full: text, at }
}

/** A person's prompt. */
function asked(text, at) {
  return { kind: 'input', text, full: text, at }
}

/** The lines of one window, read as the pane reads them. */
function lines(rows, running = false) {
  return briefRowsOf({ rows, running })
}

/* ---- a step, an answer, and where one ends ------------------------------- */

test('a run of process rows is one step, and an answer is one line', () => {
  const out = lines([
    think('先看看这两个文件', 1),
    call('read', 'read', 2),
    call('run', 'bash', 3),
    said('两处都补好了。', 4),
  ])
  assert.deepEqual(out.map((one) => one.kind), ['step', 'reply'])
  assert.deepEqual(out[0].categories, ['read', 'commands'], 'the step did not rank its two calls')
  assert.deepEqual([out[0].from, out[0].to], [0, 2], 'the step does not cover the rows it folds')
  assert.equal(out[1].text, '两处都补好了。')
})

test('a prompt closes the step above it and draws no line of its own', () => {
  const out = lines([think('一件事', 1), asked('再说一件', 2), think('好', 3)])
  assert.deepEqual(out.map((one) => one.kind), ['step', 'step'], 'the prompt was drawn, or did not close the step')
  assert.deepEqual(out.map((one) => one.to), [0, 2])
})

test('an answer closes the step above it', () => {
  const out = lines([think('想', 1), call('read', 'read', 2), said('说', 3), think('再想', 4)])
  assert.deepEqual(out.map((one) => one.kind), ['step', 'reply', 'step'])
  assert.equal(out[0].open, false, 'a step with an answer under it was read as still being worked')
})

/* ---- what a step is on now ----------------------------------------------- */

test('the last step of a conversation that still runs is open, on the tool it reached for last', () => {
  const out = lines([think('想', 1), call('run', 'bash', 2)], true)
  assert.equal(out[0].open, true)
  assert.equal(out[0].now, 'commands')
})

test('the same rows on a stopped conversation are closed', () => {
  const out = lines([think('想', 1), call('run', 'bash', 2)], false)
  assert.equal(out[0].open, false)
  assert.equal(out[0].now, null)
})

test('an open step whose newest row is reasoning is on nothing in particular', () => {
  const out = lines([
    call('run', 'bash', 1),
    { kind: 'think', text: '正在写的想法', full: '正在写的想法', live: true },
  ], true)
  assert.equal(out[0].open, true)
  assert.equal(out[0].now, null, 'a reasoning tail was read as a call')
})

test('a run\'s output row answers the command above it rather than starting a call', () => {
  const out = lines([
    call('run', 'bash', 1),
    { kind: 'run', text: 'ok', full: 'ok', at: 2 },
  ], true)
  assert.deepEqual(out[0].categories, ['commands'], 'the result row was counted as a second call')
  assert.equal(out[0].now, 'commands')
})

/* ---- the categories: DSH's own classification ---------------------------- */

test('a failed call joins the step and adds no category of its own', () => {
  const out = lines([
    call('run', 'bash', 1),
    { kind: 'fail', text: 'exit 1', full: 'exit 1', at: 2 },
  ])
  assert.equal(out.length, 1, 'the failure drew a line of its own')
  assert.deepEqual(out[0].categories, ['commands'])
})

test('the ranking is by count, and ties by first appearance', () => {
  const out = lines([
    call('read', 'read', 1),
    call('read', 'read', 2),
    call('run', 'bash', 3),
    call('tool', 'grep', 4),
  ])
  assert.deepEqual(out[0].categories, ['read', 'commands', 'search'], 'the ranking is not count-then-first-seen')
})

test('the tools DSH groups together are grouped here too', () => {
  const out = lines([
    call('tool', 'grep', 1),
    call('read', 'read_image', 2),
    call('write', 'edit', 3),
    call('write', 'str_replace_editor', 4),
  ])
  /* `str_replace_editor` is a write in this panel's own row vocabulary and an unknown tool in DSH's
     classification, which files it under `tools`: the words follow DSH, and the row kind does not. */
  assert.deepEqual(out[0].categories, ['search', 'readImage', 'edit', 'tools'])
})

test('a dispatch is a dispatch, this panel\'s own tool included', () => {
  const out = lines([call('dispatch', 'subagent', 1), call('dispatch', 'ralph', 2)])
  assert.deepEqual(out[0].categories, ['subagents'])
})

test('a step that only reasoned has no category at all', () => {
  const out = lines([think('想', 1)])
  assert.deepEqual(out[0].categories, [])
  assert.equal(out[0].open, false)
})

/* ---- the streaming step -------------------------------------------------- */

test('a streaming answer is read from the head of its buffer', () => {
  const out = lines([
    { kind: 'output', text: '…最后几个字', full: '第一行\n第二行  还有空格', live: true },
  ], true)
  assert.equal(out[0].kind, 'reply')
  assert.equal(out[0].text, '第一行 第二行 还有空格', 'a live answer was read from its tail, or its whitespace was kept')
})

/* ---- identity ------------------------------------------------------------ */

test('a step keeps its key while it grows, and two lines never share one', () => {
  const grown = lines([think('想', 1), call('read', 'read', 2)])
  const later = lines([think('想', 1), call('read', 'read', 2), call('run', 'bash', 3)])
  assert.equal(grown[0].key, later[0].key, 'the step was re-keyed when a row landed, so it would remount')
  const out = lines([think('想', 1), said('说', 1)])
  assert.equal(new Set(out.map((one) => one.key)).size, out.length)
})
