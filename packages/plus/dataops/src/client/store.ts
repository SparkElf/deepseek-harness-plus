import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { DataOpsKey } from './locales.ts'

/** Account identity returned by the delegated DataOps userinfo endpoint. */
export interface DataOpsAccount {
  username: string
  displayName: string
  email: string
}

/** Browser-visible projection of the current delegated DataOps grant. */
export interface DataOpsStatus {
  credentialConfigured: boolean
  credentialWritable: boolean
  authorizationAccepted: boolean
  expiresAt: number | null
  account: DataOpsAccount | null
}

/** Shared state rendered by the Settings section and frame-wide expiry prompt. */
export interface DataOpsState {
  status?: DataOpsStatus
  loading: boolean
  failure: DataOpsKey | undefined
  disconnecting: boolean
  expiryPromptDismissed: boolean
}

type DataOpsActionDecl = {
  beginLoad: (draft: DataOpsState) => void
  setStatus: (draft: DataOpsState, status: DataOpsStatus) => void
  setFailure: (draft: DataOpsState, failure: DataOpsKey) => void
  clearFailure: (draft: DataOpsState) => void
  setDisconnecting: (draft: DataOpsState, disconnecting: boolean) => void
  dismissExpiryPrompt: (draft: DataOpsState) => void
}

/** Bound write operations shared by both DataOps Client entries. */
export interface DataOpsActions {
  beginLoad: () => void
  setStatus: (status: DataOpsStatus) => void
  setFailure: (failure: DataOpsKey) => void
  clearFailure: () => void
  setDisconnecting: (disconnecting: boolean) => void
  dismissExpiryPrompt: () => void
}

/**
 * Return whether the stored grant exists but is no longer accepted.
 * @param status - Current Host-projected DataOps status.
 * @returns Whether a writable stored grant needs interactive sign-in.
 */
export function isLoginExpired(status: DataOpsStatus | undefined): boolean {
  return status?.credentialConfigured === true && !status.authorizationAccepted && status.credentialWritable
}

/**
 * Create the root-scoped state shared by DataOps Settings and expiry modal.
 * @returns A store handle shared by both root-scope registrations.
 */
export function createDataOpsStore(): EngineStoreHandle<DataOpsState, DataOpsActionDecl> {
  return defineStore({
    init: (): DataOpsState => ({
      loading: true,
      failure: undefined,
      disconnecting: false,
      expiryPromptDismissed: false,
    }),
    actions: {
      beginLoad: (draft) => {
        draft.loading = true
        draft.failure = undefined
      },
      setStatus: (draft, status: DataOpsStatus) => {
        const wasExpired = isLoginExpired(draft.status)
        const expired = isLoginExpired(status)
        draft.status = status
        draft.loading = false
        draft.failure = undefined
        if (!expired || !wasExpired) draft.expiryPromptDismissed = false
      },
      setFailure: (draft, failure: DataOpsKey) => {
        draft.loading = false
        draft.failure = failure
      },
      clearFailure: (draft) => {
        draft.failure = undefined
      },
      setDisconnecting: (draft, disconnecting: boolean) => {
        draft.disconnecting = disconnecting
      },
      dismissExpiryPrompt: (draft) => {
        draft.expiryPromptDismissed = true
      },
    },
  })
}
