import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceCells } from './cells';
import { conflicts, folderProblems, usable } from './declare';
import { doorForAction, noDoor, noneThisRound, previewDoorOf, raisedDoor, wrongAnswer } from './doors';
import { implOf, implPathOf, runtimeProblemsSeen, PLUGIN_IMPL_NAME } from './scan';
import { skillProblems } from './skills';
import { standInContext } from './standin';
import type { PluginContext, PluginDeclaration, PluginFolder, PluginImplModule } from './types';

/**
 * Doctor's strict face: every bad spot of the installed plugins, one sentence each — the shape and the
 * references of each declaration, name conflicts, a missing implementation entry and load failures, the
 * two ways skills disagree, a claimed source with no computing function, the rehearsal a timing owes, and
 * one real question put to every implementation against a stand-in project.
 *
 * It throws nowhere along the way: a broken plugin comes back as a few lines of explanation. The tolerant
 * side of the same questions lives in `host.ts`, and both read the door contract out of `doors.ts`.
 */

/**
 * Every bad spot of the plugins: the shape and the references of each declaration, name conflicts, a missing
 * implementation entry and load failures, the two ways skills disagree, a claimed source with no computing
 * function, and one real question put to every implementation against a stand-in project. It hands back a list of
 * sentences and throws nowhere along the way — a broken plugin comes back as a few lines of explanation.
 */
export async function verifyPlugins(folders: readonly PluginFolder[]): Promise<string[]> {
  const problems: string[] = [];
  for (const folder of folders) problems.push(...folderProblems(folder));
  problems.push(...conflicts(folders));
  // Loading comes first: the runtime problem table has to be filled before the checks below can read it.
  for (const folder of folders) {
    if (existsSync(implPathOf(folder))) await implOf(folder);
  }
  // The runtime problem table is keyed by implementation entry path, so only this batch's own folders are reported (a broken plugin of another project does not mix in).
  const ownPaths = new Set(folders.map((f) => implPathOf(f)));
  for (const [path, sentence] of runtimeProblemsSeen()) {
    if (ownPaths.has(path)) problems.push(sentence);
  }
  problems.push(...skillProblems(folders));
  for (const folder of folders) {
    const decl = folder.decl;
    if (decl === null) continue;
    // The computing function of a claimed source: only whether the name is there is checked, it is never called — a number is taken when a runtime timing asks for it.
    const impl = existsSync(implPathOf(folder)) ? await implOf(folder) : null;
    if (impl === null) continue;
    for (const [source, cell] of Object.entries(sourceCells(decl))) {
      const by = (impl as Record<string, unknown>)[cell.by];
      if (typeof by !== 'function') {
        problems.push(`plugin ${JSON.stringify(folder.name)}: source ${JSON.stringify(source)} says its number ` +
          `is computed by ${cell.by}() in ${PLUGIN_IMPL_NAME}, and there is no such function`);
      }
    }
    problems.push(...(await liveCallProblems(folder, decl, impl)));
  }
  return problems;
}

/**
 * The rehearsal gaps doctor reports as a notice, never as a declaration problem: every plugin that declares a
 * timing and ships no preview for it. The plugin still runs at the real timing; a rehearsal skips it and puts one
 * WARNING line on the round, which is where the cost of the gap is paid.
 */
export async function previewGaps(folders: readonly PluginFolder[]): Promise<string[]> {
  const gaps: string[] = [];
  for (const folder of folders) {
    const decl = folder.decl;
    if (decl === null || !usable(folder)) continue;
    const record = decl as Record<string, unknown>;
    const door = doorForAction(record.action);
    if (door === null) continue;
    const impl = existsSync(implPathOf(folder)) ? await implOf(folder) : null;
    if (impl === null) continue; // a load failure is the `plugins` check's own line
    const cells = impl as Record<string, unknown>;
    if (typeof cells[door] !== 'function') continue; // "no door at all" is a problem, not a gap
    if (typeof cells[previewDoorOf(door)] === 'function') continue;
    gaps.push(
      `plugin ${JSON.stringify(folder.name)}: the ${String(record.timing ?? '?')}/${String(record.action ?? '?')} ` +
        `timing ships no ${previewDoorOf(door)}() -- a rehearsal skips it (one WARNING line)`,
    );
  }
  return gaps;
}

/**
 * One real question put against a stand-in project: the implementation has to answer (an offer / a reason
 * sentence) or answer "none this round", and it must not throw along the way. The stand-in does no disk write and
 * runs no command — validation may not prove an implementation lied by one graph edit or one session.
 *
 * The door contract allows asynchronous implementations (a door's signature in PluginImplModule is
 * `unknown | Promise<unknown>`, and the runtime doors await it too), so the real question here waits the Promise
 * inside the same try — a rejection falls into the raised branch and reports "raised", and a return value settles
 * first and is judged for shape after. Without the wait, an asynchronous implementation would be wrong in all
 * three directions for doctor: a rejected offer would look green (missed), a check returning a string would be
 * taken as an object (false red), and a rejected Promise would be unhandled (an unhandled rejection, which inside
 * the host process is ERR_UNHANDLED_REJECTION).
 */
async function liveCallProblems(
  folder: PluginFolder,
  decl: PluginDeclaration,
  impl: PluginImplModule,
): Promise<string[]> {
  const name = folder.name;
  const door = doorForAction((decl as Record<string, unknown>).action);
  if (door === null) return [];
  const cells = impl as Record<string, unknown>;
  const call = cells[door];
  const action = (decl as Record<string, unknown>).action;
  if (typeof call !== 'function') {
    // The same sentence the timing's own WARNING is built from: one construction, two readers.
    return [noDoor(door, action === 'block' ? 'block' : 'insert', false, name).sentence];
  }
  const standIn = mkdtempSync(join(tmpdir(), 'pf-plugin-check-'));
  try {
    const problems = await doorProblems(name, door, call as (ctx: PluginContext) => unknown, decl, standIn);
    // The rehearsal the timing owes is asked the same way when it is there: a preview that raises or answers a
    // shape its timing cannot read is a plugin defect like any other, and it would only show up on a drill.
    const preview = cells[previewDoorOf(door)];
    if (typeof preview === 'function') {
      problems.push(...await doorProblems(name, previewDoorOf(door), preview as (ctx: PluginContext) => unknown, decl, standIn));
    }
    return problems;
  } finally {
    rmSync(standIn, { recursive: true, force: true });
  }
}

/** One door asked on a stand-in project: the sentence it leaves when it raises, or when its answer is a shape its timing cannot read. */
async function doorProblems(
  name: string,
  door: string,
  call: (ctx: PluginContext) => unknown,
  decl: PluginDeclaration,
  standIn: string,
): Promise<string[]> {
  let answer: unknown;
  try {
    answer = await call(standInContext(decl, standIn));
  } catch (error) {
    return [`plugin ${JSON.stringify(name)}: ${raisedDoor(door, error).sentence}`];
  }
  // "None this round" is always a legitimate answer (the same tolerance collectOffers / collectGates read):
  // null / undefined / false / '' / 0, an object with no own keys and an empty table — so a healthy plugin
  // answering an empty table for "none this round" is not blamed.
  if (noneThisRound(answer)) return [];
  if (door.startsWith('check') && typeof answer !== 'string') {
    return [`plugin ${JSON.stringify(name)}: ${wrongAnswer(door, answer).sentence}`];
  }
  if (door.startsWith('offer') && (typeof answer !== 'object' || Array.isArray(answer))) {
    return [`plugin ${JSON.stringify(name)}: ${wrongAnswer(door, answer).sentence}`];
  }
  return [];
}
