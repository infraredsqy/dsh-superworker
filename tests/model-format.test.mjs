/* The formatting segment: invariants only — which unit a duration falls in, which day a moment
 * fell on, and what is given when there is no such moment. The model measures; the words are the
 * client's.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { clock, dayParts, duration, durationParts, two } from '../src/model/format.ts'

test('没有那一刻的时候给「没有」的样子，不写 0', () => {
  const at = new Date('2026-03-10T12:00:00.000Z')

  assert.equal(clock(null), '--')
  assert.equal(duration(null), '--')
  assert.equal(durationParts(null), null)
  assert.equal(dayParts(null, at), null)
})

test('时长按档位写：秒 / 分钟 / 小时', () => {
  assert.equal(duration(0), '0s', '刚好零秒是一个真读数')
  assert.equal(duration(59), '59s')
  assert.equal(duration(60), '1m')
  assert.equal(duration(3600), '1h')
  assert.equal(duration(3700), '1h02')
  assert.equal(duration(-5), '--', '那一刻还没到：没有时长，也不写一个负的')
})

test('时长的长写法', () => {
  assert.deepEqual(durationParts(45), { unit: 'seconds', value: 45, rest: 0 })
  assert.deepEqual(durationParts(300), { unit: 'minutes', value: 5, rest: 0 })
  assert.deepEqual(durationParts(3600), { unit: 'hours', value: 1, rest: 0 })
  assert.deepEqual(durationParts(8040), { unit: 'hours', value: 2, rest: 14 }, '小时里剩下的整分钟一并带出来')
  assert.equal(durationParts(-5), null, '那一刻还没到：没有时长这一档，也不写一个负的')
})

test('钟点走本地的钟点', () => {
  assert.equal(clock(new Date(2026, 2, 10, 9, 5)), '09:05')
  assert.equal(two(7), '07')
  assert.equal(two(31), '31')
})

test('日子按读到的那一刻算', () => {
  const at = new Date(2026, 2, 10, 12, 0)

  assert.deepEqual(dayParts(new Date(2026, 2, 10, 9, 0), at), { unit: 'today' })
  assert.deepEqual(dayParts(new Date(2026, 2, 9, 23, 0), at), { unit: 'yesterday' }, '按日历日算，不按 24 小时算')
  assert.deepEqual(dayParts(new Date(2026, 2, 8, 23, 0), at), { unit: 'before-yesterday' })
  assert.deepEqual(dayParts(new Date(2026, 2, 1, 0, 0), at), { unit: 'date', month: 3, day: 1 }, '再远的给月份与日，不带年份')
})

test('收窄出口：删掉的几种写法入口与模块里都不再有，只在本模块内用的不上入口', async () => {
  const entry = await import('../src/model/index.ts')
  const format = await import('../src/model/format.ts')

  assert.equal(entry.ago, undefined)
  assert.equal(entry.durationLong, undefined)
  assert.equal(entry.elapsedSince, undefined, '没人读的紧凑拼法不上入口')
  assert.equal(entry.agoParts, undefined, '没人读的相对时间不上入口')
  assert.equal(entry.two, undefined)
  assert.equal(entry.dayLabel, undefined)
  assert.equal(Object.hasOwn(format, 'ago'), false, '旧的写法已经整个没有了，不是收进模块里')
  assert.equal(Object.hasOwn(format, 'durationLong'), false)
  assert.equal(Object.hasOwn(format, 'elapsedSince'), false, '整条删掉了：模块里也不再留一份')
  assert.equal(Object.hasOwn(format, 'agoParts'), false)
  assert.equal(Object.hasOwn(format, 'dayLabel'), false)
  assert.equal(typeof format.two, 'function', '两位补零只在本模块里用，不上入口')
  assert.equal(typeof entry.duration, 'function', '面板真在用的照旧从入口出')
  assert.equal(typeof entry.dayParts, 'function', '面板真在用的照旧从入口出')
  assert.equal(typeof entry.durationParts, 'function', '长写法只有本模块与测试认得，不算面板在用')
})
