import type { NormalizedOffer, PluginContext, PluginFolder, PluginTiming } from './types';
import type { PluginAssembly } from './assembly';
import { warnLine } from './context';
import { usable } from './declare';
import { doorOf, doorWarningLine, noDoor, noneThisRound } from './doors';
import { implOf } from './scan';

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
 *
 * "None this round" is read from the door contract (`doors.ts`) — the same tolerance doctor's stand-in
 * question applies — so a plugin answering an empty table is silent at the real timing as well.
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
 * The names that may act this round: the usable plugins, worked out once per round. A caller that hands in
 * its assembly shares one answer for the whole round (the same picture its own folder scan gave); without
 * one, this answers from the folders in hand, once per call.
 */
async function availableNames(
  folders: readonly PluginFolder[],
  assembly: PluginAssembly | undefined,
): Promise<ReadonlySet<string>> {
  if (assembly !== undefined) return new Set((await assembly.available()).map((folder) => folder.name));
  return new Set(folders.filter((folder) => usable(folder)).map((folder) => folder.name));
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
  preview: boolean,
  available: ReadonlySet<string>,
): Promise<Array<{ folder: PluginFolder; answer: unknown }>> {
  const answers: Array<{ folder: PluginFolder; answer: unknown }> = [];
  const door = doorOf(action, preview);
  for (const folder of folders) {
    const decl = folder.decl;
    if (decl === null || !available.has(folder.name)) continue;
    const record = decl as Record<string, unknown>;
    if (record.timing !== timing || record.action !== action) continue;
    if (!(await enabled(folder, ctx, warnings))) continue;
    const impl = await implOf(folder);
    if (impl === null) continue; // a load failure is already recorded in the runtime problem table, which doctor reports.
    const call = (impl as Record<string, unknown>)[door];
    if (typeof call !== 'function') {
      warnings.push(doorWarningLine(folder.name, noDoor(door, action, preview, folder.name)));
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

/** The insertions every plugin wants at this timing, in registry order; the shape was checked here and the graph edit is landed by the caller. */
export async function collectOffers(
  timing: PluginTiming,
  ctx: PluginContext,
  folders: readonly PluginFolder[],
  warnings: string[],
  preview = false,
  assembly?: PluginAssembly,
): Promise<NormalizedOffer[]> {
  const offers: NormalizedOffer[] = [];
  const answers = await askDoors(
    timing, 'insert', ctx, folders, warnings, preview, await availableNames(folders, assembly),
  );
  for (const { folder, answer } of answers) {
    // null / undefined / false / 0 / '' / an empty object / an empty table: "I have nothing to say this
    // round", always a legitimate answer — skipped silently, without a warning.
    if (noneThisRound(answer)) continue;
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
  assembly?: PluginAssembly,
): Promise<string[]> {
  const reasons: string[] = [];
  const answers = await askDoors(
    timing, 'block', ctx, folders, warnings, preview, await availableNames(folders, assembly),
  );
  for (const { folder, answer } of answers) {
    // "Not this round" has to state a reason; ones that state none are skipped silently — the same tolerance
    // collectOffers reads, from the same place.
    if (noneThisRound(answer)) continue;
    if (typeof answer !== 'string') {
      warnings.push(warnLine(folder.name, 'returned an unusable reason', `a reason is prose, got ${describe(answer)}`));
      continue;
    }
    reasons.push(answer);
  }
  return reasons;
}
