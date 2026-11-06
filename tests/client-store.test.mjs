/* The one external-store skeleton the panel's ports stand on (src/client/store.ts): a subscriber set
 * where one throwing listener does not silence the next, a snapshot that keeps its identity unless
 * the caller's own comparison says it truly changed, and the watch count an upstream join is taken
 * on.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createStore } from '../src/client/store.ts'

test('换快照：一样的读数不换 identity，也不吵醒订阅者', () => {
  const store = createStore({ n: 1 }, (left, right) => left.n === right.n)
  let woken = 0
  store.subscribe(() => { woken += 1 })

  store.put({ n: 1 })
  assert.equal(woken, 0, '同一个数：不换对象、不发通知')
  assert.deepEqual(store.getSnapshot(), { n: 1 })

  store.put({ n: 2 })
  assert.equal(woken, 1)
  assert.deepEqual(store.getSnapshot(), { n: 2 })
})

test('换快照：不说怎么比的时候就按同一个对象算', () => {
  const store = createStore({ n: 1 })
  let woken = 0
  store.subscribe(() => { woken += 1 })

  store.put(store.getSnapshot())
  assert.equal(woken, 0, '同一个引用：什么都没变')
  store.put({ n: 1 })
  assert.equal(woken, 1, '另一个对象：算变了')
})

test('一个订阅者抛了，后面的照旧收到通知，错误不外泄', () => {
  const store = createStore(0)
  const heard = []
  store.subscribe(() => { heard.push('first') })
  store.subscribe(() => { throw new Error('这一位坏了') })
  store.subscribe(() => { heard.push('last') })

  assert.doesNotThrow(() => { store.put(1) })
  assert.deepEqual(heard, ['first', 'last'], '坏的那一位没有把队列截断')
})

test('看着的人数：订阅进、退都算在这个数上，退掉的重订阅不重复计', () => {
  const store = createStore(0)
  const offA = store.subscribe(() => undefined)
  const offB = store.subscribe(() => undefined)
  assert.equal(store.watching, 2)
  offA()
  offA()
  assert.equal(store.watching, 1, '退两次只算退一次')
  offB()
  assert.equal(store.watching, 0)
})
