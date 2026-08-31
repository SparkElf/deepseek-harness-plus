import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { BackupScope } from '../types.ts'
import type {
  BackupErrorKey, BackupOperation, BackupResult, BackupSectionState,
} from './types.ts'

/** Remount-surviving state for the Settings Backup slot registration. */

type BackupSectionActions = {
  selectScope: (draft: BackupSectionState, scope: BackupScope) => void
  begin: (draft: BackupSectionState, operation: BackupOperation) => void
  progress: (draft: BackupSectionState, operation: BackupOperation) => void
  requestCancel: (draft: BackupSectionState) => void
  cancelled: (draft: BackupSectionState) => void
  complete: (draft: BackupSectionState, result: BackupResult) => void
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
      scope: 'all',
      operation: null,
      result: null,
      error: null,
      cancelling: false,
    }),
    actions: {
      selectScope: (draft, scope: BackupScope) => {
        draft.scope = scope
        draft.result = null
        draft.error = null
      },
      begin: (draft, operation: BackupOperation) => {
        draft.operation = operation
        draft.result = null
        draft.error = null
        draft.cancelling = false
      },
      progress: (draft, operation: BackupOperation) => { draft.operation = operation },
      requestCancel: (draft) => { draft.cancelling = true },
      cancelled: (draft) => {
        draft.operation = null
        draft.cancelling = false
      },
      complete: (draft, result: BackupResult) => {
        draft.operation = null
        draft.result = result
        draft.error = null
        draft.cancelling = false
      },
      fail: (draft, error: BackupErrorKey) => {
        draft.operation = null
        draft.result = null
        draft.error = error
        draft.cancelling = false
      },
    },
  })
}
