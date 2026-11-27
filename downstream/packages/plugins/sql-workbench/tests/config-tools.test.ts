import assert from 'node:assert/strict'
import test from 'node:test'
import { registerSqlTools } from '../src/tools.ts'

type Tool = { name: string; execute(args: unknown, exec: unknown): Promise<unknown> }

function fixture(outcome = 'allowed-once') {
  const tools = new Map<string, Tool>()
  const approvals: string[] = []
  const audits: string[] = []
  let saved: Record<string, unknown> | undefined
  let deleted: string | undefined
  let testedWith: Record<string, unknown> | undefined
  const connection = { id: 'c1', name: 'DataOps Postgres', kind: 'postgres', host: 'db', user: 'ops', database: 'dataops', credentialRef: 'DATAOPS_DB_PASSWORD' } as Record<string, unknown>
  const ctx = {
    tools: { register: (tool: Tool) => { tools.set(tool.name, tool); return () => {} } },
    approval: { request: async (input: { reason: string }) => { approvals.push(input.reason); return outcome } },
    credentials: { resolve: async () => ({ value: 's3cret' }) },
    logger: { info: (line: string) => { audits.push(line) }, error: () => {} },
  }
  const runtime = {
    store: {
      connection: async (id: string) => {
        if (id !== 'c1') throw new Error('SQL connection not found: ' + id)
        return { ...connection }
      },
      saveConnection: async (input: Record<string, unknown>) => { saved = { ...input, id: 'c1' }; return saved },
    },
    saveConnection: async (_session: string, input: Record<string, unknown>) => { saved = { ...input, id: 'c1' }; return saved },
    deleteConnection: async (_session: string, id: string) => { deleted = id },
    test: async (input: Record<string, unknown>) => { testedWith = input; return { durationMs: 7, rowCount: 1 } },
  }
  registerSqlTools(ctx as never, runtime as never)
  const exec = { agent: { session: { id: 's1' } }, callId: 'call-1', signal: new AbortController().signal }
  return { tools, approvals, audits, exec, saved: () => saved, deleted: () => deleted, testedWith: () => testedWith }
}

test('save accepts a credential reference and never echoes a password', async () => {
  const f = fixture()
  const value = await f.tools.get('sql_save_connection')!.execute({
    name: 'DataOps Postgres', kind: 'postgres', host: 'db', port: 5432, user: 'ops', database: 'dataops', credential_ref: 'DATAOPS_DB_PASSWORD',
  }, f.exec) as Record<string, unknown>
  assert.equal(f.approvals.length, 1)
  assert.equal(value.credentialRef, 'DATAOPS_DB_PASSWORD')
  assert.equal('password' in value, false)
  assert.equal(f.saved()?.password, undefined)
  assert.match(f.audits[0] ?? '', /sql_save_connection/)
  assert.doesNotMatch(f.audits[0] ?? '', /s3cret/)
})

test('save refuses a denied approval before touching the store', async () => {
  const f = fixture('denied')
  await assert.rejects(f.tools.get('sql_save_connection')!.execute({
    name: 'x', kind: 'postgres', host: 'db', user: 'u', database: 'd',
  }, f.exec), /approval was denied/)
  assert.equal(f.saved(), undefined)
})

test('test resolves the credential on the host and reports duration without the secret', async () => {
  const f = fixture()
  const value = await f.tools.get('sql_test_connection')!.execute({ connection_id: 'c1' }, f.exec) as Record<string, unknown>
  assert.equal(value.ok, true)
  assert.equal(value.durationMs, 7)
  assert.equal(f.testedWith()?.password, 's3cret')
  assert.equal(JSON.stringify(value).includes('s3cret'), false)
})

test('test returns ok=false and a message instead of throwing on driver failure', async () => {
  const f = fixture()
  const runtime = { store: { connection: async () => ({ id: 'c1', kind: 'postgres', credentialRef: 'R' }) }, test: async () => { throw new Error('connection refused') } }
  const tools = new Map<string, Tool>()
  registerSqlTools({
    tools: { register: (tool: Tool) => { tools.set(tool.name, tool); return () => {} } },
    approval: { request: async () => 'allowed-once' },
    credentials: { resolve: async () => ({ value: 's3cret' }) },
    logger: { info: () => {}, error: () => {} },
  } as never, runtime as never)
  const value = await tools.get('sql_test_connection')!.execute({ connection_id: 'c1' }, f.exec) as Record<string, unknown>
  assert.equal(value.ok, false)
  assert.match(String(value.error), /connection refused/)
  assert.equal(JSON.stringify(value).includes('s3cret'), false)
})

test('delete requires approval and deletes by id', async () => {
  const f = fixture()
  const value = await f.tools.get('sql_delete_connection')!.execute({ connection_id: 'c1' }, f.exec) as Record<string, unknown>
  assert.equal(f.approvals.length, 1)
  assert.equal(f.deleted(), 'c1')
  assert.deepEqual(value, { deleted: 'c1' })
})
