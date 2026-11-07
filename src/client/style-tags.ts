/**
 * The markers of the injected stylesheets in the document, plus the "mount" and "unmount" actions.
 *
 * The markers and these two actions live here, apart from the sheet bodies, so that unmounting only
 * needs the two markers and never drags in a whole sheet body. Mounting once is enough: mounting
 * goes by the marker, regardless of which call mounted it. If mounting failed or someone already
 * unmounted, unmounting does not throw.
 */

/** Marker of the panel's stylesheets. */
export const PANEL_STYLE_ID = 'dsh-superworker-panel-style'

/** Marker of the settings section. */
export const SETTINGS_STYLE_ID = 'dsh-superworker-settings-style'

export function ensureStyleTag(id: string, css: string): void {
  try {
    if (document.getElementById(id) !== null) return
    const style = document.createElement('style')
    style.id = id
    style.textContent = css
    document.head.appendChild(style)
  } catch (error) {
    /* A sheet that fails to mount is still better than no panel: draw without styles. */
  }
}

export function dropStyleTag(id: string): void {
  try {
    document.getElementById(id)?.remove()
  } catch (error) {
    /* Unmount failures must not break unloading: there is more to restore after this point. */
  }
}