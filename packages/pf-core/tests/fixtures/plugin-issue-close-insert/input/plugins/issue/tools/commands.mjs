/**
 * The issue pool's verbs: each verb is one entry of the command surface.
 *
 * The command word and its flags live here; `main` in `impl.mjs` joins this layer to the host context
 * (`ctx.root` is the project root the record directory sits in). A command answers text (what a person
 * reads) or a number (the exit code it asks its caller to leave with), and its two ways of ending are
 * not the same ending: a **usage error** — an unknown verb, a flag the verb does not take, the wrong
 * number of positional arguments, a value outside a flag's closed set, a flag the verb requires and the
 * line left out, a value of the wrong shape (a regex the engine cannot compile) — carries `code: 2` and
 * is answered with the usage line, the way the core's own words answer a refused line; any other failure
 * is thrown, and the host folds it into `main failed` with `code: 1` (at a timing's seam it becomes one
 * WARNING line and "none this round"). The text handed back on success ends with a newline, like a
 * printed line; the two sentences that would have gone to stderr (a skipped batch import, `No changes
 * specified`) are folded into that same text.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  EOL,
  SEVERITY_WEIGHTS,
  VALID_DECISIONS,
  VALID_SEVERITIES,
  VALID_SOURCES,
  VALID_STATUSES,
  ensurePlanDir,
  missingIssue,
  now,
  readPool,
  resolveFrom,
  withPoolLock,
  writePool,
} from './storage.mjs';

// ═══ How a refusal ends ══════════════════════════════════════════════════════

/**
 * A refusal about how the line was written, not about what the pool holds: the verb is unknown, the
 * flag is not one this verb takes, the positional count is wrong, the value misses a closed set, a flag
 * the verb requires was left out, the value is of the wrong shape. `code = 2` is what such a line
 * answers with — the same 2 the core's own parser answers a usage error with — and `main` lets it out
 * with that code attached. Everything else is a plain `Error`, which the host answers with `code: 1`.
 */
export class UsageError extends Error {
  constructor(sentence) {
    super(`${USAGE_HEAD}${EOL}${EOL}${sentence}`);
    this.name = 'UsageError';
    this.code = 2;
  }
}

/** The head of the usage page, and of every usage error's sentence. */
const USAGE_HEAD = 'usage: issue <verb> [options]';

// ═══ The shape of a record ═══════════════════════════════════════════════════

/**
 * The one construction of a pool record: both entry points (a single add and a batch file) land here.
 * The keys, the defaults and the four content checks (severity / decision / files / functions) are all
 * written in this one place. `where` names the row inside an error sentence; it is an empty string for
 * a single add.
 */
function buildIssueRecord(source, uid, moment, where = '') {
  const severity = gate(source, 'severity', 'P3');
  if (!VALID_SEVERITIES.includes(severity)) {
    throw new Error(`${where}invalid severity "${severity}", valid: ${[...VALID_SEVERITIES].sort().join(', ')}`);
  }
  const decision = gate(source, 'decision', 'unknown');
  if (!VALID_DECISIONS.includes(decision)) {
    throw new Error(`${where}invalid decision "${decision}", valid: ${[...VALID_DECISIONS].sort().join(', ')}`);
  }
  const files = gate(source, 'files', []);
  const functions = gate(source, 'functions', []);
  for (const [field, value] of [['files', files], ['functions', functions]]) {
    if (!Array.isArray(value)) {
      throw new Error(`${where}"${field}" must be a list, got ${describe(value)}`);
    }
  }
  const title = pick(source, 'title', uid);
  return {
    id: uid,
    severity,
    module: pick(source, 'module', ''),
    title: title ? title : uid,
    decision,
    source: pick(source, 'source', 'scan'),
    status: 'open',
    discovered: moment,
    updated_at: moment,
    check_count: 1,
    files,
    functions,
    description: pick(source, 'description', ''),
    suggestion: pick(source, 'suggestion', ''),
    reason: pick(source, 'reason', null),
    plan_path: pick(source, 'plan_path', null),
  };
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A text key: absent and `null` both count as "not given" and take the default; the arguments and the batch file are read the same way. */
function pick(source, name, fallback) {
  const value = source[name];
  return value === undefined || value === null ? fallback : value;
}

/** Keys of the "given means it must be valid" kind (severity / decision / files / functions): a `null` in a batch row is handed to the checks as it is. */
function gate(source, name, fallback) {
  const value = source[name];
  if (value === undefined) return fallback;
  return value;
}

function valueEqual(left, right) {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) return false;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || typeof left === 'object') return JSON.stringify(left) === JSON.stringify(right);
  return false;
}

/** One pool record: an id that is not in the pool is rejected at once. */
function get(uid, data) {
  const issue = data.issues[uid];
  if (issue === undefined || issue === null) throw missingIssue(uid);
  return issue;
}

/** Build a kebab-case id out of the module and the title (with `--auto-id`). */
function autoId(item) {
  const rawModule = pick(item, 'module', 'unknown');
  const mod = String(rawModule === '' ? 'unknown' : rawModule).split('/').join('-');
  const rawTitle = pick(item, 'title', 'untitled');
  const title = String(rawTitle === '' ? 'untitled' : rawTitle).toLowerCase();
  const slug = title.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return slug ? `${mod}-${slug}` : `${mod}-untitled`;
}

/** `base`, or `base-2` / `base-3`… when this batch has already used it (two real findings in one scan). */
function freeId(base, named) {
  let uid = base;
  let n = 2;
  while (named.has(uid)) {
    uid = `${base}-${n}`;
    n += 1;
  }
  return uid;
}

// ═══ The argument surface ════════════════════════════════════════════════════

/** The flags each verb knows: long spelling, short spelling, how it takes a value (flag / value / int / list), and the closed set of values. */
const FLAGS = {
  severity: { long: '--severity', kind: 'value', choices: VALID_SEVERITIES },
  decision: { long: '--decision', kind: 'value', choices: VALID_DECISIONS },
  source: { long: '--source', kind: 'value', choices: VALID_SOURCES },
  status: { long: '--status', kind: 'value', choices: VALID_STATUSES },
  id: { long: '--id', kind: 'value' },
  from_file: { long: '--from-file', kind: 'value' },
  auto_id: { long: '--auto-id', kind: 'flag' },
  module: { long: '--module', kind: 'value' },
  title: { long: '--title', kind: 'value' },
  description: { long: '--description', kind: 'value' },
  suggestion: { long: '--suggestion', kind: 'value' },
  reason: { long: '--reason', kind: 'value' },
  files: { long: '--files', kind: 'list' },
  functions: { long: '--functions', kind: 'list' },
  plan_path: { long: '--plan-path', kind: 'value' },
  limit: { long: '--limit', short: '-n', kind: 'int' },
  threshold: { long: '--threshold', short: '-t', kind: 'int' },
  brief: { long: '--brief', kind: 'flag' },
  verbose: { long: '--verbose', short: '-v', kind: 'flag' },
};

/**
 * The pool cells `update` writes: the flags its argument surface takes and, exactly, the fields one
 * `--from-file` row may carry beside its `id`.
 */
const UPDATE_FIELDS = ['severity', 'decision', 'status', 'module', 'title', 'description', 'suggestion', 'reason', 'files', 'functions', 'plan_path'];

/**
 * One verb's option table: which flags it knows and how many positional arguments it takes.
 * `suppliedBy` names the option whose rows carry the positional arguments themselves (`--from-file`),
 * so a line taking that option needs none.
 */
const SPECS = {
  add: { options: ['id', 'from_file', 'auto_id', 'severity', 'decision', 'source', 'module', 'title', 'description', 'suggestion', 'reason', 'files', 'functions', 'plan_path'], positional: { min: 0, max: 0 } },
  list: { options: ['status', 'severity', 'decision', 'source', 'module', 'limit', 'brief'], positional: { min: 0, max: 0 } },
  update: { options: ['from_file', ...UPDATE_FIELDS], positional: { min: 1, max: Number.POSITIVE_INFINITY, suppliedBy: 'from_file' } },
  resolve: { options: ['reason', 'plan_path'], positional: { min: 1, max: Number.POSITIVE_INFINITY } },
  reject: { options: ['reason'], positional: { min: 1, max: Number.POSITIVE_INFINITY } },
  acknowledge: { options: ['reason'], positional: { min: 1, max: Number.POSITIVE_INFINITY } },
  remove: { options: [], positional: { min: 1, max: Number.POSITIVE_INFINITY } },
  'open-plan': { options: [], positional: { min: 1, max: 1 } },
  status: { options: ['verbose'], positional: { min: 0, max: 0 } },
  weight: { options: ['verbose'], positional: { min: 0, max: 0 } },
  top: { options: ['limit', 'brief'], positional: { min: 0, max: 0 } },
  'by-module': { options: [], positional: { min: 0, max: 0 } },
  stale: { options: ['threshold'], positional: { min: 0, max: 0 } },
  mark: { options: [], positional: { min: 1, max: Number.POSITIVE_INFINITY } },
  search: { options: ['status', 'severity', 'source', 'limit'], positional: { min: 1, max: 1 } },
  'export-plan': { options: [], positional: { min: 1, max: Number.POSITIVE_INFINITY } },
};

/**
 * The verbs are spelled with hyphens (`open-plan`, `by-module`, `export-plan`): these are words a person
 * recites. The two underscore spellings the surface shipped with stay routable, on the same runner, so
 * a script already written against `by_module` / `export_plan` does not break; `issue help` prints them
 * beside the canonical spelling.
 */
const VERB_ALIASES = Object.freeze({ by_module: 'by-module', export_plan: 'export-plan' });

/**
 * Short spellings are folded into long ones first (`-v` -> `--verbose`, `-n` -> `--limit`,
 * `-t` -> `--threshold`). A short spelling that takes a value also accepts the attached form
 * (`-n5` / `-n=5` -> `--limit=5`: the value follows the short flag directly, or is separated by an
 * equals sign); characters attached to a short spelling that takes no value (`-v`) are not folded and
 * still count as an unrecognized argument.
 */
function normalizeShortFlags(argv, spec) {
  const shorts = new Map();
  const takingValue = [];
  for (const key of spec.options) {
    const cell = FLAGS[key];
    if (cell.short === undefined) continue;
    shorts.set(cell.short, cell);
    if (cell.kind !== 'flag') takingValue.push(cell);
  }
  const out = [];
  let positionalOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positionalOnly = true;
      out.push(token);
      continue;
    }
    if (positionalOnly) {
      out.push(token);
      continue;
    }
    const exact = shorts.get(token);
    if (exact !== undefined) {
      // When the previous token is a short spelling taking a value, this one is that value and is not
      // folded as a flag (the -t in `-n -t`).
      const previous = index > 0 ? shorts.get(argv[index - 1]) : undefined;
      out.push(previous !== undefined && previous.kind !== 'flag' ? token : exact.long);
      continue;
    }
    const attached = attachedShortValue(token, takingValue);
    if (attached !== null) {
      out.push(attached);
      continue;
    }
    out.push(token);
  }
  return out;
}

/** The fold of the attached form: `-n5` / `-n=5` -> `--limit=5` (the value is carried over as it is, into the int parsing of parseArgs). */
function attachedShortValue(token, takingValue) {
  for (const cell of takingValue) {
    if (!token.startsWith(cell.short)) continue;
    const rest = token.slice(cell.short.length);
    if (rest === '') continue;
    const value = rest.startsWith('=') ? rest.slice(1) : rest;
    return `${cell.long}=${value}`;
  }
  return null;
}

/** Split the rest of one line's argv into "flags it knows" and "positional arguments"; an unknown token is rejected at once. */
function parseArgs(argv, spec) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      positional.push(...argv.slice(index + 1));
      break;
    }
    const name = flagNameOf(token, spec);
    if (name === null) {
      if (looksLikeFlag(token)) {
        throw new UsageError(`unrecognized argument: ${token} (run \`issue help\` for the flags this verb takes)`);
      }
      positional.push(token);
      continue;
    }
    const cell = FLAGS[name];
    const inline = inlineValueOf(token);
    if (cell.kind === 'flag') {
      if (inline !== undefined) throw new UsageError(`argument ${cell.long}: takes no value`);
      options[name] = true;
      continue;
    }
    if (cell.kind === 'list') {
      const values = [];
      if (inline !== undefined) values.push(inline);
      else {
        while (index + 1 < argv.length && !looksLikeFlag(argv[index + 1])) values.push(argv[(index += 1)]);
      }
      options[name] = values;
      continue;
    }
    let raw = inline;
    if (raw === undefined) {
      index += 1;
      raw = argv[index];
    }
    if (raw === undefined) throw new UsageError(`argument ${cell.long}: expected one value`);
    if (cell.kind === 'int') {
      if (!/^[+-]?\d+$/.test(raw)) throw new UsageError(`argument ${cell.long}: invalid int value: '${raw}'`);
      options[name] = Number(raw);
      continue;
    }
    if (cell.choices !== undefined && !cell.choices.includes(raw)) {
      throw new UsageError(`invalid ${name} "${raw}", valid: ${[...cell.choices].sort().join(', ')}`);
    }
    options[name] = raw;
  }
  const count = positional.length;
  // An option that carries the positionals in its own rows (a batch file names its ids) answers the
  // minimum positional count for the whole line.
  const minimum = spec.positional.suppliedBy !== undefined && options[spec.positional.suppliedBy] !== undefined
    ? 0
    : spec.positional.min;
  if (count < minimum || count > spec.positional.max) {
    throw new UsageError(
      `this verb wants ${positionalWanted(spec)} positional argument(s), got ${count} (run \`issue help\`)`,
    );
  }
  return { options, positional };
}

function positionalWanted(spec) {
  if (spec.positional.max === Number.POSITIVE_INFINITY) return `at least ${spec.positional.min}`;
  if (spec.positional.min === spec.positional.max) return `${spec.positional.min}`;
  return `${spec.positional.min} to ${spec.positional.max}`;
}

/** Whether this token counts as a flag (a negative number like `-1` is a value, not a flag). */
function looksLikeFlag(token) {
  return typeof token === 'string' && token.startsWith('-') && token.length > 1 && !/^-\d/.test(token);
}

/** Which known flag this token lands on; `null` when it is none. */
function flagNameOf(token, spec) {
  if (typeof token !== 'string' || !token.startsWith('--')) return null;
  const name = token.includes('=') ? token.slice(0, token.indexOf('=')) : token;
  for (const key of spec.options) {
    if (FLAGS[key].long === name) return key;
  }
  return null;
}

function inlineValueOf(token) {
  const at = token.indexOf('=');
  return at < 0 ? undefined : token.slice(at + 1);
}

// ═══ Small output pieces ═════════════════════════════════════════════════════

/**
 * One piece of output text: the two-space-indent form, and the compact form that folds the
 * separators into `", "` / `": "` (a structural comma is followed by a newline, while a comma inside
 * a string is followed by some other character, which is what makes the fold exact).
 */
function jsonText(value, indent = 2) {
  if (indent > 0) return `${JSON.stringify(value, null, indent).replace(/\n/g, EOL)}${EOL}`;
  const shaped = JSON.stringify(value, null, 1)
    .split(/,\r?\n\s*/)
    .join(', ')
    .split(/\r?\n\s*/)
    .join('');
  return `${shaped}${EOL}`;
}

function sortedCounts(counts) {
  const out = {};
  for (const key of Object.keys(counts).sort()) out[key] = counts[key];
  return out;
}

// ═══ One pool table → filtered / ranked / counted ════════════════════════════
// Every read verb is the same three moves over the same table: narrow it by the filters the caller
// gave, put the rows in one order, then print them (or count them). Each move is written once here and
// the verbs name it, so `list` and `search` cannot filter one record two ways.

/**
 * The vocabulary's default for a cell a hand-written record may leave out. One table, so a count, a
 * filter and a printed row cannot disagree about what an absent `severity` falls back to.
 */
export const CELL_FALLBACK = { severity: '?', status: '?', module: 'unknown', source: 'scan' };

/** One record's cell as every read prints it: the value it carries, or the vocabulary's default. A cell stated as null reads as the default too (`??`, not `=== undefined`), so `source: null` counts as `scan` everywhere the source is read. */
function cellOf(issue, field) {
  return issue[field] ?? CELL_FALLBACK[field];
}

/** The decision a record stands on: one not settled yet is `unknown`. */
function decisionOf(issue) {
  return issue.decision ?? 'unknown';
}

/** The filter set `list` and `search` share: each filter applies only when the caller spelled it. */
function filterIssues(issues, options) {
  let out = issues;
  if (options.status) out = out.filter((issue) => issue.status === options.status);
  if (options.severity) out = out.filter((issue) => issue.severity === options.severity);
  if (options.decision) out = out.filter((issue) => decisionOf(issue) === options.decision);
  if (options.source) out = out.filter((issue) => cellOf(issue, 'source') === options.source);
  if (options.module) out = out.filter((issue) => String(issue.module ?? '').includes(options.module));
  return out;
}

/** The order the reads start from: newest discovery first. */
function newestFirst(issues) {
  return [...issues].sort((a, b) => compareText(b.discovered, a.discovered));
}

/** One read's answer: the rows under the limit, printed in full or brief. */
function printed(issues, options) {
  const limit = options.limit ?? 0;
  const rows = limit > 0 ? issues.slice(0, limit) : issues;
  return options.brief ? jsonText(rows.map(briefIssue), 0) : jsonText(rows);
}

/** How many issues each value of one cell accounts for, keys sorted (the vocabulary's default is a cell of its own). */
function countsBy(issues, field) {
  const counts = {};
  for (const issue of issues) {
    const cell = cellOf(issue, field);
    counts[cell] = (counts[cell] ?? 0) + 1;
  }
  return sortedCounts(counts);
}

/** How often a scan must have seen an issue before it counts as stale: `status`'s ceiling and `stale`'s default, one number. */
const STALE_CHECK_COUNT = 3;

/** The issues at or over that ceiling: still pickable, and checked at least `threshold` times. */
function staleIssues(issues, threshold) {
  return issues.filter((issue) => PICKABLE.has(issue.status) && (issue.check_count ?? 0) >= threshold);
}

function briefIssue(issue) {
  return {
    id: issue.id,
    severity: cellOf(issue, 'severity'),
    status: cellOf(issue, 'status'),
    title: issue.title === undefined ? '' : issue.title,
  };
}

// ═══ Verbs ═══════════════════════════════════════════════════════════════════

async function cmdAdd(args, ctx) {
  if (args.options.from_file) return cmdAddFromFile(args, ctx);
  const uid = args.options.id;
  if (!uid) throw new UsageError('--id is required (or use --from-file for batch)');
  const data = readPool(ctx.root);
  if (Object.prototype.hasOwnProperty.call(data.issues, uid)) throw new Error(`issue "${uid}" already exists`);
  const record = buildIssueRecord(args.options, uid, now());
  if (record.plan_path) ensurePlanDir(ctx.root, record.plan_path);
  data.issues[uid] = record;
  await writePool(ctx.root, data);
  const lines = [`Issue created: ${uid}`];
  if (record.plan_path) lines.push(`Plan path (nonexistent): ${resolveFrom(ctx.root, record.plan_path)}`);
  return `${lines.join(EOL)}${EOL}`;
}

async function cmdAddFromFile(args, ctx) {
  const fromFile = resolveFrom(ctx.root, args.options.from_file);
  let batch;
  try {
    batch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(fromFile)));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(batch)) throw new Error('file must contain a JSON array');

  const out = [];
  // First pass: fill in the missing ids and build every record (each one goes through the content
  // checks on the spot).
  const data = readPool(ctx.root);
  const moment = now();
  const records = [];
  const named = new Set();
  for (let index = 0; index < batch.length; index += 1) {
    const item = batch[index];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`row ${index + 1} is not an object`);
    }
    const row = `row ${index + 1}`;
    let uid = item.id;
    if (!uid) {
      if (args.options.auto_id) {
        const base = autoId(item);
        uid = freeId(base, named);
        if (uid !== base) out.push(`Auto-id disambiguated: ${row} "${base}" -> "${uid}"`);
      } else {
        throw new Error(`${row} missing "id" field (use --auto-id to generate)`);
      }
    }
    named.add(uid);
    records.push(buildIssueRecord(item, uid, moment, `${row} (id=${uid}) `));
  }

  // Second pass: write them all down (every check has passed).
  let created = 0;
  let skipped = 0;
  for (const record of records) {
    if (Object.prototype.hasOwnProperty.call(data.issues, record.id)) {
      out.push(`Warning: issue "${record.id}" already exists, skipping`);
      skipped += 1;
      continue;
    }
    if (record.plan_path) ensurePlanDir(ctx.root, record.plan_path);
    data.issues[record.id] = record;
    created += 1;
  }
  await writePool(ctx.root, data);
  out.push(`Batch import: ${created} created, ${skipped} skipped`);
  return `${out.join(EOL)}${EOL}`;
}

async function cmdList(args, ctx) {
  const issues = filterIssues(Object.values(readPool(ctx.root).issues), args.options);
  const sevOrder = severityOrder();
  // A stable sort: newest discovery first, then by severity.
  const rows = stableSort(newestFirst(issues), (issue) => sevOrder[issue.severity] ?? 99);
  return printed(rows, args.options);
}

// ═══ Update: one patch, one record or a batch ════════════════════════════════

/** One update patch: the cells the argument surface or a batch row names; an absent cell stays out of the patch. */
function updatePatch(source) {
  const patch = {};
  for (const field of UPDATE_FIELDS) patch[field] = source[field];
  return patch;
}

/** Apply one patch to one record in memory: an empty `plan_path` clears that cell; the fields that really changed come back as a set. */
function applyUpdatePatch(issue, patch) {
  const changed = new Set();
  for (const field of UPDATE_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const before = issue[field];
    issue[field] = field === 'plan_path' ? (value ? value : null) : value;
    if (!valueEqual(before, issue[field])) changed.add(field);
  }
  return changed;
}

/** The plan directories a set of patches asks for: each distinct path once. */
function ensurePatchPlanDirs(root, patches) {
  const wanted = new Set();
  for (const patch of patches) {
    if (patch.plan_path) wanted.add(patch.plan_path);
  }
  for (const planPath of wanted) ensurePlanDir(root, planPath);
}

/** Read the JSON array a `--from-file` spelling names; the path resolves from the project root. */
function readRowsFile(root, spelling) {
  const path = resolveFrom(root, spelling);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(rows)) throw new Error('file must contain a JSON array');
  return rows;
}

/** One batch row's value checks, all ahead of any change: a single bad cell refuses the whole file. */
function validateUpdateRow(row, where) {
  const closed = { severity: VALID_SEVERITIES, decision: VALID_DECISIONS, status: VALID_STATUSES };
  for (const [field, valid] of Object.entries(closed)) {
    const value = row[field];
    if (value === undefined) continue;
    if (!valid.includes(value)) {
      throw new Error(`${where}: invalid ${field} "${value}", valid: ${[...valid].sort().join(', ')}`);
    }
  }
  for (const field of ['module', 'title', 'description', 'suggestion']) {
    const value = row[field];
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`${where}: "${field}" must be a string, got ${describe(value)}`);
    }
  }
  for (const field of ['reason', 'plan_path']) {
    const value = row[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      throw new Error(`${where}: "${field}" must be a string or null, got ${describe(value)}`);
    }
  }
  for (const field of ['files', 'functions']) {
    const value = row[field];
    if (value === undefined) continue;
    if (!Array.isArray(value)) throw new Error(`${where}: "${field}" must be a list, got ${describe(value)}`);
    if (value.some((entry) => typeof entry !== 'string')) {
      throw new Error(`${where}: "${field}" must hold strings`);
    }
  }
}

/** The per-id answer of an update batch: a changed record lists its cells, an unchanged one is named once. */
function updateLines(results) {
  const lines = [];
  for (const { id, changed } of results) {
    if (changed.size === 0) {
      lines.push(`No changes: ${id}`);
      continue;
    }
    lines.push(`Issue updated: ${id}`);
    for (const field of [...changed].sort()) lines.push(`  ~ ${field}`);
  }
  return lines;
}

/**
 * The ids one line names, each once and in the order given: `resolve a a` names one record, so it
 * answers one line and takes one write, the way `hold` treats a repeated id.
 */
function uniqueIds(positional) {
  const seen = new Set();
  const ids = [];
  for (const uid of positional) {
    if (seen.has(uid)) continue;
    seen.add(uid);
    ids.push(uid);
  }
  return ids;
}

async function cmdUpdate(args, ctx) {
  if (args.options.from_file !== undefined) return cmdUpdateFromFile(args, ctx);
  const data = readPool(ctx.root);
  const ids = uniqueIds(args.positional);
  const patch = updatePatch(args.options);
  for (const uid of ids) get(uid, data);
  const moment = now();
  ensurePatchPlanDirs(ctx.root, [patch]);
  const results = [];
  for (const uid of ids) {
    const issue = get(uid, data);
    const changed = applyUpdatePatch(issue, patch);
    if (changed.size > 0) issue.updated_at = moment;
    results.push({ id: uid, changed });
  }
  const changedCount = results.filter((entry) => entry.changed.size > 0).length;
  if (changedCount === 0) return `No changes specified${EOL}`;
  await writePool(ctx.root, data);
  return `${updateLines(results).join(EOL)}${EOL}`;
}

async function cmdUpdateFromFile(args, ctx) {
  if (args.positional.length > 0) throw new Error('--from-file carries its own ids; drop the positional arguments');
  for (const field of UPDATE_FIELDS) {
    if (args.options[field] !== undefined) {
      throw new Error(`--from-file carries its own fields; drop ${FLAGS[field].long}`);
    }
  }
  const rows = readRowsFile(ctx.root, args.options.from_file);
  const data = readPool(ctx.root);
  const allowed = new Set(['id', ...UPDATE_FIELDS]);
  const entries = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const where = `row ${index + 1}`;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${where} is not an object`);
    }
    for (const key of Object.keys(row)) {
      if (!allowed.has(key)) throw new Error(`${where}: unknown field "${key}"`);
    }
    const uid = row.id;
    if (typeof uid !== 'string' || uid.trim() === '') throw new Error(`${where} missing "id" field`);
    get(uid, data);
    validateUpdateRow(row, where);
    entries.push({ id: uid, patch: updatePatch(row) });
  }
  const moment = now();
  ensurePatchPlanDirs(ctx.root, entries.map((entry) => entry.patch));
  const results = [];
  for (const entry of entries) {
    const issue = get(entry.id, data);
    const changed = applyUpdatePatch(issue, entry.patch);
    if (changed.size > 0) issue.updated_at = moment;
    results.push({ id: entry.id, changed });
  }
  const changedCount = results.filter((entry) => entry.changed.size > 0).length;
  const lines = changedCount === 0 ? ['No changes specified'] : updateLines(results);
  lines.push(`Batch update: ${changedCount} updated, ${results.length - changedCount} unchanged`);
  if (changedCount > 0) await writePool(ctx.root, data);
  return `${lines.join(EOL)}${EOL}`;
}

async function cmdResolve(args, ctx) {
  const data = readPool(ctx.root);
  const ids = uniqueIds(args.positional);
  for (const uid of ids) get(uid, data);
  const moment = now();
  if (args.options.plan_path) ensurePlanDir(ctx.root, args.options.plan_path);
  const lines = [];
  for (const uid of ids) {
    const issue = get(uid, data);
    issue.status = 'resolved';
    issue.reason = args.options.reason ? args.options.reason : issue.reason;
    issue.updated_at = moment;
    if (args.options.plan_path) issue.plan_path = args.options.plan_path;
    lines.push(`Issue resolved: ${uid}`);
  }
  await writePool(ctx.root, data);
  return `${lines.join(EOL)}${EOL}`;
}

async function cmdReject(args, ctx) {
  if (!args.options.reason) throw new UsageError('--reason is required for reject');
  const data = readPool(ctx.root);
  const ids = uniqueIds(args.positional);
  for (const uid of ids) get(uid, data);
  const moment = now();
  const lines = [];
  for (const uid of ids) {
    const issue = get(uid, data);
    issue.status = 'rejected';
    issue.reason = args.options.reason;
    issue.updated_at = moment;
    lines.push(`Issue rejected: ${uid}`);
  }
  await writePool(ctx.root, data);
  return `${lines.join(EOL)}${EOL}`;
}

async function cmdAcknowledge(args, ctx) {
  const data = readPool(ctx.root);
  const ids = uniqueIds(args.positional);
  for (const uid of ids) get(uid, data);
  const moment = now();
  const lines = [];
  for (const uid of ids) {
    const issue = get(uid, data);
    issue.status = 'acknowledged';
    issue.reason = args.options.reason ? args.options.reason : issue.reason;
    issue.updated_at = moment;
    lines.push(`Issue acknowledged: ${uid}`);
  }
  await writePool(ctx.root, data);
  return `${lines.join(EOL)}${EOL}`;
}

async function cmdRemove(args, ctx) {
  const data = readPool(ctx.root);
  const ids = uniqueIds(args.positional);
  for (const uid of ids) get(uid, data);
  const lines = [];
  for (const uid of ids) {
    delete data.issues[uid];
    lines.push(`Issue removed: ${uid}`);
  }
  await writePool(ctx.root, data);
  return `${lines.join(EOL)}${EOL}`;
}

/** The pool's reading of "not settled yet": `weight` and `status` both count these. */
const OWED = new Set(['open', 'acknowledged', 'resolving']);
/** Still pickable: `top` / `by-module` / `stale` list only these (`resolving` is already in someone's hands). */
const PICKABLE = new Set(['open', 'acknowledged']);

async function cmdStatus(args, ctx) {
  const all = Object.values(readPool(ctx.root).issues);
  const issues = args.options.verbose ? all : all.filter((issue) => OWED.has(issue.status));
  const result = {
    by_severity: countsBy(issues, 'severity'),
    by_status: countsBy(issues, 'status'),
    by_module: countsBy(issues, 'module'),
    by_source: countsBy(issues, 'source'),
    stale: staleIssues(all, STALE_CHECK_COUNT).length,
  };
  if (args.options.verbose) result.total = all.length;
  return jsonText(result);
}

/** The pool's own split of the work that is still outstanding: all of it, and the part somebody here can pay. */
function payableOf(data) {
  const actionable = Object.values(data.issues).filter((issue) => OWED.has(issue.status));
  return {
    actionable,
    payable: actionable.filter((issue) => decisionOf(issue) !== 'external'),
  };
}

/** The weight formula: the severity weights of the payable half, summed. */
function weightOf(issues) {
  return issues.reduce((sum, issue) => sum + (SEVERITY_WEIGHTS[issue.severity] ?? 0), 0);
}

/**
 * How heavy this pool is, computed here for whoever asks the reading: the same walk `issue weight`
 * prints its number from, so a caller that computes an offer reads the pool instead of reading a
 * printed line back. It throws exactly what `readPool` throws (an unreadable pool is "not known this
 * pass", never 0).
 */
export function poolWeight(root) {
  return weightOf(payableOf(readPool(root)).payable);
}

async function cmdWeight(args, ctx) {
  const data = readPool(ctx.root);
  const { actionable, payable } = payableOf(data);
  const weight = weightOf(payable);
  if (!args.options.verbose) return `${weight}${EOL}`;
  const heldBack = actionable.filter((issue) => decisionOf(issue) === 'external');
  return jsonText({
    weight,
    counted: payable.length,
    by_severity: countsBy(payable, 'severity'),
    not_counted_external: heldBack.length,
    not_counted_external_weight: weightOf(heldBack),
  });
}

async function cmdTop(args, ctx) {
  const pickable = Object.values(readPool(ctx.root).issues).filter((issue) => PICKABLE.has(issue.status));
  const sevOrder = severityOrder();
  const rows = stableSort(
    newestFirst(pickable),
    (issue) => [sevOrder[issue.severity] ?? 99, issue.status === 'open' ? 0 : 1],
  );
  return printed(rows, {
    limit: args.options.limit === undefined ? 5 : args.options.limit,
    brief: args.options.brief,
  });
}

async function cmdByModule(args, ctx) {
  const data = readPool(ctx.root);
  const modules = {};
  for (const issue of Object.values(data.issues)) {
    if (!PICKABLE.has(issue.status)) continue;
    const module = cellOf(issue, 'module');
    if (modules[module] === undefined) modules[module] = [];
    modules[module].push(issue);
  }
  return jsonText(modules);
}

async function cmdStale(args, ctx) {
  const data = readPool(ctx.root);
  const threshold = args.options.threshold === undefined ? STALE_CHECK_COUNT : args.options.threshold;
  const stale = staleIssues(Object.values(data.issues), threshold);
  return jsonText(stableSort(stale, (issue) => -(issue.check_count ?? 0)));
}

async function cmdMark(args, ctx) {
  const data = readPool(ctx.root);
  const wanted = new Set(args.positional.filter((id) => id && id.trim() !== ''));
  const moment = now();
  const marked = [];
  const unknown = [];
  for (const uid of [...wanted].sort()) {
    const issue = data.issues[uid];
    if (issue === undefined) {
      unknown.push(uid);
      continue;
    }
    issue.check_count = (issue.check_count ?? 0) + 1;
    issue.updated_at = moment;
    marked.push(uid);
  }
  const markedSet = new Set(marked);
  const candidates = Object.values(data.issues)
    .filter((issue) => issue.status === 'open' && !markedSet.has(issue.id))
    .sort((a, b) => compareText(a.id ?? '', b.id ?? ''));
  await writePool(ctx.root, data);
  return jsonText({
    marked,
    unknown_ids: unknown,
    candidates: candidates.map((issue) => ({
      id: issue.id,
      severity: issue.severity,
      title: issue.title,
      discovered: issue.discovered,
    })),
    note: ('candidates are advisory only: issues this scan did not '
      + 'confirm. Freshly added ones are unmarked by definition. '
      + 'Resolve individually and only with concrete evidence.'),
  });
}

async function cmdOpenPlan(args, ctx) {
  const data = readPool(ctx.root);
  const uid = args.positional[0];
  const issue = get(uid, data);
  if (!issue.plan_path) throw new Error(`Issue "${uid}" has no plan_path set`);
  return `${resolveFrom(ctx.root, issue.plan_path)}${EOL}`;
}

async function cmdSearch(args, ctx) {
  const data = readPool(ctx.root);
  const issues = filterIssues(Object.values(data.issues), args.options);

  let pattern;
  try {
    pattern = new RegExp(args.positional[0], 'i');
  } catch (error) {
    throw new UsageError(`invalid regex: ${error instanceof Error ? error.message : String(error)}`);
  }

  const tier1 = [];
  const tier2 = [];
  const tier3 = [];
  for (const issue of issues) {
    const uid = issue.id ?? '';
    const title = issue.title ?? '';
    const description = issue.description ?? '';
    const suggestion = issue.suggestion ?? '';
    const module = issue.module ?? '';
    const files = Array.isArray(issue.files) ? issue.files : [];
    const functions = Array.isArray(issue.functions) ? issue.functions : [];

    const idHit = pattern.test(uid);
    const titleHit = pattern.test(title);
    const descriptionHit = pattern.test(description);
    const suggestionHit = pattern.test(suggestion);
    const moduleHit = pattern.test(module);
    const filesHit = files.some((entry) => pattern.test(entry));
    const functionsHit = functions.some((entry) => pattern.test(entry));

    const base = {
      id: uid,
      title,
      severity: cellOf(issue, 'severity'),
      status: cellOf(issue, 'status'),
    };
    if (idHit || titleHit) {
      base.match = idHit ? 'id' : 'title';
      if (description) base.description = description;
      tier1.push(base);
    } else if (descriptionHit || suggestionHit) {
      const field = descriptionHit ? 'description' : 'suggestion';
      const text = descriptionHit ? description : suggestion;
      base.match = field;
      const count = text ? countMatches(pattern, text) : 0;
      base.snippet = count >= 2 ? text : snippetOf(pattern, text);
      tier2.push(base);
    } else if (moduleHit || filesHit || functionsHit) {
      if (moduleHit) {
        base.match = 'module';
        base.value = module;
      } else if (filesHit) {
        base.match = 'files';
        base.value = files.find((entry) => pattern.test(entry));
      } else {
        base.match = 'functions';
        base.value = functions.find((entry) => pattern.test(entry));
      }
      tier3.push(base);
    }
  }
  const limit = args.options.limit === undefined ? 10 : args.options.limit;
  return printed([...tier1, ...tier2, ...tier3], { limit });
}

async function cmdExportPlan(args, ctx) {
  const data = readPool(ctx.root);
  const ids = args.positional;
  if (ids.length === 0) throw new Error('specify issue IDs to export');
  const sevOrder = severityOrder();
  const issues = stableSort(
    ids.map((uid) => get(uid, data)),
    (issue) => [sevOrder[String(issue.severity ?? '').toUpperCase()] ?? 99, issue.discovered ?? ''],
  );
  const lines = ['# Execution Plan\n'];
  for (const issue of issues) {
    const severity = cellOf(issue, 'severity');
    const module = issue.module ? issue.module : '?';
    lines.push(`## ${issue.id}  (${severity})`);
    if (module) lines.push(`Module: ${module}`);
    if (Array.isArray(issue.functions) && issue.functions.length > 0) {
      lines.push(`Functions: ${issue.functions.join(', ')}`);
    }
    if (Array.isArray(issue.files) && issue.files.length > 0) lines.push(`Files: ${issue.files.join(', ')}`);
    if (issue.description) lines.push(`Desc: ${issue.description}`);
    if (issue.suggestion) lines.push(`Suggested: ${issue.suggestion}`);
    if (issue.plan_path) {
      const resolved = resolveFrom(ctx.root, issue.plan_path);
      lines.push(`Plan: ${resolved}`);
      if (existsSync(resolved)) {
        try {
          lines.push('');
          lines.push(readFileSync(resolved, 'utf8'));
        } catch (error) {
          lines.push(`  (error reading plan: ${error instanceof Error ? error.message : String(error)})`);
        }
      }
    }
    lines.push('');
  }
  lines.push('---');
  lines.push(`Total: ${issues.length} issue(s)`);
  return `${lines.join(EOL)}${EOL}`;
}

// ═══ Small helpers ═══════════════════════════════════════════════════════════

/** The severity order: P0 is the heaviest; anything not in the table sorts last. */
function severityOrder() {
  const out = {};
  [...VALID_SEVERITIES].sort().forEach((severity, index) => {
    out[severity] = index;
  });
  return out;
}

function compareText(left, right) {
  const a = String(left ?? '');
  const b = String(right ?? '');
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A stable sort: ordered by key, items with the same key keeping their original order. */
function stableSort(items, keyOf) {
  return items
    .map((item, index) => ({ item, index, key: keyOf(item) }))
    .sort((a, b) => compareKeys(a.key, b.key) || a.index - b.index)
    .map((cell) => cell.item);
}

function compareKeys(left, right) {
  const a = Array.isArray(left) ? left : [left];
  const b = Array.isArray(right) ? right : [right];
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const one = a[index];
    const two = b[index];
    if (typeof one === 'string' || typeof two === 'string') {
      const diff = compareText(one, two);
      if (diff !== 0) return diff;
      continue;
    }
    const diff = (one ?? 0) - (two ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function snippetOf(pattern, text) {
  const found = pattern.exec(text);
  if (found === null) return text;
  const position = found.index;
  const PAD = 20;
  const start = Math.max(0, position - PAD);
  const end = Math.min(text.length, position + PAD);
  let out = text.slice(start, end);
  if (start > 0) out = `...${out}`;
  if (end < text.length) out = `${out}...`;
  return out;
}

function countMatches(pattern, text) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const global = new RegExp(pattern.source, flags);
  let count = 0;
  let found;
  while ((found = global.exec(text)) !== null) {
    count += 1;
    if (found[0] === '') global.lastIndex += 1;
  }
  return count;
}

// ═══ The command surface ═════════════════════════════════════════════════════

const RUNNERS = {
  add: cmdAdd,
  list: cmdList,
  update: cmdUpdate,
  resolve: cmdResolve,
  reject: cmdReject,
  acknowledge: cmdAcknowledge,
  remove: cmdRemove,
  'open-plan': cmdOpenPlan,
  status: cmdStatus,
  weight: cmdWeight,
  top: cmdTop,
  'by-module': cmdByModule,
  stale: cmdStale,
  mark: cmdMark,
  search: cmdSearch,
  'export-plan': cmdExportPlan,
};

/**
 * The verbs whose "read → change → write" runs exclusively in this process (`add` covers the batch
 * file too, and `update` may decide to write nothing — held either way, it is one command's turn).
 * One process can run two commands at once; a body that read the pool before another body's write
 * landed would write that write back out of the pool, so the writers queue. The reading verbs stay
 * out of the queue: a write lands atomically, so a read never needs the lock and must not wait
 * behind a write.
 */
const WRITING_VERBS = new Set(['add', 'update', 'resolve', 'reject', 'acknowledge', 'remove', 'mark']);

/** The usage spelling of one flag (help and parsing use the same table). */
function flagUsage(key) {
  const cell = FLAGS[key];
  const short = cell.short === undefined ? '' : `${cell.short}|`;
  const tail = cell.kind === 'flag' ? '' : cell.kind === 'int' ? ' <n>' : ' <value>';
  return `[${short}${cell.long}${tail}]`;
}

/** The `issue help` list: the verbs and their flags, derived from the command surface's single table, with an old spelling named on the row it still routes to. */
export function usage() {
  const rows = Object.keys(SPECS).map((word) => {
    const positional = SPECS[word].positional.min === 0
      ? ''
      : SPECS[word].positional.min === SPECS[word].positional.max
        ? ' <id>'
        : ' <id…>';
    const flags = SPECS[word].options.map(flagUsage).join(' ');
    const alias = Object.keys(VERB_ALIASES).find((spoken) => VERB_ALIASES[spoken] === word);
    return `  ${word}${positional}${flags.length > 0 ? ` ${flags}` : ''}`
      + `${alias === undefined ? '' : `   (also answers as \`${alias}\`)`}`;
  });
  return [
    USAGE_HEAD,
    '',
    'the issue pool: one file per project, `<root>/.pf/issues/issues.json`.',
    '',
    ...rows,
    '',
  ].join(EOL);
}

/**
 * The command's entry point: the first entry of argv is the verb (the declaration says `keep_name: false`, so the host takes the command word off).
 *
 * A help flag in the last cell — exactly `--help` or `-h`, with something before it — asks the same
 * page the first-cell spelling asks. A help flag anywhere else is not that request: it reaches the
 * verb's parser like any other token, and a value-taking flag before it takes it as that value. A
 * value that must end the line with the flag's own spelling is attached instead: `--reason=--help`.
 */
export async function main(argv, ctx) {
  const args = [...argv];
  if (args.length === 0) return usage();
  const spoken = args[0];
  if (spoken === 'help' || spoken === '--help' || spoken === '-h') return usage();
  // An old underscore spelling is the same verb: the canonical name is what the tables and the help
  // page are keyed by, so the rest of this function never hears the alias.
  const word = VERB_ALIASES[spoken] ?? spoken;
  const runner = RUNNERS[word];
  if (runner === undefined) throw new UsageError(`unrecognized command "${spoken}" (run \`issue help\`)`);
  // A trailing help flag is the help request: the last cell is exactly `--help` or `-h`, with something before it.
  if (args.length > 1 && (args[args.length - 1] === '--help' || args[args.length - 1] === '-h')) return usage();
  const spec = SPECS[word];
  const parsed = parseArgs(normalizeShortFlags(args.slice(1), spec), spec);
  if (WRITING_VERBS.has(word)) return withPoolLock(ctx.root, () => runner(parsed, ctx));
  return runner(parsed, ctx);
}