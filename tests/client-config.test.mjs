/* Layout table for the config section: locks in how rows grow out of readings, how known keys are
 * described, which category each row falls under, and how the page's sections come out.
 *
 * The tool is the single source of truth for config keys; this side never declares "which keys the
 * tool has": rows grow out of `config list` readings, registered keys render per the table, and
 * unregistered ones fall back to raw key name + text input. No UI snapshots are locked; instead a
 * few things that could silently drift are: a key present in the reading losing its row, a
 * dropdown settling on its first option when the reading has no value, and out-of-table candidate
 * values being silently snapped back to the first option.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONFIG_GROUPS,
  configRowsOf,
  configSectionsOf,
  groupOfUnregistered,
  KNOWN_CONFIG_ROWS,
  pickState,
  rowWords,
} from '../src/client/config-rows.ts'
import { createLocalePort } from '../src/client/locale.ts'

/** The zh translator the panel itself stands on before any language service attaches: the words a reader actually sees. */
const t = createLocalePort().getSnapshot().t

/** A synthetic reading: key names are arbitrary — the rendering only cares "one row per printed key". */
function entry(value, layer = 'project') {
  return { value, layer }
}

test('every registered key is described: name, caption, group, none missing', () => {
  for (const row of Object.values(KNOWN_CONFIG_ROWS)) {
    const words = rowWords(t, row)
    assert.ok(words.name.length > 0 && words.caption.length > 0, `${row.key} has no name or no caption`)
    assert.ok(CONFIG_GROUPS.includes(row.group), `${row.key} falls outside the three groups`)
  }
})

test('rows grow out of the reading: only keys the reading has get a row; known keys follow the table order, not the tool\'s print order', () => {
  /* The reading is deliberately given in the tool's print order: the rendered order is still the table's own. */
  const rows = configRowsOf({
    max_agents: entry('1'),
    test_tier: entry('full'),
    worktree_mode: entry('off'),
    issue_repair: entry('on', 'default'),
  })

  assert.deepEqual(rows.map((row) => row.key), ['worktree_mode', 'test_tier', 'max_agents', 'issue_repair'])
  /* If the tool ever stops printing a key, its row disappears with it — nothing is drawn for what doesn't exist; this repo does not backfill rows. */
  assert.deepEqual(configRowsOf({ max_agents: entry('1') }).map((row) => row.key), ['max_agents'])
})

test('unregistered keys: raw key name + text input, after the known rows, none dropped', () => {
  const rows = configRowsOf({
    max_agents: entry('1'),
    spawner: entry('dsh'),
    test_tier: entry('full'),
    worktree_mode: entry('off'),
    issue_repair: entry('on', 'default'),
  })

  assert.deepEqual(rows.map((row) => row.key), ['worktree_mode', 'test_tier', 'max_agents', 'issue_repair', 'spawner'])
  const stranger = rows[4]
  assert.equal(stranger.name, null, 'an unregistered key has no name to look up, the table leaves it empty')
  assert.equal(rowWords(t, stranger).name, 'spawner', 'an unregistered key shows its raw name, no invented name')
  assert.equal(stranger.kind, 'text', 'an unregistered key gets a text input, no guessed control shape')
  assert.equal(stranger.options, undefined)
  assert.ok(rowWords(t, stranger).caption.length > 0, 'an unregistered key still has a caption saying who judges the value')
})

test('registered keys render per the table: a key in the reading that is in the table uses the table\'s row', () => {
  const rows = configRowsOf({ worktree_mode: entry('fork') })

  assert.deepEqual(rows[0], KNOWN_CONFIG_ROWS['worktree_mode'])
})

test('one control per row: the dropdown kind carries candidates, the other three do not', () => {
  for (const row of Object.values(KNOWN_CONFIG_ROWS)) {
    if (row.kind === 'pick') {
      assert.ok((row.options ?? []).length > 1, `${row.key} is a dropdown but has no candidates`)
      assert.equal(new Set(row.options).size, row.options?.length, `${row.key} has duplicate candidates`)
    } else {
      assert.equal(row.options, undefined, `${row.key} is not a dropdown but carries candidates`)
    }
  }
})

test('when the reading has no value for the key, neither dropdown settles on an option (left empty), not the first one', () => {
  const picks = Object.values(KNOWN_CONFIG_ROWS).filter((row) => row.kind === 'pick')
  assert.deepEqual(picks.map((row) => row.key), ['worktree_mode', 'test_tier'])
  for (const row of picks) {
    const options = row.options ?? []
    assert.deepEqual(pickState(undefined, options), { value: '', extra: null }, `${row.key} settled on an option with no value`)
    /* Leaving empty is not done by stuffing an empty word into the candidates: the table keeps only the words the tool recognizes. */
    assert.ok(!options.includes(''), `${row.key} had an empty word stuffed into its candidates`)
  }
})

test('a value in the reading: show it if it is in the table, add it as its own option if not, never fall back to the first option', () => {
  for (const row of Object.values(KNOWN_CONFIG_ROWS).filter((one) => one.kind === 'pick')) {
    const options = row.options ?? []
    assert.deepEqual(pickState({ value: options[1], layer: 'project' }, options), { value: options[1], extra: null })
    assert.deepEqual(pickState({ value: 'partial', layer: 'project' }, options), { value: 'partial', extra: 'partial' })
  }
})

test('sections split from rows: 常规 / 问题 / 测试; table order within a section; an empty group loses both its section and its index entry', () => {
  const sections = configSectionsOf({
    max_agents: entry('1'),
    test_seconds_limit: entry('-', 'default'),
    worktree_mode: entry('off'),
    issue_pool: entry('on', 'default'),
    test_tier: entry('full'),
    issue_pool_weight_limit: entry('-', 'default'),
    test_audit: entry('on', 'default'),
  })

  assert.deepEqual(sections.map((section) => section.group), ['general', 'issue', 'test'])
  assert.deepEqual(sections.map((section) => section.rows.map((row) => row.key)), [
    ['worktree_mode', 'test_tier', 'max_agents'],
    ['issue_pool', 'issue_pool_weight_limit'],
    ['test_audit', 'test_seconds_limit'],
  ])
  /* Only keys the reading printed: a group whose keys are all absent is dropped, not drawn empty. */
  assert.deepEqual(
    configSectionsOf({ max_agents: entry('1') }).map((section) => [section.group, section.rows.length]),
    [['general', 1]],
  )
  assert.deepEqual(configSectionsOf({}), [])
})

test('unregistered keys group by prefix: issue_ into issue, test_ into test, the rest into general', () => {
  assert.equal(groupOfUnregistered('issue_pool'), 'issue')
  assert.equal(groupOfUnregistered('test_audit'), 'test')
  assert.equal(groupOfUnregistered('spawner'), 'general')
  assert.equal(groupOfUnregistered('max_workers'), 'general')

  assert.deepEqual(
    configSectionsOf({
      test_shard: entry('4', 'default'),
      spawner: entry('dsh'),
      issue_scan: entry('on', 'default'),
    }).map((section) => [section.group, section.rows.map((row) => row.key)]),
    [
      ['general', ['spawner']],
      ['issue', ['issue_scan']],
      ['test', ['test_shard']],
    ],
  )
})