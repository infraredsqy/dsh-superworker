/**
 * The issue plugin's own implementation: the judgement and the node's body, plus the command entry
 * point.
 *
 * **The machinery in this file is a copy, and it is declared as one.** Seven pieces are written out
 * again in the sibling plugin that watches test wall clock (`plugins/test-audit/impl.mjs`), because
 * each plugin folder is installed and removed on its own and nothing is shared between two of them —
 * not a module, not a template. Each piece has a named destination, so a person can see which of them
 * still has to move and which one is meant to stay a copy:
 *
 *   1. reading the declaration (`plugin.json` beside the entry) — into a `ctx` seam: the engine could
 *      hand each plugin its own parsed declaration;
 *   2. pairing it with the prose (the summary, the unit) — each side carries its own, held by the
 *      pairing test: the prose is the plugin's own words;
 *   3. the `isCoding` / line-tag reading — into a `ctx` seam: the engine already reads cycles and tags;
 *   4. the `>=` comparison against the line — into a `ctx` seam: one comparison, in one place;
 *   5. assembling the offer (title, tags, body builder, one line of why) — each side carries its own,
 *      held by the pairing test: the shape is shared, the words are not;
 *   6. the six-significant-digit formatter — into a `ctx` seam: one number is spelled one way;
 *   7. the generated spec template — into a `ctx` seam: the landing path and the sections are the
 *      engine's layout, not a plugin's.
 *
 * The convergence point for 1, 3, 4, 6 and 7 is those `ctx` seams; none of them exists yet, and the
 * convergence is never one plugin importing the other's file. What holds the two copies together
 * today is a contract test that pairs them (`tests/plugin-issue-test-audit-copies.test.ts`), so a
 * change to either side is a red test rather than a difference somebody has to notice by reading two
 * files. 2 and 5 stay copies by design; the pairing test is what keeps them saying the same thing.
 *
 * **One cell of that pairing is a known divergence, and it is a debt, not a promise.** For a reading
 * whose six-digit rounding carries into a new decade (999999.7: seven significant digits, six of them
 * rounding up to 1000000) this side's formatter notices the carry and spells `1e+06`; the test-audit
 * side keeps the fixed spelling `1000000`. The contract test records both spellings as they stand
 * today rather than blessing the difference. The debt is on this side's carry branch: when one
 * spelling is chosen — the fixed one reads better — this side changes, and that cell becomes an
 * equality like every other cell in the batch.
 *
 * The host loads this file by path (the `plugin.json` beside it is its declaration), so it imports
 * nothing from the engine: everything it touches is brought by the `ctx` handed in —
 *
 *     ctx.knob(name)            the effective value of one knob down the whole chain
 *     ctx.reading(key)          the number behind one declared reading; the source it claims is the
 *                               function that supplies it (the `pool_weight` below), so the pool's
 *                               own number arrives this way
 *     ctx.nodesWithTag(tag)     the ids of nodes still open (todo) carrying one tag
 *     ctx.capture(argv)         run one command inside this process and hand back its output (kept for
 *                               a plugin that really has to ask another word; this one does not: the
 *                               pool's number is computed by a function it imports)
 *     ctx.specPath(node_id)     where one node's spec.md lands (this tree's own layout)
 *     ctx.root / ctx.cycle / ctx.nodeId / ctx.sig / ctx.dag / ctx.target
 *
 * **This file belongs to this plugin alone**: reading the declaration, pairing it with the prose
 * below, comparing the number against the line, assembling the offer, writing the node's title and
 * body — all of it here; on the engine's side there is only merging names, looking for collisions,
 * and the insertion mechanism that turns an offer into a node.
 *
 * `offer(ctx)` is the whole contract between this file and the engine: hand back the insertion this
 * pass wants (title, tags, body builder, a line of why), or `null` (the usual answer). It does not
 * land a byte, does not open a session, and does not stop for a number it cannot read: a project with
 * no line configured gets `null` here — so a close in a project that never configured a line stays
 * byte-for-byte what it was before this plugin existed.
 *
 * **The pool's weight is not reported by the session.** This plugin claims the source it takes the
 * number from (`sources` in `plugin.json`) and names the function below that computes it, so the
 * number comes in through `ctx.reading` — the pool's tools are therefore this folder's own business,
 * and the engine does not have to know. A number that cannot be read counts as "not known this pass",
 * never as 0: reading it as 0 would make a real debt look paid off.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { main as runCommand, poolWeight } from './tools/commands.mjs';

// ── The declaration beside this file ─────────────────────────────────────────
// The names (which reading, which line, which tag, which method) live in `plugin.json`; they are not
// written a second time here. A declaration that cannot be read leaves this plugin without any
// judgement for the pass — the same treatment as throwing inside `offer`.

const DECLARATION = fileURLToPath(new URL('plugin.json', import.meta.url));

let loadedDeclaration;
let declarationError = null;

/** This plugin's declaration, read once per process; `null` when it cannot be read. */
function declaration() {
  if (loadedDeclaration === undefined) {
    try {
      const loaded = JSON.parse(readFileSync(DECLARATION, 'utf8'));
      loadedDeclaration = loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : null;
      if (loadedDeclaration === null) declarationError = 'plugin.json is not an object';
    } catch (error) {
      loadedDeclaration = null;
      declarationError = error instanceof Error ? error.message : String(error);
    }
  }
  return loadedDeclaration;
}

/**
 * What this one reading measures, in the words shown to whoever reads it. The declaration carries the
 * mechanical half (which line, which tag, which method, the source this reading takes its number
 * from); this table carries only the words, and a metric the declaration names but this table does
 * not know is simply not judged (a declared reading nobody knows is what doctor reports).
 *
 * `where` says how the number is obtained, so the node that receives it knows whether to measure or
 * to look; `subject` / `criterion` / `remedy` are the mechanical completion rule the spec carries:
 * what gets pulled back under the line, how much the next close must read, and what to run to see it.
 */
const PROSE = {
  issue_pool_weight: {
    unit: '',
    subject: "the issue pool's weighted sum",
    where: '`issue weight` (the issue tool computes it itself; it does not go into a note)',
    criterion: "the pool's weighted sum the tool computes at the next close must be **below**",
    remedy: 'run `issue weight -v` to see how this number adds up, '
      + 'and confirm it is back under the line',
  },
};

// ── The reading: one function of the pool's own folder ───────────────────────
// The pool's number is computed by the command surface that owns the pool, so this reading is that
// same function, imported: one folder, one plugin's files, no plugin contract in the way. What a
// command prints is for a person to read; a number this plugin judges against a line is not read back
// out of that text.

/**
 * How heavy the pool is, computed by the pool's own tools; it throws what the pool's reader throws (an
 * unreadable pool is a number this pass does not know, never 0).
 */
export function pool_weight(ctx) {
  return poolWeight(ctx.root);
}

// ── Metrics: the declaration's names, this file's words ──────────────────────

/** The declared metrics paired with the prose above, in the declaration's own order; a metric with no prose here cannot produce a body and is skipped. */
function metricsOf(decl) {
  const readings = asRecord(decl.readings);
  const declared = asRecord(decl.metrics);
  const out = [];
  for (const [key, spec] of Object.entries(declared)) {
    const prose = PROSE[key];
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec) || prose === undefined) continue;
    const reading = asRecord(readings[key]);
    // The source cell is read the way the engine's registry reads it (`readingsOf`): the cell as it
    // stands, and a reading that names no source is not served (doctor reports it), so this metric
    // is not judged — no fallback value is invented here.
    const source = reading.source;
    if (typeof source !== 'string') continue;
    out.push({ ...prose, ...spec, reading: key, source });
  }
  return out;
}

function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/** Only a line about code is judged: this metric measures debt on the code branch. */
function isCoding(cycle) {
  const tags = Array.isArray(cycle.tags) ? cycle.tags.filter((tag) => typeof tag === 'string') : [];
  return tags.includes('coding');
}

/** The filter set of the line that asked for this insertion, read as it is written. */
function lineTags(cycle) {
  return Array.isArray(cycle.tags) ? cycle.tags.filter((tag) => typeof tag === 'string') : [];
}

// ── Judgement ────────────────────────────────────────────────────────────────

/**
 * One metric's (value, line), `null` when either half is missing.
 *
 * The comparison is `>=`: the line is the last number still acceptable, so reading exactly the line
 * means the debt is right at the ceiling and the insertion fires.
 */
function wired(metric, values, lines) {
  const value = values[metric.reading];
  if (value === undefined || value === null) return null;
  const line = lines[metric.line];
  if (line !== undefined && line !== null && value >= line) return [value, line];
  return null;
}

/**
 * The insertion this plugin wants right now, or `null` (the usual answer).
 *
 * `null` covers every way this plugin stays silent: the metric has no number, no line is drawn on this
 * line, the number is under the line, the line is not about code, and the metric's node in the graph is
 * still open — one metric has one live node at a time. A switch turned off is not one of them: that is
 * the host's gate, and this door is not asked at all in that case.
 *
 * Asking the pool late is deliberate: a line with nothing drawn on it does not read the pool at all.
 */
export async function offer(ctx) {
  const decl = declaration();
  if (!decl) return null;
  const cycle = ctx.cycle || {};
  if (!isCoding(cycle)) return null;
  const declared = metricsOf(decl);
  if (declared.length === 0) return null;
  const lines = {};
  for (const metric of declared) {
    const value = await ctx.knob(metric.line);
    if (value !== null && value !== undefined) lines[metric.line] = value;
  }
  if (Object.keys(lines).length === 0) {
    // Nothing configured at all: the answer of this close is `null`, and the pool's command is not
    // asked either. This is the regression floor: a project that never configured a line closes
    // exactly as it did before this plugin existed.
    return null;
  }
  // The switch is not read here. `enable_knob` is the host's gate, in one place (`enabled()` in
  // `src/plugins/host.ts`): a plugin whose switch is off is skipped before this door is asked at all,
  // and an unreadable switch counts as off there. Asking again here would be a second implementation
  // of one rule, with its own tolerance.
  const values = {};
  for (const metric of declared) {
    if (!(metric.line in lines)) continue;
    // The number comes in through `ctx.reading`: the source this declaration claims is supplied by
    // `pool_weight` below, and the engine hands its answer back as it is.
    const value = await ctx.reading(metric.reading);
    if (value !== null && value !== undefined) values[metric.reading] = value;
  }
  if (Object.keys(values).length === 0) return null;
  for (const metric of declared) {
    const got = wired(metric, values, lines);
    if (got === null) continue;
    if (ctx.nodesWithTag(metric.tag).length > 0) {
      // One metric, one live node: while it is still live, the next crossing waits.
      continue;
    }
    const [value, line] = got;
    const hit = { ...metric, value, at: line };
    hit.title = titleOf(hit);
    // A function, not that text: the node's uuid decides where the body lands, and the uuid only
    // exists once the node does.
    const specOf = (nodeId) => spec(hit, ctx.specPath(nodeId));
    return offerOf(ctx, cycle, hit, specOf);
  }
  return null;
}

/**
 * The rehearsal of `offer`: this gate reads — the knob chain, and the pool's own `weight` command through
 * `ctx.capture` — and writes nothing, so the same question answers the same way on a rehearsal context. A
 * rehearsal's `ctx.run` refuses (an effect belongs to the timing itself); this file never calls it.
 */
export const offer_preview = offer;

/** One number as the reader sees it: an integer stays an integer, a decimal stays a decimal (six significant digits, trailing zeros dropped). */
function shown(value, unit) {
  return `${generalFormat(value)}${unit ?? ''}`;
}

/**
 * The six-significant-digit form: exponents within -4…5 take the fixed spelling, the rest take
 * `e±NN`. Numbers and lines may both be written as decimals by people, and the title and the body
 * have to print them the same way.
 */
function generalFormat(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const negative = value < 0;
  const magnitude = Math.abs(value);
  let exponent = Math.floor(Math.log10(magnitude));
  const rounded = Number((magnitude / 10 ** exponent).toFixed(5));
  if (rounded >= 10) exponent += 1;
  if (exponent < -4 || exponent >= 6) {
    const mantissa = String(Number((magnitude / 10 ** exponent).toFixed(5)));
    const sign = exponent < 0 ? '-' : '+';
    return `${negative ? '-' : ''}${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  const decimals = Math.max(0, 5 - exponent);
  let text = magnitude.toFixed(decimals);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return `${negative ? '-' : ''}${text}`;
}

/** That crossing, as the engine reads it: what to insert, and the note around it. */
function offerOf(ctx, cycle, hit, specOf) {
  const target = ctx.target || {};
  const targetId = target.id || '';
  const closed = ctx.nodeId || '';
  const reading = shown(hit.value, hit.unit);
  const line = shown(hit.at, hit.unit);
  const note = `${hit.subject} read ${reading}, over the line ${line} in force for this close `
    + `(the \`${hit.line}\` knob): a node is inserted between the just-closed ${String(closed).slice(0, 8)} `
    + `and the ${target.title || targetId} it had picked. No session was opened, `
    + 'and the inserted node is not pinned: which node the next dispatch picks is the usual '
    + "ranking's call (on a line that fills several slots, this same close may have pinned "
    + 'the rest of its fill). After committing and pushing: '
    + `\`plan --cycle ${cycle.id} --json\`, then \`hold <that node> --cycle ${cycle.id}\` and `
    + `\`dispatch ${cycle.id}\` — or the composed \`advance --cycle ${cycle.id}\`.`;
  return {
    title: hit.title,
    tags: [hit.tag, ...lineTags(cycle)],
    spec_of: specOf,
    why: `${hit.reading} = ${reading} (line ${line})`,
    note,
  };
}

// ── The node's own body ──────────────────────────────────────────────────────

/** The node's title: which metric, which line, one line for people to read. */
function titleOf(hit) {
  return `Maintenance: ${hit.subject} = ${shown(hit.value, hit.unit)}, `
    + `over the line ${shown(hit.at, hit.unit)}`;
}

/** What the next judgement of this debt reads: the issue tool computes the pool's number itself, so it does not go into the note where nobody would use it. */
function closingReading(hit) {
  return '- the issue tool computes this metric itself (`issue weight`); the note does '
    + 'not carry it:\n'
    + '  at the next close, a number the tool computes below'
    + ` ${shown(hit.at, hit.unit)} counts as back under the line.\n`;
}

/**
 * The generated spec: why this node exists, the scope of this pass, which skill owns it, and how done
 * is counted.
 *
 * Written by the tool, not by the session that will run it later — the judgement is mechanical by
 * design, so the node must not be handed the judgement along with it. What it carries is the part
 * whoever does the work cannot infer: which reading is measured, how much it read, and where the
 * line is.
 *
 * No project function name, file path or line number appears here: which files to touch is this
 * node's own business, and a guessed template is a template that lies.
 */
function spec(hit, specPath) {
  return '# Maintenance node (generated by the tool)\n'
    + "This node's spec is generated by a conduct plugin and copied verbatim; it says **why this "
    + 'node was inserted**, **the scope of this one pass**, **how to do it**, and **the completion '
    + 'rule fixed from the start**.\n'
    + '\n'
    + '## Why this node was inserted\n'
    + '\n'
    + `- metric: ${hit.subject}\n`
    + `- where this number comes from: ${hit.where}\n`
    + `- read at the close: **${shown(hit.value, hit.unit)}**\n`
    + `- the line in force for this close: **${shown(hit.at, hit.unit)}** `
    + `(the \`${hit.line}\` knob; it may be stated on the line, the project, the machine or a `
    + 'node, and the value the close read is the one that counts)\n'
    + '- this plugin is project-level: maintenance debt belongs to no line and has no edge in '
    + 'the graph, so the ranking always pushes it to the bottom; the close therefore inserts it '
    + 'against the line in force for that close.\n'
    + '\n'
    + '## Scope\n'
    + '\n'
    + '- **this pass does one thing only**: pull this one metric back under the line. No adding '
    + 'plugins on the side, no refactoring on the side, no cleanup unrelated to this metric.\n'
    + '- another metric crossing its line, or other work in the graph being more urgent, is '
    + "outside this node's scope -- whoever crosses comes in for a pass of their own.\n"
    + '- the size of the change follows the criterion: keep going while it fails, stop when it '
    + 'passes.\n'
    + '\n'
    + '## How to do it\n'
    + '\n'
    + `- \`method: ${hit.method}\` (how to run it: \`<dshHome>/skills/${hit.method}/SKILL.md\`, the `
    + `skill root this tree places into, \`~/.dsh/skills\` unless the deployment pins \`DSH_HOME\`; `
    + 'that skill declares who runs it, and this spec only points at it)\n'
    + '\n'
    + '## Completion rule (mechanically judgeable)\n'
    + '\n'
    + `- ${hit.criterion} ${shown(hit.at, hit.unit)}.\n`
    + `- how to see this number: ${hit.remedy}.\n`
    + '- if the criterion fails, do **not** report `completed`; report `failed` and write the '
    + 'number you read in `-s`, leaving this debt out in the open for a human.\n'
    + '\n'
    + '## Closing out\n'
    + '\n'
    + 'Follow the "closing out" section of pf-conduct: get a freshly printed note form, then '
    + 'hand the ticket in -> `settle` the node -> commit and push -> `dispatch` the next cell.\n'
    + closingReading(hit)
    + `\n(this spec lands at: ${specPath})\n`;
}

// ── The second entry point: commands ─────────────────────────────────────────
// The declaration reports the word `issue`, and the host hands the rest of that line's arguments to
// this folder's own command surface, still reading the project root the engine handed in. One
// implementation serves both entry points: this is what "a plugin is a folder plus one implementation"
// means.

/** `issue …`: this folder's own tool; the command surface's verbs live in `tools/commands.mjs`. */
export async function main(argv, ctx) {
  return runCommand(argv, ctx);
}