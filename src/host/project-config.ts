/**
 * This workspace's project settings: the lines printed by the tool's command,
 * read into a reading.
 *
 * Only the tool knows the effective value and which layer it came from (the
 * global layer lives in the home directory, out of the workspace file
 * gateway's sight), so this module only parses each line `config list`
 * prints and makes no second set of judgments. Which keys the tool accepts is
 * also the tool's business: no key list is kept here — whatever is printed
 * gets read.
 */
import type { RecordRefusal } from './failure.ts'

/** Which layer a value actually lives on. */
export type ConfigLayer = 'default' | 'project' | 'global'

/**
 * What a layer's overwrite tag looks like in the tool's printed line: recognized by the first two
 * characters; an unreadable layer name gets no layer rather than inventing a reading the tool never
 * gave.
 *
 * Both spellings the tool has printed are accepted — the Chinese words and the English ones — and
 * they map to the same three layers. These are INBOUND tokens matched against the tool's stdout, not
 * words this plugin says: they are never rendered, so they are not in the client's dictionary and
 * must not move there. Accepting both is what keeps this reader working across the tool's own
 * wording changes; a layer name neither spelling covers still yields no layer.
 */
const LAYER_HEADS: readonly (readonly [ConfigLayer, string])[] = [
  ['default', '出厂默认'],
  ['project', '项目 '],
  ['global', '全局 '],
  ['default', 'factory default'],
  ['project', 'project '],
  ['global', 'global '],
]

/**
 * The printed line. Key names are alphanumerics and underscores; the value
 * sits between the equals sign and the parentheses, the layer name inside the
 * parentheses and itself free of parentheses.
 *
 * Either width of parenthesis is accepted: the tool has printed the full-width
 * pair and the half-width pair, and this reader's job is to read what it is
 * given rather than to insist on one of them.
 *
 * The value group is lazy: values like `worktree_mode = off` contain no
 * spaces, but if a value with spaces ever shows up, the trailing "space +
 * parenthesis" is the separator — the greedy version would swallow the value up
 * to just before the last parenthesis.
 */
const CONFIG_LINE = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*[（(]([^（）()]*)[）)]\s*$/u

/** What one parsed line yields. */
export interface ConfigEntry {
  /** The effective value as the tool printed it. */
  readonly value: string
  /** Which layer this value lives on; `null` when the layer name is unreadable. */
  readonly layer: ConfigLayer | null
}

/**
 * A reading of the project settings.
 *
 * `ok` says whether the tool's run succeeded (command failed to start, non-zero exit); a failure of
 * the reading side itself is a separate layer, handled by the caller via throws. When the tool
 * fails, `entries` is empty and the panel draws "absent from the records".
 *
 * A failure's reason is a code, not a sentence: the tool speaks a language this half cannot know,
 * and neither can it know which language the reader is looking at — the panel spells it
 * (`src/client/words.ts`). What the tool itself said, when it said anything, rides along in
 * `refusal.detail`.
 */
export interface SuperworkerConfigReading {
  /** The absolute workspace root read this time, same name as the four-records reading; settings land in its record. */
  readonly workspaceRoot: string
  readonly ok: boolean
  /** The tool's own output on success; empty on failure, whose reason is a code. */
  readonly text: string
  /** Why the tool's run failed; `null` when it did not. */
  readonly refusal: RecordRefusal | null
  /** Every printed line, keyed by setting key. Keys never printed are not here. */
  readonly entries: Readonly<Record<string, ConfigEntry>>
}

/** Parse a layer name into a layer; `null` when unreadable. */
function layerOf(word: string): ConfigLayer | null {
  const head = LAYER_HEADS.find(([, text]) => word === text || word.startsWith(text))
  return head === undefined ? null : head[0]
}

/**
 * Parse the lines `superworker config list` prints into a table. Unrecognizable lines
 * are skipped (the tool also prints things like `Warning:` on that stream —
 * that is other output); a line whose value is empty is skipped too: an empty
 * value yields no reading.
 */
export function parseConfigList(text: string): Record<string, ConfigEntry> {
  const out: Record<string, ConfigEntry> = {}
  for (const line of text.split(/\r?\n/u)) {
    const matched = CONFIG_LINE.exec(line)
    if (matched === null) continue
    const [, key, value, layer] = matched
    if (key === undefined || value === undefined || layer === undefined) continue
    if (value.length === 0) continue
    out[key] = { value, layer: layerOf(layer) }
  }
  return out
}