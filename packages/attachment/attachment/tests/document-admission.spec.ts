import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '../src/brand.ts'
import { admitEncodedDocuments } from '../src/admission.ts'
import type { AttachmentStore } from '../src/index.ts'
import type { DocumentAttachmentLimits, FileAttachmentRef, SaveFileAttachment } from '../src/types.ts'

const limits: DocumentAttachmentLimits = {
  maxDocumentBytes: 1024,
  maxDocumentsPerMessage: 2,
  maxMessageDocumentBytes: 1536,
  mediaTypes: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ],
}

function encoded(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString('base64')
}

function storedRef(input: SaveFileAttachment, digest: string): FileAttachmentRef {
  return {
    attachmentId: AttachmentId(`sha256:${digest.repeat(64)}`),
    mediaType: input.mediaType,
    bytes: input.data.byteLength,
    ...(input.name === undefined ? {} : { name: input.name }),
  }
}

function store(saveFile = vi.fn(async (input: SaveFileAttachment): Promise<FileAttachmentRef> => (
  storedRef(input, 'a')
))): AttachmentStore {
  return {
    documentLimits: limits,
    saveFile,
  } as unknown as AttachmentStore
}

describe('admitEncodedDocuments', () => {
  it('normalizes display names and stores a valid PDF only after batch validation', async () => {
    const saveFile = vi.fn(async (input: SaveFileAttachment): Promise<FileAttachmentRef> => storedRef(input, 'b'))
    const refs = await admitEncodedDocuments([{
      mediaType: 'application/pdf',
      name: 'C:\\Users\\me\\report.pdf',
      data: encoded([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]),
    }], store(saveFile))

    expect(saveFile).toHaveBeenCalledTimes(1)
    expect(saveFile.mock.calls[0]![0]).toMatchObject({ mediaType: 'application/pdf', name: 'report.pdf' })
    expect(refs[0]).toMatchObject({ mediaType: 'application/pdf', name: 'report.pdf' })
  })

  it('accepts the OOXML zip container for DOCX/PPTX/XLSX without parsing the archive', async () => {
    const saveFile = vi.fn(async (input: SaveFileAttachment): Promise<FileAttachmentRef> => storedRef(input, 'c'))
    const zip = encoded([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])
    const refs = await admitEncodedDocuments([
      { mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', name: 'a.docx', data: zip },
      { mediaType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', name: 'b.pptx', data: zip },
    ], store(saveFile))

    expect(refs.map(ref => ref.name)).toEqual(['a.docx', 'b.pptx'])
    expect(saveFile).toHaveBeenCalledTimes(2)
  })

  it('validates the whole decoded batch before publishing the first object', async () => {
    const saveFile = vi.fn()
    await expect(admitEncodedDocuments([
      {
        mediaType: 'application/pdf',
        name: 'good.pdf',
        data: encoded([0x25, 0x50, 0x44, 0x46, 0x2d]),
      },
      {
        mediaType: 'application/pdf',
        name: 'actually.docx',
        data: encoded([0x25, 0x50, 0x44, 0x46, 0x2d]),
      },
    ], store(saveFile))).rejects.toMatchObject({ code: 'DOCUMENT_TYPE_MISMATCH' })
    expect(saveFile).not.toHaveBeenCalled()
  })

  it('enforces document count and aggregate byte limits before persistence', async () => {
    const saveFile = vi.fn()
    const pdf = encoded([0x25, 0x50, 0x44, 0x46, 0x2d])
    await expect(admitEncodedDocuments([
      { mediaType: 'application/pdf', name: 'a.pdf', data: pdf },
      { mediaType: 'application/pdf', name: 'b.pdf', data: pdf },
      { mediaType: 'application/pdf', name: 'c.pdf', data: pdf },
    ], store(saveFile))).rejects.toMatchObject({ code: 'TOO_MANY_DOCUMENTS' })
    expect(saveFile).not.toHaveBeenCalled()
  })
})
