/**
 * A tiny broadcast for "reveal this path in the file tree". The reveal used to
 * ride only the bottom workbench's store, so the native right-Sidebar Files
 * page (a separate tree instance) never selected the row. Every mounted tree
 * subscribes here; the service emits once and whoever shows the path selects
 * and scrolls to it.
 */
type RevealListener = (path: string) => void

const listeners = new Set<RevealListener>()

export const revealBus = {
  emit(path: string): void {
    for (const listener of listeners) listener(path)
  },
  subscribe(listener: RevealListener): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
}
