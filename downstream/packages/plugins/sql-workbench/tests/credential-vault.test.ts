import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CredentialVault } from '../src/credential-vault.ts'
import { WorkbenchStore } from '../src/store.ts'

test('encrypts connection passwords with owner-only files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sql-vault-'))
  const dataFile = join(dir, 'workbench.json')
  const vault = new CredentialVault(dataFile)
  await vault.set('connection-1', 'not-plain-text')
  assert.equal(await vault.get('connection-1'), 'not-plain-text')
  const raw = await readFile(join(dir, 'sql-workbench-secrets.json'), 'utf8')
  assert.equal(raw.includes('not-plain-text'), false)
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(dir, 'sql-workbench-secrets.key'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(dir, 'sql-workbench-secrets.json'))).mode & 0o777, 0o600)
  }
})

test('migrates legacy plaintext passwords and never returns them publicly', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-sql-migrate-'))
  const dataFile = join(dir, 'workbench.json')
  await writeFile(dataFile, JSON.stringify({ connections: [{ id: 'pg-1', name: 'PG', kind: 'postgres', host: 'localhost', port: 5432, user: 'demo', password: 'legacy-secret', database: 'demo' }], savedQueries: [], drafts: [], currentBySession: {} }))
  const store = new WorkbenchStore(dataFile)
  const publicConnections = await store.listConnections()
  const publicConnection = publicConnections[0]
  assert.ok(publicConnection !== undefined)
  assert.equal('password' in publicConnection, false)
  const privateConnection = await store.connection('pg-1')
  assert.equal('password' in privateConnection && privateConnection.password, 'legacy-secret')
  assert.equal((await readFile(dataFile, 'utf8')).includes('legacy-secret'), false)
})
