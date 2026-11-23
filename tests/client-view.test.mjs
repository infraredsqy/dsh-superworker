/* The view the panel shows: which tab is on, and who is allowed to move it.
 *
 * The view is the screen's own state: the reader's pick leads, and the settings document is where a
 * pick is *remembered*, not a second authority that can move the screen back. The settings write is
 * a round trip, so its echo lands after the reader may have picked again; the case below holds the
 * round trip open (`deferred` form) and answers it in issue order, which is exactly the moment the
 * panel used to flash back to the view the reader had just left: pick 概览, pick 当前, then the
 * earlier write of 概览 lands — the screen must still be on 当前.
 *
 * The second case is the memory itself: after 概览's write lands, a fresh mount reads it back and
 * lands on 概览.
 *
 * Needs `lib/client.js`; run `npm run bundle:client` first, or this file skips itself with the reason.
 *
 *   node --test tests/client-view.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'
import { fakeSettingsForm } from './helpers/dsh-standins.mjs'
import { flush } from './helpers/wait.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** A record with a cell and its line: enough for the panes to draw, so the tab row is on the page. */
const record = () => ({
  '.superworker/ideas.json': json({
    nodes: {
      n1: {
        title: 'a cell',
        tags: [],
        mode: 'manual',
        status: 'todo',
        created_at: '2026-01-01T00:00:00.000Z',
        dependencies: [],
      },
    },
  }),
  '.superworker/state.json': json({ cycles: [] }),
})

/**
 * Answer the queued writes inside an act, then let the continuations they started run: the panel's
 * `write` resolves in a microtask, and a refused write queues its retry in another one. `flush` is
 * the shared settle (the loop turns over), not a timed wait.
 */
async function land(act, form, count) {
  await act(async () => {
    assert.ok(form.land(count) > 0, 'there is a write to answer')
    await flush()
  })
}

/** Which pane's tab says it is the shown one. */
const shown = (container) => container.querySelector('.superworker-tab[aria-selected="true"]')?.getAttribute('aria-controls')

const tabOf = (container, pane) => {
  const found = container.querySelector(`.superworker-tab[aria-controls="${pane}"]`)
  assert.notEqual(found, null, `the ${pane} tab is not in the row`)
  return found
}

test('a write whose echo lands after the reader picked again does not flash the view back', { skip: bundleSkip }, async () => {
  const form = fakeSettingsForm({}, { deferred: true })
  const mounted = await mountBuiltPanel({ record: record(), settingsForm: form })
  const { window, act, container } = mounted

  const press = async (pane) => {
    await act(async () => { tabOf(container, pane).dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  }

  /* The panel comes up on the overview: nothing is recorded yet, and that is the factory landing. */
  assert.equal(shown(container), 'pane-overview', 'with nothing recorded the panel lands on the overview')

  await press('pane-nodes')
  assert.equal(shown(container), 'pane-nodes', 'pressing the board tab shows the board')
  assert.equal(form.queued(), 1, 'the pick went out as one write and it is still in flight')

  await press('pane-overview')
  assert.equal(shown(container), 'pane-overview', 'pressing the overview tab shows the overview')
  assert.equal(form.queued(), 2, 'the second pick is in flight behind the first')

  /* The board write answers now — it is the echo of the view the reader has already left. */
  await land(act, form, 1)
  assert.equal(shown(container), 'pane-overview', 'the echo of an earlier pick must not move the view back')

  /* The overview write is fenced on the revision the board write just moved: it is refused, and the
   * panel answers that with a no-fence retry (the document read-back that follows the refusal is
   * the second place the old view used to come back from). */
  await land(act, form)
  assert.equal(shown(container), 'pane-overview', 'a fenced write and its document read-back must not move the view back')
  await land(act, form)
  assert.equal(shown(container), 'pane-overview', 'the retried overview write lands and the view stays')
  assert.equal(form.document().lastTab, 'overview', 'the document remembers the overview')

  await mounted.unmount()
  assert.deepEqual(mounted.consoleErrors, [], 'there is an error in the console')
})

test('the memory still works: the view a reader left is the view a fresh mount lands on', { skip: bundleSkip }, async () => {
  const form = fakeSettingsForm({}, { deferred: true })
  const first = await mountBuiltPanel({ record: record(), settingsForm: form })
  await first.act(async () => {
    tabOf(first.container, 'pane-nodes').dispatchEvent(new first.window.MouseEvent('click', { bubbles: true }))
  })
  await land(first.act, form)
  assert.equal(form.document().lastTab, 'nodes', 'the pick was written to the settings document')
  await first.unmount()

  const second = await mountBuiltPanel({ record: record(), settingsForm: form })
  assert.equal(shown(second.container), 'pane-nodes', 'a fresh mount lands on the view the reader left')
  await second.unmount()
  assert.deepEqual(second.consoleErrors, [], 'there is an error in the console')
})
