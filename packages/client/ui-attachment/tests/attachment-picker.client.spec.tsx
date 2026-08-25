// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { DraftAttachmentId } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { AttachmentPicker, type AttachmentPickerProps } from '../src/client/AttachmentPicker.tsx'

afterEach(() => {
  cleanup()
})

const t = ((key: string, params?: Readonly<Record<string, unknown>>): string => {
  if (key === 'attachment.add') return '添加附件'
  const count = typeof params?.count === 'number' ? String(params.count) : ''
  if (key === 'image.tooMany') return `最多 ${count} 张图片`
  if (key === 'document.tooMany') return `最多 ${count} 个文档`
  return key
}) as AttachmentPickerProps['t']

function id(value: string): DraftAttachmentId {
  return value as DraftAttachmentId
}

function props(overrides: Partial<AttachmentPickerProps> = {}): AttachmentPickerProps {
  return {
    input: {
      draft: '',
      imageIds: [],
      draftRev: 0,
      phase: 'plain',
      occurrences: [],
      queue: [],
    },
    inputActions: {
      setDraft: vi.fn(),
      addImages: vi.fn(() => true),
      removeImage: vi.fn(),
      pruneImages: vi.fn(),
      submit: vi.fn(),
    },
    useProjection: ((key: string) => key === 'imageLimits'
      ? {
        maxImageBytes: 5 * 1024 * 1024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 20 * 1024 * 1024,
        maxImagePixels: 25_000_000,
        maxImageDimension: 8192,
        mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
      }
      : key === 'documentLimits'
        ? {
          maxDocumentBytes: 20 * 1024 * 1024,
          maxDocumentsPerMessage: 10,
          maxMessageDocumentBytes: 50 * 1024 * 1024,
          mediaTypes: [
            'application/pdf',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          ],
        }
        : undefined) as AttachmentPickerProps['useProjection'],
    draftStats: () => ({ images: { count: 0, bytes: 0 }, documents: { count: 0, bytes: 0 } }),
    createDrafts: vi.fn(() => [id('image'), id('document')]),
    releaseDrafts: vi.fn(),
    t,
    ...overrides,
  } as AttachmentPickerProps
}

describe('AttachmentPicker', () => {
  it('offers image-only intake and rejects a document while parser capability is absent', () => {
    const createDrafts = vi.fn()
    const base = props()
    const view = render(<AttachmentPicker {...props({
      createDrafts,
      useProjection: ((key: string) => key === 'imageLimits'
        ? base.useProjection('imageLimits')
        : undefined),
    })} />)
    const picker = view.container.querySelector('input[type="file"]')
    if (!(picker instanceof HTMLInputElement)) throw new Error('picker input missing')

    expect(picker.accept).toContain('image/png')
    expect(picker.accept).not.toContain('application/pdf')
    fireEvent.change(picker, { target: { files: [
      new File([Uint8Array.of(1)], 'report.pdf', { type: 'application/pdf' }),
    ] } })

    expect(createDrafts).not.toHaveBeenCalled()
    expect(view.getByText('document.unavailable')).toBeTruthy()
  })

  it('keeps the native FileList order when admitting mixed picks', () => {
    const createDrafts = vi.fn(() => [id('document'), id('image')])
    const addImages = vi.fn(() => true)
    const view = render(<AttachmentPicker {...props({
      createDrafts,
      inputActions: { ...props().inputActions, addImages },
    })} />)
    const picker = view.container.querySelector('input[type="file"]')
    if (!(picker instanceof HTMLInputElement)) throw new Error('picker input missing')

    const document = new File([Uint8Array.of(1)], 'report.pdf', { type: 'application/pdf' })
    const image = new File([Uint8Array.of(2)], 'pixel.png', { type: 'image/png' })
    fireEvent.change(picker, { target: { files: [document, image] } })

    expect(createDrafts).toHaveBeenCalledWith([document, image])
    expect(addImages).toHaveBeenCalledWith([id('document'), id('image')])
  })

  it('releases picker-created drafts when the input machine refuses the transaction', () => {
    const created = [id('document'), id('image')]
    const releaseDrafts = vi.fn()
    const view = render(<AttachmentPicker {...props({
      createDrafts: () => created,
      releaseDrafts,
      inputActions: { ...props().inputActions, addImages: () => false },
    })} />)
    const picker = view.container.querySelector('input[type="file"]')
    if (!(picker instanceof HTMLInputElement)) throw new Error('picker input missing')

    fireEvent.change(picker, { target: { files: [
      new File([Uint8Array.of(1)], 'report.pdf', { type: 'application/pdf' }),
      new File([Uint8Array.of(2)], 'pixel.png', { type: 'image/png' }),
    ] } })

    expect(releaseDrafts).toHaveBeenCalledWith(created)
  })

  it('honors an empty projected document capability before creating browser drafts', () => {
    const createDrafts = vi.fn()
    const base = props()
    const view = render(<AttachmentPicker {...props({
      createDrafts,
      useProjection: ((key: string) => key === 'documentLimits'
        ? {
          maxDocumentBytes: 1,
          maxDocumentsPerMessage: 1,
          maxMessageDocumentBytes: 1,
          mediaTypes: [],
        }
        : key === 'imageLimits'
          ? base.useProjection('imageLimits')
          : undefined),
    })} />)
    const picker = view.container.querySelector('input[type="file"]')
    if (!(picker instanceof HTMLInputElement)) throw new Error('picker input missing')

    fireEvent.change(picker, { target: { files: [
      new File([Uint8Array.of(1)], 'report.pdf', { type: 'application/pdf' }),
    ] } })

    expect(createDrafts).not.toHaveBeenCalled()
    expect(view.getByText('document.unsupportedType')).toBeTruthy()
  })
})
