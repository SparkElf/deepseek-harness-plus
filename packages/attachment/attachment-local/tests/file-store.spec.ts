import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import { readFileObject, saveFileObject } from '../src/store.ts'

const roots: string[] = []

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-file-attachment-'))
  roots.push(directory)
  return join(directory, 'attachments', 'v1')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('generic attachment objects', () => {
  it('stores arbitrary immutable bytes in the same sha256 object namespace', async () => {
    const storage = await root()
    const data = new TextEncoder().encode('# parsed document\n')

    const first = await saveFileObject(storage, {
      data,
      mediaType: 'text/markdown',
      name: 'C:\\tmp\\report.md',
    })
    const second = await saveFileObject(storage, {
      data,
      mediaType: 'text/markdown',
      name: '/tmp/renamed.md',
    })

    expect(first.attachmentId).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(second.attachmentId).toBe(first.attachmentId)
    expect(first).toMatchObject({ mediaType: 'text/markdown', bytes: data.byteLength, name: 'report.md' })
    expect(second.name).toBe('renamed.md')
    await expect(readFileObject(storage, first)).resolves.toEqual({ ref: first, data })
  })

  it('rejects stale or corrupted durable file references on read', async () => {
    const storage = await root()
    const data = new TextEncoder().encode('{"blocks":[]}')
    const ref = await saveFileObject(storage, { data, mediaType: 'application/json' })
    const sha = String(ref.attachmentId).slice('sha256:'.length)
    const object = join(storage, 'objects', sha.slice(0, 2), sha)
    await writeFile(object, 'changed')

    await expect(readFileObject(storage, ref)).rejects.toMatchObject<Partial<AttachmentError>>({
      code: 'ATTACHMENT_CORRUPT',
    })
  })

  it('rejects invalid object ids before touching the filesystem', async () => {
    const storage = await root()
    const ref = {
      attachmentId: AttachmentId('not-a-content-id'),
      mediaType: 'application/json',
      bytes: 0,
    }

    await expect(readFileObject(storage, ref)).rejects.toMatchObject<Partial<AttachmentError>>({
      code: 'INVALID_ATTACHMENT_REF',
    })
  })
})
