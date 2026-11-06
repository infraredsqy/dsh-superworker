/**
 * One shipped skill file, read out of `SKILL.md`: the frontmatter block and the instruction body.
 *
 * Nothing this layer writes goes through here — the file is read, its frontmatter is understood, and
 * the body after the closing delimiter is handed on byte for byte. The block itself is read by hand
 * rather than by a YAML library because the provider's vocabulary is flat: a `key: value` cell per
 * line, the two invocation keys honoured, everything else left alone.
 */
import { readFileSync } from 'node:fs'

/** The skill-name shape DSH's provider accepts: kebab-case, the name it keys the catalog by. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** One skill as this layer reads it out of a `SKILL.md`: what the placement needs, and nothing it does not. */
export interface SkillFile {
  readonly name: string
  readonly description: string
  readonly invocation: { readonly modelInvocable: boolean; readonly userInvocable: boolean }
  /** The instruction body: the file with its frontmatter block cut off and nothing else touched. */
  readonly content: string
}

/** Reading one shipped skill file: the skill, or why this file is not one. */
export type SkillFileReading =
  | { readonly ok: true; readonly value: SkillFile }
  | { readonly ok: false; readonly detail: string }

/**
 * The reserved names a skill file's frontmatter may carry and this layer honours.
 *
 * The filesystem provider's own vocabulary, read the same way: a skill is named and described, and
 * the two invocation keys decide which surfaces may offer it. Everything else in the block is left
 * alone — a shipped file may carry extra metadata and still be installable.
 */
const INVOCATION_KEYS = ['disable-model-invocation', 'user-invocable'] as const

/** A YAML-style boolean, in the spellings DSH's own provider accepts; anything else is a refused spelling. */
function booleanOf(raw: string): boolean | undefined {
  const text = raw.trim().toLowerCase()
  if (text === 'true' || text === 'yes' || text === 'on' || text === '1') return true
  if (text === 'false' || text === 'no' || text === 'off' || text === '0') return false
  return undefined
}

/** A frontmatter value with a matching pair of quotes taken off; an unquoted value is returned as it stands. */
function unquote(raw: string): string {
  const text = raw.trim()
  const first = text[0]
  if (text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first)) return text.slice(1, -1)
  return text
}

/** The flat cells of a frontmatter block: `key: value` at the block's own level, indented cells (nested tables) skipped. */
function cellsOf(block: readonly string[]): Record<string, string> {
  const cells: Record<string, string> = {}
  for (const line of block) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    /* An indented line belongs to a cell above it (a nested table or a list); it is not a cell of its own. */
    if (line.trimStart() !== line) continue
    const sep = line.indexOf(':')
    if (sep <= 0) continue
    cells[line.slice(0, sep).trim()] = unquote(line.slice(sep + 1))
  }
  return cells
}

/**
 * Read one skill file: its frontmatter block and the instruction body after it.
 *
 * A file with no `---` block, no name, no description, or an invocation key in a spelling DSH would
 * read as neither true nor false is not a skill — and because these files ship inside the package,
 * "not a skill" is a packaging fault worth refusing over rather than a warning worth skipping.
 */
export function readSkillFile(text: string): SkillFileReading {
  const lines = text.replace(/^\uFEFF/u, '').split('\n')
  if ((lines[0] ?? '').trim() !== '---') {
    return { ok: false, detail: 'no frontmatter block (the file does not open with ---)' }
  }
  let closing = -1
  for (let index = 1; index < lines.length; index++) {
    if ((lines[index] ?? '').trim() === '---') {
      closing = index
      break
    }
  }
  if (closing < 0) return { ok: false, detail: 'no frontmatter block (the opening --- is never closed)' }
  const cells = cellsOf(lines.slice(1, closing))
  const name = cells['name'] ?? ''
  if (name === '') return { ok: false, detail: 'frontmatter has no name' }
  const description = cells['description'] ?? ''
  if (description === '') return { ok: false, detail: 'frontmatter has no description' }
  let disableModel = false
  let userInvocable = true
  for (const key of INVOCATION_KEYS) {
    const raw = cells[key]
    if (raw === undefined) continue
    const value = booleanOf(raw)
    if (value === undefined) return { ok: false, detail: `frontmatter ${key} is not a boolean: ${JSON.stringify(raw)}` }
    if (key === 'disable-model-invocation') disableModel = value
    else userInvocable = value
  }
  return {
    ok: true,
    value: {
      name,
      description,
      invocation: { modelInvocable: !disableModel, userInvocable },
      /* The body is everything after the closing delimiter line, byte for byte: the one thing this
       * layer must not touch is the text the model will read. */
      content: lines.slice(closing + 1).join('\n'),
    },
  }
}

/** One flat `.md` skill's name, read off a file; `undefined` when the file is not a skill this layer can name. */
export function skillNameOfFile(file: string): string | undefined {
  try {
    const reading = readSkillFile(readFileSync(file, 'utf8'))
    return reading.ok ? reading.value.name : undefined
  } catch {
    /* An unreadable file is not a skill this layer can name, so it cannot be a collision with one. */
    return undefined
  }
}
