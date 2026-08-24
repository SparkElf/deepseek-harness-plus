/** Draft-attachment rail: image thumbnails and compact document cards share
 * one scrollbar-less horizontal overflow surface, paged by edge arrows. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseFill14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AttachmentRail.module.css'

interface AttachmentRailItemBase {
  /** Stable identity for the React key. */
  id: string
  /** Accessible label of the item's remove control. */
  removeLabel: string
}

/** One image thumbnail in the mixed composer rail. */
export interface ImageAttachmentRailItem extends AttachmentRailItemBase {
  kind: 'image'
  /** Object or data URL rendered as the thumbnail. */
  previewUrl: string
  /** Image alt text (display name with the owner's fallback applied). */
  alt: string
}

/** One durable-document draft card in the mixed composer rail. */
export interface DocumentAttachmentRailItem extends AttachmentRailItemBase {
  kind: 'document'
  /** User-facing basename. */
  name: string
  /** Compact format label such as PDF/DOCX. */
  typeLabel: string
  /** Secondary metadata, currently the formatted byte size. */
  detail: string
}

/** Any draft attachment presentation item. */
export type AttachmentRailItem = ImageAttachmentRailItem | DocumentAttachmentRailItem

/** Rail-level strings the owner resolves from its own locale namespace. */
export interface AttachmentRailLabels {
  /** Accessible name of the rail group. */
  group: string
  /** Thumbnail tooltip inviting the original-image preview. */
  open: string
  /** Accessible label of the left paging arrow. */
  scrollLeft: string
  /** Accessible label of the right paging arrow. */
  scrollRight: string
}

/** Approximate pixels per wheel step for `deltaMode` LINE deltas (Firefox
 * notch wheels report lines, not pixels). */
const WHEEL_LINE_PX = 16

/** Smooth paging unless the user asked for reduced motion. */
function pageBehavior(): ScrollBehavior {
  // jsdom (the unit lane) implements no matchMedia despite lib.dom's
  // non-optional typing; the optional call keeps that lane on the default.
  // oxlint-disable-next-line typescript/no-unnecessary-condition
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/**
 * Horizontal mixed-attachment rail over the caller's draft attachments.
 *
 * Images keep the existing single-click original preview. Documents are
 * intentionally inert cards: generic document intake exposes only type/name/
 * size, never parser internals. Both kinds share removal, overflow paging, and
 * wheel behavior.
 */
export function AttachmentRail<T extends AttachmentRailItem>({ items, labels, onOpen, onRemove }: {
  items: readonly T[]
  labels: AttachmentRailLabels
  onOpen?: (item: T) => void
  onRemove: (item: T) => void
}) {
  const railRef = useRef<HTMLDivElement | null>(null)
  // null marks the first layout pass: a rail that MOUNTS over an existing
  // draft (session switch back to held attachments) is initial display, not
  // growth, and must not jump to the end.
  const countRef = useRef<number | null>(null)
  const [edges, setEdges] = useState({ left: false, right: false })
  const updateEdges = useCallback(() => {
    const el = railRef.current
    /* v8 ignore next -- defensive: every caller runs while the rail element is mounted. */
    if (el === null) return
    // 1px slack: engines report fractional scroll positions at the edges.
    const left = el.scrollLeft > 1
    const right = el.scrollLeft < el.scrollWidth - el.clientWidth - 1
    setEdges(prev => prev.left === left && prev.right === right ? prev : { left, right })
  }, [])
  useLayoutEffect(() => {
    const grew = countRef.current !== null && items.length > countRef.current
    countRef.current = items.length
    const el = railRef.current
    /* v8 ignore next -- defensive: the rail div renders unconditionally, so the layout effect always finds it. */
    if (el === null) return
    // A newly added attachment lands at the rail's end: reveal it.
    if (grew) el.scrollLeft = el.scrollWidth - el.clientWidth
    updateEdges()
  }, [items.length, updateEdges])
  useEffect(() => {
    const el = railRef.current
    /* v8 ignore next -- defensive: the rail div renders unconditionally, so the mount effect always finds it. */
    if (el === null) return
    let disconnect = (): void => {}
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateEdges)
      observer.observe(el)
      disconnect = () => { observer.disconnect() }
    }
    const onWheel = (event: globalThis.WheelEvent): void => {
      if (event.deltaY === 0) return
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? WHEEL_LINE_PX
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1
      event.preventDefault()
      el.scrollBy({
        left: event.deltaX !== 0
          ? event.deltaX * scale
          : Math.sign(event.deltaY) * Math.min(Math.abs(event.deltaY) * scale, 60),
        behavior: 'auto',
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [updateEdges])
  const page = (direction: -1 | 1): void => {
    const el = railRef.current
    /* v8 ignore next -- defensive: the arrows render only while the rail is mounted, so a click cannot find a null ref. */
    if (el === null) return
    // One viewport minus a card keeps the last visible attachment as context;
    // the floor keeps narrow rails paging a useful distance.
    el.scrollBy({ left: direction * Math.max(el.clientWidth - 64, 200), behavior: pageBehavior() })
  }
  return (
    <div className={css.root}>
      {edges.left && (
        <button
          type="button"
          className={clsx(css.arrow, css.arrowLeft)}
          aria-label={labels.scrollLeft}
          onClick={() => { page(-1) }}
        >
          <IconChevronLeftOutline14 />
        </button>
      )}
      <div
        ref={railRef}
        className={css.rail}
        role="group"
        aria-label={labels.group}
        onScroll={updateEdges}
      >
        {items.map(item => (
          <div
            key={item.id}
            className={clsx(css.item, item.kind === 'document' && css.itemDocument)}
            data-attachment-kind={item.kind}
          >
            {item.kind === 'image' ? (
              <button
                type="button"
                className={css.thumbnail}
                title={labels.open}
                onClick={() => { onOpen?.(item) }}
              >
                <img src={item.previewUrl} alt={item.alt} />
              </button>
            ) : (
              <div className={css.document} title={item.name}>
                <span className={css.documentType}>{item.typeLabel}</span>
                <span className={css.documentName}>{item.name}</span>
                <span className={css.documentDetail}>{item.detail}</span>
              </div>
            )}
            <button
              type="button"
              className={css.remove}
              aria-label={item.removeLabel}
              onClick={() => { onRemove(item) }}
            >
              <IconCloseFill14 size={12} />
            </button>
          </div>
        ))}
      </div>
      {edges.right && (
        <button
          type="button"
          className={clsx(css.arrow, css.arrowRight)}
          aria-label={labels.scrollRight}
          onClick={() => { page(1) }}
        >
          <IconChevronRightOutline14 />
        </button>
      )}
    </div>
  )
}
