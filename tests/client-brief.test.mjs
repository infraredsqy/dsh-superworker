/* The concise drawing's words: how a step's categories become one title, and what an open step says.
 *
 * The cases pin the *rule*, not the copy: every expectation is built from the lookup table's own
 * pieces, so a table that rewords a label moves nothing here, while a join that elides the wrong
 * prefix, prints a count, or forgets to lower-case a continued label fails. That is the arrangement
 * DSH's own `processTitle()` has, quoted into this panel — and the two cases that use Chinese check
 * that the prefix it elides is the one the table actually states.
 *
 *   node --test tests/client-brief.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { briefLineOf } from '../src/client/brief.ts'
import { createLocalePort, localeOf } from '../src/client/locale.ts'
import { en } from '../src/client/locales/index.ts'

/** The bundled table's translator: what a deployment with no locale service speaks. */
const chinese = localeOf(createLocalePort()).t

/**
 * The English one, through the port's own road: a service that answers which language it is in but
 * cannot bind a translator, which is exactly the case the bundled table stands behind.
 */
const english = (() => {
  const port = createLocalePort()
  port.attach({
    register: () => undefined,
    bind: () => { throw new Error('this stand-in cannot bind') },
    getLocale: () => ({ active: 'en' }),
  })
  return localeOf(port).t
})()

/** One closed step of these categories, as the model hands it over. */
function step(categories) {
  return { kind: 'step', key: 'k', from: 0, to: 0, categories, open: false, now: null }
}

/** One open step, on the category it names or on nothing in particular. */
function openStep(now) {
  return { kind: 'step', key: 'k', from: 0, to: 0, categories: [], open: true, now }
}

/* ---- one label ----------------------------------------------------------- */

test('one category says its own word and nothing else', () => {
  assert.equal(briefLineOf(chinese, step(['commands'])), chinese('brief.done.commands'))
  assert.equal(briefLineOf(chinese, step(['read'])), chinese('brief.done.read'))
})

test('a step with no category at all says the word DSH keeps for reasoning', () => {
  assert.equal(briefLineOf(chinese, step([])), chinese('brief.done.thinking'))
})

/* ---- two labels ---------------------------------------------------------- */

test('two labels that share a prefix say it once', () => {
  const prefix = chinese('brief.step.shared')
  const first = chinese('brief.done.read')
  const second = chinese('brief.done.search')
  assert.notEqual(prefix, '', 'this table states no shared prefix, so the case cannot be read')
  assert.ok(first.startsWith(prefix) && second.startsWith(prefix), 'these two labels no longer share the prefix')
  assert.equal(
    briefLineOf(chinese, step(['read', 'search'])),
    chinese('brief.step.joinTwo', { first, second: second.slice(prefix.length) }),
    'the shared prefix was said twice, or not elided at all',
  )
})

test('two labels that do not share it both stand whole', () => {
  const first = chinese('brief.done.commands')
  const second = chinese('brief.done.read')
  assert.equal(
    briefLineOf(chinese, step(['commands', 'read'])),
    chinese('brief.step.joinTwo', { first, second }),
    'a label that does not open with the prefix lost it anyway',
  )
})

test('English has no prefix to elide, so both labels stand whole', () => {
  assert.equal(english('brief.step.shared'), '')
  const first = en['brief.done.read']
  const second = en['brief.done.search']
  assert.equal(
    briefLineOf(english, step(['read', 'search'])),
    english('brief.step.joinTwo', { first, second: second.charAt(0).toLowerCase() + second.slice(1) }),
  )
})

/* ---- three labels, and more --------------------------------------------- */

/** Every label but the first, continued in lower case — the rule a language with capitals needs. */
function continued(label, at) {
  return at === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
}

test('three labels are joined with the comma, and each after the first loses its capital', () => {
  const categories = ['read', 'search', 'tools']
  assert.equal(
    briefLineOf(english, step(categories)),
    categories.map((kind, at) => continued(en[`brief.done.${kind}`], at)).join(english('brief.step.comma')),
  )
})

test('past three the title says three and closes with the more-word, never a count', () => {
  const three = briefLineOf(english, step(['read', 'search', 'tools']))
  const four = briefLineOf(english, step(['read', 'search', 'tools', 'commands']))
  assert.equal(four, english('brief.step.more', { title: three }), 'a fourth category changed the title instead of closing it')
})

/* ---- an open step ------------------------------------------------------- */

test('an open step says what it is on now, in the running voice', () => {
  assert.equal(briefLineOf(chinese, openStep('commands')), chinese('brief.run.commands'))
  assert.equal(briefLineOf(chinese, openStep('read')), chinese('brief.run.read'))
})

test('an open step that is only reasoning says the running word for it', () => {
  assert.equal(briefLineOf(chinese, openStep(null)), chinese('brief.run.thinking'))
})

/* ---- an answer ---------------------------------------------------------- */

test('an answer says its own sentence, and nothing is put in front of it', () => {
  const reply = { kind: 'reply', key: 'r', from: 0, to: 0, text: '两处都补好了。' }
  assert.equal(briefLineOf(chinese, reply), '两处都补好了。')
})
