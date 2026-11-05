/**
 * The reading face of the settings view: how known keys are described (display name, caption,
 * control kind, the category it belongs in, a copy of the dropdown candidates); the rows themselves
 * grow out of the `config list` reading.
 *
 * No JSX and no DOM here, so it can be measured standalone where no browser is installed. The tool
 * is the single source of settings keys, so this file does not declare "which keys the tool has":
 * every key in the reading gets a row — registered keys are described per this table, unregistered
 * ones show the key name directly with a text box; keys absent from the reading get no row here —
 * nothing is drawn for what does not exist.
 *
 * A row's category is part of its description here, not a reading-time guess: the settings page
 * stands an index down its left edge, one line per category, and each line's count is how many rows
 * that category holds.
 *
 * The names a row carries are dictionary KEYS, never the words themselves: which language they read
 * in is decided where the row is drawn, by the translator handed to {@link rowWords}.
 */
import type { ConfigEntry, ConfigLayer } from '../host/project-config.ts'
import type { Translate } from './locale.ts'
import type { WordKey } from './locales/index.ts'

export type ControlKind = 'pick' | 'num' | 'toggle' | 'text'

/** The categories the index names, in the order they stand there. */
export type ConfigGroup = 'general' | 'issue' | 'test'

export const CONFIG_GROUPS: readonly ConfigGroup[] = ['general', 'issue', 'test']

/** Each category's name, as a dictionary key. */
export const GROUP_WORDS: Readonly<Record<ConfigGroup, WordKey>> = {
  general: 'config.group.general',
  issue: 'config.group.issue',
  test: 'config.group.test',
}

export interface ConfigRow {
  readonly key: string
  /**
   * The name in the label cell, as a dictionary key.
   *
   * `null` for a key this table does not know: that key has no name of its own to translate — the key
   * name is a word out of the records, and it is printed as it stands in every language.
   */
  readonly name: WordKey | null
  /** The one sentence under the name, as a dictionary key. */
  readonly caption: WordKey
  readonly kind: ControlKind
  /** The category whose section this row stands in. */
  readonly group: ConfigGroup
  /** Only the dropdown kind has it: the words the tool accepts, in the order the dropdown lists them. */
  readonly options?: readonly string[]
}

/**
 * How known keys are described, in the order readers meet them. The tool only
 * mentions its accepted values in the prose of `config --help`, with no machine-readable list, so
 * the candidates are copied here. When the tool side adds a word, the reading will carry an
 * off-table value; {@link pickState} then promotes it to an option on the spot instead of silently
 * falling to the first one.
 *
 * `issue_repair` is the older reading of the two issue switches: tools that print it still get a
 * name and a sentence here, and a reading prints one switch or the other, never both.
 */
export const KNOWN_CONFIG_ROWS: Readonly<Record<string, ConfigRow>> = {
  worktree_mode: {
    key: 'worktree_mode',
    name: 'config.row.worktree_mode.name',
    caption: 'config.row.worktree_mode.caption',
    kind: 'pick',
    group: 'general',
    options: ['off', 'fork', 'reuse'],
  },
  test_tier: {
    key: 'test_tier',
    name: 'config.row.test_tier.name',
    caption: 'config.row.test_tier.caption',
    kind: 'pick',
    group: 'general',
    options: ['full', 'minimal'],
  },
  max_agents: {
    key: 'max_agents',
    name: 'config.row.max_agents.name',
    caption: 'config.row.max_agents.caption',
    kind: 'num',
    group: 'general',
  },
  issue_repair: {
    key: 'issue_repair',
    name: 'config.row.issue_repair.name',
    caption: 'config.row.issue_repair.caption',
    kind: 'toggle',
    group: 'issue',
  },
  issue_pool: {
    key: 'issue_pool',
    name: 'config.row.issue_pool.name',
    caption: 'config.row.issue_pool.caption',
    kind: 'toggle',
    group: 'issue',
  },
  issue_pool_weight_limit: {
    key: 'issue_pool_weight_limit',
    name: 'config.row.issue_pool_weight_limit.name',
    caption: 'config.row.issue_pool_weight_limit.caption',
    kind: 'num',
    group: 'issue',
  },
  test_audit: {
    key: 'test_audit',
    name: 'config.row.test_audit.name',
    caption: 'config.row.test_audit.caption',
    kind: 'toggle',
    group: 'test',
  },
  test_seconds_limit: {
    key: 'test_seconds_limit',
    name: 'config.row.test_seconds_limit.name',
    caption: 'config.row.test_seconds_limit.caption',
    kind: 'num',
    group: 'test',
  },
}

/** The caption under unregistered keys: the key name is already in the name cell, so this only says who judges the value. */
const UNREGISTERED_CAPTION: WordKey = 'config.unregistered-caption'

/**
 * Which category an unregistered key falls under: its prefix is the only thing this side knows
 * about it, and `issue_` / `test_` are the two plugins' own naming — a key they add later files
 * itself under the same category its siblings stand in.
 * @param key - A key printed by the tool that this table does not describe.
 */
export function groupOfUnregistered(key: string): ConfigGroup {
  if (key.startsWith('issue_')) return 'issue'
  if (key.startsWith('test_')) return 'test'
  return 'general'
}

/**
 * Grow this view's rows out of a reading: only keys present in the reading get rows, none are added.
 *
 * Registered keys are laid out per {@link KNOWN_CONFIG_ROWS}, in its order too (the order readers
 * recognize, and one that does not wobble with the order the tool prints);
 * unregistered keys follow, in reading order, showing the key name directly with a text box — the
 * write side does not filter keys, and the tool judges whether a value is valid.
 * @param entries - The key to "value + layer" table read out of `config list`.
 */
export function configRowsOf(entries: Readonly<Record<string, ConfigEntry>>): readonly ConfigRow[] {
  const rows: ConfigRow[] = []
  for (const known of Object.values(KNOWN_CONFIG_ROWS)) {
    if (entries[known.key] !== undefined) rows.push(known)
  }
  for (const key of Object.keys(entries)) {
    if (KNOWN_CONFIG_ROWS[key] === undefined) {
      rows.push({ key, name: null, caption: UNREGISTERED_CAPTION, kind: 'text', group: groupOfUnregistered(key) })
    }
  }
  return rows
}

export interface ConfigSection {
  readonly group: ConfigGroup
  readonly rows: readonly ConfigRow[]
}

/**
 * The page under the index: one section per category that has at least one row, in the index's own
 * order. An empty category is not drawn — no head over nothing, and no line in the index to a place
 * with nothing in it.
 * @param entries - The key to "value + layer" table read out of `config list`.
 */
export function configSectionsOf(entries: Readonly<Record<string, ConfigEntry>>): readonly ConfigSection[] {
  const rows = configRowsOf(entries)
  return CONFIG_GROUPS
    .map((group) => ({ group, rows: rows.filter((row) => row.group === group) }))
    .filter((section) => section.rows.length > 0)
}

/**
 * The two words one row prints, in the reader's language.
 *
 * The translator comes in as the first argument rather than being reached for, so a caller can hand
 * in whichever language is in force; see `words.ts` for the same discipline.
 *
 * An unregistered key has no name of its own to translate: its name is the key itself, which is a
 * word out of the records and reads the same in every language.
 * @param t - The translator for the language in force.
 * @param row - The row whose words are wanted.
 */
export function rowWords(t: Translate, row: ConfigRow): { readonly name: string; readonly caption: string } {
  return { name: row.name === null ? row.key : t(row.name), caption: t(row.caption) }
}

export interface PickState {
  /** The option that should be selected; an empty string when nothing matches (left blank). */
  readonly value: string
  /** The off-table entry: a value present in the reading but not in the table, promoted to an option; `null` when none. */
  readonly extra: string | null
}

/**
 * Which dropdown option to pick: when the reading has no value for the key, none is chosen (left
 * blank) rather than defaulting to the first option.
 *
 * A controlled select with a `value` matching no option falls back to the first one by the
 * browser's own hand — `worktree_mode` would land on `off` and `test_tier` on `full`, exactly the
 * two keys' factory default words, leaving the reader unable to tell "absent from the record" from
 * "the record says off / full". Nothing is drawn for what does not exist: this function blocks that
 * move up front, leaving the select blank when there is no value. When the value exists in the
 * reading but not in the candidate table (the tool side added a word), it is not hidden: it is
 * promoted to an option on the spot, keeping the view consistent with the record.
 */
export function pickState(entry: ConfigEntry | undefined, options: readonly string[]): PickState {
  const value = entry?.value ?? ''
  if (value.length === 0) return { value: '', extra: null }
  return options.includes(value) ? { value, extra: null } : { value, extra: value }
}

/**
 * The three words for the layer tag at the end of a row, on the same terms as the panel's other word
 * tables: keys, not words.
 *
 * The default layer reads as "default": the factory copy nobody has changed. The global layer is
 * the instruction ledger's own "global" — one word for one fact, spelled once.
 */
export const LAYER_WORDS: Readonly<Record<ConfigLayer, WordKey>> = {
  default: 'config.layer.default',
  project: 'config.layer.project',
  global: 'common.global',
}