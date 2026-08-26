import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AttachmentRailLabels } from '../AttachmentRail.tsx'
import type { DropOverlayLabels } from '../DropOverlay.tsx'
import type { ImageLightboxLabels } from '../ImageLightbox.tsx'
import type { MessageImageLabels } from '../MessageImage.tsx'

/**
 * Resolve original-image lightbox strings from the conversation namespace.
 * @param t - conversation namespace translator.
 * @returns translated lightbox labels.
 */
export function lightboxLabels(t: TranslateNS<'conversation'>): ImageLightboxLabels {
  return { dialog: t('image.preview'), close: t('image.closePreview') }
}

/**
 * Resolve historical message-image strings from the conversation namespace.
 * @param t - conversation namespace translator.
 * @returns translated message-image labels.
 */
export function messageImageLabels(t: TranslateNS<'conversation'>): MessageImageLabels {
  return {
    image: t('image.label'),
    open: t('image.openOriginal'),
    openNamed: label => t('image.openOriginalLabel', { label }),
    loading: t('image.loading'),
    loadFailed: t('image.loadFailed'),
    lightbox: lightboxLabels(t),
  }
}

/**
 * Resolve the generic file-drop invitation shared by image and document intake.
 * @param t - conversation namespace translator.
 * @param accepting - whether the current composer may accept another file drop.
 * @param documents - whether parser-backed document intake is available.
 * @returns translated drop-overlay labels for the current acceptance state.
 */
export function dropOverlayLabels(
  t: TranslateNS<'conversation'>,
  accepting: boolean,
  documents: boolean,
): DropOverlayLabels {
  return {
    title: accepting
      ? t(documents ? 'attachment.dropTitle' : 'attachment.dropImageTitle')
      : t('attachment.dropBlocked'),
  }
}

/**
 * Resolve mixed draft-attachment rail strings from the conversation namespace.
 * @param t - conversation namespace translator.
 * @returns translated group/open/paging labels for the mixed attachment rail.
 */
export function attachmentRailLabels(t: TranslateNS<'conversation'>): AttachmentRailLabels {
  return {
    group: t('attachment.pending'),
    open: t('image.openOriginal'),
    scrollLeft: t('attachment.scrollLeft'),
    scrollRight: t('attachment.scrollRight'),
  }
}
