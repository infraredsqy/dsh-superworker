// Build entry for the browser half's artifact: join the panel's stylesheets and bundle them with
// its React half into `lib/client.js` for the shell.
//
//   node tools/build-client.mjs
//
// The sheets in `src/client/styles/` are written in the shape they ship in: every selector already
// leads with its cell's layer class (`.superworker-page` on the main panel, `.superworker-issue` on the embedded issue
// pane). A sheet written for a document of its own carries `body { overflow: hidden }`, `:root`
// tokens and a `*` reset, none of which belong on DSH's document — the `overflow` alone would hide
// the shell. The source is the artifact, so all this entry does with styles is read the sheets in
// order and join them.
//
// One check stays at build time: a selector that escapes its layer lands on the host page, fails
// silently inside the panel, and can break DSH's own shell. A leak stops the build.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rolldown } from 'rolldown'
import { cssBlocks } from './lib/cssrules.mjs'
import { LAYER_CLASSES, SHEETS } from './lib/sheets.mjs'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

const STYLES = join(root, 'src', 'client', 'styles')

/**
 * Whether this selector segment carries the layer's class — compared per token, not by substring:
 * split on combinators first, then split each segment on `.` / `#` / `:` / `[` into tokens; only a
 * whole token equal to `superworker-page` counts.
 *
 * A substring version (`part.includes('.superworker-page')`) would treat names like `.superworker-pagewrap` and
 * `.superworker-pagefoot` as "already inside the panel layer", letting the whole rule escape onto the page
 * root; their tokens are `superworker-pagewrap` and the like, unequal to `superworker-page`, so the leak is caught.
 */
function hasScopeClass(part, className) {
  return part
    .split(/[\s>+~]+/u)
    .flatMap((segment) => segment.split(/[.#:[\]]/u))
    .some((token) => token === className)
}

/**
 * The layer ruler: every selector that ships must lead with one of the layer classes — the first
 * segment of a selector must genuinely carry it.
 *
 * A wrong prefix, or a segment the split fails to recognize (classes like `.superworker-pagewrap` that embed
 * the panel root's name), escapes it. Rules that miss their layer fail silently on the page while
 * styling DSH's shell, so this step stops the build instead.
 *
 * @param css - The joined sheet body.
 * @param roots - Every layer class that ships, one per sheet — taken from the sheet table's own
 *   `root` column (tools/lib/sheets.mjs), not written out again here.
 * @returns Selectors leading with no layer; empty list if none.
 */
function assertScopedProduct(css, roots) {
  const classes = roots.map((root) => root.replace(/^\./u, ''))
  const leaked = []
  /* The walk is the shared one (tools/lib/cssrules.mjs), containers descended into and
   * @keyframes carried whole — the same rules the artifact carries are the rules checked. */
  for (const block of cssBlocks(css)) {
    if (block.kind !== 'rule') continue
    for (const part of block.prelude.split(',').map((one) => one.trim()).filter((one) => one.length > 0)) {
      const head = part.split(/[\s>+~]+/u)[0]
      if (!classes.some((className) => hasScopeClass(head, className))) leaked.push(part)
    }
  }
  return [...new Set(leaked)]
}

const css = SHEETS
  .map(({ sheet }) => readFileSync(join(STYLES, sheet), 'utf8'))
  .filter((part) => part.trim().length > 0)
  .join('\n')
const leaked = assertScopedProduct(css, LAYER_CLASSES)
if (leaked.length > 0) {
  throw new Error(`build-client: a selector in the product is not on the panel's layer (it escaped into the host page):\n  ${leaked.join('\n  ')}`)
}

const bundle = await rolldown({
  input: join(root, 'src/client/index.ts'),
  platform: 'browser',
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json'],
  },
  external: ['react'],
  plugins: [
    {
      name: 'superworker-styles',
      resolveId(source) {
        return source === 'virtual:superworker-styles' ? source : null
      },
      load(id) {
        return id === 'virtual:superworker-styles' ? `export default ${JSON.stringify(css)}` : null
      },
    },
  ],
})

await bundle.write({
  format: 'cjs',
  exports: 'named',
  sourcemap: false,
  file: join(root, 'lib/client-body.js'),
})
await bundle.close()

const body = readFileSync(join(root, 'lib/client-body.js'), 'utf8')
if (body.includes('__ModuleLoader__')) throw new Error('build-client: the bundle already carries the loader shell')

const head = `window.__ModuleLoader__.load({ id: ${JSON.stringify(manifest.name)}, factory: (require) => {\n`
  + 'var module = { exports: {} }; var exports = module.exports;\n'
const tail = '\nreturn module.exports; } });\n'
writeFileSync(join(root, 'lib/client.js'), head + body + tail)
// The intermediate artifact is deleted on the spot: it is this step's input only — the plain bundle
// before the loader shell goes around it, which nothing reads once lib/client.js is written. Kept, it
// would just be a leftover under lib/ that no one removes; the shell-wrapped copy is the one that
// lives there.
rmSync(join(root, 'lib/client-body.js'))
console.log(`build-client: lib/client.js written (${String(head.length + body.length + tail.length)} chars, ${String(css.length)} chars of css)`)