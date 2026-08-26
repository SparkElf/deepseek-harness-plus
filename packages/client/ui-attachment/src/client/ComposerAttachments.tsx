import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ComposerAttachment, ComposerAttachmentsProps, ComposerDocumentAttachment,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachmentRail } from '../AttachmentRail.tsx'
import type { AttachmentRailItem } from '../AttachmentRail.tsx'
import { DropOverlay } from '../DropOverlay.tsx'
import { ImageLightbox } from '../ImageLightbox.tsx'
import { attachmentRailLabels, dropOverlayLabels, lightboxLabels } from './labels.ts'
import css from './ComposerAttachments.module.css'

/** Rail image retaining its browser-owned attachment for callbacks. */
type ComposerImageRailItem = Extract<AttachmentRailItem, { kind: 'image' }> & {
  attachment: ComposerAttachment
}

/** Rail document retaining its browser-owned attachment for callbacks. */
type ComposerDocumentRailItem = Extract<AttachmentRailItem, { kind: 'document' }> & {
  attachment: ComposerDocumentAttachment
}

type ComposerRailItem = ComposerImageRailItem | ComposerDocumentRailItem

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function documentTypeLabel(file: File): string {
  const extension = file.name.split('.').at(-1)?.trim().toUpperCase()
  return extension === undefined || extension === '' ? 'FILE' : extension
}

/** Draft mixed-attachment rail, document-level drop target, and image preview slot entry. */
export function ComposerAttachments({
  attachments, documents, canAcceptDrop, onAddImages, onAddDocuments,
  onRemoveImage, onRemoveDocument, documentDropLimits, t,
}: ComposerAttachmentsProps) {
  const [preview, setPreview] = useState<ComposerAttachment | null>(null)
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const closePreview = useCallback(() => { setPreview(null) }, [])

  useEffect(() => {
    if (preview !== null && !attachments.some(attachment => attachment.id === preview.id)) setPreview(null)
  }, [attachments, preview])

  useEffect(() => {
    const fileTransfer = (event: globalThis.DragEvent): DataTransfer | null => {
      const dataTransfer = event.dataTransfer
      if (dataTransfer === null || !dataTransfer.types.includes('Files')) return null
      return dataTransfer
    }
    const reset = (): void => {
      dragDepth.current = 0
      setDragActive(false)
    }
    const onDragEnter = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      event.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    }
    const onDragOver = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      dataTransfer.dropEffect = canAcceptDrop ? 'copy' : 'none'
    }
    const onDragLeave = (event: globalThis.DragEvent): void => {
      if (fileTransfer(event) === null) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
      const leftViewport = event.clientX <= 0 || event.clientY <= 0
        || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight
      if ((event.target === document.documentElement || event.target === document.body) && leftViewport) reset()
    }
    const onDrop = (event: globalThis.DragEvent): void => {
      const dataTransfer = fileTransfer(event)
      if (dataTransfer === null) return
      event.preventDefault()
      reset()
      if (!canAcceptDrop) return
      const images: File[] = []
      const genericDocuments: File[] = []
      for (const file of dataTransfer.files) {
        if (file.type.startsWith('image/')) images.push(file)
        else genericDocuments.push(file)
      }
      if (images.length > 0) onAddImages(images)
      if (genericDocuments.length > 0) onAddDocuments(genericDocuments)
    }
    document.addEventListener('dragenter', onDragEnter)
    document.addEventListener('dragover', onDragOver)
    document.addEventListener('dragleave', onDragLeave)
    document.addEventListener('drop', onDrop)
    window.addEventListener('dragend', reset)
    return () => {
      document.removeEventListener('dragenter', onDragEnter)
      document.removeEventListener('dragover', onDragOver)
      document.removeEventListener('dragleave', onDragLeave)
      document.removeEventListener('drop', onDrop)
      window.removeEventListener('dragend', reset)
    }
  }, [canAcceptDrop, onAddDocuments, onAddImages])

  const railItems = useMemo<ComposerRailItem[]>(() => [
    ...attachments.map((attachment): ComposerImageRailItem => ({
      kind: 'image',
      id: attachment.id,
      previewUrl: attachment.previewUrl,
      alt: attachment.file.name || t('image.pending'),
      removeLabel: t('image.remove', { name: attachment.file.name }),
      attachment,
    })),
    ...documents.map((attachment): ComposerDocumentRailItem => ({
      kind: 'document',
      id: attachment.id,
      name: attachment.file.name,
      typeLabel: documentTypeLabel(attachment.file),
      detail: sizeLabel(attachment.file.size),
      removeLabel: t('document.remove', { name: attachment.file.name }),
      attachment,
    })),
  ], [attachments, documents, t])

  return (
    <>
      {dragActive && (
        <DropOverlay
          disabled={!canAcceptDrop}
          labels={dropOverlayLabels(t, canAcceptDrop, documentDropLimits !== undefined)}
        />
      )}
      {railItems.length > 0 && (
        <div className={css.rail}>
          <AttachmentRail
            items={railItems}
            labels={attachmentRailLabels(t)}
            onOpen={(item) => {
              if (item.kind === 'image') setPreview(item.attachment)
            }}
            onRemove={(item) => {
              if (item.kind === 'image') onRemoveImage(item.attachment.id)
              else onRemoveDocument(item.attachment.id)
            }}
          />
        </div>
      )}
      {preview !== null && (
        <ImageLightbox
          src={preview.previewUrl}
          alt={preview.file.name || t('image.original')}
          labels={lightboxLabels(t)}
          onClose={closePreview}
        />
      )}
    </>
  )
}
