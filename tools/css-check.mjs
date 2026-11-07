#!/usr/bin/env node
/**
 * The panel's stylesheet self-check.
 *
 * DSH's own stylesheet contracts (`ui-theme`'s specs, and the scan helper they
 * share) range over the harness's `packages/` tree. A plugin lives outside it,
 * so it cannot be held to those specs by running them — this script runs the
 * same set of questions against this repo's own sheets, and adds the two things
 * those specs leave to a human: which alias each mark inks itself with, and
 * whether that ink clears this panel's contrast floors in both palettes.
 *
 * Usage: node tools/css-check.mjs [--root <dir>] [--quiet]
 * Exit code 0 when every question passes.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cssBlocks, stripComments } from './lib/cssrules.mjs'
import { LAYER_CLASSES, SHEETS } from './lib/sheets.mjs'

const argv = process.argv.slice(2)
const argOf = (flag) => {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}
const QUIET = argv.includes('--quiet')
const ROOT = resolve(argOf('--root') ?? fileURLToPath(new URL('..', import.meta.url)))
/* The design blueprint: a local, gitignored snapshot — the four hand-drawn pages and their own
 * page-shaped sheets. Nothing here is required; with it absent the page-link section has nothing
 * to check and the rest of this file runs unchanged. */
const PREVIEW = join(ROOT, 'design')
/* The sheets that ship, in the shape they ship in — the panel's own source. */
const STYLES = join(ROOT, 'src', 'client', 'styles')
/* DSH's own theme values, copied down so the two palettes and the contrast floors resolve offline.
 * An input of this check, not a preview asset: it lives here, with the checker. */
const THEME_SHEET = join(ROOT, 'tools', 'theme.css')

/* ------------------------------------------------------------------ parsing */

/* The layer classes the shipped sheets lead their selectors with — one per cell, read off the
 * shipping manifest (tools/lib/sheets.mjs) rather than kept as a second copy here: a sheet added to
 * the table is a layer class here too, and a class no sheet leads with is not one. The names go into
 * a regular expression below, so the leading dot comes off. */
const LAYER_NAMES = LAYER_CLASSES.map((one) => one.replace(/^\./u, ''))

/**
 * Fold a shipped selector back into the page shape this checker asks its questions in.
 *
 * The sheets are stored in the shape they ship in, so a selector leads with its cell's layer class
 * (`.pf-page .pf-cell`, `.is-embed.pf-issue .pf-band`, and plain `.pf-page` for the page
 * root). Every expectation downstream — the mark table's `.pf-cell` / `.is-P0`, the per-name
 * rules, the palette map's `:root` / `body` — is written in the sheets' page shape, and those
 * expectations are the check's whole point, so the shape is restored once here rather than rewritten
 * in a dozen places. Only the first class comes off: `.is-embed.pf-issue .pf-page` is a rule whose
 * layer prefix is real and whose subject is a `.pf-page` inside it.
 *
 * A selector that was nothing but the layer class becomes `body` — the page root the panel's own
 * declarations were written on. (`:root` and `body` collapse into one layer class on the way in, so
 * the checker reads them all as `body`, which is where the theme's aliases are declared too.)
 */
function bareSelector(selector) {
  const one = new RegExp(`\\.(?:${LAYER_NAMES.join('|')})(?![\\w-])`, 'u')
  if (!one.test(selector)) return selector
  const tidy = selector.replace(one, '').trim().replace(/^[>+~]\s*/u, '').replace(/\s+/gu, ' ')
  if (tidy.length === 0) return 'body'
  return tidy.startsWith('::') ? `*${tidy}` : tidy
}

/**
 * Every rule in a sheet, in source order, flattened across at-rules. The walk itself —
 * comment stripping, brace balancing, the descent into every at-rule's body — is the
 * shared one (tools/lib/cssrules.mjs); this checker's strategy is `'all'`, so a rule
 * inside any at-rule, `@keyframes` steps included, is asked the same questions.
 * @param {string} css - stylesheet text.
 * @returns {{selectors: string[], declarations: [string, string][], at: string}[]}
 */
const parseRules = (css) => cssBlocks(stripComments(css), { descend: 'all' })
  .filter((block) => block.kind === 'rule')
  .map((block) => ({
    selectors: block.prelude.split(',').map(s => bareSelector(s.trim())).filter(Boolean),
    declarations: block.body.split(';').map(p => p.trim()).filter(p => p.includes(':')).map((p) => {
      const colon = p.indexOf(':')
      return [p.slice(0, colon).trim(), p.slice(colon + 1).trim()]
    }),
    at: block.at,
  }))

const varNames = (value) => [...value.matchAll(/var\(\s*(--[\w-]+)/g)].map(([, name]) => name)

/**
 * Substitute var() references until none are left, looking each name up in the
 * given map (fallback text wins only when the name is absent and the reference
 * carries one). Cycle-safe.
 */
function resolveVars(value, map, seen = new Set()) {
  let out = value
  for (let pass = 0; pass < 12; pass += 1) {
    if (!out.includes('var(')) break
    let changed = false
    out = out.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/g, (whole, name, fallback) => {
      if (seen.has(name)) return whole
      const found = map.get(name)
      if (found === undefined) return fallback !== undefined ? fallback.trim() : whole
      changed = true
      seen.add(name)
      return found
    })
    if (!changed) break
  }
  return out
}

/* ------------------------------------------------------------------- colour */

function parseColor(text) {
  const value = text.trim()
  const hex = value.match(/^#([0-9a-f]{3,8})$/i)
  if (hex) {
    const d = hex[1]
    const wide = d.length > 4
    const step = wide ? 2 : 1
    const part = (n) => parseInt(d.slice(n * step, n * step + step).padEnd(step, d[0]), 16)
    const alpha = wide && d.length === 8 ? part(3) / 255 : 1
    return { r: part(0), g: part(1), b: part(2), a: alpha }
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i)
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  return undefined
}

function colorOf(value) {
  const direct = parseColor(value)
  if (direct) return direct
  const mix = value.match(/color-mix\(\s*in\s+srgb\s*,\s*(.+?)\s+([\d.]+)%\s*,\s*(transparent|#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*\)/i)
  if (!mix) return undefined
  const base = colorOf(mix[1])
  const weight = Number(mix[2]) / 100
  if (!base) return undefined
  if (mix[3].toLowerCase() === 'transparent') return { ...base, a: base.a * weight }
  const other = colorOf(mix[3])
  if (!other) return undefined
  const share = 1 - weight
  return {
    r: base.r * weight + other.r * share,
    g: base.g * weight + other.g * share,
    b: base.b * weight + other.b * share,
    a: base.a * weight + other.a * share,
  }
}

function over(ink, ground) {
  if (ink.a >= 1) return ink
  return {
    r: ink.r * ink.a + ground.r * (1 - ink.a),
    g: ink.g * ink.a + ground.g * (1 - ink.a),
    b: ink.b * ink.a + ground.b * (1 - ink.a),
    a: 1,
  }
}

const channel = (c) => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = ({ r, g, b }) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)

/** WCAG contrast ratio. */
function contrast(ink, ground) {
  const a = luminance(over(ink, ground))
  const b = luminance(ground)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

const hex = (c) => '#' + [c.r, c.g, c.b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()

/* -------------------------------------------------------------------- input */

const failures = []
const fail = (section, detail) => failures.push(`${section}: ${detail}`)

const read = (path) => readFileSync(path, 'utf8')
/* The sheet set and its cascade order are the artifact's, not this checker's invention: both
 * come from the shared manifest (tools/lib/sheets.mjs), the same list build-client joins into
 * the bundle. Last-wins readings therefore fall to whichever sheet ships last — the cascade's
 * own winner. The directory itself is scanned only to catch the opposite mistake out loud: a
 * .css sitting in styles/ but not on the manifest ships nowhere, and a manifest sheet missing
 * from disk means the artifact would be built short a sheet. Either one refuses the check. */
const stylesDir = STYLES
const manifestSheets = SHEETS.map(({ sheet }) => join(stylesDir, sheet))
const absent = manifestSheets.filter((p) => !existsSync(p))
if (absent.length > 0) throw new Error(`sheets the manifest ships are missing under ${STYLES}: ${absent.join(', ')}`)
const strays = existsSync(stylesDir)
  ? readdirSync(stylesDir).filter(n => n.endsWith('.css') && !SHEETS.some(({ sheet }) => sheet === n)).sort()
  : []
if (strays.length > 0) throw new Error(`sheets not on the shipping manifest (tools/lib/sheets.mjs) — they ship nowhere: ${strays.join(', ')}`)
const panelSheets = manifestSheets
const pages = existsSync(PREVIEW)
  ? readdirSync(PREVIEW).filter(n => n.endsWith('.html')).sort().map(n => join(PREVIEW, n))
  : []

if (!existsSync(THEME_SHEET)) throw new Error(`no theme sheet at ${THEME_SHEET}`)

const rel = (p) => relative(ROOT, p).split(sep).join('/')
const themeRules = parseRules(read(THEME_SHEET))
const panelFiles = panelSheets.map(path => ({ path, rules: parseRules(read(path)) }))

/* Token map per palette: theme `:root` then the palette block, then every panel
 * sheet's own `:root`-ish declarations (last wins, which is how the ramp's
 * per-day ink is read). */
function paletteMap(palette) {
  const map = new Map()
  const collect = (rules, test) => {
    for (const rule of rules) {
      if (!rule.selectors.some(test)) continue
      for (const [name, value] of rule.declarations) if (name.startsWith('--')) map.set(name, value)
    }
  }
  collect(themeRules, s => s === ':root')
  collect(themeRules, s => s === 'body')
  if (palette === 'dark') collect(themeRules, s => s.includes('data-ds-dark-theme'))
  // Panel sheets: `body` first (the panel's own ladder lives there, beside the
  // theme's aliases), then `:root` numbers, then the per-state declarations. The
  // sheets are stored layer-prefixed; `bareSelector` folds them back to this shape.
  for (const file of panelFiles) collect(file.rules, s => s === 'body')
  for (const file of panelFiles) collect(file.rules, s => s === ':root')
  for (const file of panelFiles) collect(file.rules, s => /^\.pf-/.test(s) && s.includes('['))
  return map
}

const PALETTES = { light: paletteMap('light'), dark: paletteMap('dark') }

/* Section banners carry names, not numbers: the source's blocks are laid out by subject, not
 * in report order, and a number here would drift against the report's own index. The report
 * below is where the rows are numbered. */

/* ------------------------------------------------------ colours, aliases */

const LITERAL = /(#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\()/i
/** Aliases a feature sheet may spend. Anything else is either the theme's own
 * business or a raw palette step. */
const ALIAS_FAMILIES = /^--(?:dsw-alias-|dsw-elevation|dsw-menu-|dsw-mask-|dsw-radius-|dsw-font-|dsw-focus-|dsw-corner-shape|dsw-specific-|ds-font-|ds-ease-|ds-transition-|pf-)/

let literalCount = 0
let rawStepCount = 0
/* Every custom property the sheets declare themselves: a component may own one for
 * its own layout contract, and reading it back is what makes that a contract. */
const declared = new Set()
/* Declarations the panel sheets make themselves. `--pf-*` is this panel's own
 * vocabulary (ink steps, marks, the two floors), so where it is declared is the
 * thing to ask about: the theme sheet carries none of it. */
const panelDeclared = new Set()
for (const file of panelFiles) {
  for (const rule of file.rules) for (const [property] of rule.declarations) if (property.startsWith('--')) panelDeclared.add(property)
}
for (const file of [...panelFiles, { path: THEME_SHEET, rules: themeRules }]) {
  for (const rule of file.rules) for (const [property] of rule.declarations) if (property.startsWith('--')) declared.add(property)
}
/** Properties a page's script passes in, each with a fallback where it is read. */
const optional = new Set([...[...panelFiles].flatMap(file => [...read(file.path).matchAll(/var\(\s*(--[\w-]+)\s*,/g)].map(([, name]) => name))])
/* Custom properties the client's TSX writes inline, so no sheet may declare a value for them:
 * the map's card box (`map.tsx`, from `map-layout.ts`'s `CARD_W` / `CARD_H`). The sheet reads
 * them fallback-less on purpose — the inline style is the only writer, and a CSS-declared copy
 * could only drift. */
const scriptWritten = new Set(['--card-w', '--card-h'])
for (const file of panelFiles) {
  for (const rule of file.rules) {
    for (const [property, value] of rule.declarations) {
      if (LITERAL.test(value)) {
        literalCount += 1
        fail('literal colour', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
      }
      for (const name of varNames(value)) {
        if (name.startsWith('--dsw-static-')) {
          rawStepCount += 1
          fail('raw palette step', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
        } else if (!ALIAS_FAMILIES.test(name) && !declared.has(name) && !optional.has(name) && !scriptWritten.has(name)) {
          fail('unknown token family', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${name} }`)
        }
      }
    }
  }
}

/* Theme selectors stay out of a feature sheet: light/dark is the theme owner's. */
const THEME_SELECTOR = /(data-ds-dark-theme|data-theme|prefers-color-scheme|\.dark\b|\bdark-mode\b)/
let themeSelectorCount = 0
for (const file of panelFiles) {
  for (const rule of file.rules) {
    if (rule.at && THEME_SELECTOR.test(rule.at) && !/prefers-reduced-motion/.test(rule.at)) {
      themeSelectorCount += 1
      fail('theme selector', `${rel(file.path)} ${rule.at}`)
    }
    for (const selector of rule.selectors) {
      if (THEME_SELECTOR.test(selector)) {
        themeSelectorCount += 1
        fail('theme selector', `${rel(file.path)} ${selector}`)
      }
    }
  }
}

/* --------------------------------------------------------- theme aliases */

/* Both palettes have to define every alias the panel reads. */
const panelTokens = new Set()
for (const file of panelFiles) {
  for (const rule of file.rules) for (const [, value] of rule.declarations) for (const name of varNames(value)) panelTokens.add(name)
}
let undefinedTokens = 0
for (const name of [...panelTokens].sort()) {
  if (!name.startsWith('--dsw-') && !name.startsWith('--ds-')) continue
  for (const palette of ['light', 'dark']) {
    if (!PALETTES[palette].has(name)) {
      undefinedTokens += 1
      fail('alias not defined by the theme', `${name} (${palette})`)
    }
  }
}

/* ---------------------------------------------------------- panel tokens */

/* The same question on the panel's own side: a `--pf-*` name with a letter off
 * (`--pf-ink44`) paints nothing in either palette, raises nothing, and every mark it
 * inks just goes missing. A name a page's script hands in is written with a fallback. */
let undeclaredPanelTokens = 0
for (const name of [...panelTokens].sort()) {
  if (!name.startsWith('--pf-')) continue
  if (!panelDeclared.has(name) && !optional.has(name)) {
    undeclaredPanelTokens += 1
    fail('panel token not declared', name)
  }
}

/* --------------------------------------------- radius scale, full-round pair */

const themeTokens = new Set([...PALETTES.light.keys()])
let radiusOffScale = 0
let fullRoundUnpaired = 0
const RADIUS_PROPERTY = /^(?:border(?:-[a-z]+)*?-radius|--dsl-[\w-]*radius)$/
for (const file of [...panelFiles, { path: THEME_SHEET, rules: themeRules }]) {
  for (const rule of file.rules) {
    const declarations = rule.declarations
    for (const [property, value] of declarations) {
      if (!RADIUS_PROPERTY.test(property)) continue
      const offScale = [...value.matchAll(/\b(\d+(?:\.\d+)?)px\b/g)].some(([, n]) => Number(n) > 4 && Number(n) < 99)
      const missingToken = varNames(value).some(n => n.startsWith('--dsw-radius-') && !themeTokens.has(n))
      if (offScale || missingToken) {
        radiusOffScale += 1
        fail('radius off the shared scale', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
      }
    }
    const fullRound = declarations.some(([property, value]) => property === 'border-radius'
      && value.split(/\s+/).some(part => part === '50%' || part === '100%' || (part.endsWith('px') && Number.parseFloat(part) >= 99)))
    if (fullRound && !declarations.some(([property, value]) => property === 'corner-shape' && value === 'round')) {
      fullRoundUnpaired += 1
      fail('full-round radius without corner-shape: round', `${rel(file.path)} ${rule.selectors.join(', ')}`)
    }
  }
}

/* ------------------------------------------------ borders and elevation */

const ELEVATED_SHADOW = /--dsw-(?:elevation-|shadow-lv)/
const NEUTRAL_BORDER = /--dsw-alias-border-/
const STATE_COLOR = /--dsw-alias-state-|--dsw-alias-link/
const BORDER_EDGE = /^border(?:-top|-bottom|-left|-right)?(-width)?$/
/* Ring tracks: the border is the drawn graphic (a rotating ring), not an outline,
 * so it keeps its width — the same exemption the theme's elevation spec spells out.
 * The panel draws this ring in two places, but the rule lives once, in the
 * tokens.css shared block (lines.css keeps only the linemark size box). */
const RING_TRACKS = new Set(['tokens.css .pf-state.is-run'])
let elevationPairedWithBorder = 0
let neutralBorderWide = 0
let stateBorderNarrow = 0
let filledDividerWide = 0
for (const file of panelFiles) {
  for (const rule of file.rules) {
    const elevated = rule.declarations.some(([property, value]) => property === 'box-shadow' && ELEVATED_SHADOW.test(value))
    if (elevated) {
      const bordered = rule.declarations.some(([property, value]) => property.startsWith('border') && !property.startsWith('border-radius') && NEUTRAL_BORDER.test(value))
      if (bordered) {
        elevationPairedWithBorder += 1
        fail('elevation shadow beside a neutral border', `${rel(file.path)} ${rule.selectors.join(', ')}`)
      }
      const paintsMenu = rule.declarations.some(([property, value]) => (property === 'background' || property === 'background-color')
        && /--dsw-(?:specific-menu|menu-surface-fill)/.test(value))
      if (paintsMenu && !rule.declarations.some(([property, value]) => property === 'backdrop-filter' && value === 'var(--dsw-menu-backdrop-filter)')) {
        fail('menu fill without the shared backdrop filter', `${rel(file.path)} ${rule.selectors.join(', ')}`)
      }
    }
    for (const [property, value] of rule.declarations) {
      if (BORDER_EDGE.test(property) && value.includes('solid')) {
        const width = resolveVars(value, PALETTES.light).trim().split(/\s+/)[0]
        const exempt = rule.selectors.some(s => RING_TRACKS.has(`${rel(file.path).split('/').pop()} ${s}`))
        if (NEUTRAL_BORDER.test(value) && width !== '0.5px' && !exempt) {
          neutralBorderWide += 1
          fail('neutral border off the hairline', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
        }
        if (STATE_COLOR.test(value) && width !== '1px') {
          stateBorderNarrow += 1
          fail('state-coloured border not 1px', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
        }
      }
      if ((property === 'background' || property === 'background-color') && NEUTRAL_BORDER.test(value)) {
        const box = rule.declarations.find(([p]) => p === 'height' || p === 'width')
        if (box && box[1].trim() === '1px') {
          filledDividerWide += 1
          fail('filled divider off the hairline', `${rel(file.path)} ${rule.selectors.join(', ')} { ${box[0]}: 1px }`)
        }
      }
    }
  }
}

/* ------------------------------------------------------ menus, links */

let menuRoleContainers = 0
let nativeSelects = 0
let anchors = 0
for (const page of pages) {
  const text = read(page)
  const roles = [...text.matchAll(/role="(menu|listbox)"/g)]
  menuRoleContainers += roles.length
  for (const role of roles) {
    // A static page has no MenuSurface component to wrap anything in, so a
    // menu role here means a second menu material was invented.
    fail('menu role without MenuSurface', `${rel(page)} role="${role[1]}"`)
  }
  nativeSelects += [...text.matchAll(/<select\b/g)].length
  anchors += [...text.matchAll(/<a\s/g)].length
}

let menuMaterialOverrides = 0
for (const file of panelFiles) {
  for (const rule of file.rules) {
    for (const [property, value] of rule.declarations) {
      if (property === '--dsw-menu-surface-fill' || property === '--dsw-menu-backdrop-filter' || property === '--dsw-specific-menu') {
        menuMaterialOverrides += 1
        fail('menu material redefined outside the theme', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property} }`)
      }
      if (property === 'backdrop-filter' && value !== 'var(--dsw-menu-backdrop-filter)') {
        fail('backdrop filter not the theme material', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
      }
    }
  }
  for (const rule of file.rules) {
    for (const selector of rule.selectors) {
      if (!/(^|[\s,>+~])a(?::|[\s,>+~.]|$)/.test(selector)) continue
      const colored = rule.declarations.some(([property, value]) => (property === 'color' || property.startsWith('border')) && value.includes('--dsw-alias-link'))
      if (!colored) fail('link selector without the link alias', `${rel(file.path)} ${selector}`)
    }
  }
}

/* -------------------------------------------- hover and the card face */

/* A card carries a reading on its own surface: the amber ring that says a person
 * has to move is an inset shadow on `.pf-card`, and the card's raised look is its
 * fill. A hover that paints either does two things at once — it covers the ring
 * (the reading is gone while the pointer is on it) and, because both paint through
 * the same transition, it sweeps a solid block through the interpolation. So a hover
 * on a card moves the stroke and leaves the face alone; a row keeps its fill. */
const CARD = /\.(?:pf-card|pf-zcard|pf-case)(?![\w-])/
const HOVER = /:(?:hover|active)\b/
const FACE_INK = new Set(['background', 'background-color', 'box-shadow', 'filter', 'backdrop-filter', 'opacity'])
let hoverPaintsFace = 0
for (const file of panelFiles) {
  for (const rule of file.rules) {
    if (!rule.selectors.some(s => CARD.test(s) && HOVER.test(s))) continue
    for (const [property, value] of rule.declarations) {
      if (!FACE_INK.has(property)) continue
      hoverPaintsFace += 1
      fail('card hover paints the face', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} }`)
    }
  }
}

/* -------------------------- panel tokens that would resolve to nothing */

/* The theme declares its aliases on `body`, and a custom property's var() is
 * substituted where the declaration sits. A panel token declared on `:root` or
 * `html` therefore resolves against an element that has no alias yet, computes
 * to the guaranteed-invalid value, and paints nothing — in both palettes. */
const ALIAS_READ = /var\(\s*--(?:dsw|ds)-/
let rootTokensWithAlias = 0
for (const file of panelFiles) {
  for (const rule of file.rules) {
    if (!rule.selectors.some(s => s === ':root' || s === 'html' || s === 'html, body' || s === 'body, html')) continue
    for (const [property, value] of rule.declarations) {
      if (!property.startsWith('--')) continue
      if (ALIAS_READ.test(value) || panelTokensFeed(value)) {
        rootTokensWithAlias += 1
        fail('panel token on html with a theme alias in it', `${rel(file.path)} ${rule.selectors.join(', ')} { ${property}: ${value} } — declare it on body`)
      }
    }
  }
}
function panelTokensFeed(value, depth = 0) {
  if (depth > 6) return false
  for (const name of varNames(value)) {
    if (!name.startsWith('--pf-')) continue
    for (const file of panelFiles) {
      for (const rule of file.rules) {
        for (const [property, declared] of rule.declarations) {
          if (property !== name) continue
          if (ALIAS_READ.test(declared) || panelTokensFeed(declared, depth + 1)) return true
        }
      }
    }
  }
  return false
}

/* -------------------------------------------- the mark inks and floors */

const floorOf = (name, fallback) => {
  const found = PALETTES.light.get(name)
  const value = found === undefined ? undefined : Number(resolveVars(found, PALETTES.light))
  return Number.isFinite(value) ? value : fallback
}
const FLOOR = { A: floorOf('--pf-mark-floor', 3), B: floorOf('--pf-mark-floor-dense', 1.5) }

/**
 * The marks this panel paints, each tied to the rule that paints it: the check
 * fails when a sheet stops saying what the table says it says. `tier` is the floor
 * the mark answers to ('A' a mark the reader resolves on its own, 'B' one read as
 * part of a dense row), or null for a reading that is the theme's own value rather
 * than a choice made here.
 *
 * `where` is the instance the reading belongs to, `decl` the rule whose declaration
 * carries the ink (defaulting to `where`). The two differ where one rule paints the
 * same mark in two places that stand on different grounds — a board card
 * (`.pf-card`, `--dsw-alias-bg-layer-1`) and a detail row (`.pf-row`,
 * `--dsw-alias-bg-base`) — so one row per place.
 */
const MARKS = [
  { what: 'register mark · resolved', where: '.pf-cell', property: 'background', ink: 'var(--pf-ink-2)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'card state mark · entering next', where: '.pf-card .pf-state.is-next', decl: '.pf-state.is-next', property: 'border', ink: 'var(--pf-ink-3)', ground: '--dsw-alias-bg-layer-1', tier: 'A' },
  { what: 'detail row mark · entering next', where: '.pf-row .pf-state.is-next', decl: '.pf-state.is-next', property: 'border', ink: 'var(--pf-ink-3)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'issue pool mark · acknowledged', where: '.pf-cell.is-acknowledged', property: 'box-shadow', ink: 'var(--pf-ink-2)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'issue pool mark · rejected', where: '.pf-cell.is-rejected', property: 'box-shadow', ink: 'var(--pf-ink-3)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'severity tier · heaviest (P0)', where: '.is-P0', property: '--sev', ink: 'var(--pf-ink-1)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'severity tier · second (P1)', where: '.is-P1', property: '--sev', ink: 'var(--pf-ink-2)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'severity tier · third (P2)', where: '.is-P2', property: '--sev', ink: 'var(--pf-ink-3)', ground: '--dsw-alias-bg-base', tier: 'A' },
  { what: 'severity tier · lightest (P3, the dense row)', where: '.is-P3', property: '--sev', ink: 'var(--pf-ink-4)', ground: '--dsw-alias-bg-base', tier: 'B' },
  { what: 'weight bar cell · empty slot', where: '.pf-block', property: 'box-shadow', ink: 'var(--pf-ink-4)', ground: '--dsw-alias-bg-base', tier: 'B' },
  /* The amber ring is an inset shadow on the card's own face, so the card's fill is
   * its ground — not the layer the card itself sits on. */
  { what: 'card gate · amber ring', where: '.pf-card.is-gate', property: 'box-shadow', ink: 'var(--dsw-alias-state-warn-primary)', ground: '--dsw-alias-bg-layer-1', tier: null },
  { what: 'card state mark · delivered', where: '.pf-card .pf-state.is-done', decl: '.pf-state.is-done', property: 'color', ink: 'var(--dsw-alias-state-success-primary)', ground: '--dsw-alias-bg-layer-1', tier: null },
  { what: 'detail row mark · delivered', where: '.pf-row .pf-state.is-done', decl: '.pf-state.is-done', property: 'color', ink: 'var(--dsw-alias-state-success-primary)', ground: '--dsw-alias-bg-base', tier: null },
  /* The same rule paints this ring on three grounds: a board card, a detail row, and the map's own
   * face, where it leads the foot row of the card in hand. The first of the three has no instance on
   * the page right now, so its row is read where it would stand. */
  { what: 'card state mark · running', where: '.pf-card .pf-state.is-run', decl: '.pf-state.is-run', property: 'color', ink: 'var(--dsw-alias-link)', ground: '--dsw-alias-bg-layer-1', tier: null },
  { what: 'detail row mark · running', where: '.pf-row .pf-state.is-run', decl: '.pf-state.is-run', property: 'color', ink: 'var(--dsw-alias-link)', ground: '--dsw-alias-bg-base', tier: null },
  { what: 'map card · running', where: '.pf-mnode .pf-state.is-run', decl: '.pf-state.is-run', property: 'color', ink: 'var(--dsw-alias-link)', ground: '--dsw-alias-bg-layer-2', tier: null },
  { what: 'issue pool mark · open', where: '.pf-cell.is-open', property: 'box-shadow', ink: 'var(--dsw-alias-state-warn-primary)', ground: '--dsw-alias-bg-base', tier: null },
  { what: 'line mark · blocked node', where: '.pf-linemark.is-blocked::before', property: 'background', ink: 'var(--dsw-alias-state-warn-primary)', ground: '--dsw-alias-bg-base', tier: null },
  /* The delete dialog's alert zone: the bar is the mark, and the layer the dialog
   * itself stands on is its ground — the amber tint under the sentence is 8%, so the
   * bar reads against that layer and the check can keep saying so. */
  { what: 'delete-this row · alert zone left edge', where: '.pf-del-warn', property: 'box-shadow', ink: 'var(--dsw-alias-state-warn-primary)', ground: '--dsw-alias-bg-layer-2', tier: null },
  { what: 'the theme\'s own idle point (the basis of the 1.5 floor)', where: null, property: null, ink: 'var(--dsw-alias-state-idle-primary)', ground: '--dsw-alias-bg-base', tier: null },
]

const findDeclaration = (selector, property) => {
  for (const file of panelFiles) {
    for (const rule of file.rules) {
      if (!rule.selectors.includes(selector)) continue
      const hit = rule.declarations.find(([p]) => p === property)
      if (hit) return { file, value: hit[1] }
    }
  }
  return undefined
}

const readings = []
let markFailures = 0
for (const mark of MARKS) {
  const decl = mark.decl ?? mark.where
  if (decl !== null) {
    const found = findDeclaration(decl, mark.property)
    if (!found) {
      markFailures += 1
      fail('mark rule missing', `${decl} { ${mark.property} } (${mark.what})`)
      continue
    }
    if (!found.value.includes(mark.ink)) {
      markFailures += 1
      fail('mark ink moved', `${decl} { ${mark.property}: ${found.value} } — the table reads ${mark.ink} (${mark.what})`)
      continue
    }
  }
  const row = { what: mark.what, where: mark.where ?? '(theme)', ink: mark.ink, ground: mark.ground, tier: mark.tier, floor: mark.tier === null ? null : FLOOR[mark.tier], reading: {} }
  for (const palette of ['light', 'dark']) {
    const map = PALETTES[palette]
    const ink = colorOf(resolveVars(mark.ink, map))
    const ground = colorOf(resolveVars(`var(${mark.ground})`, map))
    if (!ink || !ground) {
      markFailures += 1
      fail('mark ink unresolvable', `${mark.what} (${palette}): ${mark.ink} / ${mark.ground}`)
      continue
    }
    const ratio = contrast(ink, ground)
    row.reading[palette] = { ratio, ink: hex(over(ink, ground)), ground: hex(ground) }
    if (row.floor !== null && ratio < row.floor) {
      markFailures += 1
      fail('mark under its floor', `${mark.what} (${palette}): ${ratio.toFixed(2)}:1 < ${row.floor}:1`)
    }
  }
  readings.push(row)
}

/* -------------------------------------------- names meaning two things */

/* A name's own declarations in one file: the rules whose selector is a compound that
 * starts with it (`.pf-mark`, `.pf-mark:hover`). Rules that merely mention it further
 * along (`.pf-line:hover .pf-chev`) style something else, not that object's own shape. */
const NAME_RULE = (name) => new RegExp(`^\\.${name}(?![\\w-])`)
/** (selector, file) -> property -> value. */
const bySelector = new Map()
const namesOf = new Map()
for (const file of panelFiles) {
  for (const rule of file.rules) {
    for (const selector of rule.selectors) {
      const names = [...selector.matchAll(/\.(pf-[\w-]+)/g)].map(([, n]) => n).filter(n => NAME_RULE(n).test(selector))
      if (!names.length) continue
      const key = selector
      if (!bySelector.has(key)) bySelector.set(key, new Map())
      const perFile = bySelector.get(key)
      if (!perFile.has(file.path)) perFile.set(file.path, new Map())
      for (const [property, value] of rule.declarations) perFile.get(file.path).set(property, value)
      for (const name of names) {
        if (!namesOf.has(name)) namesOf.set(name, new Set())
        namesOf.get(name).add(key)
      }
    }
  }
}
/** Selectors two files declare with a different value for one property: one class, two
 * objects — latent until two views share one document. */
const collisions = new Map()
for (const [selector, perFile] of [...bySelector].sort()) {
  if (perFile.size < 2) continue
  const files = [...perFile.keys()]
  const disagreed = new Set()
  for (let i = 0; i < files.length; i += 1) {
    for (let j = i + 1; j < files.length; j += 1) {
      for (const [property, value] of perFile.get(files[i])) {
        const other = perFile.get(files[j]).get(property)
        if (other === undefined || other === value) continue
        disagreed.add(`${property}: ${value} / ${other}`)
      }
    }
  }
  if (!disagreed.size) continue
  for (const [name, selectors] of namesOf) {
    if (!selectors.has(selector)) continue
    if (!collisions.has(name)) collisions.set(name, { name, files: new Set(), why: new Set() })
    const entry = collisions.get(name)
    for (const f of files) entry.files.add(rel(f))
    entry.why.add(`${selector} :: ${[...disagreed].join('; ')}`)
  }
}

/* --------------------------------------------- sheets and their pages */

/* Every link a preview page writes must resolve; a shipped sheet missing from the pages' links
 * says nothing — the pages link their own page-shaped sheets. */
const linked = new Set()
let brokenHref = 0
for (const page of pages) {
  for (const [, href] of read(page).matchAll(/<link[^>]+href="([^"]+)"/g)) {
    const target = resolve(PREVIEW, href)
    if (!existsSync(target) || !statSync(target).isFile()) {
      brokenHref += 1
      fail('link target missing', `${rel(page)} -> ${href}`)
    }
    linked.add(target)
  }
}

/* ------------------------------------------------------------------- report */

const line = (text = '') => { if (!QUIET) console.log(text) }
const pad = (text, width) => String(text).padEnd(width)

line(`css-check · root ${ROOT}`)
line(`sheets: theme 1, panel ${panelSheets.length} (${panelSheets.map(p => rel(p).replace('src/client/styles/', '')).join(', ')})`)
line('')
line(`1  colours         literals ${literalCount}, raw palette steps ${rawStepCount}, theme selectors ${themeSelectorCount}`)
line(`2  radii           off scale ${radiusOffScale}, unpaired full-round ${fullRoundUnpaired}`)
line(`3  elevation       shadow beside a neutral border ${elevationPairedWithBorder}`)
line(`4  borders         neutral not 0.5px ${neutralBorderWide}, state not 1px ${stateBorderNarrow}, filled dividers not 0.5px ${filledDividerWide}`)
line(`5  menus           menu-role containers ${menuRoleContainers}, native selects ${nativeSelects}, material overrides ${menuMaterialOverrides}`)
line(`6  links           anchors ${anchors}`)
line(`7  theme aliases   read ${panelTokens.size}, undefined ${undefinedTokens}`)
line(`7b panel tokens    read ${panelTokens.size}, undeclared ${undeclaredPanelTokens}`)
line(`8  marks           rows ${readings.length}, under floor ${markFailures}`)
line(`9  class names     one selector two meanings ${collisions.size}`)
line(`10 page links      hrefs checked ${linked.size}, broken ${brokenHref}`)
line(`11 card hover      face-ink declarations ${hoverPaintsFace}`)
line(`12 panel tokens on html that read an alias (would paint nothing): ${rootTokensWithAlias}`)
line('')
line('floors, read from --pf-mark-floor / --pf-mark-floor-dense in src/client/styles/tokens.css:')
line(`  a mark the reader resolves on its own >= ${FLOOR.A}:1 · one read as density >= ${FLOOR.B}:1`)
line('')
line('mark inks with a floor — all of these pass:')
line(`${pad('mark', 40)}${pad('ink', 10)}${pad('ground', 10)}${pad('light', 22)}${pad('dark', 22)}floor`)
const cellOf = (row, palette) => {
  const r = row.reading[palette]
  return r ? `${r.ratio.toFixed(2)}:1 ${r.ink}` : '—'
}
const rowLine = (row) => `${pad(row.what, 40)}${pad(row.ink.replace('var(', '').replace(')', ''), 10)}${pad(String(row.ground).replace('--dsw-alias-', ''), 10)}${pad(cellOf(row, 'light'), 22)}${pad(cellOf(row, 'dark'), 22)}${row.floor === null ? 'theme' : row.floor + ':1'}`
for (const row of readings.filter(r => r.floor !== null)) line(rowLine(row))
line('')
line('the theme\'s own state hues and structure, read for the record (the panel paints')
line('what the theme defines and these are not this panel\'s numbers to move):')
for (const row of readings.filter(r => r.floor === null)) line(rowLine(row))
line('')
line('names two modules declare with different values — one class, two objects. No single')
line('document loads both of these today, so each is latent until two views share one page;')
line('the day they do, each of these names needs one meaning:')
for (const entry of [...collisions.values()].sort((a, b) => a.name.localeCompare(b.name))) {
  line(`  ${entry.name} — ${[...entry.files].join(', ')}`)
  for (const why of entry.why) line(`      ${why}`)
}
line('')
if (failures.length) {
  line(`FAIL ${failures.length}`)
  for (const f of failures) line(`  ${f}`)
  process.exit(1)
}
line(`PASS — ${panelSheets.length} panel sheets, ${readings.length} marks in 2 palettes, 0 failures`)