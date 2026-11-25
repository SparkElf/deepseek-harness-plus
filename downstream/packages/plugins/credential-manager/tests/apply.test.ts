import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { apply, type CredentialContext } from '../src/index.ts'
import type { CredentialRecordProvider } from '../src/store.ts'

function provider(): CredentialRecordProvider {
  const records = new Map<string, CredentialRecord>()
  return {
    async describeRecord(key: CredentialKey) { return { configured: records.has(String(key)) } },
    async readRecord(key: CredentialKey) { return records.get(String(key)) },
    async modifyRecord(key: CredentialKey, mutate) {
      const next = await mutate(records.get(String(key)))
      if (next !== undefined) records.set(String(key), next)
      return next
    },
    async deleteRecord(key: CredentialKey) { records.delete(String(key)) },
  }
}

describe('plugin apply wiring', () => {
  it('registers one API route and exactly the manifest tool set', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-credential-apply-'))
    const vaultDir = await mkdtemp(join(tmpdir(), 'dsh-credential-vault-'))
    const routes: { kind: string; path: string }[] = []
    const tools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    const ctx = {
      credentials: provider(),
      approval: { request: async () => 'allowed-once' },
      logger: { info() {}, error() {} },
      effect(callback: () => unknown) { callback(); return () => undefined },
      webServer: {
        register(route: { kind: string; path: string }) { routes.push(route); return () => undefined },
      },
      tools: {
        register(tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) { tools.push(tool); return () => undefined },
      },
    } as unknown as CredentialContext

    apply(ctx, { dataFile: join(dir, 'credentials.json'), vaultDirectory: vaultDir })

    expect(routes.map(route => ({ kind: route.kind, path: route.path }))).toEqual([{ kind: 'prefix', path: '/dsh-credential-manager/api' }])
    const manifest = JSON.parse(await readFile(join(import.meta.dirname, '..', 'dsh.plugin.json'), 'utf8')) as { contributes: { tools: string[] } }
    expect(tools.map(tool => tool.name)).toEqual(manifest.contributes.tools)
    expect(tools).toHaveLength(7)

    const create = tools.find(tool => tool.name === 'credential_create')
    if (create === undefined) throw new Error('credential_create was not registered')
    await create.execute({
      name: 'Apply Wiring',
      type: 'prefect',
      auth_kind: 'api-key',
      config: { apiUrl: 'https://prefect.example.com/api' },
      secret: { apiKey: 'apply-wiring-secret' },
    }, { agent: {}, callId: 'call-1', signal: new AbortController().signal })
    expect(await readFile(join(dir, 'credentials.json'), 'utf8')).not.toContain('apply-wiring-secret')
    expect(await readFile(join(vaultDir, 'workbench-vault.json'), 'utf8')).not.toContain('apply-wiring-secret')
  })
})