import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkbenchVault } from '../src/index.ts'

describe('WorkbenchVault', () => {
  it('encrypts namespaced records without exposing plaintext', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-workbench-vault-'))
    const vault = new WorkbenchVault({ directory })
    await vault.set('ssh', 'shared-id', { password: 'ssh-secret' })
    await vault.set('api', 'shared-id', { token: 'api-secret' })
    await expect(vault.get('ssh', 'shared-id')).resolves.toEqual({ password: 'ssh-secret' })
    await expect(vault.get('api', 'shared-id')).resolves.toEqual({ token: 'api-secret' })
    const data = await readFile(join(directory, 'workbench-vault.json'), 'utf8')
    expect(data).not.toContain('ssh-secret')
    expect(data).not.toContain('api-secret')
    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'workbench-vault.key'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(directory, 'workbench-vault.json'))).mode & 0o777).toBe(0o600)
    }
  })

  it('serializes concurrent mutations without losing records', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-workbench-vault-concurrent-'))
    const vault = new WorkbenchVault({ directory })
    await Promise.all(Array.from({ length: 20 }, (_, index) => vault.set('api', String(index), { value: 'secret-' + index.toString() })))
    for (let index = 0; index < 20; index++) await expect(vault.has('api', String(index))).resolves.toBe(true)
    await vault.delete('api', '3')
    await expect(vault.get('api', '3')).resolves.toBeUndefined()
  })
})
