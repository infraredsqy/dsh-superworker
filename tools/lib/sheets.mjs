/**
 * The sheets that ship, in cascade order, each with the one layer class its selectors must lead
 * with. One list for every reader of the panel's styles: `build-client.mjs` joins it into the
 * artifact, `css-check.mjs` asks its questions over exactly these files in exactly this order —
 * a sheet not on this list does not ship, and a check run over any other set would answer
 * questions about a page that is never built.
 *
 * Order is load-bearing. The embedded sheet is a standalone document where it was drawn, and inside
 * the panel it competes with the main panel's sheets for the same element names (`.superworker-row` in the
 * detail pane, the main panel's own `.superworker-head`); it wins those by "same specificity, later in
 * order", so it follows the main panel's sheets here. The main panel's sheet order follows the layer
 * order a reader sees.
 */
export const SHEETS = [
  { sheet: 'tokens.css', root: '.superworker-page' },
  { sheet: 'main.css', root: '.superworker-page' },
  { sheet: 'map.css', root: '.superworker-page' },
  { sheet: 'lines.css', root: '.superworker-page' },
  { sheet: 'detail.css', root: '.superworker-page' },
  { sheet: 'notes.css', root: '.superworker-page' },
  { sheet: 'register.css', root: '.superworker-issue' },
  { sheet: 'settings.css', root: '.superworker-page' },
]

/**
 * The layer classes those sheets lead their selectors with — the `root` column above, deduped, in
 * the same order. Both readers of this table take the set from here: `build-client.mjs` hands it to
 * its scoping check, `css-check.mjs` folds shipped selectors back to the page shape with it. A class
 * no sheet leads with is not a layer, so it is not a layer class; adding a sheet is the one move that
 * widens it.
 */
export const LAYER_CLASSES = [...new Set(SHEETS.map(({ root }) => root))]
