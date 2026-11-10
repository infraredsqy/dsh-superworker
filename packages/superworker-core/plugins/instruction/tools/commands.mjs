/**
 * The instruction account's verbs: each verb is one entry of the command surface.
 *
 * The command word and its flags live here; `main` in `impl.mjs` joins this layer to the host context
 * (`ctx.root` is the project root the record directory sits in). A command answers text (what a person
 * reads) or a number (the exit code it asks its caller to leave with), and its two ways of ending are
 * not the same ending: a **usage error** — a line that names no verb, an unknown verb, a flag the verb
 * does not take, the wrong number of positional arguments, a value outside a flag's closed set, a flag
 * the verb requires and the line left out — carries `code: 2` and is answered with the usage page, the
 * way the core's own words answer a refused line; any other failure is thrown, and the host folds it
 * into `main failed` with `code: 1`.
 *
 * The five verbs are the account's whole surface, and the words they answer are the words this
 * account answered before this folder owned them: one verb, one operation — `add` appends one
 * sentence verbatim, `list` is the account read (the reader's view by default, the raw rows when
 * asked), `resolve` archives one, `revive` puts an archived one back, `rm` takes one away text and
 * all. The read side never takes the lock (a write lands atomically, so a read cannot see half an
 * entry); every writing verb holds the account's own lock through "read → change → write".
 *
 * Which cycle or node a new entry binds to is decided here, and it is the same decision as before:
 * take what the caller named (the named cycle has to be in the line account, a named node has to be
 * on a non-empty graph), otherwise take the single active line and the node it holds; a cycle- or
 * node-scoped entry with nothing to bind to is refused, because an unbound entry would be read as
 * visible to everyone, forever, which is what the scope exists to prevent.
 *
 * The project a line acts on is `ctx.root` unless the line names one: `--project` is resolved from this
 * process's own directory, and a linked worktree's checkout root leads back to the main tree that holds
 * the account (see `projectRootOf` in `storage.mjs`).
 */
import {
  EOL,
  ISSUED_ID,
  LIVE_STATE,
  REMOVED_KEY,
  STATE_MARKS,
  UsageError,
  VALID_SCOPES,
  VALID_TARGETS,
  assertInitialized,
  nowSeconds,
  projectRootOf,
  readCycles,
  readInstructions,
  readNodes,
  short,
  withInstructionsLock,
  writeInstructions,
} from './storage.mjs'

/** The head of the usage page, and of every usage refusal. */
const USAGE_HEAD = 'usage: instruction <verb> [options]'

/** The three scopes as a reader sees them, spelled out (the account's own vocabulary). */
const SCOPE_WORDS = {
  global: 'global (counts anywhere)',
  cycle: 'for this run (it stops counting once this run ends)',
  node: 'this node only (it stops counting once this node is done)',
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

// ═══ The shape of one entry ══════════════════════════════════════════════════

/** Whether this counts as live: `live` is the only state word read, and an old entry missing the state reads as it. */
function isLive(entry) {
  return (entry.state ?? LIVE_STATE) === LIVE_STATE
}

/** The scope of an entry: a word outside the vocabulary (or a missing key) reads as global — erring towards "visible". */
function entryScope(entry) {
  return VALID_SCOPES.includes(entry.scope) ? entry.scope : 'global'
}

/** What the scope is measured against: `('node', id)` / `('cycle', id)` / an empty binding. An empty binding is visible everywhere. */
function scopeBinding(entry) {
  const scope = entryScope(entry)
  if (scope === 'node' && entry.node) return ['node', entry.node]
  if (scope === 'cycle' && entry.cycle) return ['cycle', entry.cycle]
  return [null, null]
}

/**
 * The visibility decision (a pure function, THE one): whether an entry is visible from where the
 * reader stands. With a position the comparison is exact against the binding; without one it falls
 * back to a wide read — the bound line is still active, the bound node is not completed — so an
 * entry that cannot be pinned down is read out rather than held back (missing a real constraint costs
 * far more than reading one row too many).
 */
function inScope(entry, nodes, activeCycleIds, readerCycle, readerNode) {
  const [kind, bound] = scopeBinding(entry)
  if (kind === 'node') {
    if (readerNode !== null) return bound === readerNode
    return nodes[bound]?.status !== 'completed'
  }
  if (kind === 'cycle') {
    if (readerCycle !== null) return bound === readerCycle
    return activeCycleIds.has(bound)
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
 * Where the reader stands: `(line, node)`, both halves null when it cannot be given. With one line
 * active that line is it; with two active lines side by side the node named pins the line (only a
 * single active line that holds that node counts as pinned). The node half: a named node counts as
 * named; without a name the first node the line holds is taken.
 */
function positionOf(cycles, namedNode) {
  const active = cycles.filter((record) => record.status === 'active')
  let cycle
  if (active.length === 1) {
    cycle = active[0]
  } else if (namedNode !== null) {
    const hits = active.filter((record) => holdingIds(record).includes(namedNode))
    if (hits.length !== 1) return { cycle: null, node: null }
    cycle = hits[0]
  } else {
    return { cycle: null, node: null }
  }
  const cycleId = typeof cycle.id === 'string' ? cycle.id : null
  if (cycleId === null) return { cycle: null, node: null }
  if (namedNode !== null) return { cycle: cycleId, node: namedNode }
  const holding = holdingIds(cycle)
  return { cycle: cycleId, node: holding.length > 0 ? holding[0] : null }
}

/** The binding of a new entry: named first (and checked), then the single active line and the node it holds. */
function bindingOf(options, cycles, nodes) {
  const active = cycles.filter((record) => record.status === 'active')
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
  } else if (active.length === 1) {
    const only = active[0].id
    cycleId = typeof only === 'string' ? only : null
  }

  let nodeId = null
  if (options.node !== undefined) {
    // A non-empty graph is the precondition for checking the name: an empty graph has nothing to
    // check against, so the name is written as given.
    if (Object.keys(nodes).length > 0 && !(options.node in nodes)) {
      throw new Error(`node ${JSON.stringify(options.node)} is not in the DAG`)
    }
    nodeId = options.node
  }

  if (cycleId !== null && nodeId === null) {
    const record = cycles.find((entry) => entry.id === cycleId)
    const holding = record === undefined ? [] : holdingIds(record)
    nodeId = holding.length > 0 ? holding[0] : null
  }

  if (options.scope === 'cycle' && cycleId === null) {
    throw new Error(
      'a cycle-scoped entry needs a line to bind to (no single active cycle in state.json). ' +
        'Name it: cycle: <id>. Without a binding the entry would be read as visible to ' +
        'everyone, forever, so nothing was written.',
    )
  }
  if (options.scope === 'node' && nodeId === null) {
    throw new Error(
      'a node-scoped entry needs a node to bind to, and the state does not name one ' +
        '(no active cycle, or the cycle it names is holding no node). Name it: node: <id>. ' +
        'Without a binding the entry would be read as visible to everyone, so nothing was written.',
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
    `(The instruction record has ${total} entries: they are bound to another cycle or another node, or they are no longer in force. When the position cannot be pinned down these entries are still read out -- reading as empty means they really cannot reach this step.)`,
  ]
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

/** One verb's option table: which flags it knows, how many positional arguments, and which flag it must have. */
const SPECS = {
  add: {
    options: ['text', 'scope', 'cycle', 'node', 'target', 'said_by', 'note', 'stop_after_nodes'],
    required: ['text'],
    positional: { min: 0, max: 0 },
  },
  list: { options: ['json', 'all', 'live', 'scope', 'project', 'node'], positional: { min: 0, max: 0 } },
  resolve: {
    options: ['state', 'note', 'project'],
    required: ['state'],
    positional: { min: 1, max: 1 },
  },
  rm: { options: ['project'], positional: { min: 1, max: 1 } },
  revive: { options: ['project'], positional: { min: 1, max: 1 } },
}

/** Whether this token looks like a flag (a negative number is a value, not a flag). */
function looksLikeFlag(token) {
  return typeof token === 'string' && token.startsWith('-') && token.length > 1 && !/^-\d/.test(token)
}

/** Which known flag this token lands on; null when it is none. */
function flagNameOf(token, spec) {
  if (typeof token !== 'string' || !token.startsWith('--')) return null
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token
  for (const key of spec.options) {
    if (FLAGS[key].long === name) return key
  }
  return null
}

function inlineValueOf(token) {
  const at = token.indexOf('=')
  return at < 0 ? undefined : token.slice(at + 1)
}

/**
 * Split the rest of one line's argv into "options it knows" and "positional arguments".
 *
 * A value-taking flag takes the next cell as its value even when that cell opens with a dash: the
 * account's sentences are the user's verbatim words, and `--text` is always the last switch of an
 * `add` line, so a sentence that begins with `-` still rides as one cell (the panel builds exactly
 * this line).
 */
function parseArgs(argv, spec) {
  const options = {}
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--') {
      positional.push(...argv.slice(index + 1))
      break
    }
    const name = flagNameOf(token, spec)
    if (name === null) {
      if (looksLikeFlag(token)) {
        throw new UsageError(`unrecognized argument: ${token} (run \`instruction help\` for the flags this verb takes)`)
      }
      positional.push(token)
      continue
    }
    const cell = FLAGS[name]
    const inline = inlineValueOf(token)
    if (cell.kind === 'flag') {
      if (inline !== undefined) throw new UsageError(`argument ${cell.long}: takes no value`)
      options[name] = true
      continue
    }
    let raw = inline
    if (raw === undefined) {
      index += 1
      raw = argv[index]
    }
    if (raw === undefined) throw new UsageError(`argument ${cell.long}: expected one value`)
    if (cell.choices !== undefined && !cell.choices.includes(raw)) {
      throw new UsageError(`invalid ${name} "${raw}", valid: ${[...cell.choices].sort().join(', ')}`)
    }
    options[name] = raw
  }
  const count = positional.length
  if (count < spec.positional.min || count > spec.positional.max) {
    const wanted =
      spec.positional.max === spec.positional.min
        ? `${spec.positional.min}`
        : `${spec.positional.min} to ${spec.positional.max}`
    throw new UsageError(`this verb wants ${wanted} positional argument(s), got ${count} (run \`instruction help\`)`)
  }
  for (const key of spec.required ?? []) {
    if (options[key] === undefined) {
      throw new UsageError(`argument ${FLAGS[key].long}: is required (run \`instruction help\`)`)
    }
  }
  return { options, positional }
}

// ═══ Verbs ═══════════════════════════════════════════════════════════════════

async function cmdAdd(args, ctx) {
  const { text, scope = 'global', target = 'stage' } = args.options
  // The wording is checked before any disk is touched: a refusal names the vocabulary and nothing is written.
  // An empty sentence is a failure of the run — the account will not take it — not a malformed line: it
  // is thrown as it always was, and the host answers it with `code: 1`.
  if (typeof text !== 'string' || text.trim() === '') throw new Error('text must not be empty')
  if (!VALID_SCOPES.includes(scope)) {
    throw new UsageError(`scope must be one of ${JSON.stringify([...VALID_SCOPES])}, got ${JSON.stringify(scope)}`)
  }
  if (!VALID_TARGETS.includes(target)) {
    throw new UsageError(`target must be one of ${JSON.stringify([...VALID_TARGETS])}, got ${JSON.stringify(target)}`)
  }
  return withInstructionsLock(ctx.root, async () => {
    const data = readInstructions(ctx.root)
    const cycles = readCycles(ctx.root)
    const nodes = readNodes(ctx.root)
    const binding = bindingOf({ ...args.options, scope, target }, cycles, nodes)
    const entry = {
      id: nextInstructionId(data),
      text,
      scope,
      target,
      state: 'live',
      cycle: binding.cycle,
      node: binding.node,
      said_by: args.options.said_by ?? 'user',
      at: nowSeconds(),
      resolved_at: null,
      note: args.options.note ?? null,
    }
    if (args.options.stop_after_nodes !== undefined && args.options.stop_after_nodes !== null) {
      entry.stop_after_nodes = Number(args.options.stop_after_nodes)
    }
    data.instructions.push(entry)
    await writeInstructions(ctx.root, data)
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
  })
}

async function cmdList(args, ctx) {
  const { all, live, scope, node, json } = args.options
  const data = readInstructions(ctx.root)
  const accountView = all === true || live === true || scope !== undefined

  if (!accountView) {
    const cycles = readCycles(ctx.root)
    const nodes = readNodes(ctx.root)
    const position = positionOf(cycles, node ?? null)
    const active = new Set(
      cycles.filter((record) => record.status === 'active').map((record) => record.id).filter((id) => typeof id === 'string'),
    )
    const visible = data.instructions
      .filter((entry) => isLive(entry))
      .filter((entry) => inScope(entry, nodes, active, position.cycle, position.node))
      .map(readerRow)
    if (json === true) {
      // The machine's view carries the four structural cells and nothing else.
      return jsonText(visible.map(({ id, text, scope: rowScope, target }) => ({ id, text, scope: rowScope, target })))
    }
    if (visible.length === 0) {
      // Two silences with two meanings: no record at all, or a record whose entries cannot reach this
      // step. The account's own count is what tells them apart.
      const total = data.instructions.length
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

  let cells = data.instructions
  if (all !== true) cells = cells.filter((entry) => isLive(entry))
  if (scope !== undefined) cells = cells.filter((entry) => entryScope(entry) === scope)
  if (live === true) cells = cells.filter((entry) => isLive(entry))
  if (json === true) return jsonText(cells)
  if (cells.length === 0) {
    const total = data.instructions.length
    const globalTotal = data.instructions.filter((entry) => entryScope(entry) === 'global').length
    return emptyAccountLines(total, scope, globalTotal).join(EOL)
  }
  const lines = []
  for (const entry of cells) {
    const mark = STATE_MARKS[entry.state] ?? STATE_MARKS.withdrawn
    const deliver = DELIVER_WORDS[entry.target] ?? '?'
    lines.push(`${mark} ${entry.id}  [${entry.scope}/${deliver}]  ${entry.text ?? ''}`)
    if (typeof entry.note === 'string' && entry.note !== '') lines.push(`      note: ${entry.note}`)
  }
  return lines.join(EOL)
}

async function cmdResolve(args, ctx) {
  const id = args.positional[0]
  return withInstructionsLock(ctx.root, async () => {
    const data = readInstructions(ctx.root)
    const hit = data.instructions.find((entry) => entry.id === id)
    if (hit === undefined) throw new Error(`no instruction ${JSON.stringify(id)}`)
    // Resolving touches the state and timestamp cells, plus the note when one is given: text, scope and
    // binding are all kept as they are, and a note that was never given is not cleared.
    hit.state = 'withdrawn'
    hit.resolved_at = nowSeconds()
    if (args.options.note !== undefined && args.options.note !== '') hit.note = args.options.note
    await writeInstructions(ctx.root, data)
    return `INSTRUCTION ${id} → ${args.options.state}`
  })
}

async function cmdRevive(args, ctx) {
  const id = args.positional[0]
  return withInstructionsLock(ctx.root, async () => {
    const data = readInstructions(ctx.root)
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
    await writeInstructions(ctx.root, data)
    return `INSTRUCTION ${id} → live`
  })
}

async function cmdRm(args, ctx) {
  const id = args.positional[0]
  return withInstructionsLock(ctx.root, async () => {
    const data = readInstructions(ctx.root)
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
    traces.push({ id, at: nowSeconds() })
    await writeInstructions(ctx.root, data)
    return `${head}REMOVED ${id}`
  })
}

// ═══ The command surface ═════════════════════════════════════════════════════

const RUNNERS = { add: cmdAdd, list: cmdList, resolve: cmdResolve, rm: cmdRm, revive: cmdRevive }

/** The verbs that change the account: the init gate and the account's lock stand in front of each one. */
const WRITING_VERBS = new Set(['add', 'resolve', 'rm', 'revive'])

/** The usage spelling of one flag (the page and the parser read the same table). */
function flagUsage(key) {
  const cell = FLAGS[key]
  return cell.kind === 'flag' ? `[${cell.long}]` : `[${cell.long} <value>]`
}

/**
 * The `instruction help` list: the five verbs and their flags, derived from the command surface's one
 * table, with the scope vocabulary printed beside the verb that binds it.
 */
export function usage() {
  const rows = Object.keys(SPECS).map((word) => {
    const spec = SPECS[word]
    const positional =
      spec.positional.min === 0 ? '' : spec.positional.min === spec.positional.max ? ' <ins_id>' : ' <ins_id...>'
    const flags = spec.options.map(flagUsage).join(' ')
    return `  ${word}${positional}${flags.length > 0 ? ` ${flags}` : ''}`
  })
  return [
    USAGE_HEAD,
    '',
    "the standing instruction account: one file per project, `.superworker/instructions.json`.",
    'scopes: global / cycle / node (where an entry can be read from, not who remembers to resolve it).',
    'reaches: stage / boundary (when a worker reads it: while working, or only when closing out).',
    '',
    ...rows,
    '',
  ].join(EOL)
}

/**
 * The command's entry point: the first cell of argv is the verb (the declaration says `keep_name: false`,
 * so the host takes the command word off).
 *
 * A help flag in the last cell — exactly `--help` or `-h`, with something before it — asks the same
 * page the first-cell spelling asks. A help flag anywhere else reaches the verb's parser like any
 * other token. A line that names no verb is a refused line, not a help request: the page goes out as a
 * usage refusal, and the caller answers it with its exit code (2) on the stderr stream.
 */
export async function main(argv, ctx) {
  const args = [...argv]
  if (args.length === 0) throw new UsageError(usage().replace(/\n+$/u, ''))
  const spoken = args[0]
  if (spoken === 'help' || spoken === '--help' || spoken === '-h') return usage()
  const runner = RUNNERS[spoken]
  if (runner === undefined) throw new UsageError(`unrecognized command "${spoken}" (run \`instruction help\`)`)
  if (args.length > 1 && (args[args.length - 1] === '--help' || args[args.length - 1] === '-h')) return usage()
  const spec = SPECS[spoken]
  const parsed = parseArgs(args.slice(1), spec)
  // A named `--project` replaces the root the host handed in, resolved from this process's own
  // directory — and, being an explicit root, resolved through a linked worktree back to the main tree
  // that holds the account. No name means the host's root as it came: the host already resolved it.
  const named = parsed.options.project
  const root = named === undefined || named === '' ? ctx.root : projectRootOf(named)
  // The gate comes before the lock: a record directory that was never set up gets not one byte,
  // and not even the lock's own meta/ directory (the engine's verbs gated the same way).
  if (WRITING_VERBS.has(spoken)) assertInitialized(root)
  return runner(parsed, { ...ctx, root })
}