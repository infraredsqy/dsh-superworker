/* The weight gauge over the built panel: with the table in hand the gauge is drawn to the values the
 * reading carries, and with no table it is not drawn at all.
 *
 * This is the spec's own completion criterion measured where a reader would see it — the mounts below
 * go through the real host half (the gateway, the plugin's own declaration, the model), so what is
 * judged is the whole path and not a stand-in for it. The two cases differ in one thing only: the
 * folder the host reads the weight table from. A host told `null` has no table, which is what a
 * deployment whose issue plugin is missing looks like.
 *
 * What is deliberately *not* measured: slot widths, colours, the number of pixels the line sits at.
 * The gauge's presence and the numbers it is built from are the invariants; its shape is the hand
 * pass's.
 *
 * Needs `lib/client.js`; `npm test` builds it first. Run `node --test tests/` without that build and
 * this file skips itself, saying so.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { bundleSkip, mountBuiltPanel } from './helpers/client-shell.mjs'
import { SEVERITY_WEIGHTS } from '../packages/superworker-core/plugins/issue/tools/storage.mjs'

const json = (value) => JSON.stringify(value, null, 2) + '\n'

/** How many slots the pool weighs: the heaviest tier's own weight, taken from the plugin's constant. */
const HEAVIEST = Math.max(...Object.values(SEVERITY_WEIGHTS))

/**
 * A record whose pool weighs something: one still-open issue of the heaviest tier and one of the
 * lightest, under a policy line high enough to hold them both. The numbers come from the plugin's own
 * constant, so this fixture cannot drift from the table it is weighed by.
 */
const record = () => ({
  '.superworker/ideas.json': json({ nodes: { n1: { title: 'a node', status: 'todo', mode: 'auto', created_at: '2026-01-01T00:00:00.000Z', dependencies: [] } } }),
  '.superworker/state.json': json({
    cycles: [{
      id: 'c1',
      title: 'a cycle',
      status: 'active',
      tags: [],
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-06T00:00:00.000Z',
      /* Above the pool's weight, so the scale has empty slots and the line has somewhere to sit. */
      policies: { issue_pool_weight_limit: HEAVIEST * 2 },
      holding: [],
      path: [],
    }],
  }),
  '.superworker/instructions.json': json({ instructions: [] }),
  '.superworker/issues/issues.json': json({
    version: 1,
    issues: {
      heavy: { id: 'heavy', title: 'the heaviest', severity: 'P0', status: 'open', decision: 'unknown', discovered: '2026-01-08T00:00:00.000Z' },
      light: { id: 'light', title: 'the lightest', severity: 'P3', status: 'open', decision: 'unknown', discovered: '2026-01-08T00:00:00.000Z' },
    },
  }),
})

/** The heaviest tier's own weight, read off the plugin's constant without naming a tier here. */
const HEAVIEST_TIER_WEIGHT = Math.max(...Object.values(SEVERITY_WEIGHTS))

test('with the table in hand: the gauge is drawn, and it is built from the weights the plugin declares', { skip: bundleSkip }, async () => {
  const mounted = await mountBuiltPanel({ record: record() })
  const { act, window, container, tabs, settle, unmount, consoleErrors } = mounted
  try {
    const issueTab = tabs().find((tab) => tab.getAttribute('aria-controls') === 'pane-issue')
    assert.notEqual(issueTab, undefined, 'the issue pane is not in the tab strip')
    await act(async () => { issueTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()

    const gauge = container.querySelector('#gauge')
    assert.notEqual(gauge, null, 'a reading with a table and a line must draw the gauge')

    /* One slot per unit of weight, sized by the policy line: the line is twice the heaviest tier, so
       the scale has that many slots — and the slots that carry a tier are exactly the ones the issues'
       weights add up to. Any second copy of the numbers that disagreed would move one of these. */
    const slots = [...gauge.querySelectorAll('.superworker-block')]
    assert.equal(slots.length, HEAVIEST * 2, 'one slot per unit of the policy line')
    const filled = slots.filter((slot) => slot.className.trim() !== 'superworker-block')
    assert.equal(
      filled.length,
      HEAVIEST + Math.min(...Object.values(SEVERITY_WEIGHTS)),
      'the slots carrying weight are the heaviest tier plus the lightest: the weights the plugin declares',
    )
    assert.ok(HEAVIEST_TIER_WEIGHT > 0, 'the heaviest tier really has weight, or the two counts above say nothing')

    /* The hover line on a severity badge names the weight that tier carries, as declared. */
    const chips = [...container.querySelectorAll('.superworker-sev')]
    assert.ok(chips.length > 0, 'the ledger draws severity badges for the cases it holds')
    const tips = chips.map((chip) => chip.getAttribute('title') ?? '')
    assert.ok(
      tips.every((tip) => [...Object.values(SEVERITY_WEIGHTS)].some((weight) => tip.includes(String(weight)))),
      `a badge tip names no declared weight: ${JSON.stringify(tips)}`,
    )

    assert.deepEqual(consoleErrors, [], 'there is an error in the console')
  } finally {
    await unmount()
  }
})

test('with no table to be had: the gauge is not drawn, and no weight is printed in its place', { skip: bundleSkip }, async () => {
  /* `weightsFolder: null` is a host that was told not to look — the same reading as a folder whose
     issue plugin is not there. The pool and its cases still draw; only the gauge and the weights are
     withheld, because a scale built on a table nobody obtained would be a drawing of a fact the record
     never stated. */
  const mounted = await mountBuiltPanel({ record: record(), weightsFolder: null })
  const { act, window, container, tabs, settle, unmount, consoleErrors } = mounted
  try {
    const issueTab = tabs().find((tab) => tab.getAttribute('aria-controls') === 'pane-issue')
    assert.notEqual(issueTab, undefined, 'the issue pane is not in the tab strip')
    await act(async () => { issueTab.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    await settle()

    assert.equal(container.querySelector('#gauge'), null, 'no table and no line: the gauge must not be drawn')
    /* The cases are still on the ledger — counting them never needed a table. */
    assert.ok(container.querySelectorAll('#pane-issue .superworker-row').length > 0, 'the pool still draws its cases')

    /* No badge stands in a `0` for a weight nobody read: the tip is absent rather than wrong. */
    const chips = [...container.querySelectorAll('.superworker-sev')]
    assert.ok(chips.length > 0, 'the badges are still drawn: a severity is a fact of the case, not of the table')
    for (const chip of chips) {
      const tip = chip.getAttribute('title')
      assert.ok(
        tip === null || !/·\s*(weight|权重)\s*0\b/u.test(tip),
        `a badge claims a weight of 0 where no table was obtained: ${JSON.stringify(tip)}`,
      )
    }

    assert.deepEqual(consoleErrors, [], 'there is an error in the console')
  } finally {
    await unmount()
  }
})
