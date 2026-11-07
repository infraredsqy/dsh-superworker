/* The skills' own wording (phase 5): what a `SKILL.md` puts in front of the model,
 * measured over the shipped corpus — the catalog slot the description has to fit, the
 * command lines a body may hand over to be guessed at, and the `shared/` page a folder
 * already carries beside the skill it would otherwise restate.
 *
 * - **description fits the catalog**: every `SKILL.md` frontmatter `description:` is at most 120 code
 *   points; the YAML quotes are parsed off and not counted.
 * - **no command menu in a fence**: a fenced block that lists three or more distinct sub-words
 *   of one group is a menu — something the model has to guess at — unless every one of
 *   those lines is a placeholder template (`superworker issue resolve <id> --reason "<…>"`), which
 *   is a working trio, not a menu. This pins that fenced `superworker <group> <verb>` shape only:
 *   prose, tables, a list split across fences, a top-level verb with no group, and an
 *   underscored sub-word are all outside what it reads. The block the rule was measured
 *   on (`pool.md` before phase 5) is kept as a frozen literal and asserted red here, so
 *   the rule provably catches the shape it pins even after the live corpus has stopped
 *   carrying one.
 * - **no restating shared/**: a `SKILL.md` and the markdown pages in the `shared/` tree beside
 *   it share no run of one or more consecutive prose sentences (fences, tables and
 *   headings dropped, whitespace collapsed). The same comparison runs on a page against
 *   itself first and must find a hit — a detector that can no longer see anything would
 *   otherwise read exactly like a clean corpus.
 * - **surface sentence carries three parameters**: the paragraph of a `SKILL.md` that names `superworker` also carries
 *   `` `word` ``, `` `args` `` and `` `help` `` — structural, so a skill may reword the
 *   sentence but not drop a parameter.
 *
 *   node --test tests/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const pluginsRoot = join(repo, 'packages', 'superworker-core', 'plugins')

/** Every file under `dir` whose basename the predicate keeps. */
function filesUnder(dir, keep) {
  const found = []
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (keep(entry.name)) found.push(full)
    }
  }
  walk(dir)
  return found
}

/** The `skills/` trees the shipped plugins carry. */
const skillTrees = []
const findSkillTrees = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (entry.name === 'skills') skillTrees.push(full)
    else findSkillTrees(full)
  }
}
findSkillTrees(pluginsRoot)
/** Every markdown page under those trees. */
const skillMarkdown = skillTrees.flatMap((dir) => filesUnder(dir, (name) => name.endsWith('.md')))
/** The pages that are a skill's own body. */
const skillFiles = skillMarkdown.filter((file) => basename(file) === 'SKILL.md')

/**
 * The frontmatter `description:` value of one `SKILL.md`, and the line it sits on: the
 * value is parsed, so the YAML quotes are not part of the count. A folded block (`>` /
 * `|`) is joined the way YAML would; this corpus writes a single line, and a parser that
 * silently returned nothing would make the length check vacuous.
 */
function descriptionOf(file) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const open = lines.findIndex((line) => line.trim() === '---')
  if (open < 0) return { value: '', line: 0 }
  for (let i = open + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break
    const match = /^description:\s*(.*)$/u.exec(lines[i])
    if (match === null) continue
    let value = match[1].trim()
    if (value.startsWith('>') || value.startsWith('|')) {
      const gathered = []
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '---' || /^[A-Za-z][\w-]*:\s/u.test(lines[j])) break
        if (lines[j].trim() !== '') gathered.push(lines[j].trim())
      }
      value = gathered.join(' ')
    }
    if (/^(["']).*\1$/u.test(value)) value = value.slice(1, -1)
    return { value, line: i + 1 }
  }
  return { value: '', line: 0 }
}

test('Description fits the catalog: every SKILL.md frontmatter description is at most 120 code points', () => {
  assert.ok(skillFiles.length >= 14, `every shipped skill is walked (walked ${skillFiles.length} files, at least 14)`)
  for (const file of skillFiles) {
    const { value, line } = descriptionOf(file)
    assert.notEqual(value, '', `${relative(repo, file)}:${line} read no description, so this leg spins on nothing`)
    const length = [...value].length
    assert.ok(length <= 120, `${relative(repo, file)}:${line}: ${length} code points, cap 120`)
  }
})

/** The sub-word lines of a fence: `superworker <group> <sub-word> …` — the shape a menu or a
 *  usage template is written in. A line whose second slot is `<command>` is neither: it
 *  does not name a sub-word the block could run. */
const COMMAND_LINE = /^\s*superworker\s+([a-z][a-z-]+)\s+([a-z][a-z-]*)\b/u
/** An angle-bracket placeholder (`<id>`, `"<…>"`, `<node>`): the slot the reader fills in. */
const PLACEHOLDER = /<[^<>]+>/u

/**
 * The command-menu rule, and the measurement behind it. At HEAD, fences holding three
 * or more distinct sub-words of one group are exactly four: the
 * `issue/skills/{en,zh}/sw-issue-repair/pool.md` blocks (`status / top / search /
 * weight`, runnable as written — the real menus) and the two `sw-issue-repair/SKILL.md`
 * blocks (`resolve / update / reject`, every line `superworker issue <sub> <id> --reason "<…>"`
 * — a working trio). Fences with exactly two distinct sub-words: zero. The rule, then:
 * a block is a **menu** (red, reported by its fence's own line) when one group appears
 * with three or more distinct sub-words and the block is not a template, a template
 * being a block in which *every* one of that group's command lines names a placeholder
 * and so cannot be run as written. A command-menu block is what a reader has to turn
 * into a `--help` ask; the parameterised trio is usage, and stays green.
 *
 * What this pins is that one fenced shape — a `superworker <group> <verb>` line inside a single
 * fence. It reads one fence at a time and takes the second slot for the verb, so prose
 * that lists commands, a table of them, a list spread across two fences, a top-level
 * verb with no group, and an underscored sub-word are all invisible to it. A green run
 * says those fences carry no menu; it does not say the corpus carries no command menu.
 */
function menuFindingsIn(text, file) {
  const findings = []
  let fence = null
  const flush = () => {
    if (fence === null) return
    const groups = new Map()
    for (const line of fence.lines) {
      const match = COMMAND_LINE.exec(line.text)
      if (match === null) continue
      if (!groups.has(match[1])) groups.set(match[1], [])
      groups.get(match[1]).push({ sub: match[2], text: line.text })
    }
    for (const [group, entries] of groups) {
      const subs = [...new Set(entries.map((entry) => entry.sub))]
      if (subs.length < 3) continue
      if (entries.every((entry) => PLACEHOLDER.test(entry.text))) continue
      findings.push({ file, line: fence.start, group, subs })
    }
    fence = null
  }
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*```/u.test(line)) {
      if (fence === null) fence = { start: i + 1, lines: [] }
      else flush()
      return
    }
    if (fence !== null) fence.lines.push({ text: line })
  })
  flush()
  return findings
}

test('The command menu in a fence: a `superworker <group> <verb>` fence with three sub-words of one group is a menu, unless every line is a placeholder template', () => {
  assert.ok(skillMarkdown.length >= 60, `every shipped skill body is walked (walked ${skillMarkdown.length} files, at least 60)`)
  const findings = skillMarkdown.flatMap((file) =>
    menuFindingsIn(readFileSync(file, 'utf8'), relative(repo, file)),
  )
  const report = findings
    .map((hit) => `${hit.file}:${hit.line} superworker ${hit.group} [${hit.subs.join(' ')}]`)
    .join('\n')
  assert.ok(findings.length === 0, `these fences hand over a command menu:\n${report}`)

  // The old bytes of `pool.md`, frozen: the five command lines with their glosses, as
  // `5bdfdfb` had them. A frozen sample, not live corpus — the live tree is green
  // because the menu was deleted, and only this leg proves the rule can still see one.
  const oldPoolMenu = [
    '```pwsh',
    'superworker issue <command> --help    # look at it before touching anything',
    'superworker issue status             # the present state',
    'superworker issue top --limit 10     # by priority',
    "superworker issue search '<regex>'    # locate; search like words in one go with |",
    'superworker issue weight -v          # how the weighted sum adds up',
    '```',
  ].join('\n')
  const frozen = menuFindingsIn(oldPoolMenu, '<frozen: pool.md @ 5bdfdfb>')
  assert.equal(frozen.length, 1, `the old pool.md menu must be caught by this rule: ${JSON.stringify(frozen)}`)
  assert.equal(frozen[0].line, 1, 'it reports the fence\'s own line')
  assert.deepEqual(frozen[0].subs, ['status', 'top', 'search', 'weight'])
})

/**
 * The prose sentences of one markdown page, each with the 1-based line it starts on:
 * fences, tables, headings and list markers are dropped, whitespace is collapsed, and
 * the page is segmented in its own language — so a restatement is caught however the two
 * copies wrap their lines differently. Short fragments (under 8 code points) are dropped:
 * they repeat everywhere and prove nothing.
 */
function proseSentencesOf(file) {
  const locale = /[\\/]zh[\\/]/u.test(file) ? 'zh' : 'en'
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  const parts = []
  let fenced = false
  lines.forEach((raw, i) => {
    if (/^\s*```/u.test(raw)) {
      fenced = !fenced
      return
    }
    if (fenced) return
    if (/^\s*\|.*\|\s*$/u.test(raw)) return
    if (/^\s*#+\s/u.test(raw)) return
    const text = raw.replace(/^\s*(?:[-*+]|\d+\.)\s+/u, '').replace(/\s+/gu, ' ').trim()
    if (text !== '') parts.push({ line: i + 1, text })
  })
  const starts = []
  let at = 0
  for (const part of parts) {
    starts.push(at)
    at += part.text.length + 1
  }
  const lineOf = (index) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= index) lo = mid
      else hi = mid - 1
    }
    return parts[lo].line
  }
  const sentences = []
  for (const segment of new Intl.Segmenter(locale, { granularity: 'sentence' }).segment(parts.map((part) => part.text).join(' '))) {
    const text = segment.segment.replace(/\s+/gu, ' ').trim()
    if ([...text].length < 8 || !/[\p{L}\p{N}]/u.test(text)) continue
    sentences.push({ text, line: lineOf(segment.index) })
  }
  return sentences
}

/** The shortest shared run this test counts as a restatement. One sentence: the reviewer
 *  found no single-sentence overlap between any skill and its `shared/` pages, so the
 *  tighter floor costs nothing live and makes the self-check below possible. */
const MIN_RUN = 1

/**
 * Runs of `MIN_RUN` or more consecutive identical sentences shared by the skill and a
 * page. The comparison reads prose only: tables and headings are dropped before it (see
 * `proseSentencesOf`), so a restatement living in a table or a heading is invisible here.
 */
function restatementsBetween(skillFile, sharedFiles) {
  const skill = proseSentencesOf(skillFile)
  const found = []
  for (const sharedFile of sharedFiles) {
    const shared = proseSentencesOf(sharedFile)
    const atOf = new Map()
    for (let j = 0; j + MIN_RUN <= shared.length; j++) {
      atOf.set(shared.slice(j, j + MIN_RUN).map((sentence) => sentence.text).join('\n'), j)
    }
    for (let i = 0; i + MIN_RUN <= skill.length; i++) {
      const at = atOf.get(skill.slice(i, i + MIN_RUN).map((sentence) => sentence.text).join('\n'))
      if (at === undefined) continue
      let length = MIN_RUN
      while (i + length < skill.length && at + length < shared.length && skill[i + length].text === shared[at + length].text) length++
      found.push({
        from: skill[i].line,
        to: skill[i + length - 1].line,
        sharedFile,
        sharedLine: shared[at].line,
        length,
        head: skill[i].text.slice(0, 80),
      })
      i += length - 1
    }
  }
  return found
}

/** The skill folders that carry a `shared/` tree beside their `SKILL.md`. */
const sharedFolders = skillFiles
  .map((file) => dirname(file))
  .filter((dir) =>
    readdirSync(dir, { withFileTypes: true }).some((entry) => entry.isDirectory() && entry.name === 'shared'),
  )

test('No restating shared/, self-check: a page against itself must find a restatement, or the green means nothing', () => {
  assert.ok(sharedFolders.length >= 4, `all four skill folders with a shared/ are walked (walked ${sharedFolders.length})`)
  for (const folder of sharedFolders) {
    const skillFile = join(folder, 'SKILL.md')
    const control = restatementsBetween(skillFile, [skillFile])
    assert.ok(
      control.length >= 1,
      `${relative(repo, skillFile)} finds no restatement against itself — the rule is blind, and the live assertion below spins on nothing`,
    )
  }
})

test('No restating shared/: a SKILL.md and the shared/ beside it share no run of consecutive prose sentences', () => {
  assert.ok(sharedFolders.length >= 4, `all four skill folders with a shared/ are walked (walked ${sharedFolders.length})`)
  for (const folder of sharedFolders) {
    const skillFile = join(folder, 'SKILL.md')
    const sharedFiles = filesUnder(join(folder, 'shared'), (name) => name.endsWith('.md'))
    assert.ok(sharedFiles.length >= 1, `${relative(repo, join(folder, 'shared'))} holds no pages`)
    const found = restatementsBetween(skillFile, sharedFiles)
    const report = found
      .map(
        (hit) =>
          `${relative(repo, skillFile)}:${hit.from}-${hit.to} restates ${relative(repo, hit.sharedFile)}:${hit.sharedLine} (${hit.length} sentences) "${hit.head}"`,
      )
      .join('\n')
    assert.ok(found.length === 0, `these paragraphs restate the shared/ text:\n${report}`)
  }
})

/** A path-free mention of the tool: `superworker` as a word, not a directory in a path. */
const TOOL_MENTION = /(?<![/\\])superworker[A-Za-z]*(?!\/)/u
/** The three parameter tokens the surface sentence carries, the same in either language. */
const PARAMETER_TOKENS = ['`word`', '`args`', '`help`']

test('Surface sentence carries three parameters: every paragraph naming superworker carries `word` / `args` / `help`', () => {
  assert.ok(skillFiles.length >= 14, `every shipped skill is walked (walked ${skillFiles.length} files, at least 14)`)
  let pages = 0
  for (const file of skillFiles) {
    // Paragraphs are the contiguous non-blank blocks: frontmatter is its own block, and a
    // reworded sentence stays one paragraph as long as it is not split by a blank line.
    const paragraphs = []
    let opening = null
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (line.trim() === '') {
          if (opening !== null) paragraphs.push(opening)
          opening = null
          return
        }
        if (opening === null) opening = { line: i + 1, body: [] }
        opening.body.push(line)
      })
    if (opening !== null) paragraphs.push(opening)
    for (const paragraph of paragraphs) {
      const text = paragraph.body.join('\n')
      if (!TOOL_MENTION.test(text)) continue
      pages += 1
      const missing = PARAMETER_TOKENS.filter((token) => !text.includes(token))
      assert.deepEqual(
        missing,
        [],
        `${relative(repo, file)}:${paragraph.line} this paragraph names superworker but is missing ${missing.join(' / ')}`,
      )
    }
  }
  assert.ok(pages >= 14, `at least 14 surface sentences under this rule (walked ${pages})`)
})