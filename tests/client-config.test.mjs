/* Layout table for the config section: locks in how rows grow out of readings, how known keys are
 * described, which category each row falls under, and how the page's sections come out.
 *
 * The tool is the single source of truth for config keys; this side never declares "which keys the
 * tool has": rows grow out of `config list` readings, registered keys render per the table, and
 * unregistered ones fall back to raw key name + text input. The dropdown candidates are the
 * engine's own declaration, handed in with the reading — this side spells no candidate word of its
 * own. No UI snapshots are locked; instead a few things that could silently drift are: a key
 * present in the reading losing its row, a dropdown settling on its first option when the reading
 * has no value, an out-of-list candidate value being silently snapped back to the first option,
 * and a second candidate list growing back on this side.
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
function entry(value, layer = 'project', options) {
  return options === undefined ? { value, layer } : { value, layer, options }
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

test('registered keys render per the table: the table\'s description stands whatever control the reading grows', () => {
  /* With candidates in the reading, the drawn row is the table's own, carrying the reading's words. */
  const options = ['off', 'fork']
  const described = configRowsOf({ worktree_mode: entry('fork', 'project', options) })
  assert.deepEqual(described[0], { ...KNOWN_CONFIG_ROWS['worktree_mode'], options })
  /* Without them the row falls back to a text box, but stays the table's: name, caption and group
   * keep standing, so a described key never degrades into a raw unregistered row. */
  const fallback = configRowsOf({ worktree_mode: entry('off') })[0]
  assert.equal(fallback.kind, 'text')
  assert.equal(fallback.name, KNOWN_CONFIG_ROWS['worktree_mode'].name)
  assert.equal(fallback.caption, KNOWN_CONFIG_ROWS['worktree_mode'].caption)
  assert.equal(fallback.group, KNOWN_CONFIG_ROWS['worktree_mode'].group)
})

test('a knob only the global layer accepts is in the table as read-only: no text-box fallback, no control kind, no candidates', () => {
  /* `answer` declares layers: ['global'] and the pane writes the project layer only, so the old
   * fallback drew it as an unregistered text row — a control the tool refuses every time. */
  const rows = configRowsOf({ answer: entry('plain', 'default') })
  assert.deepEqual(rows.map((row) => row.key), ['answer'])
  const row = rows[0]
  assert.equal(row, KNOWN_CONFIG_ROWS['answer'], 'the global-only knob is described by the table, not drawn as an unregistered text box')
  assert.equal(row.kind, 'readonly', 'the write road cannot reach its layer: the row stands read-only, no dead control')
  assert.equal(row.options, undefined, 'a read-only row offers no candidates')
  assert.equal(row.name, null, 'the knob\'s name is a record word, printed as it stands in every language')
  assert.ok(rowWords(t, row).name.length > 0, 'the name cell still prints the key itself')
  assert.ok(rowWords(t, row).caption.length > 0, 'the caption says who can change it')
})

test('the table spells no candidates: the engine\'s declaration is the only vocabulary, the reading is where it arrives', () => {
  /* A candidate word spelled here would be a second copy of the engine's list, drifting the moment
   * the engine edits its declaration — the very debt this face once carried. */
  for (const row of Object.values(KNOWN_CONFIG_ROWS)) {
    assert.equal(row.options, undefined, `${row.key} hand-copies candidates; candidates grow from the reading only`)
  }
})

test('candidates are the reading\'s own words: a vocabulary this client has never spelled is offered as it stands (the engine edits its declaration, the client changes nothing)', () => {
  /* The words below are spelled nowhere in this client — the engine's declaration is their only
   * home. The row's options are the entry's options, whatever they are; nothing here pins which
   * words the engine states. */
  const options = ['alpha', 'beta', 'gamma']
  const rows = configRowsOf({ worktree_mode: entry('beta', 'project', options) })
  assert.deepEqual(rows[0].options, options, 'the row offers exactly the reading\'s words, in the reading\'s order')
  assert.deepEqual(
    pickState({ value: 'gamma', layer: 'project' }, rows[0].options),
    { value: 'gamma', extra: null },
    'a declared word draws as its own option',
  )
})

test('a key the engine declares no vocabulary for falls back to a text box, even when the table calls it a dropdown; only the dropdown kind reads the candidates', () => {
  const rows = configRowsOf({
    worktree_mode: entry('off'),
    max_agents: entry('1', 'project', ['1', '2']),
    spawner: entry('dsh', 'project', ['dsh', 'other']),
  })
  const fallback = rows.find((row) => row.key === 'worktree_mode')
  assert.equal(fallback.kind, 'text', 'no declared vocabulary, no dropdown — a control with no words in it is not drawn')
  assert.equal(fallback.options, undefined, 'the fallback invents no candidates')
  assert.equal(rows.find((row) => row.key === 'max_agents').kind, 'num', 'a number row stays a number row')
  assert.equal(rows.find((row) => row.key === 'max_agents').options, undefined, 'a non-dropdown row ignores the candidates')
  assert.equal(rows.find((row) => row.key === 'spawner').kind, 'text', 'an unregistered key stays a text box')
  assert.equal(rows.find((row) => row.key === 'spawner').options, undefined, 'an unregistered row takes no candidates either')
})

test('when the reading has no value for the key, neither dropdown settles on an option (left empty), not the first one', () => {
  const readings = configRowsOf({
    worktree_mode: entry('off', 'project', ['off', 'fork', 'reuse']),
    test_tier: entry('full', 'project', ['full', 'minimal']),
  })
  const picks = readings.filter((row) => row.kind === 'pick')
  assert.deepEqual(picks.map((row) => row.key), ['worktree_mode', 'test_tier'])
  for (const row of picks) {
    const options = row.options
    assert.deepEqual(pickState(undefined, options), { value: '', extra: null }, `${row.key} settled on an option with no value`)
    /* Leaving empty is not done by stuffing an empty word into the candidates: the list keeps only the words the declaration states. */
    assert.ok(!options.includes(''), `${row.key} had an empty word stuffed into its candidates`)
  }
})

test('a value in the reading: show it among the options, add it as its own option if not among them, never fall back to the first option', () => {
  for (const row of configRowsOf({
    worktree_mode: entry('fork', 'project', ['off', 'fork', 'reuse']),
    test_tier: entry('minimal', 'project', ['full', 'minimal']),
  }).filter((one) => one.kind === 'pick')) {
    const options = row.options
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