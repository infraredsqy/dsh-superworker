/* Two judgments the panel needs before it can put words on the screen: whether the four sources all
 * landed on the same outcome, and which nodes a cycle's detail section collects. Plus the three
 * readings the drawing layer consumes instead of judging again: a card's bucket, its place in the
 * triage order, and the one moment it speaks of.
 *
 * What is locked are the criteria themselves — an empty set does not count as "all present", both
 * walked-by and held-by count, the delivered section orders newest completion first, and a line's
 * parked count names the same cards its detail's waiting section does.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { belongsTo, bucketOf, everySourceIs, lineStateOf, nodesOf, ownersOf, rankOf, readProject } from '../src/model/index.ts'
import { cycle, node, record } from './helpers/record-fixtures.mjs'

function readingWithSources(sources) {
  return { sources: Object.fromEntries(['nodes', 'cycles', 'instructions', 'issues'].map((key) => [key, sources[key] ?? sources.all])) }
}

test('四份来源都落在同一个结局上才算；一份都没有的时候不算「全都在」', () => {
  assert.equal(everySourceIs(readingWithSources({ all: 'missing' }), 'missing'), true)
  assert.equal(everySourceIs(readingWithSources({ all: 'unusable' }), 'unusable'), true)
  assert.equal(everySourceIs(readingWithSources({ all: 'read' }), 'read'), true)

  assert.equal(everySourceIs(readingWithSources({ nodes: 'missing', cycles: 'unusable' }), 'missing'), false, '混着的不是「全都在」')
  assert.equal(everySourceIs(readingWithSources({ nodes: 'read', cycles: 'missing' }), 'missing'), false, '有一份读到了就不是「都没有」')

  assert.equal(everySourceIs({ sources: {} }, 'missing'), false, '一份来源都没列到：还没读，不是「全都在」')
  assert.equal(everySourceIs(readingWithSources({ all: 'missing' }), 'unusable'), false, '问的结局对不上就是不对上')
})

test('明细收格：走过它的算，它此刻正握着的也算', () => {
  const reading = readProject(record({
    nodes: {
      walked: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
      held: node({ dependencies: [] }),
      other: node({ dependencies: [] }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'held', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'walked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }],
      }),
      cycle({ id: 'c2', holding: [{ id: 'walked', since: '2026-03-10T11:30:00.000Z' }] }),
    ],
  }))
  const c1 = reading.cycleById.c1
  const idsOf = (key) => nodesOf(key, c1, reading).map((one) => one.id)

  assert.deepEqual(idsOf('done'), ['walked'], '走过它的算它名下的，哪怕此刻被别的线握着')
  assert.deepEqual(idsOf('run'), ['held'], '它此刻握着的那一格算进行中那段')
  assert.deepEqual(idsOf('shelved'), [])
  assert.deepEqual(idsOf('ready'), [])
  assert.deepEqual(idsOf('wait'), [])
})

test('明细收格：已交付那段按交付时刻新的在前', () => {
  const reading = readProject(record({
    nodes: {
      early: node({ status: 'completed', completed_at: '2026-03-10T07:00:00.000Z' }),
      late: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [
      cycle({
        path: [
          { node: 'early', started_at: '2026-03-10T06:00:00.000Z', ended_at: '2026-03-10T07:00:00.000Z', result: 'completed' },
          { node: 'late', started_at: '2026-03-10T09:00:00.000Z', ended_at: '2026-03-10T10:00:00.000Z', result: 'completed' },
        ],
      }),
    ],
  }))

  assert.deepEqual(
    nodesOf('done', reading.cycleById.c1, reading).map((one) => one.id),
    ['late', 'early'],
  )
})

test('桶读数：要人的那一格先落闸，哪怕线正握着它', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual' }),
      busyGate: node({ mode: 'manual' }),
      checkpoint: node({ mode: 'checkpoint', status: 'completed', completed_at: '2026-03-10T10:00:00.000Z' }),
    },
    cycles: [cycle({ holding: [{ id: 'busyGate', since: '2026-03-10T11:00:00.000Z' }] })],
  }))

  assert.equal(bucketOf(reading.nodeById.gated), 'gate', '手动闸的未开始一格落人闸')
  assert.equal(bucketOf(reading.nodeById.busyGate), 'gate', '人闸压过进行中：握着它的线改不了这一桶')
  assert.equal(bucketOf(reading.nodeById.checkpoint), 'gate', '交付了还没批过的检查点落人闸')
})

test('桶读数：出局的判决自己一桶，余下按在手与格子自己的状态', () => {
  const reading = readProject(record({
    nodes: {
      parked: node({ status: undefined }),
      busy: node(),
      idle: node(),
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'busy', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }],
      }),
    ],
  }))

  assert.equal(bucketOf(reading.nodeById.parked), 'shelved', '判决失败的出局等人，落等待那一桶')
  assert.equal(bucketOf(reading.nodeById.busy), 'run')
  assert.equal(bucketOf(reading.nodeById.idle), 'todo')
  assert.equal(bucketOf(reading.nodeById.done), 'done')
})

test('分诊档次：桶自己的次序，只把未开始那半分成可开工与还在等', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual' }),
      parked: node({ status: undefined }),
      busy: node(),
      ready: node(),
      waiting: node({ dependencies: ['ready'] }),
      done: node({ status: 'completed', completed_at: '2026-03-10T09:00:00.000Z' }),
    },
    cycles: [
      cycle({
        holding: [{ id: 'busy', since: '2026-03-10T11:00:00.000Z' }],
        path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }],
      }),
    ],
  }))

  assert.equal(rankOf(reading.nodeById.gated), 0, '要人的那一格排在最前')
  assert.equal(rankOf(reading.nodeById.parked), 0, '出局等人也排在等人那一档，不看它此刻有没有交付')
  assert.equal(rankOf(reading.nodeById.busy), 1, '在别人手里的其次')
  assert.equal(rankOf(reading.nodeById.ready), 2, '可以开工的第三')
  assert.equal(rankOf(reading.nodeById.waiting), 3, '还欠前置的第四')
  assert.equal(rankOf(reading.nodeById.done), 4, '落定的最后')
})

test('卡上那一刻：闸的一刻先于握住的，握住的先于步子收尾，收尾先于交付，交付先于创建', () => {
  const reading = readProject(record({
    nodes: {
      gated: node({ mode: 'manual', created_at: '2026-03-10T06:00:00.000Z' }),
      held: node({ created_at: '2026-03-10T06:00:00.000Z' }),
      stepped: node({ status: 'completed', completed_at: '2026-03-10T10:00:00.000Z', created_at: '2026-03-10T06:00:00.000Z' }),
      created: node({ created_at: '2026-03-10T06:00:00.000Z' }),
      bare: node(),
    },
    cycles: [
      {
        id: 'c1',
        status: 'active',
        holding: [{ id: 'gated', since: '2026-03-10T07:00:00.000Z' }],
        path: [{ node: 'gated', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }],
      },
      {
        id: 'c2',
        status: 'active',
        holding: [{ id: 'held', since: '2026-03-10T07:00:00.000Z' }],
        path: [
          { node: 'held', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' },
          { node: 'stepped', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' },
        ],
      },
    ],
  }))

  assert.equal(reading.nodeById.gated.stampAt?.toISOString(), '2026-03-10T08:00:00.000Z', '人闸那一刻先于握住：08:00 在前，07:00 的握住不顶上来')
  assert.equal(reading.nodeById.held.stampAt?.toISOString(), '2026-03-10T07:00:00.000Z', '握住的一刻先于步子收尾')
  assert.equal(reading.nodeById.stepped.stampAt?.toISOString(), '2026-03-10T09:00:00.000Z', '步子收尾先于交付那一刻')
  assert.equal(reading.nodeById.created.stampAt?.toISOString(), '2026-03-10T06:00:00.000Z', '什么都没有的格轮到创建那一刻')
  assert.equal(reading.nodeById.bare.stampAt, null, '一刻都没有就是没有，不拿别的顶上')
})

test('一格归哪条线：走过它的每条线加此刻握着它的线，明细、阻塞计数与上墨都读这一份', () => {
  const reading = readProject(record({
    nodes: {
      carried: node({ status: undefined }),
      plain: node(),
    },
    cycles: [
      /* c1 holds the cell; c2 walked it first and the verdict parked it. */
      cycle({ id: 'c2', path: [{ node: 'carried', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }] }),
      cycle({ id: 'c1', holding: [{ id: 'carried', since: '2026-03-10T10:00:00.000Z' }] }),
    ],
  }))

  assert.deepEqual([...ownersOf(reading.nodeById.carried)], ['c2', 'c1'], '第一条走过的线在前，握着它的线也占一份')
  assert.deepEqual([...ownersOf(reading.nodeById.plain)], [], '哪条线都没碰过：不归任何线')
  assert.deepEqual(reading.cycleById.c1.parked, ['carried'], '握着它又判决出局的线，阻塞计数里也有它')
  assert.deepEqual(nodesOf('shelved', reading.cycleById.c1, reading).map((one) => one.id), ['carried'],
    '同一份判据：明细的等待处理分组与阻塞计数说的是同一格')
  assert.deepEqual(reading.cycleById.c2.parked, ['carried'], '第一条走过它的线同样记着这次出局')
})

test('一格被两条线走过：两条线都算碰过它，重跑的那条不算「没碰过」', () => {
  const reading = readProject(record({
    nodes: { rerun: node() },
    cycles: [
      /* c1 walked the cell first; c2 re-ran the same cell later and left it standing. */
      cycle({ id: 'c1', path: [{ node: 'rerun', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'completed' }] }),
      cycle({ id: 'c2', path: [{ node: 'rerun', started_at: '2026-03-10T10:00:00.000Z', ended_at: '2026-03-10T11:00:00.000Z', result: 'completed' }] }),
    ],
  }))
  const one = reading.nodeById.rerun

  assert.deepEqual([...one.cycleIds], ['c1', 'c2'], '两条线都走过这一格：记录里两条都算碰过')
  assert.deepEqual([...ownersOf(one)], ['c1', 'c2'], '走过它的每条线各占一份，按记录次序')
  assert.equal(belongsTo(one, 'c1'), true)
  assert.equal(belongsTo(one, 'c2'), true, '重跑的那条线也碰过这一格，不是「没碰过」')
  assert.deepEqual(nodesOf('ready', reading.cycleById.c1, reading).map((each) => each.id), ['rerun'])
  assert.deepEqual(nodesOf('ready', reading.cycleById.c2, reading).map((each) => each.id), ['rerun'],
    '明细分组与上墨读同一份判据：重跑的线也收得到这一格')
})

test('线的三态只判一次：欠人一格的算阻塞，还在服务里的算进行中，其余算停下', () => {
  const reading = readProject(record({
    nodes: { parked: node({ status: undefined }), busy: node() },
    cycles: [
      /* c1 owes a person: its verdict parked a cell. */
      cycle({ id: 'c1', path: [{ node: 'parked', started_at: '2026-03-10T08:00:00.000Z', ended_at: '2026-03-10T09:00:00.000Z', result: 'failed' }] }),
      cycle({ id: 'c2', holding: [{ id: 'busy', since: '2026-03-10T10:00:00.000Z' }] }),
      cycle({ id: 'c3', status: 'inactive' }),
      /* c4: no word written on it and nothing in hand — not in service, so stopped. */
      cycle({ id: 'c4', status: undefined }),
    ],
  }))

  assert.equal(lineStateOf(reading.cycleById.c1), 'blocked', '名下有一格等人：先看这次出局')
  assert.equal(lineStateOf(reading.cycleById.c2), 'run', '还没写状态但手里有活：在服务里')
  assert.equal(lineStateOf(reading.cycleById.c3), 'stopped')
  assert.equal(lineStateOf(reading.cycleById.c4), 'stopped', '没写状态又什么都没握着：不读成进行中')
})
