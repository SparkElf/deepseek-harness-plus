/** Remount-surviving state for the Settings Backup slot registration. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type {
  BackupErrorKey, BackupOperation, BackupSectionState, BackupStatusKey,
} from './types.ts'

type BackupSectionActions = {
  begin: (draft: BackupSectionState, operation: BackupOperation) => void
  progress: (draft: BackupSectionState, operation: BackupOperation) => void
  requestCancel: (draft: BackupSectionState) => void
  cancelled: (draft: BackupSectionState) => void
  complete: (draft: BackupSectionState, status: BackupStatusKey) => void
  fail: (draft: BackupSectionState, error: BackupErrorKey) => void
}

/** Store handle shared by each remount of the root-scoped Backup section. */
export type BackupSectionStore = EngineStoreHandle<BackupSectionState, BackupSectionActions>

/**
 * Declare the Backup section operation and result state.
 * @returns the root-scoped store handle.
 */
export function createBackupSectionStore(): BackupSectionStore {
  return defineStore({
    init: (): BackupSectionState => ({
      operation: null,
      status: null,
      error: null,
      cancelling: false,
    }),
    actions: {
      begin: (draft, operation: BackupOperation) => {
        draft.operation = operation
        draft.status = null
        draft.error = null
        draft.cancelling = false
      },
      progress: (draft, operation: BackupOperation) => { draft.operation = operation },
      requestCancel: (draft) => { draft.cancelling = true },
      cancelled: (draft) => {
        draft.operation = null
        draft.cancelling = false
      },
      complete: (draft, status: BackupStatusKey) => {
        draft.operation = null
        draft.status = status
        draft.error = null
        draft.cancelling = false
      },
      fail: (draft, error: BackupErrorKey) => {
        draft.operation = null
        draft.status = null
        draft.error = error
        draft.cancelling = false
      },
    },
  })
}
