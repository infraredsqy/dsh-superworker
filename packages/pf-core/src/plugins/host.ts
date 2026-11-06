import type { NormalizedOffer, PluginContext, PluginFolder, PluginTiming } from './types';
import { warnLine } from './context';
import { implOf, isEmptyObject, usable } from './registry';

/**
 * The two timings each ask their own question:
 *
 *     insertions(timing, ctx)   "is there anything to put into the graph now?" → a table of offers
 *     gates(timing, ctx)        "may the next step go?"                        → a table of reason sentences
 *
 * **Tolerant at runtime, strict in doctor.** A plugin that throws is not allowed to stop somebody else's
 * project: every failure turns into one WARNING line (data), that plugin produces nothing this round, and the
 * pipeline goes on as usual. `enable_knob` is gated here in one place: a switch that resolves to off skips this
 * plugin and nothing its implementation says counts; an unreadable switch counts as off — a plugin whose own
 * switch is broken is not a plugin that should be acting.
 *
 * An offer's shape is checked here, before the graph edit happens: a half offer that got into the edit would
 * only blow up in the edit once the close has landed, which is the one moment the pipeline cannot take back.
 * Each cell is checked by the type the edit will use, and one wrong cell spends this plugin's round (one
 * warning naming the cell), on the same footing as throwing.
 */

/** Whether a plugin is on this round: a plugin without an enable_knob is always on. */
async function enabled(folder: PluginFolder, ctx: PluginContext, warnings: string[]): Promise<boolean> {
  const key = (folder.decl as Record<string, unknown> | null)?.enable_knob;
  if (typeof key !== 'string' || key === '') return true;
  try {
    return (await ctx.knob(key)) !== 'off';
  } catch (error) {
    warnings.push(warnLine(folder.name, `could not read its switch ${JSON.stringify(key)}`, error));
    return false;
  }
}

/** Turn a shape-valid offer into the host's internal shape; one wrong cell spends this plugin's round (one warning). */
function normalizeOffer(plugin: string, offer: unknown, warnings: string[]): NormalizedOffer | null {
  if (offer === null || typeof offer !== 'object' || Array.isArray(offer)) {
    warnings.push(warnLine(plugin, 'returned an unusable offer', `an offer is an object, got ${describe(offer)}`));
    return null;
  }
  const cell = offer as Record<string, unknown>;

  const title = cell.title;
  if (typeof title !== 'string' || title.trim() === '') {
    warnings.push(warnLine(plugin, 'returned an unusable offer', `\`title\` must be a non-empty string, got ${JSON.stringify(title ?? null)}`));
    return null;
  }
  const specOf = cell.spec_of;
  if (typeof specOf !== 'function') {
    warnings.push(warnLine(plugin, 'returned an unusable offer', "`spec_of` must be a function that builds the node's text"));
    return null;
  }

  const rawTags = cell.tags;
  const tags: string[] = rawTags === undefined || rawTags === null
    ? []
    : Array.isArray(rawTags) && rawTags.every((tag) => typeof tag === 'string')
      ? (rawTags as string[])
      : [];
  const tagsUsable = rawTags === undefined || rawTags === null || tags.length > 0 || (Array.isArray(rawTags) && rawTags.length === 0);
  if (!tagsUsable) {
    // A single string would be read as a tag per character: refuse it instead of wrapping it — whoever writes
    // `"tags": "coding"` should see this line.
    warnings.push(warnLine(plugin, 'returned an unusable offer', `\`tags\` must be a list of strings, got ${JSON.stringify(rawTags)}`));
    return null;
  }

  const rawFields = cell.fields;
  const fields: Record<string, unknown> = rawFields === undefined || rawFields === null
    ? ({} as Record<string, unknown>)
    : (rawFields as Record<string, unknown>);
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    warnings.push(warnLine(plugin, 'returned an unusable offer', `\`fields\` must be an object, got ${JSON.stringify(fields)}`));
    return null;
  }

  const note = cell.note === undefined || cell.note === null ? '' : cell.note;
  if (typeof note !== 'string') {
    warnings.push(warnLine(plugin, 'returned an unusable offer', `\`note\` must be a string, got ${JSON.stringify(note)}`));
    return null;
  }
  const why = cell.why === undefined || cell.why === null ? '' : cell.why;
  if (typeof why !== 'string') {
    warnings.push(warnLine(plugin, 'returned an unusable offer', `\`why\` must be a string, got ${JSON.stringify(why)}`));
    return null;
  }

  return {
    plugin,
    title,
    tags,
    specOf: specOf as (nodeId: string) => string | Promise<string>,
    fields,
    note,
    why,
  };
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * The action's own keys: fields carrying any of these are taken off, one warning per key. The union comes from
 * two places: the cells of the offer shape on the TS side (title / spec_of / tags / fields / note / why /
 * steps), plus the same-named group in the action bag, `RESERVED_FIELDS` — fields are the plugin's own data, and
 * an offer that says `cycle` is pointing at another line, one that says `prompt` / `nodes` is pretending an
 * insertion is a dispatch, and `before_node` / `why` are how the action itself reads its destination.
 */
const RESERVED_FIELDS: ReadonlySet<string> = new Set([
  'title', 'spec_of', 'tags', 'fields', 'note', 'why', 'steps',
  'action', 'cycle', 'node_id', 'node_title', 'spec', 'add_command', 'commands',
  'insertions', 'before_node', 'before_title',
  'nodes', 'mode', 'prompt', 'prompt_text',
]);

/** The fields of one offer keep only its own data: the action's cells are taken off (one warning each). */
function ownFields(plugin: string, fields: Record<string, unknown>, warnings: string[]): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_FIELDS.has(key)) {
      warnings.push(warnLine(plugin, 'field is reserved', `${JSON.stringify(key)} is the action's own cell and was dropped`));
      continue;
    }
    kept[key] = value;
  }
  return kept;
}

/**
 * The entry the two questions share: filter plugins by timing and action, ask the switch, get the implementation,
 * call the door, and leave one line per failure.
 *
 * A rehearsal (`preview`) asks the door's own preview instead (`offer_preview` / `check_preview`). A plugin that
 * declares a timing but ships no preview is skipped for this round with one WARNING: it still runs at the real
 * timing, and the rehearsal says out loud which plugin it could not picture.
 */
async function askDoors(
  timing: PluginTiming,
  action: 'insert' | 'block',
  ctx: PluginContext,
  folders: readonly PluginFolder[],
  warnings: string[],
  preview = false,
): Promise<Array<{ folder: PluginFolder; answer: unknown }>> {
  const answers: Array<{ folder: PluginFolder; answer: unknown }> = [];
  const door = doorOf(action, preview);
  for (const folder of folders) {
    const decl = folder.decl;
    if (decl === null || !usable(folder)) continue;
    const record = decl as Record<string, unknown>;
    if (record.timing !== timing || record.action !== action) continue;
    if (!(await enabled(folder, ctx, warnings))) continue;
    const impl = await implOf(folder);
    if (impl === null) continue; // a load failure is already recorded in the runtime problem table, which doctor reports.
    const call = (impl as Record<string, unknown>)[door];
    if (typeof call !== 'function') {
      warnings.push(
        preview
          ? warnLine(
              folder.name,
              `has no ${door}()`,
              `a rehearsal cannot say what it would ${action === 'insert' ? 'insert' : 'hold back'} this round`,
            )
          : warnLine(folder.name, `has no ${door}()`, 'the timing it declares cannot be served'),
      );
      continue;
    }
    try {
      answers.push({ folder, answer: await (call as (ctx: PluginContext) => unknown)(ctx) });
    } catch (error) {
      warnings.push(warnLine(folder.name, 'failed', error));
    }
  }
  return answers;
}

/** The door of one action: the real one, or its rehearsal. */
function doorOf(action: 'insert' | 'block', preview: boolean): string {
  const base = action === 'insert' ? 'offer' : 'check';
  return preview ? `${base}_preview` : base;
}

/** The insertions every plugin wants at this timing, in registry order; the shape was checked here and the graph edit is landed by the caller. */
export async function collectOffers(
  timing: PluginTiming,
  ctx: PluginContext,
  folders: readonly PluginFolder[],
  warnings: string[],
  preview = false,
): Promise<NormalizedOffer[]> {
  const offers: NormalizedOffer[] = [];
  for (const { folder, answer } of await askDoors(timing, 'insert', ctx, folders, warnings, preview)) {
    // null / undefined / false / an empty object: "I have nothing to say this round", always a legitimate answer —
    // skipped silently, without a warning.
    if (answer === null || answer === undefined || answer === false || isEmptyObject(answer)) continue;
    const normalized = normalizeOffer(folder.name, answer, warnings);
    if (normalized !== null) offers.push(normalized);
  }
  return offers;
}

/** One reason sentence per plugin saying "not now"; an empty table is the green light. The gates combine with "and": any one saying no means no. */
export async function collectGates(
  timing: PluginTiming,
  ctx: PluginContext,
  folders: readonly PluginFolder[],
  warnings: string[],
  preview = false,
): Promise<string[]> {
  const reasons: string[] = [];
  for (const { folder, answer } of await askDoors(timing, 'block', ctx, folders, warnings, preview)) {
    // "Not this round" has to state a reason; ones that state none (null / false / an empty string / an object with
    // no own keys) are skipped silently — the same rule as collectOffers.
    if (answer === null || answer === undefined || answer === false || answer === '' || isEmptyObject(answer)) continue;
    if (typeof answer !== 'string') {
      warnings.push(warnLine(folder.name, 'returned an unusable reason', `a reason is prose, got ${describe(answer)}`));
      continue;
    }
    reasons.push(answer);
  }
  return reasons;
}

/** The fields version after the action's cells have been taken off cleanly (used when the insertion lands, travelling with the offer). */
export function fieldsForInsertion(offer: NormalizedOffer, warnings: string[]): Record<string, unknown> {
  return ownFields(offer.plugin, offer.fields, warnings);
}
