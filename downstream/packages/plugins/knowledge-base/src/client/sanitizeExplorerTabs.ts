/**
 * Remove knowledge-explorer tabs that were persisted with the old placeholder id.
 *
 * Earlier builds let `@kb-explorer` reach a session-scoped sidebar tab address. The
 * tab was stored in the browser's per-session layout; after the placeholder was
 * removed from the open path, the old tab still made the restored sidebar resolve a
 * non-existent Session. This one-way migration drops only those tab records. Host fs
 * routes still use the placeholder key and are untouched.
 */

const STORAGE_PREFIX = 'dsh-sidebar:v1:'
const PLACEHOLDER = '@kb-explorer'

/** A tab whose address is scoped to the retired placeholder session. */
function isStaleExplorerTab(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const raw = JSON.stringify(value)
  return raw.includes(`session/${PLACEHOLDER}/`)
    || raw.includes('session/%40kb-explorer/')
    || raw.includes('session/@kb%2Dexplorer/')
}

/** Walk one persisted layout and drop stale tab entries from every tab list. */
function cleanNode(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false
    const next = value
      .filter(item => {
        if (isStaleExplorerTab(item)) {
          changed = true
          return false
        }
        return true
      })
      .map(item => {
        const cleaned = cleanNode(item)
        if (cleaned.changed) changed = true
        return cleaned.value
      })
    return { value: next, changed }
  }
  if (typeof value !== 'object' || value === null) return { value, changed: false }
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'tabs' && Array.isArray(child)) {
      const kept = child.filter(tab => {
        if (isStaleExplorerTab(tab)) {
          changed = true
          return false
        }
        return true
      }).map(tab => {
        const cleaned = cleanNode(tab)
        if (cleaned.changed) changed = true
        return cleaned.value
      })
      next[key] = kept
      continue
    }
    const cleaned = cleanNode(child)
    if (cleaned.changed) changed = true
    next[key] = cleaned.value
  }
  return { value: next, changed }
}

/**
 * Remove persisted sidebar layouts that contain the retired explorer placeholder.
 *
 * Called once when the knowledge plugin activates. It is deliberately narrow: only
 * tab records carrying a `session/@kb-explorer/` address are removed; all other tabs
 * and per-session layout data survive byte-for-byte when nothing matches.
 *
 * @param storage - localStorage-like store, injectable for tests.
 * @returns how many storage keys were rewritten or removed.
 */
export function sanitizeExplorerTabs(
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'> | undefined =
    typeof localStorage === 'undefined' ? undefined : localStorage,
): number {
  if (storage === undefined) return 0
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key !== null && key.startsWith(STORAGE_PREFIX)) keys.push(key)
  }
  let changed = 0
  for (const key of keys) {
    if (key.includes(PLACEHOLDER)) {
      storage.removeItem(key)
      changed += 1
      continue
    }
    const raw = storage.getItem(key)
    if (raw === null || !raw.includes('kb-explorer')) continue
    try {
      const parsed = JSON.parse(raw) as unknown
      const cleaned = cleanNode(parsed)
      if (cleaned.changed) {
        storage.setItem(key, JSON.stringify(cleaned.value))
        changed += 1
      }
    } catch {
      // Corrupt storage is the host's to discard on its own next load.
    }
  }
  return changed
}
