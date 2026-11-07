/* The built browser half, mounted on its own: the artifact the package ships is handed to the shell,
 * boots onto a roster, draws itself, walks every pane, and leaves the console clean.
 *
 * The record comes from the in-memory port stand-in, so this file needs no `.superworker` directory on disk,
 * no `superworker` command and no fixture of its own: the panel reads through a port. The panel's copy and
 * layout are deliberately not measured here — they move far more often than the four things below,
 * and a test pinning them costs an edit per change; the readings that do need a record are walked by
 * hand. The one reading from a record that is measured here is which lines the panel names: the
 * record tells of one cell two lines walked and one cell only a line holds, and the detail and the
 * cards have to say both. The map's touch road has its own file (`client-map-gesture`): it is the
 * map's wiring, not this artifact smoke test's business.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/` without that build and
 * this file skips itself, saying so.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** A record with something in every one of the four sources: the panes draw content rather than an empty state. */
const record = () => ({
  '.superworker/ideas.json': json({
    nodes: {
      n1: {
        title: 'the first node',
        description: 'a finished piece of work',
        tags: ['t0'],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-02T00:00:00.000Z',
        dependencies: [],
      },
      n2: {
        title: 'the second node',
        tags: [],
        mode: 'manual',
        status: 'todo',
        created_at: '2026-01-04T00:00:00.000Z',
        dependencies: ['n1'],
      },
      n3: {
        title: 'a shelved one',
        tags: ['t0'],
        mode: 'auto',
        status: 'shelved',
        created_at: '2026-01-05T00:00:00.000Z',
        dependencies: ['n1'],
      },
    },
  }),
  '.superworker/state.json': json({
    cycles: [
      {
        id: 'c1',
        title: 'a cycle',
        status: 'active',
        tags: ['main'],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-06T00:00:00.000Z',
        policies: { issue_pool_weight_limit: 8 },
        holding: [{ id: 'n2', since: '2026-01-06T00:00:00.000Z' }],
        path: [
          { node: 'n1', started_at: '2026-01-01T00:00:00.000Z', ended_at: '2026-01-02T00:00:00.000Z', result: 'delivered' },
        ],
      },
      {
        /* A re-run of the same cell: two lines have walked n1, and a card's foot owes both of them. */
        id: 'c2',
        title: 'a rerun cycle',
        status: 'active',
        tags: [],
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-07T00:00:00.000Z',
        policies: { issue_pool_weight_limit: 8 },
        holding: [],
        path: [
          { node: 'n1', started_at: '2026-01-03T00:00:00.000Z', ended_at: '2026-01-03T01:00:00.000Z', result: 'delivered' },
        ],
      },
    ],
  }),
  '.superworker/instructions.json': json({
    instructions: [
      { id: 'i1', text: 'something the user said', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, at: '2026-01-07T00:00:00.000Z', resolved_at: null, note: 'a note' },
      { id: 'i2', text: 'a line taken back', scope: 'cycle', target: 'stage', state: 'archived', cycle: 'c1', node: null, at: '2026-01-03T00:00:00.000Z', resolved_at: '2026-01-08T00:00:00.000Z', note: null },
    ],
  }),
  '.superworker/issues/issues.json': json({
    version: 1,
    issues: {
      p1: {
        id: 'p1',
        title: 'a defect',
        severity: 'P1',
        status: 'open',
        module: 'mod-a',
        source: 'review',
        decision: 'fix',
        discovered: '2026-01-08T00:00:00.000Z',
        updated_at: '2026-01-09T00:00:00.000Z',
        check_count: 2,
        files: ['a.ts'],
        description: 'what is wrong',
        suggestion: 'what to do',
      },
    },
  }),
})

test('this build: the shell loads, the panel draws, every tab opens, cycle names read in full, the console stays clean', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  const { window, act, container, ledger, loaded, panel, asked, consoleErrors, settle } = mounted

  /* ---- what the shell got: one spec under this id, and a factory that exports apply ---- */
  assert.equal(loaded?.id, 'dsh-superworker', 'the shell knows this build by its id')
  assert.equal(typeof mounted.client.apply, 'function', 'this build exports apply')

  /* ---- what it installed: one service, three rows on the roster ---- */
  assert.equal(panel?.id, 'superworker', 'the panel registered as a service')
  assert.equal(ledger.size, 3, `this layer registers three: ${[...ledger.keys()].join(', ')}`)

  /* ---- what it drew ---- */
  assert.notEqual(container.querySelector('.superworker-page'), null, 'the panel page is drawn')
  assert.ok((container.textContent ?? '').length > 0, 'there are words on the panel')
  assert.ok(asked.length > 0, 'it asked the host half for the record')

  /* Every pane its tabs point at: press each one, and the thing it says it controls has to be there
   * and to be the shown one. The tab set is read off the panel, so a pane added or dropped later
   * moves both sides together. */
  const tabs = mounted.tabs()
  assert.ok(tabs.length > 0, 'the tab strip is drawn')
  for (const tab of tabs) {
    await act(async () => { tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
    const pane = container.querySelector(`#${String(tab.getAttribute('aria-controls'))}`)
    assert.notEqual(pane, null, `the "${tab.textContent}" tab is missing`)
    assert.equal(tab.getAttribute('aria-selected'), 'true', `pressing "${tab.textContent}" did not select it`)
  }

  /* Which line the detail is showing follows the pick, and it is not always the record's first line:
   * two lines walked the same record, and pressing the second one has to move the sidebar's
   * `aria-current` and the list of cells under it together. A detail that always resolves the
   * record's first line leaves every assertion above green, so this one is what holds it. */
  const detailTab = tabs.find((tab) => tab.getAttribute('aria-controls') === 'pane-detail')
  assert.notEqual(detailTab, undefined, 'the detail tab is not in the tab strip')
  await act(async () => { detailTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const picks = [...container.querySelectorAll('#pane-detail .superworker-linepick')]
  assert.deepEqual(picks.map((one) => one.querySelector('.superworker-cycle')?.textContent), ['c1', 'c2'], 'one row per cycle in the sidebar')
  const second = picks[1]
  await act(async () => { second.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  assert.equal(second.getAttribute('aria-current'), 'true', 'the second cycle was clicked: the sidebar marks it')
  assert.equal(picks[0].getAttribute('aria-current'), 'false', 'the first cycle is no longer the selected one')
  const rows = [...container.querySelectorAll('#pane-detail .superworker-row')].map((row) => row.getAttribute('data-id'))
  assert.deepEqual(rows, ['n1'], 'the detail lists the cells this cycle walked: c2 walked only n1')

  /* The drawing is read where the reader sees it: open the map, then read its cards. The map's touch
   * road belongs to `client-map-gesture`; here the drawing is only read, never dragged. */
  const mapTab = tabs.find((tab) => tab.getAttribute('aria-controls') === 'pane-map')
  assert.notEqual(mapTab, undefined, 'the map tab is not in the tab strip')
  await act(async () => { mapTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  /* A card's foot names every line the model says this cell belongs to, in the model's own order —
   * the lines that walked it first, then the one holding it — and a cell no line has touched wears
   * no id at all. Printing only the first walker leaves a cell that is merely in a line's hand with
   * no name on it, so the three cells below are the whole of this reading. */
  const tagsOf = (id) => {
    const card = container.querySelector(`.superworker-mnode[data-id="${id}"]`)
    assert.notEqual(card, null, `card ${id} is not on the map`)
    return [...card.querySelectorAll('.superworker-mtag')].map((tag) => tag.textContent)
  }
  assert.deepEqual(tagsOf('n1'), ['c1·c2'], 'a cell walked by two cycles: both are printed, in record order')
  assert.deepEqual(tagsOf('n2'), ['c1'], 'a cycle only holds it, has not walked it: that cycle still prints')
  assert.deepEqual(tagsOf('n3'), [], 'no cycle has touched it: no tag printed')
  await mounted.unmount()

  assert.deepEqual(consoleErrors, [], 'there is an error in the console')
})
