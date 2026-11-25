// @ts-nocheck
import { createContext, useContext } from 'react'
import { createStore, useStore } from 'zustand'
import type { StoreApi } from 'zustand/vanilla'
import type { CatalogDatabase, CatalogObject, CatalogSnapshot, WorkbenchState } from '../types.ts'

export type MainMode = 'objects' | 'query' | 'results'
export type ExplorerMode = 'objects' | 'queries'

export interface WorkbenchUiState {
  server: WorkbenchState | null
  catalog: CatalogSnapshot | null
  selectedConnectionId: string | null
  selectedDatabase: CatalogDatabase | null
  selectedObject: CatalogObject | null
  mainMode: MainMode
  explorerMode: ExplorerMode
  loading: string | null
  error: string | null
  adoptServer(server: WorkbenchState): void
  setCatalog(catalog: CatalogSnapshot | null): void
  selectConnection(connectionId: string): void
  selectDatabase(database: CatalogDatabase | null): void
  selectObject(object: CatalogObject | null): void
  setMainMode(mode: MainMode): void
  setExplorerMode(mode: ExplorerMode): void
  setLoading(value: string | null): void
  setError(value: string | null): void
  updateDraftLocal(draftId: string, sql: string): void
}

export type WorkbenchStore = StoreApi<WorkbenchUiState>

/** 每个official right Sidebar Tab创建一个独立Zustand store，避免跨会话共享编辑状态。 */
export function createWorkbenchStore(): WorkbenchStore {
  return createStore<WorkbenchUiState>()((set, get) => ({
    server: null,
    catalog: null,
    selectedConnectionId: null,
    selectedDatabase: null,
    selectedObject: null,
    mainMode: 'objects',
    explorerMode: 'objects',
    loading: null,
    error: null,
    adoptServer: server => {
      const current = server.drafts.find(draft => draft.id === server.currentDraftId)
      const preferred = current?.connectionId ?? get().selectedConnectionId
      const selectedConnectionId = server.connections.some(connection => connection.id === preferred)
        ? preferred ?? null
        : server.connections[0]?.id ?? null
      set({ server, selectedConnectionId })
    },
    setCatalog: catalog => { set({ catalog }) },
    selectConnection: selectedConnectionId => { set({ selectedConnectionId, catalog: null, selectedDatabase: null, selectedObject: null }) },
    selectDatabase: selectedDatabase => { set({ selectedDatabase, selectedObject: null }) },
    selectObject: selectedObject => { set({ selectedObject, selectedDatabase: null }) },
    setMainMode: mainMode => { set({ mainMode }) },
    setExplorerMode: explorerMode => { set({ explorerMode }) },
    setLoading: loading => { set({ loading }) },
    setError: error => { set({ error }) },
    updateDraftLocal: (draftId, sql) => {
      const server = get().server
      if (server === null) return
      const drafts = server.drafts.map(draft => draft.id === draftId
        ? { ...draft, sql, dirty: true, updatedAt: Date.now() }
        : draft)
      set({ server: { ...server, drafts } })
    },
  }))
}

export const WorkbenchStoreContext = createContext<WorkbenchStore | null>(null)

export function useWorkbench<T>(selector: (state: WorkbenchUiState) => T): T {
  const store = useContext(WorkbenchStoreContext)
  if (store === null) throw new Error('SQL workbench store is unavailable')
  return useStore(store, selector)
}
