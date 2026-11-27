// @ts-nocheck
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_UPGRADE_STATE_VERSION,
  clearWorkspaceUpgradeState,
  readWorkspaceUpgradeState,
  writeWorkspaceUpgradeState,
} from '../src/workspace-upgrade-state.ts'

const state = {
  version: WORKSPACE_UPGRADE_STATE_VERSION,
  upgradeId: 'upgrade-1',
  targetImage: 'dataops-ai-workspace:local',
  sessions: [
    { sessionId: 'session-a', title: '数据查询' },
    { sessionId: 'session-b', cwd: '/workspace' },
  ],
  createdAt: '2026-10-28T08:00:00.000Z',
} as const

describe('workspace upgrade hand-off state', () => {
  it('round-trips the pending record from the persistent file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dataops-upgrade-'))
    const file = join(directory, 'workspace-upgrade.json')
    try {
      await writeWorkspaceUpgradeState(state, file)
      expect(await readWorkspaceUpgradeState(file)).toEqual(state)
      expect(await readFile(file, 'utf8')).toContain('"session-a"')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('returns null for missing, corrupt, or wrong-version files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dataops-upgrade-'))
    const file = join(directory, 'workspace-upgrade.json')
    try {
      expect(await readWorkspaceUpgradeState(file)).toBeNull()
      await writeFile(file, '{not json', 'utf8')
      expect(await readWorkspaceUpgradeState(file)).toBeNull()
      await writeFile(file, JSON.stringify({ ...state, version: 99 }), 'utf8')
      expect(await readWorkspaceUpgradeState(file)).toBeNull()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('clears the file after the recovery attempt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dataops-upgrade-'))
    const file = join(directory, 'workspace-upgrade.json')
    try {
      await writeWorkspaceUpgradeState(state, file)
      await clearWorkspaceUpgradeState(file)
      expect(await readWorkspaceUpgradeState(file)).toBeNull()
      await expect(clearWorkspaceUpgradeState(file)).resolves.toBeUndefined()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
