/**
 * The instruction account's verbs: each verb is one entry of the command surface.
 *
 * **The surface's mechanics are the engine's one copy**, reached through the record base the host
 * hands in (`ctx.base.verbSurface`, see the engine's `src/plugins/verb-surface.ts`): splitting a
 * line into flags and positional arguments, the closed-set and positional-count refusals, the
 * usage page, the help spellings, and the lock the writing verbs run under. What is left here is
 * the account's own words: which flags and verbs exist, what each verb does to the account, and
 * the text a person reads. The tables below (FLAGS, SPECS, RUNNERS) are this plugin's data; the
 * surface is assembled from them on first use.
 *
 * A command answers text (what a person reads) or a number (the exit code it asks its caller to
 * leave with), and its two ways of ending are not the same ending: a **usage error** — a line that
 * names no verb, an unknown verb, a flag the verb does not take, the wrong number of positional
 * arguments, a value outside a flag's closed set, a flag the verb requires and the line left out —
 * carries `code: 2` and is answered with the usage page, the way the core's own words answer a
 * refused line; any other failure is thrown, and the host folds it into `main failed` with `code: 1`.
 *
 * The five verbs are the account's whole surface, and the words they answer are the words this
 * account answered before this folder owned them: one verb, one operation — `add` appends one
 * sentence verbatim, `list` is the account read (the reader's view by default, the raw rows when
 * asked), `resolve` archives one, `revive` puts an archived one back, `rm` takes one away text and
 * all. The read side never takes the lock (a write lands atomically, so a read cannot see half an
 * entry).
 *
 * The account knows two levels — global, and one line (`cycle`) — and no third: the node level was
 * retired, and what one node needs is said in that node's own spec. A row an older account carries
 * with a retired scope word is skipped by every read (the level it named is gone); it stays on the
 * account byte for byte, `rm` still takes it off, and the account views say how many are sitting
 * there. `list` keeps `--node`, and it names a *position*, not a level: which node the reader holds,
 * which pins the line the read stands on when two lines run side by side. No name, no position: a
 * reader that cannot say which node it works stands on no line, and the globals alone are visible.
 *
 * Which cycle a new entry binds to is decided here, and it is the same decision as before:
 * take what the caller named (the named cycle has to be in the line account), otherwise take the
 * single active line; a cycle-scoped entry with nothing to bind to is refused, because an unbound
 * entry would be read as visible to everyone, forever, which is what the scope exists to prevent.
 *
 * The project a line acts on is `ctx.root` unless the line names one: `--project` goes through
 * `ctx.projectRootOf`, the engine's one resolution of "which project root does this directory mean" —
 * a linked worktree's checkout root leads back to the main tree that holds the account, and nothing of
 * that rule is written in this folder.
 */
import {
  EOL,
  ISSUED_ID,
  LIVE_STATE,
  REMOVED_KEY,
  RETIRED_SCOPES,
  STATE_MARKS,
  VALID_SCOPES,
  VALID_TARGETS,
  readCycles,
  readInstructions,
  short,
  withInstructionsLock,
  writeInstructions,
} from './storage.mjs'

/** The head of the usage page, and of every usage refusal. */
const USAGE_HEAD = 'usage: instruction <verb> [options]'

/** The two scopes as a reader sees them, spelled out (the account's own vocabulary). */
const SCOPE_WORDS = {
  global: 'global (counts anywhere)',
  cycle: 'for this run (it stops counting once this run ends)',
}

/** How an entry is delivered: the two words the reader's view prints for the reach cell. */
const REACH_WORDS = { stage: 'every node', boundary: 'read only at the close' }

/** The account view's delivery cell: what each target means for somebody reading the raw rows. */
const DELIVER_WORDS = { stage: 'visible while working', boundary: 'read only when closing out' }

/**
 * The two sentences a project with no entries at all reads: the account is absent, and that state is
 * an answer rather than a failure. The same pair is printed by the reader's view and the account
 * views — both places say "no record", so a reader cannot mistake it for "there is a record and you
 * are not seeing it".
 */
const NO_RECORD_LINES = [
  'This project has no instruction record at all.',
  'That is not an error: work can start as usual.',
]

// ═══ The command surface, assembled from the engine's one copy ════════════════

/**
 * The surface of this command word, built once per process from the tables below: the mechanics
 * (parsing, usage, refusals, writing-verb locking) are the engine's record base's; the tables are
 * this plugin's own words. The base arrives on the context the host hands in — a build of this
 * plugin run by an engine that hands none in is named as it is, instead of failing obscurely.
 */
let surface = null

function baseOf(ctx) {
  const base = ctx === null || typeof ctx !== 'object' ? undefined : ctx.base
  if (base === undefined || base === null || typeof base.verbSurface !== 'function') {
    throw new Error(
      'the instruction tool reads its command surface and record base from the context the host hands ' +
        'in (ctx.base), and this engine hands none in: update the engine, or install the build of this ' +
        'plugin that still carries its own record base',
    )
  }
  return base
}

/**
 * The resolution a `--project` line is answered with: the engine's one answer, handed in as
 * `ctx.projectRootOf` beside the record base. Read on every call that has to resolve a named root, so
 * a build of this plugin run by an engine that hands no such cell in is named as it is, instead of
 * failing with a bare `is not a function` the caller cannot act on.
 */
function seamOf(ctx) {
  const seam = ctx === null || typeof ctx !== 'object' ? undefined : ctx.projectRootOf
  if (typeof seam !== 'function') {
    throw new Error(
      'the instruction tool reads which project root a --project directory acts on from the context the ' +
        'host hands in (ctx.projectRootOf), and this engine hands none in: update the engine, or install ' +
        'the build of this plugin that still carries its own project root resolution',
    )
  }
  return seam
}

function surfaceOf(base) {
  if (surface === null) {
    surface = base.verbSurface({
      name: 'instruction',
      head: USAGE_HEAD,
      blurb: [
        'the standing instruction account: one file per project, `.superworker/instructions.json`.',
        'scopes: global / cycle (where an entry can be read from, not who remembers to resolve it).',
        'scope node is retired: an old entry carrying it stays on the account, read by no view.',
        'reaches: stage / boundary (when a worker reads it: while working, or only when closing out).',
      ],
      // This word's text is LF on every platform, unlike the seam's default (the platform's line
      // ending): the answers and the page here were LF before this folder took them over.
      eol: EOL,
      // A refusal here is its sentence alone, not the head in front of it: that is how this word's
      // refusals read before this layer owned them.
      refusalHead: false,
      // A line naming no verb is a refused line for this word, not a help request: the page goes out
      // as the refusal, and the caller answers it with code 2.
      emptyArgv: 'refuse',
      flags: FLAGS,
      specs: SPECS,
      runners: RUNNERS,
      // `add`'s own reading of the line is decided before the lock is taken, as it was when this
      // folder held the lock itself: a refused sentence must not bring the lock's directory into being.
      lineChecks: { add: checkAddLine },
      writingVerbs: ['add', 'resolve', 'rm', 'revive'],
      withWrite: (ctxOf, body) => withInstructionsLock(ctxOf.root, body, ctxOf.base),
      contextOf,
    })
  }
  return surface
}

/**
 * The refusal about how the line was written: the class comes with the surface (bound on first
 * use, before any runner can run), and `code: 2` is what such a line answers with — the same 2
 * the core's own parser answers a usage error with. Everything else is a plain `Error`, which the
 * host answers with `code: 1`.
 */
function usageError(sentence) {
  if (surface === null) {
    throw new Error('the instruction command surface is not assembled yet: run the tool through main')
  }
  return new surface.UsageError(sentence)
}

// ═══ The shape of one entry ══════════════════════════════════════════════════

/** Whether this counts as live: `live` is the only state word read, and an old entry missing the state reads as it. */
function isLive(entry) {
  return (entry.state ?? LIVE_STATE) === LIVE_STATE
}

/**
 * Whether this row carries a retired scope word. Not the same judgement as an unknown word: an
 * unknown word reads as `global` (erring towards visible), while a retired word says the level this
 * row was bound to is gone, so no read hands it to anybody. The row itself is never touched.
 */
function isRetired(entry) {
  return RETIRED_SCOPES.includes(entry.scope)
}

/** The scope of an entry: a word outside the vocabulary (or a missing key) reads as global — erring towards "visible". */
function entryScope(entry) {
  return VALID_SCOPES.includes(entry.scope) ? entry.scope : 'global'
}

/** What the scope is measured against: `('cycle', id)` or an empty binding. An empty binding is visible everywhere. */
function scopeBinding(entry) {
  const scope = entryScope(entry)
  if (scope === 'cycle' && entry.cycle) return ['cycle', entry.cycle]
  return [null, null]
}

/**
 * The visibility decision (a pure function, THE one): whether an entry is visible from where the
 * reader stands. A position is the reader's own claim — the node it works, pinned to its line by
 * the holding — and the comparison is exact against the binding: a line's entries reach exactly
 * the sessions working that line's nodes, and nobody else. Without a position the cycle-bound rows
 * are held back, not read out: a working rule of one line is nobody else's business, and silence
 * costs the outside reader nothing.
 */
function inScope(entry, readerCycle) {
  const [kind, bound] = scopeBinding(entry)
  if (kind === 'cycle') {
    if (readerCycle === null) return false
    return bound === readerCycle
  }
  return true
}

/** The tombstones: a missing key, or a key that is not an array, reads as none. */
function removedTracesOf(data) {
  return Array.isArray(data[REMOVED_KEY]) ? data[REMOVED_KEY] : []
}

/** The next id: the highest issued + 1 (entries and tombstones counted together); an issued number is never issued again. */
function nextInstructionId(data) {
  let highest = 0
  const records = [...data.instructions, ...removedTracesOf(data)]
  for (const record of records) {
    const value = record !== null && typeof record === 'object' ? record.id : undefined
    if (typeof value !== 'string') continue
    const match = ISSUED_ID.exec(value)
    if (match !== null) highest = Math.max(highest, Number(match[1]))
  }
  return `i-${String(highest + 1).padStart(4, '0')}`
}

/** Find an id: `(entry, tombstone)` hits at most one place; when both miss, the id never existed on this account. */
function locate(data, id) {
  for (const entry of data.instructions) {
    if (entry !== null && typeof entry === 'object' && entry.id === id) return [entry, null]
  }
  for (const trace of removedTracesOf(data)) {
    if (trace !== null && typeof trace === 'object' && trace.id === id) return [null, trace]
  }
  return [null, null]
}

/** The roster one line holds, accepting both on-disk shapes (the canonical `{id, since}` and a bare id string). */
function holdingIds(record) {
  const holding = record.holding
  if (!Array.isArray(holding)) return []
  const out = []
  for (const item of holding) {
    if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id !== '') out.push(item.id)
    else if (typeof item === 'string' && item !== '') out.push(item)
  }
  return out
}

/**
 * Where the reader stands: `(line, node)`, both halves null when it cannot be given.
 * Only a named node pins a position — the unique line currently holding it. With no name there is
 * no position: the account does not invent one out of the running book, so a reader that cannot
 * say which node it works stands on no line, and the globals alone are visible.
 */
function positionOf(cycles, namedNode) {
  if (namedNode === null) return { cycle: null, node: null }
  const hits = cycles.filter((record) => holdingIds(record).includes(namedNode))
  if (hits.length !== 1) return { cycle: null, node: null }
  const cycleId = typeof hits[0].id === 'string' ? hits[0].id : null
  if (cycleId === null) return { cycle: null, node: null }
  return { cycle: cycleId, node: namedNode }
}

/** The binding of a new entry: named first (and checked), then the single running line and the node it holds. */
function bindingOf(options, cycles) {
  const running = cycles.filter((record) => holdingIds(record).length > 0)
  const known = cycles.map((record) => record.id).filter((id) => typeof id === 'string' && id !== '')
  let cycleId = null
  if (options.cycle !== undefined) {
    if (!known.includes(options.cycle)) {
      throw new Error(
        `cycle ${JSON.stringify(options.cycle)} is not in state.json; the account has ` +
          `${known.length > 0 ? JSON.stringify(known) : 'no cycle'}`,
      )
    }
    cycleId = options.cycle
  } else if (running.length === 1) {
    const only = running[0].id
    cycleId = typeof only === 'string' ? only : null
  }

  // The node half is provenance, never a level: where the sentence was said, taken from the line's
  // own hand. Nothing binds to it — visibility reads the scope word and the cycle alone.
  let nodeId = null
  if (cycleId !== null) {
    const record = cycles.find((entry) => entry.id === cycleId)
    const holding = record === undefined ? [] : holdingIds(record)
    nodeId = holding.length > 0 ? holding[0] : null
  }

  if (options.scope === 'cycle' && cycleId === null) {
    throw new Error(
      'a cycle-scoped entry needs a line to bind to (no single running cycle in state.json). ' +
        'Name it: cycle: <id>. Without a binding the entry would be read as visible to ' +
        'everyone, forever, so nothing was written.',
    )
  }
  return { cycle: cycleId, node: nodeId }
}

/** The reader-facing row of one entry: the sentence, the scope as read, and how it is delivered. */
function readerRow(entry) {
  const target = entry.target ?? null
  return {
    id: entry.id,
    text: typeof entry.text === 'string' ? entry.text : '',
    scope: entryScope(entry),
    target,
    reach: target === 'boundary' ? 'boundary' : 'stage',
  }
}

// ═══ Output pieces ═══════════════════════════════════════════════════════════

/** One value in the two-space indented spelling (JSON.stringify's own line ending is LF). */
function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

/** The reader's view found nothing while the account holds entries: the count, and why silence is not a green light. */
function nothingVisibleLines(total) {
  return [
    'No instruction is visible from this step.',
    `(The instruction record has ${total} entries: the cycle-bound ones reach only the sessions working their own line's nodes, and the others are no longer in force. Reading as empty here means they really cannot reach this step.)`,
  ]
}

/**
 * The one line the account views append when retired rows are sitting on the account: the only
 * place their existence is said out loud. The reader's view and the machine's view say nothing —
 * a retired row reaches nobody, and the injected listing is the reader's view.
 */
function retiredLine(count) {
  return `(${count} more entr${count === 1 ? 'y' : 'ies'} on this account carry a retired scope word: kept, read by no view. instruction rm <id> takes one off.)`
}

/** One of the account views found nothing: say which of the four states this is. */
function emptyAccountLines(total, scope, globalTotal) {
  if (total === 0) return NO_RECORD_LINES
  if (scope !== undefined) {
    return [
      `No instruction with scope=${scope} is still in force.`,
      `(The instruction record has ${total} entries.)`,
    ]
  }
  if (globalTotal === 0) {
    return [
      'This project has no global instruction.',
      `(The instruction record has ${total} entries, and none of them is global.)`,
    ]
  }
  return [
    'No instruction record is in force right now.',
    `(The instruction record has ${total} entries, and none of them is in force. Only the owner can archive an instruction.)`,
  ]
}

// ═══ The argument surface ════════════════════════════════════════════════════

/** The flags each verb knows: long spelling, how it takes a value, and the closed set of values. */
const FLAGS = {
  text: { long: '--text', kind: 'value' },
  scope: { long: '--scope', kind: 'value', choices: VALID_SCOPES },
  cycle: { long: '--cycle', kind: 'value' },
  /** Names the reader's position (which node is in hand, pinning the line); `list`'s own, never a level to bind to. */
  node: { long: '--node', kind: 'value' },
  target: { long: '--target', kind: 'value', choices: VALID_TARGETS },
  said_by: { long: '--said-by', kind: 'value' },
  note: { long: '--note', kind: 'value' },
  stop_after_nodes: { long: '--stop-after-nodes', kind: 'value' },
  json: { long: '--json', kind: 'flag' },
  all: { long: '--all', kind: 'flag' },
  live: { long: '--live', kind: 'flag' },
  project: { long: '--project', kind: 'value' },
  state: { long: '--state', kind: 'value', choices: ['withdrawn'] },
}

/**
 * One verb's option table: which flags it knows, how many positional arguments, and which flag it
 * must have. `label` is the placeholder word this verb's usage row spells for its positionals — the
 * account's own word; the engine's usage page renders it as spelled here.
 */
const SPECS = {
  add: {
    options: ['text', 'scope', 'cycle', 'target', 'said_by', 'note', 'stop_after_nodes'],
    required: ['text'],
    positional: { min: 0, max: 0 },
  },
  list: { options: ['json', 'all', 'live', 'scope', 'project', 'node'], positional: { min: 0, max: 0 } },
  resolve: {
    options: ['state', 'note', 'project'],
    required: ['state'],
    positional: { min: 1, max: 1, label: '<ins_id>' },
  },
  rm: { options: ['project'], positional: { min: 1, max: 1, label: '<ins_id>' } },
  revive: { options: ['project'], positional: { min: 1, max: 1, label: '<ins_id>' } },
}

// ═══ Verbs ═══════════════════════════════════════════════════════════════════

/**
 * What one `add` line must carry on its own, settled after the line is parsed and **before** the
 * account's lock is taken — the moment the wording has always been read at, when this folder held
 * the lock itself: a refused line names the vocabulary and reaches no disk, the lock's own directory
 * included. The three checks are the account's own reading of a whole line: the sentence, and the
 * two words a caller can name out of the surface's own parser (`--scope` / `--target` are closed
 * sets there already, and stand here as the account's reading of its own vocabulary, as they did).
 *
 * A sentence that is empty once trimmed is a failure of the run — the account will not take it —
 * not a malformed line: it is thrown plain, as it always was, and the host answers it with `code: 1`.
 */
function checkAddLine(args) {
  const { text, scope = 'global', target = 'stage' } = args.options
  if (typeof text !== 'string' || text.trim() === '') throw new Error('text must not be empty')
  if (!VALID_SCOPES.includes(scope)) {
    throw usageError(`scope must be one of ${JSON.stringify([...VALID_SCOPES])}, got ${JSON.stringify(scope)}`)
  }
  if (!VALID_TARGETS.includes(target)) {
    throw usageError(`target must be one of ${JSON.stringify([...VALID_TARGETS])}, got ${JSON.stringify(target)}`)
  }
}

async function cmdAdd(args, ctx) {
  const { text, scope = 'global', target = 'stage' } = args.options
  // The wording was checked before this run took the lock (`checkAddLine`, declared on the surface):
  // what this verb does is read the account, build the entry, and land it.
  const data = await readInstructions(ctx.root, ctx.base)
  const cycles = await readCycles(ctx.root, ctx.base)
  const binding = bindingOf({ ...args.options, scope, target }, cycles)
  const entry = {
    id: nextInstructionId(data),
    text,
    scope,
    target,
    state: 'live',
    cycle: binding.cycle,
    node: binding.node,
    said_by: args.options.said_by ?? 'user',
    at: ctx.base.nowSeconds(),
    resolved_at: null,
    note: args.options.note ?? null,
  }
  if (args.options.stop_after_nodes !== undefined && args.options.stop_after_nodes !== null) {
    entry.stop_after_nodes = Number(args.options.stop_after_nodes)
  }
  data.instructions.push(entry)
  await writeInstructions(ctx.root, data, ctx.base)
  // The binding as a reader sees it: the line's id and the node's short form. A global entry records
  // where it was said, and the printed line leaves that bookkeeping on the account.
  const where =
    scope === 'global'
      ? []
      : [entry.cycle, typeof entry.node === 'string' && entry.node !== '' ? short(entry.node) : undefined].filter(
          (cell) => typeof cell === 'string' && cell !== '',
        )
  return (
    `INSTRUCTION ${entry.id}: [${scope}/${target}] ${entry.text}` +
    (where.length > 0 ? `   @ ${where.join(' / ')}` : '')
  )
}

async function cmdList(args, ctx) {
  const { all, live, scope, node, json } = args.options
  const data = await readInstructions(ctx.root, ctx.base)
  /* Retired rows leave every view here: they are not entries a reader could reach, and counting them
   * in a silence's sentence would say "there is something to read" about rows nothing can read. The
   * account views below still say how many are sitting on the account. */
  const rows = data.instructions.filter((entry) => !isRetired(entry))
  const retiredCount = data.instructions.length - rows.length
  const accountView = all === true || live === true || scope !== undefined

  if (!accountView) {
    const cycles = await readCycles(ctx.root, ctx.base)
    const position = positionOf(cycles, node ?? null)
    const visible = rows
      .filter((entry) => isLive(entry))
      .filter((entry) => inScope(entry, position.cycle))
      .map(readerRow)
    if (json === true) {
      // The machine's view carries the four structural cells and nothing else.
      return jsonText(visible.map(({ id, text, scope: rowScope, target }) => ({ id, text, scope: rowScope, target })))
    }
    if (visible.length === 0) {
      // Two silences with two meanings: no record at all, or a record whose entries cannot reach this
      // step. The account's own count is what tells them apart.
      const total = rows.length
      return (total === 0 ? NO_RECORD_LINES : nothingVisibleLines(total)).join(EOL)
    }
    const lines = [`This project has ${visible.length} instruction(s) visible from this step:`]
    for (const [index, row] of visible.entries()) {
      lines.push('')
      lines.push(`${index + 1}. ${row.text}`)
      lines.push(`   visibility: ${SCOPE_WORDS[row.scope] ?? row.scope}`)
      const reach = REACH_WORDS[row.reach]
      if (reach !== undefined) lines.push(`   reach: ${reach}`)
    }
    // The listing closes on a blank line, so the last entry's block ends where the next one begins.
    lines.push('')
    return `${lines.join(EOL)}${EOL}`
  }

  let cells = rows
  if (all !== true) cells = cells.filter((entry) => isLive(entry))
  if (scope !== undefined) cells = cells.filter((entry) => entryScope(entry) === scope)
  if (live === true) cells = cells.filter((entry) => isLive(entry))
  if (json === true) return jsonText(cells)
  const tail = retiredCount > 0 ? [retiredLine(retiredCount)] : []
  if (cells.length === 0) {
    const total = rows.length
    const globalTotal = rows.filter((entry) => entryScope(entry) === 'global').length
    return [...emptyAccountLines(total, scope, globalTotal), ...tail].join(EOL)
  }
  const lines = []
  for (const entry of cells) {
    const mark = STATE_MARKS[entry.state] ?? STATE_MARKS.withdrawn
    const deliver = DELIVER_WORDS[entry.target] ?? '?'
    lines.push(`${mark} ${entry.id}  [${entry.scope}/${deliver}]  ${entry.text ?? ''}`)
    if (typeof entry.note === 'string' && entry.note !== '') lines.push(`      note: ${entry.note}`)
  }
  return [...lines, ...tail].join(EOL)
}

async function cmdResolve(args, ctx) {
  const id = args.positional[0]
  const data = await readInstructions(ctx.root, ctx.base)
  const hit = data.instructions.find((entry) => entry.id === id)
  if (hit === undefined) throw new Error(`no instruction ${JSON.stringify(id)}`)
  // Resolving touches the state and timestamp cells, plus the note when one is given: text, scope and
  // binding are all kept as they are, and a note that was never given is not cleared.
  hit.state = 'withdrawn'
  hit.resolved_at = ctx.base.nowSeconds()
  if (args.options.note !== undefined && args.options.note !== '') hit.note = args.options.note
  await writeInstructions(ctx.root, data, ctx.base)
  return `INSTRUCTION ${id} → ${args.options.state}`
}

async function cmdRevive(args, ctx) {
  const id = args.positional[0]
  const data = await readInstructions(ctx.root, ctx.base)
  const [hit, trace] = locate(data, id)
  if (hit === null && trace === null) throw new Error(`no instruction ${JSON.stringify(id)}`)
  if (hit === null) {
    throw new Error(
      `instruction ${JSON.stringify(id)} was removed at ${trace.at}; its text went with it, and ` +
        'putting an entry back is not how a removal is undone',
    )
  }
  if (isLive(hit)) {
    throw new Error(`instruction ${JSON.stringify(id)} is already live: there is nothing to put back`)
  }
  // Reviving touches only the state and the timestamp: a live entry has no resolution timestamp.
  hit.state = 'live'
  hit.resolved_at = null
  await writeInstructions(ctx.root, data, ctx.base)
  return `INSTRUCTION ${id} → live`
}

async function cmdRm(args, ctx) {
  const id = args.positional[0]
  const data = await readInstructions(ctx.root, ctx.base)
  const [hit, trace] = locate(data, id)
  if (hit === null && trace === null) throw new Error(`no instruction ${JSON.stringify(id)}`)
  if (hit === null) {
    throw new Error(
      `instruction ${JSON.stringify(id)} was removed at ${trace.at}; its text is already off the account`,
    )
  }
  // The sentence is printed first, then it goes: the entry leaves with its text, the tombstone keeps
  // the id and the moment, and an issued number is never issued again.
  const head = `INSTRUCTION ${hit.id}: [${hit.scope}/${hit.target ?? 'stage'}] ${hit.text}\n`
  const at = data.instructions.indexOf(hit)
  data.instructions.splice(at, 1)
  let traces = data[REMOVED_KEY]
  if (!Array.isArray(traces)) {
    traces = []
    data[REMOVED_KEY] = traces
  }
  traces.push({ id, at: ctx.base.nowSeconds() })
  await writeInstructions(ctx.root, data, ctx.base)
  return `${head}REMOVED ${id}`
}

// ═══ The command surface ═════════════════════════════════════════════════════

const RUNNERS = { add: cmdAdd, list: cmdList, resolve: cmdResolve, rm: cmdRm, revive: cmdRevive }

/**
 * The context one verb runs under: a named `--project` replaces the root the host handed in. Which
 * root that is has one home — the engine's `projectRootOf`, handed in as `ctx.projectRootOf`: a linked
 * worktree's checkout root leads back to the main tree that holds the account, and everything else is
 * the directory it is. None of that judgement is repeated in this folder. No name means the host's root
 * exactly as it came: `ctx.root` is already resolved by the host, and asking again could only move it.
 */
function contextOf(args, ctx) {
  const named = args.options.project
  if (named === undefined || named === '') return ctx
  return { ...ctx, root: seamOf(ctx)(named, ctx.root) }
}

/**
 * The command's entry point: the first cell of argv is the verb (the declaration says `keep_name: false`,
 * so the host takes the command word off). The line is parsed, its refusals decided, its project root
 * settled by `contextOf`, and a writing verb locked by the command surface assembled above — the
 * engine's one copy of the mechanics; this function only binds that surface to the context that
 * carries the record base, and hands the line over.
 *
 * A help flag in the last cell — exactly `--help` or `-h`, with something before it — asks the same
 * page the first-cell spelling asks. A help flag anywhere else reaches the verb's parser like any
 * other token. A line that names no verb is a refused line, not a help request: the page goes out as a
 * usage refusal, and the caller answers it with its exit code (2) on the stderr stream.
 */
export async function main(argv, ctx) {
  // The base is read on **every** call, not only on the one that assembles the surface: a caller
  // that hands in a context without one is answered with the sentence below, whichever call it is.
  return surfaceOf(baseOf(ctx)).main(argv, ctx)
}
