/**
 * The panel's own stylesheets.
 *
 * The sheets live in `src/client/styles/`, in the shape they ship in, and the build joins them into
 * `virtual:superworker-styles`; that source is the single one, so no second copy lives here. DSH theme values
 * are not bundled: the real panel's aliases are provided by the shell.
 */
import css from 'virtual:superworker-styles'
import { PANEL_STYLE_ID, dropStyleTag, ensureStyleTag } from './style-tags.ts'

export const PANEL_CSS: string = css

export function ensureStyle(): void {
  ensureStyleTag(PANEL_STYLE_ID, PANEL_CSS)
}

export function dropStyle(): void {
  dropStyleTag(PANEL_STYLE_ID)
}