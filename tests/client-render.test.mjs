/* The built browser half, mounted on its own: the artifact the package ships is handed to the shell,
 * boots onto a roster, draws itself, walks every pane, and leaves the console clean.
 *
 * The record comes from the in-memory port stand-in, so this file needs no `.superworker` directory on disk,
 * no `superworker` command and no fixture of its own: the panel reads through a port. The panel's copy and
 * layout are deliberately not measured here — they move far more often than the four things below,
 * and a test pinning them costs an edit per change; the readings that do need a record are walked by
 * hand. The one reading from a record that is measured here is which lines the panel names: the
 * record tells of one cell two lines walked and one cell only a line holds, and the board's two
 * drawings have to say both. The map's touch road has its own file (`client-map-gesture`): it is the
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
  assert.ok(asked.includes('watch'), 'it opened the host half\'s channel for the records')

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

  /* The board draws one reading two ways, and the two have to agree about which cells they hold.
   * The drawing is read where the reader sees it: open the board, read its cards, then switch it to
   * the list and read its rows. The map's touch road belongs to `client-map-gesture`; here the
   * drawing is only read, never dragged. */
  const boardTab = tabs.find((tab) => tab.getAttribute('aria-controls') === 'pane-nodes')
  assert.notEqual(boardTab, undefined, 'the board tab is not in the tab strip')
  await act(async () => { boardTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
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

  /* The other drawing of the same reading. The scope is the board's own control, and both drawings
   * read it: over the whole workspace the list holds every cell the map draws. */
  const modeBtn = (mode) => container.querySelector(`#node-mode-${mode}`)
  const rows = () => [...container.querySelectorAll('#pane-nodes .superworker-row')].map((row) => row.getAttribute('data-id'))
  assert.equal(modeBtn('map').getAttribute('aria-pressed'), 'true', 'the board opens on the map')
  await act(async () => { modeBtn('detail').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  assert.deepEqual(rows().sort(), ['n1', 'n2', 'n3'], 'over the whole workspace the list holds every cell')
  /* The band's right end counts what is in hand — the same sections the list groups by, counted.
   * The number is not a word, so it is the number this reads: one waiting for a person, one in a
   * line's hand, and nothing ready, which is a zero and so stands no pill. The count is a reading
   * and answers no press. */
  const counted = () => [...container.querySelectorAll('#pane-nodes .superworker-count .superworker-pill .superworker-num')].map((num) => num.textContent)
  assert.deepEqual(counted(), ['1', '1'], 'over the whole workspace the band counts the cells in hand')
  assert.equal(container.querySelectorAll('#pane-nodes .superworker-count .superworker-state.is-gate').length, 1, 'the waiting count wears the pause mark its rows wear')
  assert.equal(container.querySelectorAll('#pane-nodes .superworker-count .superworker-state.is-run').length, 1, 'the count of what a line holds wears the ring its rows wear')
  assert.equal(container.querySelectorAll('#pane-nodes .superworker-count button').length, 0, 'the count answers no press')
  /* A cell walked by two lines says so on its row, and only over the whole workspace: a scoped list
   * would wear the scope control\'s own word on every row. */
  const rowTagsOf = (id) => [...container.querySelector(`#pane-nodes .superworker-row[data-id="${id}"]`).querySelectorAll('.superworker-mtag')].map((tag) => tag.textContent)
  assert.deepEqual(rowTagsOf('n1'), ['c1·c2'], 'the row names both lines the cell belongs to')

  /* The scope is a filter over both drawings, and it is the board\'s, not the drawing\'s: it
   * survives the switch from one drawing to the other. */
  const scope = container.querySelector('#node-scope')
  assert.notEqual(scope, null, 'the scope control is missing')
  await act(async () => {
    scope.value = 'c2'
    scope.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle()
  assert.deepEqual(rows(), ['n1'], 'the list holds only the scoped line\'s cells')
  assert.deepEqual(rowTagsOf('n1'), [], 'under one scope the row wears no line tag')
  /* The scope filters the count as it filters the drawings: this line holds nothing and waits on
   * nothing, so the band counts nothing. */
  assert.deepEqual(counted(), [], 'under a line with nothing in hand the band counts nothing')
  await act(async () => { modeBtn('map').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  await settle()
  assert.equal(scope.value, 'c2', 'switching the drawing keeps the scope')
  const cards = [...container.querySelectorAll('.superworker-mnode')].map((card) => card.getAttribute('data-id'))
  assert.deepEqual(cards, ['n1'], 'the scoped map draws the cells the scoped list lists')
  await mounted.unmount()

  assert.deepEqual(consoleErrors, [], 'there is an error in the console')
})

test('a pane that fails to draw keeps the workshop up: the guard says so, the catch is loud, coming back retries', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  const { window, React, act, client, container, consoleErrors } = mounted

  /* The wiring proof is the healthy mount itself: every pane body now draws behind a guard, the
   * panel above drew clean, and no guard tripped on its own. */
  assert.notEqual(container.querySelector('.superworker-page'), null, 'the panel is drawn behind the guards')

  /* The guard pressed directly, on a root of its own: the child throws while `broken` stands, on
   * every attempt — the stand-in for a pane whose drawing went wrong (the overview's measure-loop
   * crash was exactly one of these, and without the guard it retired the whole center cell). A
   * throw-once child would not do: React retries a failed render once before a boundary may
   * catch it, so the child must still be broken on the retry. The flag moves between draws,
   * never inside one. The sentence is this case's own, so the panel's wording stays out of the
   * unit's hands. */
  const { PaneBoundary } = client
  const { createRoot } = await import('react-dom/client')
  let broken = true
  const FlakyPane = () => {
    if (broken) throw new Error('the drawing went wrong')
    return React.createElement('p', null, 'the pane drew')
  }
  const holder = window.document.createElement('div')
  window.document.body.appendChild(holder)
  const root = createRoot(holder)
  const draw = async (active) => {
    await act(async () => {
      root.render(
        React.createElement(PaneBoundary, { pane: 'probe', active, said: 'the pane could not be drawn' }, React.createElement(FlakyPane)),
      )
    })
  }

  await draw(true)
  assert.equal(holder.textContent, 'the pane could not be drawn', 'a pane that cannot draw says so in its own place')
  assert.ok(consoleErrors.some((line) => line.includes('did not draw')), 'the catch is loud: a crash must leave a traceable line')

  /* Still broken, the reader leaves and comes back: the re-arm re-runs the pane, and a crash that
   * still happens crashes again — the sentence returns, loud a second time. */
  await draw(false)
  await draw(true)
  assert.equal(holder.textContent, 'the pane could not be drawn', 'a pane that is still broken says so again')
  const loud = () => consoleErrors.filter((line) => line.includes('did not draw')).length
  assert.equal(loud(), 2, 'each crash is loud exactly once')

  /* A pane whose fault is gone heals on the way back: the flag lifts while the pane is away, and
   * the re-arm's retry draws the body instead of the sentence. */
  broken = false
  await draw(false)
  await draw(true)
  assert.equal(holder.textContent, 'the pane drew', 'coming back retries the pane, and a healed one draws again')
  assert.equal(holder.querySelector('.superworker-none'), null, 'no sentence stands over a drawn pane')
  assert.equal(loud(), 2, 'a healed draw crashes no third time')

  await act(async () => { root.unmount() })
  holder.remove()
  await mounted.unmount()
})

test('a workspace with no record keeps the tab strip: every tab still opens, and the one sentence stands under each', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: {} })
  const { window, act, container, consoleErrors, settle } = mounted

  /* All four sources missing is the one nothing-to-draw state that keeps its tabs: the sentence
   * replaces each pane's body, and the strip stays so the reader can move between the views. */
  const tabs = mounted.tabs()
  assert.equal(tabs.length, 5, 'the tab strip is not drawn over an empty workspace')
  for (const tab of tabs) {
    await act(async () => { tab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()
    assert.equal(tab.getAttribute('aria-selected'), 'true', `pressing "${tab.textContent}" did not select it`)
    const sentence = container.querySelector('.superworker-none p')
    assert.notEqual(sentence, null, `the "${tab.textContent}" tab has no sentence under it`)
    assert.ok((sentence.textContent ?? '').length > 0, 'the sentence under the tab has no words')
    assert.equal(container.querySelector('.superworker-stage'), null, 'an empty pane stage stands beside the sentence')
  }

  await mounted.unmount()
  assert.deepEqual(consoleErrors, [], 'there is an error in the console')
})

test('SettingsSection forwards port to AnswerRow and reads/writes global answer without a session', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  const { window, React, act, client, settle } = mounted
  const { SettingsSection } = client
  const { createRoot } = await import('react-dom/client')

  let current = 'plain'
  const calls = []
  const port = {
    source: 'remote',
    async readGlobalConfig(sessionId, workspaceRoot) {
      calls.push(['readGlobalConfig', sessionId, workspaceRoot])
      return {
        workspaceRoot: '',
        ok: true,
        text: '',
        refusal: null,
        entries: {
          answer: { value: current, layer: 'global', options: ['technical', 'plain'], layers: ['project', 'global'] },
        },
      }
    },
    async setGlobalConfig(sessionId, workspaceRoot, key, value) {
      calls.push(['setGlobalConfig', sessionId, workspaceRoot, key, value])
      current = value
      return { ok: true, text: '' }
    },
  }

  const holder = window.document.createElement('div')
  window.document.body.appendChild(holder)
  const root = createRoot(holder)
  await act(async () => {
    root.render(React.createElement(SettingsSection, { port }))
  })
  await settle()

  const select = holder.querySelector('.superworker-settings-pick select')
  assert.notEqual(select, null, 'AnswerRow renders a select dropdown when port is connected')
  assert.equal(select.value, 'plain')
  assert.deepEqual([...select.options].map((o) => o.value), ['technical', 'plain'])
  assert.ok(calls.some((c) => c[0] === 'readGlobalConfig'), 'readGlobalConfig was called')

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set
    setter.call(select, 'technical')
    select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await settle()

  assert.ok(calls.some((c) => c[0] === 'setGlobalConfig' && c[3] === 'answer' && c[4] === 'technical'), 'setGlobalConfig wrote technical')
  assert.equal(select.value, 'technical')

  await act(async () => { root.unmount() })
  holder.remove()
  await mounted.unmount()
})
