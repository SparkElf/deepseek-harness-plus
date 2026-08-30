import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'

/** Callbacks and localized copy shared by both DataOps Client entries. */
export interface DataOpsClientInjected {
  /** Translate one DataOps UI message key. */
  t: (key: keyof typeof en) => string
  /** Start the always-mounted status and OAuth browser lifecycle. */
  start: () => () => void
  /** Refresh the authoritative Host status. */
  reload: () => void
  /** Open the real DataOps OAuth popup from a user gesture. */
  openAuthorization: () => void
  /** Disconnect the delegated grant and report whether it completed. */
  disconnect: () => Promise<boolean>
}

/** Optional injected face while the slot registration is activating. */
export type DataOpsInjectedProps = Partial<InjectFace<DataOpsClientInjected>>
