import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createDshBranchLifecycle } from '../../src/connector/group-branch-lifecycle.ts'

const savedDshHome = process.env.DATAOPS_DSH_HOME

async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-branch-'))
}

afterEach(() => {
  if (savedDshHome === undefined) delete process.env.DATAOPS_DSH_HOME
  else process.env.DATAOPS_DSH_HOME = savedDshHome
})

function fakeContext(options: { archiveFails?: boolean; live?: Set<string> } = {}): {
  ctx: Context
  archived: string[]
  unarchived: string[]
} {
  const archived: string[] = []
  const unarchived: string[] = []
  const ctx = {
    workspaceRegistry: {
      async archiveSession(sessionId: string) {
        if (options.archiveFails === true) throw new Error('archive unavailable')
        archived.push(sessionId)
      },
      async unarchiveSession(sessionId: string) { unarchived.push(sessionId) },
    },
    sessions: {
      get: (id: unknown) => options.live?.has(String(id)) === true ? { id: String(id) } : undefined,
    },
    sessionTitle: { rename: () => undefined },
  } as unknown as Context
  return { ctx, archived, unarchived }
}

describe('group branch lifecycle', () => {
  it('archives a turn-private child and records 7-day metadata', async () => {
    const root = await tempRoot()
    process.env.DATAOPS_DSH_HOME = root
    const { ctx, archived } = fakeContext()
    const now = 1_000_000
    const lifecycle = createDshBranchLifecycle(ctx, { dataDir: join(root, 'ledger'), now: () => now, retentionMs: 7 * 24 * 60 * 60_000 })
    await lifecycle.retire('fork-1', {
      botId: 'bot-1',
      chatId: 'chat-1',
      senderId: 'sender-a',
      turnId: 'msg-1',
      parentGroupSession: 'shared-1',
      reason: 'sender_only',
      createdAt: now,
      expiresAt: now + 7 * 24 * 60 * 60_000,
    })
    expect(archived).toEqual(['fork-1'])
    const ledger = JSON.parse(await readFile(join(root, 'ledger', 'branch-ledger.json'), 'utf8')) as {
      entries: Record<string, Record<string, unknown>>
    }
    expect(ledger.entries['fork-1']).toMatchObject({
      ephemeral: true,
      parentGroupSession: 'shared-1',
      senderId: 'sender-a',
      turnId: 'msg-1',
      reason: 'sender_only',
      archivedAt: now,
    })
    await rm(root, { recursive: true, force: true })
  })

  it('records archiveError but keeps the ledger when archive is unavailable', async () => {
    const root = await tempRoot()
    process.env.DATAOPS_DSH_HOME = root
    const { ctx, archived } = fakeContext({ archiveFails: true })
    const lifecycle = createDshBranchLifecycle(ctx, { dataDir: join(root, 'ledger'), now: () => 1_000_000 })
    await lifecycle.retire('fork-2', {
      botId: 'bot-1',
      chatId: 'chat-1',
      senderId: 'sender-a',
      turnId: 'msg-2',
      parentGroupSession: 'shared-1',
      reason: 'sender_only',
      createdAt: 1_000_000,
      expiresAt: 1_000_000 + 1000,
    })
    expect(archived).toEqual([])
    const ledger = JSON.parse(await readFile(join(root, 'ledger', 'branch-ledger.json'), 'utf8')) as {
      entries: Record<string, Record<string, unknown>>
    }
    expect(String(ledger.entries['fork-2']!.archiveError)).toMatch(/archive unavailable/u)
    expect(ledger.entries['fork-2']!.deletedAt).toBeUndefined()
    await rm(root, { recursive: true, force: true })
  })

  it('deletes an expired, archived, non-live child log directory and unarchives it', async () => {
    const root = await tempRoot()
    process.env.DATAOPS_DSH_HOME = root
    const { ctx, archived, unarchived } = fakeContext()
    const sessionDir = join(root, 'sessions', '--workspace--', 'fork-3')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
    let now = 1_000_000
    const lifecycle = createDshBranchLifecycle(ctx, { dataDir: join(root, 'ledger'), now: () => now, retentionMs: 1_000 })
    await lifecycle.retire('fork-3', {
      botId: 'bot-1',
      chatId: 'chat-1',
      senderId: 'sender-a',
      turnId: 'msg-3',
      parentGroupSession: 'shared-1',
      reason: 'sender_only',
      createdAt: now,
      expiresAt: now + 1_000,
    })
    expect(archived).toEqual(['fork-3'])
    now += 2_000
    expect(await lifecycle.sweep()).toBe(1)
    expect(await readFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'utf8').catch(() => undefined)).toBeUndefined()
    expect(unarchived).toEqual(['fork-3'])
    await rm(root, { recursive: true, force: true })
  })

  it('keeps a live child for the next process start', async () => {
    const root = await tempRoot()
    process.env.DATAOPS_DSH_HOME = root
    const { ctx } = fakeContext({ live: new Set(['fork-4']) })
    const sessionDir = join(root, 'sessions', '--workspace--', 'fork-4')
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'x')
    let now = 1_000_000
    const lifecycle = createDshBranchLifecycle(ctx, { dataDir: join(root, 'ledger'), now: () => now, retentionMs: 1_000 })
    await lifecycle.retire('fork-4', {
      botId: 'bot-1',
      chatId: 'chat-1',
      senderId: 'sender-a',
      turnId: 'msg-4',
      parentGroupSession: 'shared-1',
      reason: 'sender_only',
      createdAt: now,
      expiresAt: now + 1_000,
    })
    now += 2_000
    expect(await lifecycle.sweep()).toBe(0)
    expect(await readFile(join(sessionDir, 'session.v4.jsonl.zstd'), 'utf8')).toBe('x')
    await rm(root, { recursive: true, force: true })
  })
})