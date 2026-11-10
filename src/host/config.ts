/**
 * The settings schema for this plugin line.
 *
 * schemastery is provided by the host and loaded via dynamic import: when the
 * package is absent the module still loads — DSH just won't expose this line
 * as a settings namespace, while the reading side and the panel remain.
 */
import type { Schema, Schemastery } from '@deepseek-ai/schemastery'
import {
  PANEL_PREF_DEFAULTS,
  PANEL_PREF_FIELDS,
  SIDE_MAX,
  SIDE_MIN,
  VIEW_IDS,
} from './settings-fields.ts'

/** The schemastery provided by the host; `null` when the package is absent. */
const schemastery: Schemastery | null = await import('@deepseek-ai/schemastery').then(
  (module) => module.default,
  () => null,
)

/**
 * Build this line's settings schema from the field table. Split into a
 * function so it can be tested in isolation: at runtime the schemastery
 * passed in is the one the host provides.
 *
 * Every field is marked volatile: the settings service only projects volatile
 * fields — an entry with none would vanish from settings entirely, while
 * marking extra ones is harmless. Older builds (3.18.1 era) lack
 * `.volatile()`, and calling it there would break module evaluation and take
 * the reading side down with it, so each field is probed before it is marked —
 * the declaration states the method as optional, which is what makes that probe
 * a real branch rather than dead code. If a host lacks it, the fields are handed
 * through unchanged, at the cost of them not showing in settings.
 */
export function buildConfig(z: Schemastery): Schema<Record<string, unknown>> {
  const live = <T extends Schema>(field: T): T => {
    const mark: Schema['volatile'] = field.volatile
    return typeof mark === 'function' ? (mark.call(field) as T) : field
  }
  return z.object({
    [PANEL_PREF_FIELDS.sideWidth]: live(
      z.number().min(SIDE_MIN).max(SIDE_MAX).default(PANEL_PREF_DEFAULTS.sideWidth),
    ),
    [PANEL_PREF_FIELDS.defaultTab]: live(
      z.union(VIEW_IDS).default(PANEL_PREF_DEFAULTS.defaultTab),
    ),
    [PANEL_PREF_FIELDS.showArchived]: live(
      z.boolean().default(PANEL_PREF_DEFAULTS.showArchived),
    ),
    [PANEL_PREF_FIELDS.showOtherStates]: live(
      z.boolean().default(PANEL_PREF_DEFAULTS.showOtherStates),
    ),
    [PANEL_PREF_FIELDS.autoRelay]: live(
      z.boolean().default(PANEL_PREF_DEFAULTS.autoRelay),
    ),
    [PANEL_PREF_FIELDS.injectInstructions]: live(
      z.boolean().default(PANEL_PREF_DEFAULTS.injectInstructions),
    ),
  })
}

/**
 * This line's settings schema: field names and factory defaults come from
 * {@link PANEL_PREF_FIELDS} / {@link PANEL_PREF_DEFAULTS}, so the rows in the
 * settings page, the write-back paths, and the keys the panel reads all line
 * up.
 *
 * When the host lacks schemastery this is `undefined` — DSH reads that as "no
 * form" and this line takes no place in settings.
 */
export const Config: Schema<Record<string, unknown>> | undefined = schemastery === null
  ? undefined
  : buildConfig(schemastery)