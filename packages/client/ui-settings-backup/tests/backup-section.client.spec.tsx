// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BackupSection, type BackupSectionProps } from '../src/client/BackupSection.tsx'

function makeProps(overrides: Partial<BackupSectionProps> = {}): BackupSectionProps {
  return {
    close: () => {},
    t: (key: string) => 'copy.' + key,
    exportArchive: async () => ({ archiveBase64: 'AA==', entries: 1 }),
    importArchive: async () => ({ entries: 1 }),
    ...overrides,
  } as unknown as BackupSectionProps
}

let revokeStub: ReturnType<typeof vi.fn>

describe('BackupSection', () => {
  beforeEach(() => {
    revokeStub = vi.fn()
    ;(URL as { createObjectURL?: unknown }).createObjectURL = vi.fn(() => 'blob:local')
    ;(URL as { revokeObjectURL?: unknown }).revokeObjectURL = revokeStub
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('renders the section chrome with enabled actions', () => {
    render(<BackupSection {...makeProps()} />)
    expect(screen.getByText('copy.title')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'copy.exportButton' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'copy.importButton' })).not.toBeNull()
    expect(screen.getByText('copy.warning')).not.toBeNull()
  })

  it('exports the archive and starts a browser download', async () => {
    const exportArchive = vi.fn(async () => ({ archiveBase64: 'AA==', entries: 2 }))
    render(<BackupSection {...makeProps({ exportArchive })} />)
    fireEvent.click(screen.getByRole('button', { name: 'copy.exportButton' }))
    await waitFor(() => { expect(screen.getByText('copy.exported')).not.toBeNull() })
    expect(exportArchive).toHaveBeenCalledTimes(1)
    expect(revokeStub).toHaveBeenCalledWith('blob:local')
  })

  it.each([
    ['missing backup-manifest.json', 'copy.notBackup'],
    ['Backup archive contains an unsafe path: x', 'copy.unsafe'],
    ['boom', 'copy.failed'],
  ])('localizes an export rejection: %s', async (message, copy) => {
    render(<BackupSection {...makeProps({ exportArchive: async () => { throw new Error(message) } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'copy.exportButton' }))
    await waitFor(() => { expect(screen.getByText(copy)).not.toBeNull() })
  })

  it('imports a picked archive and reports success', async () => {
    let received: string | undefined
    const importArchive = vi.fn(async (archiveBase64: string) => { received = archiveBase64; return { entries: 3 } })
    render(<BackupSection {...makeProps({ importArchive })} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([1, 2])], 'b.zip', { type: 'application/zip' })
    fireEvent.change(input, { target: { files: [file] } })
    await waitFor(() => { expect(screen.getByText('copy.imported')).not.toBeNull() })
    expect(importArchive).toHaveBeenCalledTimes(1)
    expect(received).toBe(btoa(String.fromCharCode(1, 2)))
  })

  it('ignores a picker change without a file', () => {
    const importArchive = vi.fn(async () => ({ entries: 1 }))
    render(<BackupSection {...makeProps({ importArchive })} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [] } })
    expect(importArchive).not.toHaveBeenCalled()
  })

  it('reports an import rejection and re-enables the actions', async () => {
    render(<BackupSection {...makeProps({ importArchive: async () => { throw new Error('boom') } })} />)
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'b.zip')] } })
    await waitFor(() => { expect(screen.getByText('copy.failed')).not.toBeNull() })
    expect(screen.getByRole('button', { name: 'copy.exportButton' })).not.toBeNull()
  })

  it('routes the import button to the hidden input and localizes non-Error rejections', async () => {
    render(<BackupSection {...makeProps({ importArchive: async () => { throw 'plain' } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'copy.importButton' }))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([new Uint8Array([1])], 'b.zip')] } })
    await waitFor(() => { expect(screen.getByText('copy.failed')).not.toBeNull() })
  })

  it('disables both actions while an export is in flight', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    render(<BackupSection {...makeProps({ exportArchive: async () => { await gate; return { archiveBase64: 'AA==', entries: 1 } } })} />)
    fireEvent.click(screen.getByRole('button', { name: 'copy.exportButton' }))
    await waitFor(() => { expect(screen.getByRole('button', { name: 'copy.busyExport' })).not.toBeNull() })
    expect(screen.getByRole('button', { name: 'copy.busyExport' }).getAttribute('disabled')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'copy.importButton' }).getAttribute('disabled')).not.toBeNull()
    release()
    await waitFor(() => { expect(screen.getByText('copy.exported')).not.toBeNull() })
  })
})
