/* The browser-half settings pathway: locks in a few invariants.
 *
 * The panel's own preferences come from a settings document (the field table in
 * `src/host/settings-fields.ts`, with the host building the schema from it). This file measures
 * three things: a settings document reads into the panel's values, the write-back op handed to
 * the settings service carries the right revision, and the source's readings before/after the
 * settings service arrives (no change means no subscriber wake-up — `useSyncExternalStore`
 * depends on it; breaking that means the panel re-renders forever).
 *
 * A second set asks `buildConfig` directly: all four fields present in the host schema, each
 * marked volatile, and the factory defaults and bounds matching the field table's numbers. A
 * field missing the volatile mark simply never appears on the settings page, with no error
 * either — so a stand-in that records every call stands in for schemastery to press that
 * question to the end.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfig } from '../src/host/config.ts'
import {
  PANEL_PREF_DEFAULTS,
  PANEL_PREF_FIELDS,
  SIDE_DEFAULT,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_IDS,
} from '../src/host/settings-fields.ts'
import {
  clampSide,
  createPrefsSource,
  DEFAULT_PREFS,
  prefsFromSection,
  prefsWriteOp,
  VIEW_WORDS,
} from '../src/client/prefs.ts'
import { createLocalePort } from '../src/client/locale.ts'
import { fakeSettingsForm } from './helpers/dsh-standins.mjs'

/* The shared settings-document stand-in, with this file's extra face switched on: every case here
 * reads the write log (and notify / bump) the option adds. */
const fakeForm = (initial) => fakeSettingsForm(initial, { writeLog: true })

test('the field table is exactly those keys, and the factory defaults line up item by item with the browser side', () => {
  assert.deepEqual(Object.keys(PANEL_PREF_DEFAULTS).sort(), Object.values(PANEL_PREF_FIELDS).sort())
  /* The words printed on the settings page and the panel: one entry per view. The table holds
   * KEYS, so what has to line up is the key set. */
  assert.deepEqual(Object.keys(VIEW_WORDS).sort(), [...VIEW_IDS].sort())

  /* Each entry RESOLVES to a word through the lookup table: every view still has something to
   * print, and it is the lookup table in force that says it. */
  const t = createLocalePort().getSnapshot().t
  for (const entry of Object.values(VIEW_WORDS)) {
    assert.equal(typeof t(entry), 'string', `${entry} has no word in the bundled dictionary`)
    assert.notEqual(t(entry), entry, `${entry} should resolve to a word, not draw the key itself`)
  }

  /* What the table holds is the KEY, not the word: the settings row and the tab row both render it
   * through the same translator, so the two cannot drift apart. */
  assert.notEqual(VIEW_WORDS.map, t(VIEW_WORDS.map))
})

test('a fully written settings document reads as those panel values', () => {
  const prefs = prefsFromSection({
    sideWidth: 200,
    defaultTab: 'detail',
    showArchived: true,
    showOtherStates: true,
    autoRelay: false,
  })
  assert.deepEqual(prefs, { sideWidth: 200, tab: 'detail', archived: true, otherStates: true, autoRelay: false })
})

test('sections that cannot be read fall back to the factory ones, the rest read through', () => {
  assert.deepEqual(prefsFromSection(undefined), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection(null), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection('not a document'), DEFAULT_PREFS)
  assert.deepEqual(prefsFromSection({}), DEFAULT_PREFS)
  /* Stored records may still hold words written by older versions: unrecognized ones each fall back, the rest read through. */
  assert.deepEqual(
    prefsFromSection({ defaultTab: 'overview', showArchived: 'yes', sideWidth: 'wide' }),
    DEFAULT_PREFS,
  )
  assert.deepEqual(
    prefsFromSection({ defaultTab: 'issue', showArchived: 1, showOtherStates: 0 }),
    { sideWidth: DEFAULT_PREFS.sideWidth, tab: 'issue', archived: false, otherStates: false, autoRelay: true },
  )
  /* The relay switch reads `false` when the document says false; a value that is not a boolean
     (an older document, a hand edit) falls back to the factory default, which is on. */
  assert.deepEqual(prefsFromSection({ autoRelay: true }).autoRelay, true)
  assert.deepEqual(prefsFromSection({ autoRelay: 'no' }).autoRelay, true)
  /* A field this version no longer has (`infoLevel`, the old cards-per-column tier) is dead weight
   * in an old document: it reads as nothing rather than as a bad value. */
  assert.deepEqual(prefsFromSection({ infoLevel: 'lean' }), DEFAULT_PREFS)
})

test('width clamps into its bounds: out of range comes back in, unmeasurable uses the factory one', () => {
  assert.equal(clampSide(SIDE_MIN - 1), SIDE_MIN)
  assert.equal(clampSide(SIDE_MAX + 1), SIDE_MAX)
  assert.equal(clampSide(SIDE_DEFAULT), SIDE_DEFAULT)
  assert.equal(clampSide(SIDE_DEFAULT + 0.4), SIDE_DEFAULT)
  assert.equal(prefsFromSection({ sideWidth: SIDE_MAX + 500 }).sideWidth, SIDE_MAX)
  assert.equal(prefsFromSection({ sideWidth: SIDE_MIN - 500 }).sideWidth, SIDE_MIN)
  assert.equal(prefsFromSection({ sideWidth: Number.NaN }).sideWidth, SIDE_DEFAULT)
  assert.equal(prefsFromSection({ sideWidth: Number.POSITIVE_INFINITY }).sideWidth, SIDE_DEFAULT)
})

test('the write is one top-level set, its path the field table\'s own word', () => {
  assert.deepEqual(prefsWriteOp(PANEL_PREF_FIELDS.defaultTab, 'map'), {
    op: 'set',
    path: ['defaultTab'],
    value: 'map',
  })
  assert.deepEqual(prefsWriteOp(PANEL_PREF_FIELDS.sideWidth, 216), {
    op: 'set',
    path: ['sideWidth'],
    value: 216,
  })
  /* A fresh object per call: callers mutating it must not leak elsewhere. */
  assert.notEqual(prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true), prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true))
})

test('the settings service has not arrived: the factory values, and the write does not count', async () => {
  const source = createPrefsSource()
  assert.deepEqual(source.getSnapshot(), {
    prefs: DEFAULT_PREFS,
    status: 'unavailable',
    revision: undefined,
    writable: false,
    refused: false,
  })
  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'detail'), false)
})

test('once the form is attached the reading is that section, revision and all', () => {
  const form = fakeForm({ sideWidth: 300, defaultTab: 'issue', showArchived: true })
  const source = createPrefsSource()
  source.attach(form)
  const snapshot = source.getSnapshot()
  assert.deepEqual(snapshot.prefs, { sideWidth: 300, tab: 'issue', archived: true, otherStates: false, autoRelay: true })
  assert.equal(snapshot.status, 'ready')
  assert.equal(snapshot.revision, 1)
  assert.equal(snapshot.writable, true)
})

test('the write carries the revision it read; the second carries the latest one', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)

  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'detail'), true)
  assert.deepEqual(form.writes[0], {
    ops: [{ op: 'set', path: ['defaultTab'], value: 'detail' }],
    expected: 1,
  })
  assert.equal(source.getSnapshot().revision, 2)

  assert.equal(await source.write(PANEL_PREF_FIELDS.defaultTab, 'notes'), true)
  assert.deepEqual(form.writes[1], {
    ops: [{ op: 'set', path: ['defaultTab'], value: 'notes' }],
    expected: 2,
  })
  assert.equal(form.document().defaultTab, 'notes')
})

test('the second write in one round trip: the first is refused with a stale revision, and without the fence it lands on the retry', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)
  /* Someone else bumped the document first; this side still holds 1. */
  form.bump()

  assert.equal(await source.write(PANEL_PREF_FIELDS.showArchived, true), true)
  assert.equal(form.writes.length, 2)
  assert.deepEqual(form.writes[0], {
    ops: [{ op: 'set', path: ['showArchived'], value: true }],
    expected: 1,
  })
  /* After the rejection this write carries no fence: the controller picks up the latest revision itself. */
  assert.deepEqual(form.writes[1], {
    ops: [{ op: 'set', path: ['showArchived'], value: true }],
    expected: undefined,
  })
  assert.equal(form.document().showArchived, true)
  assert.equal(source.getSnapshot().refused, false)
  assert.equal(source.getSnapshot().prefs.archived, true)
})

test('two attempts, neither accepted: not silent — the reading says refused, and the next successful write takes it back', async () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  source.attach(form)
  form.refuse()

  assert.equal(await source.write(PANEL_PREF_FIELDS.showOtherStates, true), false)
  assert.equal(form.writes.length, 2)
  assert.equal(form.writes[1].expected, undefined)
  /* Two attempts, neither accepted: the reading says so. A fact, not a sentence — which words say
   * it is the panel's business, because the language is the reader's. */
  assert.equal(source.getSnapshot().refused, true, 'two failed attempts must show in the reading, not stay silent')
  assert.equal(source.getSnapshot().failure, undefined, 'the reading carries the fact of refusal, not a sentence')

  /* A successful write clears it: the fact is about "the previous write did not land". */
  form.refuse(false)
  assert.equal(await source.write(PANEL_PREF_FIELDS.showOtherStates, true), true)
  assert.equal(source.getSnapshot().refused, false)
})

test('a row flipped elsewhere: subscribers get the new reading at once', () => {
  const form = fakeForm({})
  const source = createPrefsSource()
  let rounds = 0
  source.attach(form)
  source.subscribe(() => { rounds += 1 })

  form.mutate([prefsWriteOp(PANEL_PREF_FIELDS.showArchived, true)], undefined)
  assert.equal(source.getSnapshot().prefs.archived, true)

  /* One wake-up with the value untouched: the snapshot is not replaced and no further notification
   * happens — `useSyncExternalStore` compares it across reads; a fresh object per read would make
   * the panel re-render forever. */
  const held = source.getSnapshot()
  const before = rounds
  form.notify()
  assert.equal(source.getSnapshot(), held)
  assert.equal(rounds, before)
})

test('a form swapped or taken back: the reading follows, and taking it back returns to the factory values', () => {
  const first = fakeForm({ defaultTab: 'detail' })
  const second = fakeForm({ defaultTab: 'notes', showOtherStates: true })
  const source = createPrefsSource()
  const off = source.attach(first)
  assert.equal(source.getSnapshot().prefs.tab, 'detail')

  source.attach(second)
  assert.equal(source.getSnapshot().prefs.tab, 'notes')
  assert.equal(source.getSnapshot().prefs.otherStates, true)
  first.notify()
  assert.equal(source.getSnapshot().prefs.tab, 'notes')

  off()
  /* `off` means "detach only if it is still my instance"; the second form is the one attached now, so the reading stays. */
  assert.equal(source.getSnapshot().prefs.tab, 'notes')
  source.attach(null)
  assert.deepEqual(source.getSnapshot().prefs, DEFAULT_PREFS)
  assert.equal(source.getSnapshot().status, 'unavailable')
})

function fakeSchemastery() {
  const made = []
  const field = (kind, extra = {}) => {
    const node = {
      kind,
      extra,
      marks: [],
      defaults: [],
      volatile() { this.marks.push('volatile'); return this },
      default(value) { this.defaults.push(value); return this },
      min(value) { this.extra.min = value; return this },
      max(value) { this.extra.max = value; return this },
    }
    made.push(node)
    return node
  }
  return {
    made,
    boolean: () => field('boolean'),
    number: () => field('number'),
    union: (values) => field('union', { values: [...values] }),
    object: (dict) => ({ kind: 'object', dict }),
  }
}

test('the host schema: all four fields are there, each marked volatile', () => {
  const z = fakeSchemastery()
  const schema = buildConfig(z)
  assert.deepEqual(Object.keys(schema.dict), Object.values(PANEL_PREF_FIELDS))
  /* Asked one by one: a field missing the volatile mark never appears on the settings page, and the page raises no error either. */
  for (const [name, node] of Object.entries(schema.dict)) {
    assert.ok(node.marks.includes('volatile'), `${name} is missing its volatile mark`)
  }
})

test('the host schema: kinds, factory defaults and bounds are the field table\'s own numbers', () => {
  const z = fakeSchemastery()
  const dict = buildConfig(z).dict
  const read = (name) => {
    const node = dict[name]
    return { kind: node.kind, defaults: node.defaults, extra: node.extra }
  }

  assert.deepEqual(read(PANEL_PREF_FIELDS.sideWidth), {
    kind: 'number',
    defaults: [PANEL_PREF_DEFAULTS.sideWidth],
    extra: { min: SIDE_MIN, max: SIDE_MAX },
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.defaultTab), {
    kind: 'union',
    defaults: [PANEL_PREF_DEFAULTS.defaultTab],
    extra: { values: [...VIEW_IDS] },
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.showArchived), {
    kind: 'boolean',
    defaults: [PANEL_PREF_DEFAULTS.showArchived],
    extra: {},
  })
  assert.deepEqual(read(PANEL_PREF_FIELDS.showOtherStates), {
    kind: 'boolean',
    defaults: [PANEL_PREF_DEFAULTS.showOtherStates],
    extra: {},
  })
  /* The relay switch defaults to on: an untouched row must not silently turn the relay off. */
  assert.deepEqual(read(PANEL_PREF_FIELDS.autoRelay), {
    kind: 'boolean',
    defaults: [PANEL_PREF_DEFAULTS.autoRelay],
    extra: {},
  })
  assert.equal(PANEL_PREF_DEFAULTS.autoRelay, true)
})

test('prefs no longer carries POLICY_KEYS: no second policy-key list on the panel side', async () => {
  const prefs = await import('../src/client/prefs.ts')

  assert.equal(prefs.POLICY_KEYS, undefined, 'the panel keeps no policy-key list of its own: whether a key is writable is the tool\'s call')
})