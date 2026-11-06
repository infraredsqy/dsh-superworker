/* The built browser half, mounted on its own: the artifact the package ships is handed to the shell,
 * boots onto a roster, draws itself, walks every pane, and leaves the console clean.
 *
 * The record comes from the in-memory port stand-in, so this file needs no `.pf` directory on disk,
 * no `pf` command and no fixture of its own: the panel reads through a port. What the panel *says*
 * about a record is deliberately not measured here — the copy and the layout move far more often
 * than the four things below, and a test pinning them costs an edit per change; the readings that
 * do need a record are walked by hand. The map's touch road has its own file (`client-map-gesture`):
 * it is the map's wiring, not this artifact smoke test's business.
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

test('这一份产物：外壳装得上、画得出来、每一格都走得通，控制台一路干净', { skip: bundleSkip }, async () => {
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

  await mounted.unmount()

  assert.deepEqual(consoleErrors, [], '控制台里有 error')
})
