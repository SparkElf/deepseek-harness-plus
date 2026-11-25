// @ts-nocheck
/**
 * Copy text from the browser, including plain-HTTP deployments.
 *
 * The workbench runs inside the DataOps portal over `http://<lan-ip>`, which is not a
 * secure context: `navigator.clipboard` is undefined there. Asking it directly turns
 * every "Copy DDL" click into an error, so the selection fallback is not optional.
 * @param text - exact text to place on the clipboard.
 * @returns whether a copy path succeeded; callers surface the failure themselves.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Insecure context or a denied permission; fall through to the selection copy.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch {
    return false
  }
}
