/* The built browser half, mounted on its own: the artifact the package ships is handed to the shell,
 * boots onto a roster, draws itself, walks every pane, and leaves the console clean.
 *
 * The record comes from the in-memory port stand-in, so this file needs no `.pf` directory on disk,
 * no `pf` command and no fixture of its own: the panel reads through a port. The panel's copy and
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
  '.pf/ideas.json': json({
    nodes: {
      n1: {
        title: '第一个节点',
        description: '一件做完的事',
        tags: ['t0'],
        mode: 'auto',
        status: 'completed',
        created_at: '2026-01-01T00:00:00.000Z',
        completed_at: '2026-01-02T00:00:00.000Z',
        dependencies: [],
      },
      n2: {
        title: '第二个节点',
        tags: [],
        mode: 'manual',
        status: 'todo',
        created_at: '2026-01-04T00:00:00.000Z',
        dependencies: ['n1'],
      },
      n3: {
        title: '搁置的一个',
        tags: ['t0'],
        mode: 'auto',
        status: 'shelved',
        created_at: '2026-01-05T00:00:00.000Z',
        dependencies: ['n1'],
      },
    },
  }),
  '.pf/state.json': json({
    cycles: [
      {
        id: 'c1',
        title: '一条线',
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
        title: '重跑的一条',
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
  '.pf/instructions.json': json({
    instructions: [
      { id: 'i1', text: '用户说过的一句话', scope: 'global', target: 'stage', state: 'live', cycle: null, node: null, at: '2026-01-07T00:00:00.000Z', resolved_at: null, note: '一条备注' },
      { id: 'i2', text: '收回去了的一句', scope: 'cycle', target: 'stage', state: 'archived', cycle: 'c1', node: null, at: '2026-01-03T00:00:00.000Z', resolved_at: '2026-01-08T00:00:00.000Z', note: null },
    ],
  }),
  '.pf/issues/issues.json': json({
    version: 1,
    issues: {
      p1: {
        id: 'p1',
        title: '一处毛病',
        severity: 'P1',
        status: 'open',
        module: 'mod-a',
        source: 'review',
        decision: 'fix',
        discovered: '2026-01-08T00:00:00.000Z',
        updated_at: '2026-01-09T00:00:00.000Z',
        check_count: 2,
        files: ['a.ts'],
        description: '哪里不对',
        suggestion: '该怎么办',
      },
    },
  }),
})

test('这一份产物：外壳装得上、画得出来、每一格都走得通、线名念得全，控制台一路干净', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  const { window, act, container, ledger, loaded, panel, asked, consoleErrors, settle } = mounted

  /* ---- what the shell got: one spec under this id, and a factory that exports apply ---- */
  assert.equal(loaded?.id, 'dsh-pathfinder', '外壳按 id 认这一份')
  assert.equal(typeof mounted.client.apply, 'function', '这一份导出了 apply')

  /* ---- what it installed: one service, three rows on the roster ---- */
  assert.equal(panel?.id, 'pathfinder', '面板装成了一条服务')
  assert.equal(ledger.size, 3, `这一层登记三条：${[...ledger.keys()].join(', ')}`)

  /* ---- what it drew ---- */
  assert.notEqual(container.querySelector('.pf-page'), null, '画出了面板那一页')
  assert.ok((container.textContent ?? '').length > 0, '面板上有字')
  assert.ok(asked.length > 0, '它向宿主半身要了记录')

  /* Every pane its tabs point at: press each one, and the thing it says it controls has to be there
   * and to be the shown one. The tab set is read off the panel, so a pane added or dropped later
   * moves both sides together. */
  const tabs = mounted.tabs()
  assert.ok(tabs.length > 0, '标签栏画出来了')
  for (const tab of tabs) {
    await act(async () => { tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
    const pane = container.querySelector(`#${String(tab.getAttribute('aria-controls'))}`)
    assert.notEqual(pane, null, `「${tab.textContent}」那一格不在`)
    assert.equal(tab.getAttribute('aria-selected'), 'true', `「${tab.textContent}」按下去没选中`)
  }

  /* Which line the detail is showing follows the pick, and it is not always the record's first line:
   * two lines walked the same record, and pressing the second one has to move the sidebar's
   * `aria-current` and the list of cells under it together. A detail that always resolves the
   * record's first line leaves every assertion above green, so this one is what holds it. */
  const detailTab = tabs.find((tab) => tab.getAttribute('aria-controls') === 'pane-detail')
  assert.notEqual(detailTab, undefined, '明细那一格不在标签栏上')
  await act(async () => { detailTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  const picks = [...container.querySelectorAll('#pane-detail .pf-linepick')]
  assert.deepEqual(picks.map((one) => one.querySelector('.pf-cycle')?.textContent), ['c1', 'c2'], '侧栏一行一条线')
  const second = picks[1]
  await act(async () => { second.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  assert.equal(second.getAttribute('aria-current'), 'true', '点了第二条线：侧栏认的是它')
  assert.equal(picks[0].getAttribute('aria-current'), 'false', '第一条线不再是被选中的那条')
  const rows = [...container.querySelectorAll('#pane-detail .pf-row')].map((row) => row.getAttribute('data-id'))
  assert.deepEqual(rows, ['n1'], '明细列的是这条线走过的格子：c2 只走过 n1')

  /* The drawing is read where the reader sees it: open the map, then read its cards. The map's touch
   * road belongs to `client-map-gesture`; here the drawing is only read, never dragged. */
  const mapTab = tabs.find((tab) => tab.getAttribute('aria-controls') === 'pane-map')
  assert.notEqual(mapTab, undefined, '地图那一格不在标签栏上')
  await act(async () => { mapTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  /* A card's foot names every line the model says this cell belongs to, in the model's own order —
   * the lines that walked it first, then the one holding it — and a cell no line has touched wears
   * no id at all. Printing only the first walker leaves a cell that is merely in a line's hand with
   * no name on it, so the three cells below are the whole of this reading. */
  const tagsOf = (id) => {
    const card = container.querySelector(`.pf-mnode[data-id="${id}"]`)
    assert.notEqual(card, null, `卡片 ${id} 不在图上`)
    return [...card.querySelectorAll('.pf-mtag')].map((tag) => tag.textContent)
  }
  assert.deepEqual(tagsOf('n1'), ['c1·c2'], '一块被两条线走过：两条都印，按记录次序')
  assert.deepEqual(tagsOf('n2'), ['c1'], '一条线只握着它、还没走过：也印得出这条线')
  assert.deepEqual(tagsOf('n3'), [], '哪条线都没碰过：一个标签都不印')
  await mounted.unmount()

  assert.deepEqual(consoleErrors, [], '控制台里有 error')
})
