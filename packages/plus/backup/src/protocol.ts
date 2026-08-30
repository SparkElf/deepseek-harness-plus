/** Host progress and terminal records for Plus user-data Backup routes. */

/** Progress without a stable byte total while scanning, validating, or reloading. */
type BackupOpenProgress = {
  phase: 'scan' | 'validate' | 'reload'
}

/** Progress with a stable byte total while compressing or restoring. */
type BackupMeasuredProgress = {
  phase: 'compress' | 'restore'
  completedBytes: number
  totalBytes: number
}

/** Host-authored progress emitted by one Backup operation. */
export type BackupHostProgress = BackupOpenProgress | BackupMeasuredProgress

/** Ordered progress writer; archive work waits for response backpressure. */
export type BackupProgressReporter = (progress: BackupHostProgress) => Promise<void>

/** One NDJSON progress or terminal line sent to the Client. */
export type BackupProgressLine = {
  type: 'progress'
  progress: BackupHostProgress
} | {
  type: 'export-ready'
  downloadUrl: string
  entries: number
} | {
  type: 'import-complete'
  entries: number
} | {
  type: 'error'
  message: string
}
