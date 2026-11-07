/* The workspace selector's candidate list at the top of the panel: locks in "where the list comes
 * from" and "which bucket this session falls into".
 *
 * The list comes from the read-only face on DSH's `workspaces` service; malformed shapes count as
 * absent. With no list, the empty list is the same object every time — a freshly built one would
 * make React think it keeps changing.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { NO_WORKSPACES, workspaceOf, workspacesAt } from '../src/client/workspaces.ts'

function choice(workspaceId, sessionIds = []) {
  return { workspaceId, path: `C:\\${workspaceId}`, title: workspaceId, sessionIds }
}

function source(items) {
  const snapshot = { items }
  const listeners = []
  return {
    listeners,
    face: {
      getSnapshot: () => snapshot,
      subscribe: (listener) => {
        listeners.push(listener)
        return () => { listeners.splice(listeners.indexOf(listener), 1) }
      },
    },
  }
}

test('the list comes off the context: only with both getSnapshot and subscribe does it count', () => {
  const { face } = source([choice('w-1')])
  const owner = { get: (name) => (name === 'workspaces' ? { list: face } : undefined) }

  assert.equal(workspacesAt(owner), face)
})

test('a list hanging off a property (a context with no get) is recognized too', () => {
  const { face } = source([choice('w-1')])

  assert.equal(workspacesAt({ workspaces: { list: face } }), face)
})

test('a malformed shape: one hand missing, or not a list at all, counts as absent', () => {
  assert.equal(workspacesAt({ get: () => ({ list: { getSnapshot: () => ({ items: [] }) } }) }), undefined)
  assert.equal(workspacesAt({ get: () => ({ list: { subscribe: () => () => undefined } }) }), undefined)
  assert.equal(workspacesAt({ get: () => ({ list: null }) }), undefined)
  assert.equal(workspacesAt({ get: () => undefined }), undefined)
  assert.equal(workspacesAt(undefined), undefined)
})

test('the empty list when there is none: always the same object, subscribing to it does nothing', () => {
  assert.equal(NO_WORKSPACES.getSnapshot(), NO_WORKSPACES.getSnapshot())
  assert.deepEqual(NO_WORKSPACES.getSnapshot().items, [])
  assert.equal(typeof NO_WORKSPACES.subscribe(() => undefined), 'function')
})

test('which workspace this session falls in: it belongs to whichever workspace lists its identity', () => {
  const items = [choice('w-1', ['s-9']), choice('w-2', ['s-7', 's-8'])]

  assert.equal(workspaceOf(items, 's-7')?.workspaceId, 'w-2')
  assert.equal(workspaceOf(items, 's-9')?.workspaceId, 'w-1')
})

test('listed nowhere, or no session at all: ungrouped', () => {
  const items = [choice('w-1', ['s-9'])]

  assert.equal(workspaceOf(items, 's-404'), undefined)
  assert.equal(workspaceOf(items, ''), undefined)
  assert.equal(workspaceOf(items, undefined), undefined)
  assert.equal(workspaceOf([], 's-9'), undefined)
})
