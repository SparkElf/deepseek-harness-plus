/**
 * Copy text from a sidebar page.
 *
 * `navigator.clipboard` needs a secure context; a DataOps deployment served over plain
 * HTTP on a LAN address is not one, so the fallback is required rather than defensive.
 * @param text - what to put on the clipboard.
 * @returns whether the copy succeeded.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard !== undefined && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Fall through to the selection-based path.
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}
