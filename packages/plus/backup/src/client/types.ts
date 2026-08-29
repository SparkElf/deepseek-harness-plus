/** Browser presentation progress after parsing Host lines or upload events. */
export type BackupSectionProgress = {
  /** Phase without a measurable byte total. */
  phase: 'scan' | 'validate' | 'reload'
} | {
  /** Phase with a stable byte total. */
  phase: 'compress' | 'upload' | 'restore'
  /** Bytes completed in the current phase. */
  completedBytes: number
  /** Stable byte total for the current phase. */
  totalBytes: number
}

/** One active backup operation rendered by the Settings section. */
export type BackupOperation = {
  kind: 'export' | 'import'
  progress: BackupSectionProgress
}

/** Successful operation copy selected by the current locale. */
export type BackupStatusKey = 'exported' | 'imported'

/** Failed operation copy selected by the current locale. */
export type BackupErrorKey = 'notBackup' | 'unsafe' | 'exportFailed' | 'importFailed'

/** Remount-surviving presentation state owned by the Backup slot registration. */
export type BackupSectionState = {
  operation: BackupOperation | null
  status: BackupStatusKey | null
  error: BackupErrorKey | null
  cancelling: boolean
}
