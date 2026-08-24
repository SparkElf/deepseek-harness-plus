import { useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { IconWarningOutline16, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AttachmentPicker.module.css'

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])

/** Native picker filter: the browser hides everything outside PR A's supported set. */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_TYPES,
  ...DOCUMENT_TYPES,
].join(',')

/** Existing browser-draft usage, split by the two independent Host limit domains. */
export interface DraftAttachmentStats {
  readonly images: { readonly count: number; readonly bytes: number }
  readonly documents: { readonly count: number; readonly bytes: number }
}

/** Business face bound to one session by the attachment plugin registration. */
export interface AttachmentPickerInjected {
  /** Current live draft usage for client-side limit prechecks. */
  draftStats(ids: readonly DraftAttachmentId[]): DraftAttachmentStats
  /** Register one already-prechecked mixed file list and preserve its original order. */
  createDrafts(files: readonly File[]): readonly DraftAttachmentId[]
  /** Release every id created by a picker transaction that the input machine refused. */
  releaseDrafts(ids: readonly DraftAttachmentId[]): void
}

export type AttachmentPickerProps =
  PropsRuntime<'conversation.input.left'> & InjectFace<AttachmentPickerInjected> & PropsLocale<'conversation'>

function byteLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/**
 * Tool-row attachment picker. It does not own durable admission; it mirrors
 * the Host's boot-constant limits for immediate feedback, then registers only
 * browser-local drafts. The normal composer submit remains the sole Host
 * transaction, so a rejected send retains every selected file.
 */
export function AttachmentPicker({
  input, inputActions, useProjection, draftStats, createDrafts, releaseDrafts, t,
}: AttachmentPickerProps) {
  const pickerRef = useRef<HTMLInputElement | null>(null)
  const buttonRef = useRef<HTMLButtonElement | null>(null)
  const [error, setError] = useState<{ seq: number; text: string } | null>(null)
  const errorSeq = useRef(0)
  const imageLimits = useProjection('imageLimits')
  const documentLimits = useProjection('documentLimits')
  const busy = input.phase === 'adjudicating' || input.phase === 'submitting'

  const reject = (text: string): void => {
    errorSeq.current += 1
    setError({ seq: errorSeq.current, text })
  }

  const validate = (files: readonly File[]): string | null => {
    const existing = draftStats(input.imageIds)
    const images = files.filter(file => IMAGE_TYPES.has(file.type))
    const documents = files.filter(file => DOCUMENT_TYPES.has(file.type))
    if (images.length + documents.length !== files.length) {
      return files.some(file => file.type.startsWith('image/'))
        ? t('image.unsupportedType')
        : t('document.unsupportedType')
    }
    if (documents.some(file => file.name.trim() === '')) return t('document.nameRequired')

    if (imageLimits !== undefined) {
      if (existing.images.count + images.length > imageLimits.maxImagesPerMessage) {
        return t('image.tooMany', { count: imageLimits.maxImagesPerMessage })
      }
      if (images.some(file => file.size > imageLimits.maxImageBytes)) {
        return t('image.fileTooLarge', { size: byteLabel(imageLimits.maxImageBytes) })
      }
      const bytes = existing.images.bytes + images.reduce((sum, file) => sum + file.size, 0)
      if (bytes > imageLimits.maxMessageImageBytes) {
        return t('image.totalTooLarge', { size: byteLabel(imageLimits.maxMessageImageBytes) })
      }
    }

    if (documentLimits !== undefined) {
      if (existing.documents.count + documents.length > documentLimits.maxDocumentsPerMessage) {
        return t('document.tooMany', { count: documentLimits.maxDocumentsPerMessage })
      }
      if (documents.some(file => file.size > documentLimits.maxDocumentBytes)) {
        return t('document.fileTooLarge', { size: byteLabel(documentLimits.maxDocumentBytes) })
      }
      const bytes = existing.documents.bytes + documents.reduce((sum, file) => sum + file.size, 0)
      if (bytes > documentLimits.maxMessageDocumentBytes) {
        return t('document.totalTooLarge', { size: byteLabel(documentLimits.maxMessageDocumentBytes) })
      }
    }
    return null
  }

  const onFiles = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = [...(event.currentTarget.files ?? [])]
    // Reset immediately so choosing the same file after remove/rejection fires
    // another change event in every browser.
    event.currentTarget.value = ''
    if (files.length === 0 || busy) return
    const failure = validate(files)
    if (failure !== null) {
      reject(failure)
      return
    }
    let ids: readonly DraftAttachmentId[]
    try {
      ids = createDrafts(files)
    } catch (reason: unknown) {
      reject(reason instanceof Error ? reason.message : String(reason))
      return
    }
    if (inputActions.addImages(ids)) return
    releaseDrafts(ids)
  }

  return (
    <>
      <input
        ref={pickerRef}
        className={css.file}
        type="file"
        multiple
        accept={ATTACHMENT_ACCEPT}
        tabIndex={-1}
        aria-hidden="true"
        onChange={onFiles}
      />
      <button
        ref={buttonRef}
        type="button"
        className={css.trigger}
        aria-label={t('attachment.add')}
        title={t('attachment.add')}
        disabled={busy}
        onClick={() => { pickerRef.current?.click() }}
      >
        <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
          <path
            d="M5.2 8.8 9.6 4.4a2.2 2.2 0 1 1 3.1 3.1l-5.1 5.1a3.4 3.4 0 0 1-4.8-4.8l5-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {error !== null && (
        <Toast
          key={error.seq}
          text={error.text}
          icon={<IconWarningOutline16 />}
          anchor={buttonRef.current}
          onDone={() => { setError(null) }}
        />
      )}
    </>
  )
}
