/**
 * Safety net for the one case the slot override cannot cover.
 *
 * Shadowing `settings.launcher` is the whole mechanism: while our registration
 * wins, the official signed-out menu does not exist in the DOM. If another
 * contributor ever takes the cell at a lower priority, or this plugin's
 * registration is rejected, the official menu comes back — and its last row is
 * a DeepSeek sign-in action that cannot work in a DataOps deployment.
 *
 * The sweep is deliberately narrow: only the official signed-out menu
 * (`[role="menu"].yHnPSG_signedOutMenu`) is considered, and inside it only the
 * row carrying the official user icon is removed. Settings and Feedback carry
 * different artwork, so no text matching and no ordinal guess is involved.
 *
 * @module @sparkelf/dsh-dataops-account/client/dom-guard
 */

const OFFICIAL_SIGNED_OUT_MENU = '[role="menu"].yHnPSG_signedOutMenu'
/** First path of `IconUserOutlineMedium` (the icon the sign-in row renders). */
const SIGN_IN_ICON_PATH_PREFIX = 'M8 8.25C9.51878'

const removeSignInRows = (root: ParentNode): void => {
  for (const menu of root.querySelectorAll(OFFICIAL_SIGNED_OUT_MENU)) {
    for (const item of menu.querySelectorAll('[role="menuitem"]')) {
      const carriesUserIcon = [...item.querySelectorAll('svg path')].some(
        path => (path.getAttribute('d') ?? '').startsWith(SIGN_IN_ICON_PATH_PREFIX),
      )
      if (carriesUserIcon) item.remove()
    }
  }
}

/**
 * Watch for the official signed-out menu and drop its sign-in row.
 * @returns disposer that stops the observer.
 */
export const installSignedOutMenuGuard = (): (() => void) => {
  removeSignInRows(document)
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element) removeSignInRows(node)
        else if (node.parentElement !== null) removeSignInRows(node.parentElement)
      }
    }
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}