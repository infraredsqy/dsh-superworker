import type { PluginAction } from './types';

/**
 * The timing door's contract, in one place: which door each action asks (`offer` / `check`, and the
 * rehearsal each owes beside it), what "nothing to say this round" means, and the sentences a failure
 * leaves.
 *
 * Three readers ask the same question — the real timing, a rehearsal, and doctor's stand-in question —
 * so they read this one table and this one tolerance. A door name spelled twice, or a tolerance written
 * three times, is how the runtime and the check-up drift apart: a plugin answering an empty table would
 * be green in doctor and a WARNING at the real timing.
 */

/** The doors of the two actions: the real one and the rehearsal that owes beside it. */
export const DOORS: Readonly<Record<PluginAction, { readonly door: string; readonly preview: string }>> = {
  insert: { door: 'offer', preview: 'offer_preview' },
  block: { door: 'check', preview: 'check_preview' },
};

/** The door of one action: the real one, or its rehearsal. A declaration of any other action has no door to ask. */
export function doorOf(action: PluginAction, preview = false): string {
  return preview ? DOORS[action].preview : DOORS[action].door;
}

/** The door a declared action names, read off the same table: null when the declaration names no action the core serves (validation has already reported it). */
export function doorForAction(action: unknown): string | null {
  if (typeof action !== 'string' || !Object.keys(DOORS).includes(action)) return null;
  return DOORS[action as PluginAction].door;
}

/** The rehearsal a door owes beside it: the same name with `_preview` (see PluginImplModule). */
export function previewDoorOf(door: string): string {
  return `${door}_preview`;
}

/**
 * "None this round" — the one tolerance the three readers share: an absent answer (null / undefined),
 * `false`, `0`, an empty string, an object with no own keys and an empty table all mean "I have nothing
 * to say this round", and none of them is a warning. Anything else is an answer the door's own timing
 * reads (an offer object, a reason sentence), and the shape check is the caller's.
 */
export function noneThisRound(answer: unknown): boolean {
  if (!answer) return true;
  if (Array.isArray(answer)) return answer.length === 0;
  return typeof answer === 'object' && Object.keys(answer as Record<string, unknown>).length === 0;
}

/**
 * What went wrong with one door, in the two renderings the readers print: the short cell a WARNING line
 * states beside the plugin's name (`what`), the detail it carries, and the one sentence doctor prints
 * after the plugin's name (`sentence`). One construction, so the timing and the check-up cannot describe
 * the same fault two ways.
 */
export interface DoorFailure {
  /** The short cell of the WARNING line: `has no offer()`, `<door>() raised`, ... */
  readonly what: string;
  /** The detail the WARNING line carries. */
  readonly detail: string;
  /** The sentence doctor prints after the plugin's name. */
  readonly sentence: string;
}

/** The door a declaration names is not in its implementation entry: the timing it declares can never be served. */
export function noDoor(door: string, action: PluginAction, preview: boolean, plugin: string): DoorFailure {
  if (preview) {
    return {
      what: `has no ${door}()`,
      detail: `a rehearsal cannot say what it would ${action === 'insert' ? 'insert' : 'hold back'} this round`,
      sentence: `plugin ${JSON.stringify(plugin)}: ${door}() is missing, so a rehearsal skips it`,
    };
  }
  return {
    what: `has no ${door}()`,
    detail: 'the timing it declares cannot be served',
    sentence: `plugin ${JSON.stringify(plugin)}: has no ${door}(), so the ${JSON.stringify(action)} timing ` +
      'it declares can never be served',
  };
}

/** A door that raises: doctor asks it on a stand-in project, the timing asks it on the real scene. */
export function raisedDoor(door: string, error: unknown): DoorFailure {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    what: `${door}() raised on a stand-in project`,
    detail,
    sentence: `${door}() raised on a stand-in project: ${detail}`,
  };
}

/** A door that answers a shape its timing cannot read: a reason is prose, an offer is an object. */
export function wrongAnswer(door: string, answer: unknown): DoorFailure {
  const said = Array.isArray(answer) ? 'array' : typeof answer;
  const reads = door.startsWith('check') ? 'a reason string or nothing' : 'an offer object or nothing';
  return {
    what: `${door}() answered ${said}`,
    detail: `that timing reads ${reads}`,
    sentence: `${door}() answered ${said}, and that timing reads ${reads}`,
  };
}

/** The one line the tolerant path leaves for one failure (data, not stderr). */
export function doorWarningLine(plugin: string, failure: DoorFailure): string {
  return `WARNING: plugin ${plugin} ${failure.what}: ${failure.detail}`;
}
