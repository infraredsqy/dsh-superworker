/* The one bounded map both per-root tenants share: entries past the cap give way, least recently used first.
 *
 * The invariant this pins is the one the two tenants lean on — the opener's per-workspace queues
 * (host-executor) and the injection's carried listings (host-instruction-context), both of which keep
 * per-root state for the process's whole life and used to never evict it. Filling the table with more
 * roots than the cap leaves the count at the cap, the oldest root gives way, and a root that was hit
 * again keeps its seat — an entry still being hit is never the one evicted, and the explicit delete
 * (the carried gate's "record absent" path) keeps working. A seat a tenant holds against eviction —
 * the opener's in-flight line — is skipped: the oldest unpinned seat gives way, every seat held
 * leaves the table sitting past the cap until a hold comes off, one hold is one `pin`, and a delete
 * lapses the holds. The queues tenant's own shape runs here too at a cap a case can fill, because
 * the real table's cap is the shared 128 and the wiring at that cap is pinned in host-executor.
 * The table is judged as an opaque bounded map: only the count bound, the eviction order, the holds
 * and the delete are locked, never an internal data structure.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { flush } from './helpers/wait.mjs'
import { BoundedMap, PER_ROOT_STATE_CAP } from '../src/host/bounded-map.ts'

test('filling more roots than the cap: the count stays bounded and the oldest root gives way', () => {
  const held = new BoundedMap(3)
  for (let at = 1; at <= 3; at += 1) held.set(`C:\\ws-${at}`, `text-${at}`)

  held.set('C:\\ws-4', 'text-4')

  assert.equal(held.size, 3, 'the entry count is bounded by the cap, not by how many roots poured in')
  assert.equal(held.get('C:\\ws-1'), undefined, 'the oldest root is the one that gave way')
  assert.equal(held.get('C:\\ws-2'), 'text-2', 'the newer roots are still held')
  assert.equal(held.get('C:\\ws-3'), 'text-3')
  assert.equal(held.get('C:\\ws-4'), 'text-4', 'the newest root is held')
})

test('a hit refreshes recency: the root the process just asked for keeps its seat, an untouched one gives way', () => {
  const held = new BoundedMap(3)
  held.set('C:\\ws-a', 'a')
  held.set('C:\\ws-b', 'b')
  held.set('C:\\ws-c', 'c')

  assert.equal(held.get('C:\\ws-a'), 'a', 'the hit answers as usual')
  held.set('C:\\ws-d', 'd')

  assert.equal(held.get('C:\\ws-a'), 'a', 'an entry still being hit is not evicted early')
  assert.equal(held.get('C:\\ws-b'), undefined, 'the root nobody asked for is the one that gave way')
  assert.equal(held.get('C:\\ws-c'), 'c')
  assert.equal(held.get('C:\\ws-d'), 'd')
})

test('an explicit delete still works: the gate that clears a stale entry keeps its power', () => {
  const held = new BoundedMap(2)
  held.set('C:\\ws-a', 'carried text')
  held.set('C:\\ws-b', 'other text')

  assert.equal(held.delete('C:\\ws-a'), true, 'the delete answers as a plain map does')
  assert.equal(held.get('C:\\ws-a'), undefined)
  assert.equal(held.size, 1)
  assert.equal(held.delete('C:\\ws-a'), false, 'deleting a missing entry answers false, no throw')
})

test('overwriting one root moves it to the fresh seat and keeps the count: same key, one entry', () => {
  const held = new BoundedMap(2)
  held.set('C:\\ws-a', 'old')
  held.set('C:\\ws-b', 'b')

  held.set('C:\\ws-a', 'new')

  assert.equal(held.size, 2, 'a rewrite of a held root adds no entry')
  held.set('C:\\ws-c', 'c')
  assert.equal(held.get('C:\\ws-a'), 'new', 'the rewritten root was refreshed, so it survived')
  assert.equal(held.get('C:\\ws-b'), undefined, 'the untouched one gave way')
})

test('the cap both tenants share is a real bound', () => {
  assert.ok(Number.isInteger(PER_ROOT_STATE_CAP) && PER_ROOT_STATE_CAP >= 1, `PER_ROOT_STATE_CAP must be a positive integer, got ${PER_ROOT_STATE_CAP}`)
})

/* ---- the pin: an entry whose work is still in flight is never the one that gives way ---- */

test('a pinned entry is not the one that gives way: eviction takes the next oldest unpinned seat', () => {
  const held = new BoundedMap(3)
  held.set('C:\\ws-a', 'the line in flight')
  held.pin('C:\\ws-a')
  held.set('C:\\ws-b', 'b')
  held.set('C:\\ws-c', 'c')

  held.set('C:\\ws-d', 'd')

  assert.equal(held.size, 3, 'the count still lands on the cap')
  assert.equal(held.get('C:\\ws-a'), 'the line in flight', 'the held entry kept its seat through the fill')
  assert.equal(held.get('C:\\ws-b'), undefined, 'the oldest unpinned seat is the one that gave way')
  assert.equal(held.get('C:\\ws-c'), 'c')
  assert.equal(held.get('C:\\ws-d'), 'd')
})

test('every seat pinned: the table may sit past the cap until a pin comes off, then gives way again', () => {
  const held = new BoundedMap(2)
  held.set('C:\\ws-a', 'a')
  held.set('C:\\ws-b', 'b')
  held.pin('C:\\ws-a')
  held.pin('C:\\ws-b')

  held.set('C:\\ws-c', 'c')

  assert.equal(held.size, 3, 'with nothing allowed to give way, the insert stays: the overshoot is the pins\' own')
  assert.equal(held.get('C:\\ws-a'), 'a')
  assert.equal(held.get('C:\\ws-b'), 'b')
  assert.equal(held.get('C:\\ws-c'), 'c')

  held.unpin('C:\\ws-a')
  held.set('C:\\ws-d', 'd')

  assert.equal(held.get('C:\\ws-a'), undefined, 'the released seat is the first to give way')
  assert.equal(held.get('C:\\ws-b'), 'b', 'the still-pinned one survives the same trim')
  assert.equal(held.get('C:\\ws-c'), undefined, 'the trim keeps going until the count is back under the cap')
  assert.equal(held.get('C:\\ws-d'), 'd')
  assert.equal(held.size, 2)
})

test('two holds on one entry: one release is not enough, the last one is', () => {
  const held = new BoundedMap(1)
  held.set('C:\\ws-a', 'the line in flight')
  held.pin('C:\\ws-a')
  held.pin('C:\\ws-a')

  held.set('C:\\ws-b', 'b')
  assert.equal(held.size, 2, 'both seats held: the insert overshoots rather than evicting a pinned one')

  held.unpin('C:\\ws-a')
  held.set('C:\\ws-c', 'c')
  assert.equal(held.get('C:\\ws-a'), 'the line in flight', 'one release leaves the other hold standing')
  assert.equal(held.get('C:\\ws-b'), undefined, 'the unpinned bystander gave way instead')

  held.unpin('C:\\ws-a')
  held.set('C:\\ws-d', 'd')
  assert.equal(held.get('C:\\ws-a'), undefined, 'the last release makes the seat evictable again')
  assert.equal(held.get('C:\\ws-c'), undefined)
  assert.equal(held.get('C:\\ws-d'), 'd')
  assert.equal(held.size, 1)
})

test('an explicit delete lapses the pin: a pin never reaches the seat\'s next tenant', () => {
  const held = new BoundedMap(2)
  held.set('C:\\ws-a', 'first tenant')
  held.pin('C:\\ws-a')
  held.delete('C:\\ws-a')

  held.set('C:\\ws-a', 'second tenant')
  held.set('C:\\ws-b', 'b')

  held.set('C:\\ws-c', 'c')

  assert.equal(held.get('C:\\ws-a'), undefined, 'the re-inserted key is evictable: the old pin died with the delete')
  assert.equal(held.get('C:\\ws-b'), 'b')
  assert.equal(held.get('C:\\ws-c'), 'c')
  assert.equal(held.size, 2)
})

/** The queues tenant's exact shape (`executor.ts`'s `inLine`): chain behind the root's seat, seat the landing wrapper, hold the seat until the line lands, release it then. Replicated here because the real table's cap cannot be downsized in a unit test. */
function queued(cap) {
  const queues = new BoundedMap(cap)
  return {
    queues,
    inLine(root, step) {
      const ahead = queues.get(root) ?? Promise.resolve()
      const mine = ahead.then(step, step)
      queues.set(root, mine.then(() => undefined, () => undefined))
      queues.pin(root)
      mine.then(() => queues.unpin(root), () => queues.unpin(root))
      return mine
    },
  }
}

test('at a small cap, an in-flight line keeps its seat, the same root\'s second step still waits behind it, and a landed seat gives way', async () => {
  const { queues, inLine } = queued(3)
  const order = []
  let releaseA1
  const gateA1 = new Promise((resolve) => { releaseA1 = resolve })

  const first = inLine('A', async () => { order.push('A1'); await gateA1 })
  /* Three other roots, one line each: at the moment D seats itself, B and C's lines have not run
   * yet either — all four roots are in flight, so nothing may give way and the table overshoots.
   * The sweep happens at the next insert, and it takes the seats whose lines have landed by then. */
  const flood = ['B', 'C', 'D'].map((root) => inLine(root, async () => { order.push(root) }))
  await Promise.all(flood)
  await flush()

  assert.deepEqual(order, ['A1', 'B', 'C', 'D'], 'each root\'s line ran on its own, in arrival order')
  assert.notEqual(queues.get('A'), undefined, 'the in-flight line kept its seat through the flood')
  assert.equal(queues.size, 4, 'all four lines in flight: the table sits past the cap until a hold comes off')

  /* One more root seats itself now: B's line landed long ago, so the sweep takes the landed seats
   * oldest first and stops as soon as the count is back under the cap — B and C give way, D (newer)
   * survives beside the pinned A. */
  const extra = inLine('E', async () => { order.push('E') })
  await flush()

  assert.equal(queues.get('B'), undefined, 'the landed seat is the one that gave way at the next insert, as before the pin existed')
  assert.equal(queues.get('C'), undefined, 'the sweep kept going while the count was still over the cap')
  assert.notEqual(queues.get('D'), undefined, 'the sweep stopped once the count was back under the cap: the newer landed seat survives')
  assert.notEqual(queues.get('A'), undefined, 'the in-flight line kept its seat through the sweep too')
  assert.equal(queues.size, 3, 'the sweep stopped at the cap: {A, D, E}')
  assert.deepEqual(order, ['A1', 'B', 'C', 'D', 'E'], 'the extra line ran on its own')

  const second = inLine('A', async () => { order.push('A2') })
  await flush()
  assert.deepEqual(order, ['A1', 'B', 'C', 'D', 'E'], 'the second step of the same root is still queued behind the first: serialization holds')

  releaseA1()
  await Promise.all([first, second, extra])
  assert.deepEqual(order, ['A1', 'B', 'C', 'D', 'E', 'A2'], 'the second step ran only after the first line landed')
})
