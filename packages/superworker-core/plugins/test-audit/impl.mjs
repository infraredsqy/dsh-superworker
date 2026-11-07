/**
 * The test-audit plugin's own implementation: the judgement, plus the node's own body (the reading,
 * the threshold, the dedup tag, the body verbatim).
 *
 * The core loads this file **by path**, so it is a module of its own: it and the `plugin.json` beside
 * it (this plugin's declaration) are the two things in one folder, and beyond that it imports nothing
 * from this repository — everything it can touch is in the `ctx` handed to it (`PluginContext`):
 *
 *     await ctx.knob(name)      the effective value of one knob down the whole chain
 *     await ctx.reading(key)    the number one declared reading answers with (the one the ticket reports)
 *     ctx.nodesWithTag(tag)     the ids of nodes still open (todo) carrying this tag
 *     ctx.specPath(nodeId)      where one node's spec.md lands (this tree's own layout, not a guess here)
 *     ctx.cycle / ctx.nodeId / ctx.sig / ctx.dag / ctx.target
 *
 * **This file is this plugin's own.** Reading the declaration, pairing it with the prose table below,
 * comparing the number against the line, assembling the offer, writing the node's title and body — all
 * of it is here; the other one in the same batch of plugins (the one watching the issue pool) carries
 * its own copy of the same machinery: this thing is not shared between plugins, and it is not lifted
 * into the core either. The core merges names, looks for collisions, and turns an offer into a node in
 * `src/plugins/insertion.ts`.
 *
 * `offer(ctx)` is the whole contract between it and the core: the insertion wanted right now (title,
 * tags, body builder, plus its own two lines), or `null` — the common one. It never writes a file,
 * never opens a session, and never throws because a number is missing: the close of a project with no
 * line configured gets `null` here, which is where "a close without the plugin is the same bytes as
 * before" comes from.
 *
 * **A number may be missing, and a number that cannot be read counts as "not known this pass".** The
 * line lives in its own knob (`knobs.test_seconds_limit` in the declaration, judged at whichever layer
 * of the chain states it), and the ticket carries the wall clock the session measured. Reading a
 * missing number as 0 would make a real debt look paid off, so it reads as absent.
 */

import { readFileSync } from 'node:fs';

// ── The declaration beside it ────────────────────────────────────────────────
// The names (which reading is taken, which line it is compared against, what the dedup tag is spelled,
// what the method is called) live in `plugin.json` and are never copied a second time here; this is
// where it is read. A declaration that cannot be read equals no judgement this round for this plugin
// (the same path as blowing up inside `offer`).

const DECLARATION = new URL('./plugin.json', import.meta.url);

let readOnce = false;
let declarationValue = null;

/** This plugin's declaration, read once per process; `null` when it cannot be read (or is not an object). */
function declaration() {
  if (!readOnce) {
    readOnce = true;
    try {
      const parsed = JSON.parse(readFileSync(DECLARATION, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        declarationValue = parsed;
      }
    } catch {
      declarationValue = null;
    }
  }
  return declarationValue;
}

/** The object shape of one declared entry; an entry that does not fit counts as an empty table (declaration problems are doctor's to report, this file only has to not throw). */
function objectOf(value) {
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

// ── The body: what this metric measures ──────────────────────────────────────
// The declaration carries the mechanical half (which line it is compared against, what the dedup tag
// is spelled, what the method is called); this is where only the prose lives, and a metric the
// declaration names but this file does not know is not judged (a declared reading nobody knows is
// doctor's to report).
//
// `where` says where the number comes from, so the node that receives it knows whether to measure or
// to look. `subject` / `criterion` / `remedy` are the mechanical completion rule the generated spec
// carries: what the number pulled back under the line is, what the next close must read, and what to
// run to see it.

const PROSE = {
  test_seconds: {
    unit: 's',
    subject: "the project test suite's full wall clock (seconds)",
    where:
      "the note's `outputs.reading.test_seconds` (measured by the session that ran the " +
      'full verification)',
    criterion: "the next closing note's `reading.test_seconds` must be **below**",
    remedy:
      'run the full verification command the project docs settle on and **measure** it ' +
      '(never estimate), then report the measured seconds in the note',
  },
};

// ── The reading: the number the worker reports ───────────────────────────────

/**
 * One reading, or `null`.
 *
 * A number is a number and nothing else counts: a boolean is a decision JSON spells out, and the host
 * context has already filtered it out; a string is left as it is and not parsed — guessing a number
 * out of prose is exactly the road that makes a threshold fire on the wrong evidence.
 */
function numberOf(value) {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

// ── Metrics: the declaration's names, plus the prose here ────────────────────

/** The metrics the declaration accepts, merged with the prose above, in the declaration's own order; a metric with no prose here cannot be written out and is skipped. */
function metrics(decl) {
  const readings = objectOf(decl.readings);
  const declared = objectOf(decl.metrics);
  const out = [];
  for (const [key, spec] of Object.entries(declared)) {
    const prose = PROSE[key];
    if (prose === undefined || spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      continue;
    }
    const reading = objectOf(readings[key]);
    out.push({ ...prose, ...spec, reading: key, source: reading.source || 'ticket' });
  }
  return out;
}

/** The tags of one line, read as they are written (non-strings dropped). */
function tagsOf(cycle) {
  return Array.isArray(cycle.tags) ? cycle.tags.filter((tag) => typeof tag === 'string') : [];
}

/** Only a line about code is judged: this metric is debt on the code branch. */
function isCoding(cycle) {
  return tagsOf(cycle).includes('coding');
}

/** This line's own filter set, read as written; an inserted node carries the same tags. */
function lineTags(cycle) {
  return tagsOf(cycle);
}

// ── Judgement ────────────────────────────────────────────────────────────────

/**
 * One metric's `[number, line]`, `null` when either half is missing.
 *
 * The comparison is `>=`: the line is the last acceptable number, and reading it means the debt is at
 * the ceiling and the insertion should fire.
 */
function wired(metric, values, lines) {
  const value = values.get(metric.reading);
  if (value === undefined || value === null) return null;
  const line = lines.get(metric.line);
  if (line !== undefined && line !== null && value >= line) return [value, line];
  return null;
}

/** The insertion wanted right now, or `null`. */
export async function offer(ctx) {
  const decl = declaration();
  if (decl === null) return null;
  const cycle = objectOf(ctx.cycle);
  if (!isCoding(cycle)) return null;
  const declared = metrics(decl);
  if (declared.length === 0) return null;

  const lines = new Map();
  for (const metric of declared) {
    const value = await ctx.knob(metric.line);
    if (value !== null && value !== undefined) lines.set(metric.line, value);
  }
  if (lines.size === 0) {
    // Nothing configured at all: the answer of the close is `null`. This is the regression floor: a
    // project that never configured a line closes the old way.
    return null;
  }

  // No switch is read here: `enable_knob` is the host's gate in one place (`enabled()` in
  // `src/plugins/host.ts`), which skips a plugin whose switch is off before this door is asked, and
  // counts an unreadable switch as off.

  const values = new Map();
  for (const metric of declared) {
    const got = numberOf(await ctx.reading(metric.reading));
    if (got !== null) values.set(metric.reading, got);
  }
  if (values.size === 0) return null;

  for (const metric of declared) {
    const got = wired(metric, values, lines);
    if (got === null) continue;
    if (ctx.nodesWithTag(metric.tag).length > 0) {
      // One metric, one live node: while that one is still live, the next crossing waits.
      continue;
    }
    const [value, line] = got;
    const hit = { ...metric, value, at: line };
    hit.title = title(hit);
    // What comes back is a function: the node's uuid decides where its body lands, and the uuid only
    // exists once the node does.
    hit.spec_of = (nodeId) => spec(hit, ctx.specPath(nodeId));
    return offerText(ctx, cycle, hit);
  }
  return null;
}

/**
 * The rehearsal of `offer`: this gate only reads (the knobs and the ticket's own number), so the same question
 * answers the same way on a rehearsal context. A rehearsal's `ctx.run` refuses — this file never calls it.
 */
export const offer_preview = offer;

/** One number written the way the reader sees it: six significant digits, trailing zeros dropped, plus the unit. */
function shown(value, unit) {
  return `${gFormat(value)}${unit}`;
}

function gFormat(value) {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent < -4 || exponent >= 6) {
    let [mantissa, power] = value.toExponential(5).split('e');
    if (mantissa.includes('.')) mantissa = mantissa.replace(/0+$/, '').replace(/\.$/, '');
    const sign = power.startsWith('-') ? '-' : '+';
    return `${mantissa}e${sign}${power.replace(/^[+-]/, '').padStart(2, '0')}`;
  }
  let fixed = value.toFixed(Math.max(0, 5 - exponent));
  if (fixed.includes('.')) fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return fixed;
}

/** This crossing, as the core reads it: what to insert, plus the few sentences around it. */
function offerText(ctx, cycle, hit) {
  const target = objectOf(ctx.target);
  const targetId = typeof target.id === 'string' ? target.id : '';
  const closed = typeof ctx.nodeId === 'string' ? ctx.nodeId : '';
  const reading = shown(hit.value, hit.unit);
  const line = shown(hit.at, hit.unit);
  const note =
    `${hit.subject} read ${reading}, over the line ${line} in force for this close ` +
    `(the \`${hit.line}\` knob): a node is inserted between the just-closed ${closed.slice(0, 8)} ` +
    `and the ${target.title || targetId} it had picked. No session was opened, ` +
    `and the inserted node is not pinned: which node the next dispatch picks is the usual ` +
    `ranking's call (on a line that fills several slots, this same close may have pinned ` +
    `the rest of its fill). After committing and pushing: ` +
    `\`plan --cycle ${cycle.id} --json\`, then \`hold <that node> --cycle ${cycle.id}\` and ` +
    `\`dispatch ${cycle.id}\` — or the composed \`advance --cycle ${cycle.id}\`.`;
  return {
    title: hit.title,
    tags: [hit.tag, ...lineTags(cycle)],
    spec_of: hit.spec_of,
    why: `${hit.reading} = ${reading} (line ${line})`,
    note,
  };
}

// ── The node's own body ──────────────────────────────────────────────────────

/** The node's title: which reading was measured, which line, one line of words for people. */
function title(hit) {
  return `Maintenance: ${hit.subject} = ${shown(hit.value, hit.unit)}, ` +
    `over the line ${shown(hit.at, hit.unit)}`;
}

/** What this debt's next judgement reads: the wall clock only the session that ran the verification can measure, and the ticket's form points this field out. */
function closingReading(hit) {
  return `- in the note's \`-o\`, carry \`"reading": {"${hit.reading}": <measured number>}\`` +
    ' (the form points this slot out), so the next close can judge whether it is back ' +
    'under the line.\n';
}

/**
 * The generated spec: why this node exists, the scope of this pass, which skill owns it, and how done
 * is counted.
 *
 * Written by the tool, not by the session that is to run it — the whole point is that the judgement is
 * mechanical, so this node must not be handed the judgement again. What it carries is the thing a
 * worker cannot infer: which reading was read, how much it read, and where the line is.
 *
 * No project function name, file path or line number appears here: which files to touch is this node's
 * own business, and a guessed template is a template that lies.
 */
function spec(hit, specPath) {
  return (
    '# Maintenance node (generated by the tool)\n' +
    "This node's spec is generated by a conduct plugin and copied verbatim; it says **why this " +
    'node was inserted**, **the scope of this one pass**, **how to do it**, and **the completion ' +
    'rule fixed from the start**.\n' +
    '\n' +
    '## Why this node was inserted\n' +
    '\n' +
    `- metric: ${hit.subject}\n` +
    `- where this number comes from: ${hit.where}\n` +
    `- read at the close: **${shown(hit.value, hit.unit)}**\n` +
    `- the line in force for this close: **${shown(hit.at, hit.unit)}** ` +
    `(the \`${hit.line}\` knob; it may be stated on the line, the project, the machine or a ` +
    'node, and the value the close read is the one that counts)\n' +
    '- this plugin is project-level: maintenance debt belongs to no line and has no edge in ' +
    'the graph, so the ranking always pushes it to the bottom; the close therefore inserts it ' +
    'against the line in force for that close.\n' +
    '\n' +
    '## Scope\n' +
    '\n' +
    '- **this pass does one thing only**: pull this one metric back under the line. No adding ' +
    'plugins on the side, no refactoring on the side, no cleanup unrelated to this metric.\n' +
    "- another metric crossing its line, or other work in the graph being more urgent, is " +
    "outside this node's scope -- whoever crosses comes in for a pass of their own.\n" +
    '- the size of the change follows the criterion: keep going while it fails, stop when it ' +
    'passes.\n' +
    '\n' +
    '## How to do it\n' +
    '\n' +
    `- \`method: ${hit.method}\` (how to run it: \`<dshHome>/skills/${hit.method}/SKILL.md\`, the ` +
    `skill root this tree places into, \`~/.dsh/skills\` unless the deployment pins \`DSH_HOME\`; ` +
    'that skill declares who runs it, and this spec only points at it)\n' +
    '\n' +
    '## Completion rule (mechanically judgeable)\n' +
    '\n' +
    `- ${hit.criterion} ${shown(hit.at, hit.unit)}.\n` +
    `- how to see this number: ${hit.remedy}.\n` +
    '- if the criterion fails, do **not** report `completed`; report `failed` and write the ' +
    'number you read in `-s`, leaving this debt out in the open for a human.\n' +
    '\n' +
    '## Closing out\n' +
    '\n' +
    'Follow the "closing out" section of sw-conduct: get a freshly printed note form, then ' +
    'hand the ticket in -> `settle` the node -> commit and push -> `dispatch` the next cell.\n' +
    closingReading(hit) +
    `\n(this spec lands at: ${specPath})\n`
  );
}