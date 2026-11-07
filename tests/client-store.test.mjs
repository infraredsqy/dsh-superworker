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

test('a snapshot swap: an identical reading keeps its identity and wakes no subscriber', () => {
  const store = createStore({ n: 1 }, (left, right) => left.n === right.n)
  let woken = 0
  store.subscribe(() => { woken += 1 })

  store.put({ n: 1 })
  assert.equal(woken, 0, 'the same number: no new object, no notification')
  assert.deepEqual(store.getSnapshot(), { n: 1 })

  store.put({ n: 2 })
  assert.equal(woken, 1)
  assert.deepEqual(store.getSnapshot(), { n: 2 })
})

test('a snapshot swap: with no comparison given, the same object counts as unchanged', () => {
  const store = createStore({ n: 1 })
  let woken = 0
  store.subscribe(() => { woken += 1 })

  store.put(store.getSnapshot())
  assert.equal(woken, 0, 'the same reference: nothing changed')
  store.put({ n: 1 })
  assert.equal(woken, 1, 'another object: counts as changed')
})

test('one subscriber throws, the rest still hear it, the error does not leak', () => {
  const store = createStore(0)
  const heard = []
  store.subscribe(() => { heard.push('first') })
  store.subscribe(() => { throw new Error('this one is broken') })
  store.subscribe(() => { heard.push('last') })

  assert.doesNotThrow(() => { store.put(1) })
  assert.deepEqual(heard, ['first', 'last'], 'the broken one did not cut the queue short')
})

test('the watch count: subscribes and unsubscribes both count, a double unsubscribe counts once', () => {
  const store = createStore(0)
  const offA = store.subscribe(() => undefined)
  const offB = store.subscribe(() => undefined)
  assert.equal(store.watching, 2)
  offA()
  offA()
  assert.equal(store.watching, 1, 'unsubscribing twice counts once')
  offB()
  assert.equal(store.watching, 0)
})
