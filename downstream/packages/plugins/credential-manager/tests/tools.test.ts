import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { CredentialManagerStore, type CredentialRecordProvider } from '../src/store.ts'
import { createCredentialTools, type CredentialApprovalGate } from '../src/tools.ts'

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

const exec = {
  agent: {} as never,
  callId: 'call-1' as never,
  signal: new AbortController().signal,
} as unknown as ToolRunContext

async function fixture(approve?: CredentialApprovalGate) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credential-tools-'))
  const store = new CredentialManagerStore({ dataFile: join(dir, 'credentials.json'), credentials: provider() })
  const approvals: string[] = []
  const gate: CredentialApprovalGate = approve ?? (async request => { approvals.push(request.toolName) })
  const tools = createCredentialTools({ store, approve: gate })
  return { store, tools, approvals }
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find(item => item.name === name)
  if (found === undefined) throw new Error('Missing tool: ' + name)
  return found
}

async function call(tools: ToolDefinition[], name: string, args: unknown): Promise<Record<string, unknown>> {
  return await tool(tools, name).execute(args, exec) as Record<string, unknown>
}

const createArgs = {
  name: 'Production Prefect',
  type: 'prefect',
  description: 'Orchestration',
  tags: ['production'],
  auth_kind: 'api-key',
  config: { apiUrl: 'https://prefect.example.com/api', workspace: 'default' },
  secret: { apiKey: 'tool-secret-value' },
}

describe('credential model tools', () => {
  it('creates, lists, gets, updates, tests, and deletes through approval', async () => {
    const { tools, approvals, store } = await fixture()

    const created = await call(tools, 'credential_create', createArgs)
    expect(created.created).toBe(true)
    const credential = created.credential as { id: string; secretConfigured: boolean }
    expect(credential.secretConfigured).toBe(true)
    expect(JSON.stringify(created)).not.toContain('tool-secret-value')

    const listed = await call(tools, 'credential_list', {})
    expect(listed.count).toBe(1)
    expect(JSON.stringify(listed)).not.toContain('tool-secret-value')

    const fetched = await call(tools, 'credential_get', { credential_id: credential.id })
    expect(JSON.stringify(fetched)).not.toContain('tool-secret-value')
    expect((fetched.template as { type: string }).type).toBe('prefect')

    const updated = await call(tools, 'credential_update', {
      credential_id: credential.id,
      description: 'Rotated by a model',
      secret: { apiKey: 'rotated-tool-secret' },
    })
    expect((updated.credential as { description: string }).description).toBe('Rotated by a model')
    expect(JSON.stringify(updated)).not.toContain('rotated-tool-secret')
    expect(await store.readSecret(credential.id)).toEqual({ apiKey: 'rotated-tool-secret' })

    const tested = await call(tools, 'credential_test', { credential_id: credential.id })
    expect(tested.ok).toBe(true)
    expect(tested.mode).toBe('validation')
    expect(tested.networkAttempted).toBe(false)

    const templates = await call(tools, 'credential_templates', {})
    expect((templates.templates as unknown[]).length).toBe(6)

    const deleted = await call(tools, 'credential_delete', {
      credential_id: credential.id,
      confirm: true,
      confirm_name: 'Production Prefect',
    })
    expect(deleted.deleted).toBe(true)
    expect((await store.state()).credentials).toEqual([])
    expect(approvals).toEqual(['credential_create', 'credential_list', 'credential_get', 'credential_update', 'credential_test', 'credential_templates', 'credential_delete'])
  })

  it('requires both an approval decision and an exact delete confirmation', async () => {
    const { tools, store } = await fixture()
    const created = await call(tools, 'credential_create', createArgs)
    const credentialId = (created.credential as { id: string }).id

    await expect(call(tools, 'credential_delete', {
      credential_id: credentialId,
      confirm: false,
      confirm_name: 'Production Prefect',
    })).rejects.toThrow(/explicit confirmation/)

    await expect(call(tools, 'credential_delete', {
      credential_id: credentialId,
      confirm: true,
      confirm_name: 'Production Prefect ',
    })).rejects.toThrow(/does not match/)

    expect((await store.state()).credentials).toHaveLength(1)
  })

  it('fails closed when approval is rejected, before mutating the store', async () => {
    const { tools, store, approvals } = await fixture(async () => { throw new Error('credential_create approval was rejected') })
    await expect(call(tools, 'credential_create', createArgs)).rejects.toThrow(/approval was rejected/)
    expect(approvals).toEqual([])
    expect((await store.state()).credentials).toEqual([])
  })

  it('keeps credential_get metadata-only for a credential with no secret', async () => {
    const { tools } = await fixture()
    const created = await call(tools, 'credential_create', {
      name: 'Public status',
      type: 'http',
      auth_kind: 'none',
      config: { baseUrl: 'https://status.example.com' },
    })
    const id = (created.credential as { id: string }).id
    const fetched = await call(tools, 'credential_get', { credential_id: id })
    expect((fetched.credential as { secretConfigured: boolean }).secretConfigured).toBe(false)
    expect((fetched.credential as { configuredSecretFields: string[] }).configuredSecretFields).toEqual([])
  })
})