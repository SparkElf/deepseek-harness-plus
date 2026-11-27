import { describe, expect, it, vi } from 'vitest'
import { openInSidebar } from '../src/client/openInSidebar.ts'

function context(claimAbsolute: boolean, opened: string[]): unknown {
  return {
    get: (name: string) => {
      if (name === 'sidebarRightTabs') {
        return {
          candidates: (address: string) => address.startsWith('dsh-resource://file/session/')
            ? [{ kind: 'preview' }]
            : claimAbsolute ? [{ kind: 'editor' }] : [],
        }
      }
      if (name === 'sidebarRight') {
        return { isExpanded: () => true, openResource: (address: string) => { opened.push(address) } }
      }
      return undefined
    },
  }
}

describe('openInSidebar session handling', () => {
  it('opens an absolute-address claimant without creating a session', async () => {
    const opened: string[] = []
    const ensure = vi.fn(async () => 'real-session')
    await expect(openInSidebar(context(true, opened), undefined, '/workspace', '/workspace/kb/a.md', ensure))
      .resolves.toBe('opened')
    expect(ensure).not.toHaveBeenCalled()
    expect(opened[0]).toContain('/a.md')
  })

  it('uses a real session for a session-scoped address, never the placeholder', async () => {
    const opened: string[] = []
    const ensure = vi.fn(async () => 'real-session')
    await expect(openInSidebar(context(false, opened), undefined, '/workspace', '/workspace/kb/a.pdf', ensure))
      .resolves.toBe('opened')
    expect(ensure).toHaveBeenCalledTimes(1)
    expect(opened[0]).toContain('session/real-session/')
    expect(opened[0]).not.toContain('@kb-explorer')
  })

  it('degrades to no-seat when no real session can be created', async () => {
    const opened: string[] = []
    await expect(openInSidebar(context(false, opened), '@kb-explorer', '/workspace', '/workspace/kb/a.pdf', async () => undefined))
      .resolves.toBe('no-seat')
    expect(opened).toEqual([])
  })
})
