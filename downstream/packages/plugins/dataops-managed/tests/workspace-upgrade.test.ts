// @ts-nocheck
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceUpgrade, WorkspaceUpgradeError } from '../src/workspace-upgrade.ts'
import { readWorkspaceUpgradeState } from '../src/workspace-upgrade-state.ts'

const CONFIG = { baseUrl: 'http://dataops.test:3101', credentialRef: 'DATAOPS_ACCESS_TOKEN' }

const runningAgent = (id: string, title = '任务') => ({
  id,
  status: 'running' as const,
  session: { id, header: { title, cwd: '/workspace' } },
  followup: vi.fn(),
})

const idleAgent = (id: string) => ({
  id,
  status: 'idle' as const,
  session: { id, header: { cwd: '/workspace' } },
  followup: vi.fn(),
})

const contextWith = (agents: unknown) => ({
  credentials: { resolve: vi.fn(async () => ({ value: 'jwt' })) },
  agents,
  logger: { warn: vi.fn() },
}) as never

const respond = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
}) as Response

const previewBody = {
  workspace: { imageStatus: 'UPDATE_AVAILABLE', configuredImage: 'dataops-ai-workspace:local' },
  activeTasks: [{ id: 'task-1' }, { id: 'task-2' }],
}

describe('WorkspaceUpgrade', () => {
  it('snapshots only running sessions and persists before restarting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dataops-upgrade-test-'))
    const file = join(directory, 'workspace-upgrade.json')
    const agents = {
      list: () => [runningAgent('session-a'), runningAgent('session-b'), idleAgent('idle')],
      get: vi.fn(),
      resume: vi.fn(),
    }
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/restart-preview')) return respond(200, previewBody)
      return respond(200, { status: 'STARTING' })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const upgrade = new WorkspaceUpgrade(contextWith(agents), CONFIG, file)
      const state = await upgrade.upgrade()
      expect(state.sessions.map(session => session.sessionId)).toEqual(['session-a', 'session-b'])
      expect(await readWorkspaceUpgradeState(file)).toEqual(state)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain('/api/ai/workspace/restart')
    } finally {
      vi.unstubAllGlobals()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('refuses to restart when no image update is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dataops-upgrade-test-'))
    const file = join(directory, 'workspace-upgrade.json')
    vi.stubGlobal('fetch', vi.fn(async () => respond(200, {
      workspace: { imageStatus: 'CURRENT', configuredImage: 'dataops-ai-workspace:local' },
    })))
    try {
      const upgrade = new WorkspaceUpgrade(contextWith({ list: () => [], get: vi.fn(), resume: vi.fn() }), CONFIG, file)
      await expect(upgrade.upgrade()).rejects.toMatchObject<Partial<WorkspaceUpgradeError>>({ status: 409 })
    } finally {
      vi.unstubAllGlobals()
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('resumes each snapshotted session and sends 继续 once', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dataops-upgrade-test-'))
    const file = join(directory, 'workspace-upgrade.json')
    const fileBody = {
      version: 1,
      upgradeId: 'upgrade-1',
      targetImage: 'dataops-ai-workspace:local',
      sessions: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
      createdAt: '2026-10-28T08:00:00.000Z',
    }
    await import('node:fs/promises').then(fs => fs.writeFile(file, JSON.stringify(fileBody), 'utf8'))
    const agentA = runningAgent('session-a')
    const agentB = runningAgent('session-b')
    const agents = {
      list: () => [],
      get: (id: string) => id === 'session-a' ? agentA : undefined,
      resume: vi.fn(async () => ({ agent: agentB })),
    }
    try {
      const upgrade = new WorkspaceUpgrade(contextWith(agents), CONFIG, file)
      await expect(upgrade.recover()).resolves.toEqual({ recovered: 2, skipped: 0 })
      expect(agentA.followup).toHaveBeenCalledTimes(1)
      expect(agentB.followup).toHaveBeenCalledTimes(1)
      expect(await readWorkspaceUpgradeState(file)).not.toBeNull()
      await upgrade.clearRecoveryState()
      expect(await readWorkspaceUpgradeState(file)).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
