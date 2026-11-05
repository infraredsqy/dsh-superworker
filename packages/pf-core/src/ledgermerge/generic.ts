/**
 * The shared foundation of the three-way merge: the three-way decision, the field-by-field walk of one record, the
 * entry-by-entry walk of one table, the union rules of append-style records, and the two questions "which record is
 * this" and "how does a decision get said out loud".
 *
 * Nothing here knows the fields of any one record; the four engines beside it are the ones that recognise fields.
 *
 * The decision reading (fixed point by point):
 *
 *   ours == theirs          both sides agree, take it, not a problem
 *   ours == base            only the other side changed it, take the other side
 *   theirs == base          only this side changed it, take this side
 *   both changed, differently  `UNDECIDED`, the engine sets the rule, and with no rule it records a conflict for a
 *                              person to judge
 *
 * A record becomes a problem only when both sides changed the same field to two different values: a field only one
 * side touched is asked about by nobody.
 */

/** The kind words of a record: graph (nodes) / lines / instructions / handoff ticket. */
export const KIND_IDEAS = 'ideas';
export const KIND_STATE = 'state';
export const KIND_INSTRUCTIONS = 'instructions';
export const KIND_SIGNAL = 'signal';

/** A file other than these four records is never touched by the driver. */
export type MergeKind =
  | typeof KIND_IDEAS
  | typeof KIND_STATE
  | typeof KIND_INSTRUCTIONS
  | typeof KIND_SIGNAL;

/** The three outcomes the driver hands back: merged / needs a person / a usage or read error. */
export const EXIT_OK = 0;
export const EXIT_CONFLICT = 1;
export const EXIT_USAGE = 2;

/** This key is not in the record at all. JSON's null is a legitimate value (`cycle` and `resolved_at` are null most of the time). */
export const MISSING: unique symbol = Symbol('pf.merge.missing');
export type Missing = typeof MISSING;

/** One side deleted this entry: it only appears as a value on a conflict line. */
export const DELETED: unique symbol = Symbol('pf.merge.deleted');
export type Deleted = typeof DELETED;

/** The "cannot tell" the three-way decision hands back. It, too, must not be mixed up with null. */
export const UNDECIDED: unique symbol = Symbol('pf.merge.undecided');
export type Undecided = typeof UNDECIDED;

/** How one record table reads: identity → entry, keeping the on-disk order. */
export type EntryIndex = Map<string, unknown>;

/** The judge of one field in one record: it takes the three sides' values and hands back the winner (or `MISSING`: this key is dropped). */
export type FieldResolver = (
  key: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
) => unknown;

/** The judge of one entry in one table. `label` is the name used on the conflict line. */
export type EntryResolver = (
  label: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
) => unknown;

/** Read one on-disk table as "identity → entry"; a shape it cannot recognise reads as an empty table. */
export type IndexReader = (value: unknown) => EntryIndex;

// ═══════════════════════════════════════════════════════════════════════════════
//  which record this is
// ═══════════════════════════════════════════════════════════════════════════════

/** Collection key → kind: when the file name cannot be recognised, the shape is what recognises it. */
const COLLECTION_KINDS: ReadonlyArray<readonly [string, MergeKind]> = [
  ['nodes', KIND_IDEAS],
  ['cycles', KIND_STATE],
  ['instructions', KIND_INSTRUCTIONS],
];

/**
 * Which record a path is, recognised by file name.
 *
 * `name` is git's `%P` (the path in the repository, carried as the fourth argument by the driver configuration) or
 * the real path when a person runs it by hand. Handoff tickets are kept in `signals/<line>/<node>.json`, recognised
 * by directory name.
 */
export function kindOf(name: string | null | undefined): MergeKind | null {
  if (name === null || name === undefined || name === '') return null;
  const parts = String(name).replace(/\\/g, '/').split('/');
  const base = parts[parts.length - 1] ?? '';
  if (base === 'ideas.json') return KIND_IDEAS;
  if (base === 'state.json') return KIND_STATE;
  if (base === 'instructions.json') return KIND_INSTRUCTIONS;
  if (base.endsWith('.json') && parts.slice(0, -1).includes('signals')) return KIND_SIGNAL;
  return null;
}

/**
 * The record's own shape, for the occasions when there is no file name to recognise.
 *
 * Under git there often is no name: `%O`/`%A`/`%B` are its temporary files. The three collection files each carry
 * that collection key, so they cannot be mistaken; a handoff ticket is the one record that "has a status and no
 * collection underneath". Everything else is refused, not guessed.
 */
export function kindFromShape(...sides: unknown[]): MergeKind | null {
  for (const data of sides) {
    if (!isRecord(data)) continue;
    for (const [key, kind] of COLLECTION_KINDS) {
      if (key in data) return kind;
    }
  }
  for (const data of sides) {
    if (isRecord(data) && data['status'] && ('timestamp' in data || 'outputs' in data)) {
      return KIND_SIGNAL;
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  how a decision gets said out loud
// ═══════════════════════════════════════════════════════════════════════════════

/** The verdict of one merge: the decisions said to a person (the ones `--dry-run` prints) and the conflict lines (which always go to stderr). */
export class MergeReport {
  readonly kind: MergeKind;
  readonly path: string;
  readonly decisions: string[] = [];
  readonly conflicts: string[] = [];

  constructor(kind: MergeKind, path: string) {
    this.kind = kind;
    this.path = displayPath(path);
  }

  decide(what: string): void {
    this.decisions.push(`  ${what}`);
  }

  conflict(entry: string, field: string, ours: unknown, theirs: unknown, note = ''): void {
    const tail = note ? ` (${note})` : '';
    this.conflicts.push(
      `merge-ledger: conflict [${this.path}] ${entry} field ${field}: ` +
        `ours=${fmt(ours)} theirs=${fmt(theirs)}${tail}`,
    );
  }
}

/** How a path is spelled in the verdict: forward slashes, a question mark by default. */
export function displayPath(path: string | null | undefined): string {
  return path ? String(path).replace(/\\/g, '/') : '?';
}

/** How a value is said on a conflict line: a missing key, a deletion, or its JSON. */
export function fmt(value: unknown): string {
  if (value === MISSING) return '<no such field>';
  if (value === DELETED) return '<deleted on this side>';
  const text = JSON.stringify(value) ?? String(value);
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

/** The name of one record on a conflict line. */
export function entryLabel(kind: MergeKind, key: string): string {
  if (kind === KIND_IDEAS) return `Node ${key.slice(0, 8)}`;
  if (kind === KIND_STATE) return `cycle '${key}'`;
  if (kind === KIND_INSTRUCTIONS) return `instruction ${key}`;
  return 'note';
}

// ═══════════════════════════════════════════════════════════════════════════════
//  the three-way decision
// ═══════════════════════════════════════════════════════════════════════════════

/** A JSON object: records and entries both look like this (arrays and null are counted separately). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Use a record as a dictionary: hand back an empty record when there is no object in hand. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Take one field; when the key is not there it is `MISSING` (an explicit null is a legitimate value). */
export function get(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) return MISSING;
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : MISSING;
}

/** Whether two on-disk values are equal: objects and arrays are compared by content, and key order is not a difference. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === MISSING || b === MISSING || a === DELETED || b === DELETED) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameValue(item, b[index]));
  }
  if (isRecord(a) && isRecord(b)) {
    const aKeys = Object.keys(a);
    if (aKeys.length !== Object.keys(b).length) return false;
    return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]));
  }
  return false;
}

/**
 * The first half every engine shares: `UNDECIDED` means the two sides really did change the same field to two
 * values. A field only one side changed is asked about by nobody.
 */
export function threeWay(
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
): unknown {
  if (sameValue(oursValue, theirsValue)) return oursValue;
  if (sameValue(oursValue, baseValue)) return theirsValue;
  if (sameValue(theirsValue, baseValue)) return oursValue;
  return UNDECIDED;
}

/** Did both sides change this field to different values? */
export function bothChanged(baseValue: unknown, oursValue: unknown, theirsValue: unknown): boolean {
  return threeWay(baseValue, oursValue, theirsValue) === UNDECIDED;
}

/** Text comparison: timestamps and ids are ASCII, so comparing by code point is comparing as strings. */
function compareText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** The merged key order: this side's order, followed by the keys only the other side has. */
export function keyOrder(...objs: unknown[]): string[] {
  const out: string[] = [];
  for (const obj of objs) {
    if (!isRecord(obj)) continue;
    for (const key of Object.keys(obj)) {
      if (!out.includes(key)) out.push(key);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  one record, one table
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * One record, field by field.
 *
 * `resolve` judges one ordinary field; a field it answers `MISSING` for is absent by design: either one side
 * deleted the key, or the rule declined to judge it.
 */
export function mergeMapping(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  resolve: FieldResolver,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keyOrder(ours, theirs)) {
    const value = resolve(key, get(base, key), get(ours, key), get(theirs, key));
    if (value !== MISSING) out[key] = value;
  }
  return out;
}

/**
 * One table, three-way merged entry by entry: the union of keys, keeping this side's order.
 *
 * A key only one side has is taken whole from that side — there is no field on the other side to compare.
 *
 * `propagateDelete` decides **what an absence means**. With it off (lines, instructions) an absence is "this side
 * never had it": the entry comes back, because neither side's engine has a command that deletes it, so reviving it
 * costs nothing. With it on (the graph: `ledger.dag.remove` is a command a person really uses) base decides:
 *
 *   base has it, one side deleted it, the other left it alone   -> deleted (not in the result)
 *   base has it, one side deleted it, the other edited it       -> a conflict (delete vs edit)
 *   base never had it                                           -> the side that has it added it
 *   both sides deleted it                                       -> deleted
 */
export function mergeEntries(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
  resolveEntry: EntryResolver,
  indexOf: IndexReader,
  propagateDelete = false,
): EntryIndex {
  const baseIndex = indexOf(base);
  const oursIndex = indexOf(ours);
  const theirsIndex = indexOf(theirs);
  const merged: EntryIndex = new Map();
  const keys = [...oursIndex.keys()];
  for (const key of theirsIndex.keys()) {
    if (!oursIndex.has(key)) keys.push(key);
  }
  for (const key of keys) {
    const label = entryLabel(report.kind, key);
    if (oursIndex.has(key) && theirsIndex.has(key)) {
      merged.set(
        key,
        resolveEntry(label, baseIndex.get(key), oursIndex.get(key), theirsIndex.get(key), report),
      );
    } else if (oursIndex.has(key)) {
      keepOrDelete(merged, key, label, baseIndex, oursIndex.get(key), report, propagateDelete, true);
    } else {
      keepOrDelete(merged, key, label, baseIndex, theirsIndex.get(key), report, propagateDelete, false);
    }
  }
  if (propagateDelete) {
    for (const key of baseIndex.keys()) {
      if (!oursIndex.has(key) && !theirsIndex.has(key)) {
        report.decide(
          `${entryLabel(report.kind, key)}: both sides deleted it -> drop it from the result`,
        );
      }
    }
  }
  return merged;
}

/** An entry only one side has: either an addition, or a deletion the other side has to answer. */
function keepOrDelete(
  merged: EntryIndex,
  key: string,
  label: string,
  baseIndex: EntryIndex,
  survivor: unknown,
  report: MergeReport,
  propagateDelete: boolean,
  oursSide: boolean,
): void {
  const side = oursSide ? 'ours' : 'theirs';
  const other = oursSide ? 'theirs' : 'ours';
  const fromBase = baseIndex.get(key);
  if (!propagateDelete || fromBase === undefined) {
    report.decide(`${label}: only ${side} has it -> take ${side}`);
    merged.set(key, survivor);
    return;
  }
  if (sameValue(survivor, fromBase)) {
    report.decide(
      `${label}: ${other} deleted it, ${side} left it alone -> deleted (drop it from the result)`,
    );
    return;
  }
  report.conflict(
    label,
    '(the whole record)',
    survivor,
    DELETED,
    `${other} deleted it, ${side} edited it: delete vs edit collided`,
  );
  merged.set(key, survivor);
}

/**
 * One record file as a whole: the collection key is walked entry by entry, the remaining fields follow the ordinary
 * rules.
 *
 * `key` is this file's collection key (`nodes` / `cycles` / `instructions`), `indexOf` reads that field as
 * "identity → entry", `asList` says whether the merged result has to be turned back into a list when written,
 * `propagateDelete` belongs to `mergeEntries`, and `after` is what still has to be checked once the whole result is
 * there (the graph's dangling dependencies).
 */
export interface MergeCollectionOptions {
  readonly key: string;
  readonly resolveEntry: EntryResolver;
  readonly indexOf: IndexReader;
  readonly propagateDelete?: boolean;
  readonly asList?: boolean;
  readonly after?: (
    merged: Record<string, unknown>,
    ours: unknown,
    theirs: unknown,
    report: MergeReport,
  ) => void;
}

export function mergeCollection(
  label: string,
  base: unknown,
  ours: unknown,
  theirs: unknown,
  report: MergeReport,
  options: MergeCollectionOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of keyOrder(ours, theirs)) {
    if (field === options.key) {
      const entries = mergeEntries(
        get(base, field),
        get(ours, field),
        get(theirs, field),
        report,
        options.resolveEntry,
        options.indexOf,
        options.propagateDelete === true,
      );
      out[field] = options.asList === true ? [...entries.values()] : Object.fromEntries(entries);
    } else {
      out[field] = plainField(
        label,
        field,
        get(base, field),
        get(ours, field),
        get(theirs, field),
        report,
      );
    }
  }
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(out)) {
    if (value !== MISSING) merged[key] = value;
  }
  options.after?.(merged, ours, theirs, report);
  return merged;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  the field rules
// ═══════════════════════════════════════════════════════════════════════════════

/** A field the rule table gives no rule for: only one side changed it, take that side; both changed it, and a person has to judge. */
export function plainField(
  label: string,
  key: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  const note =
    baseValue === MISSING
      ? 'both sides added this entry, with different content'
      : 'both sides changed this field and the rule table has no basis for trimming it';
  report.conflict(label, key, oursValue, theirsValue, note);
  return MISSING;
}

/** A metadata timestamp (`updated_at` / `created_at`): the other side's value must not be lost, so the later or the earlier one is taken. */
export function stampField(
  label: string,
  key: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
  pick: 'max' | 'min',
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  if (typeof oursValue !== 'string' || typeof theirsValue !== 'string') {
    report.conflict(
      label,
      key,
      oursValue,
      theirsValue,
      'the timestamp is not a string; cannot pick one',
    );
    return MISSING;
  }
  const keepOurs = pick === 'max' ? oursValue >= theirsValue : oursValue <= theirsValue;
  return keepOurs ? oursValue : theirsValue;
}

/** The rule on one field of an append-style record: when one side is a prefix of the other take the longer one, when both have tails take the union, and when the same thing disagrees it is a conflict. */
export interface ExtendOrUnionOptions {
  /** What makes two elements **the same thing** (in the line account it is the node id). */
  readonly identity: (mark: Record<string, unknown>) => unknown;
  /** Whether two elements sharing one identity are the same act (the line's path compares `result` only). */
  readonly sameAct: (previous: Record<string, unknown>, mark: Record<string, unknown>) => boolean;
  /** What orders the two tails in the union (a timestamp). */
  readonly orderBy: (mark: Record<string, unknown>) => string;
  /** How that one disagreement is said out loud; both elements are records. */
  readonly sameNote?: (
    tag: string,
    previous: Record<string, unknown>,
    mark: Record<string, unknown>,
  ) => string;
}

export function extendOrUnion(
  label: string,
  key: string,
  baseValue: unknown,
  oursValue: unknown,
  theirsValue: unknown,
  report: MergeReport,
  options: ExtendOrUnionOptions,
): unknown {
  const got = threeWay(baseValue, oursValue, theirsValue);
  if (got !== UNDECIDED) return got;
  if (!Array.isArray(oursValue) || !Array.isArray(theirsValue)) {
    report.conflict(label, key, oursValue, theirsValue, 'not a list, cannot trim');
    return MISSING;
  }
  const ours = oursValue;
  const theirs = theirsValue;
  let shared = 0;
  while (shared < ours.length && shared < theirs.length && sameValue(ours[shared], theirs[shared])) {
    shared += 1;
  }
  if (shared === ours.length || shared === theirs.length) {
    const longer = ours.length >= theirs.length ? ours : theirs;
    report.decide(
      `${label}: ${key} one side is a prefix of the other -> take the longer one ` +
        `(${longer.length} items)`,
    );
    return longer;
  }
  const seen = new Map<string, Record<string, unknown>>();
  for (const mark of [...ours.slice(shared), ...theirs.slice(shared)]) {
    if (!isRecord(mark)) {
      report.conflict(
        label,
        key,
        oursValue,
        theirsValue,
        `an item in ${key} is not an object; cannot trim`,
      );
      return MISSING;
    }
    const tag = String(options.identity(mark));
    const previous = seen.get(tag);
    if (previous !== undefined && !options.sameAct(previous, mark)) {
      report.conflict(
        label,
        key,
        previous,
        mark,
        options.sameNote
          ? options.sameNote(tag, previous, mark)
          : 'the same item has different content on the two sides',
      );
      return MISSING;
    }
    if (previous === undefined) seen.set(tag, mark);
  }
  const tail = [...seen.values()].sort((left, right) =>
    compareText(options.orderBy(left), options.orderBy(right)),
  );
  report.decide(
    `${label}: ${key} both sides appended after the common prefix -> ` +
      `union ordered by stamp (${tail.length} items)`,
  );
  return [...ours.slice(0, shared), ...tail];
}
