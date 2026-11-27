import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

interface EncryptedRecord {
  iv: string
  tag: string
  ciphertext: string
  updatedAt: number
}

interface VaultData {
  version: 1
  entries: Record<string, EncryptedRecord>
}

export interface WorkbenchVaultOptions {
  directory?: string
}

function entryKey(namespace: string, id: string): string {
  if (namespace.trim() === '' || id.trim() === '') throw new Error('Vault namespace and id are required')
  return encodeURIComponent(namespace) + ':' + encodeURIComponent(id)
}

/** One host-only encrypted secret owner shared by every Workbench plugin. */
export class WorkbenchVault {
  private readonly keyFile: string
  private readonly dataFile: string
  private key: Buffer | undefined
  private data: VaultData | undefined
  private mutations: Promise<void> = Promise.resolve()

  constructor(options: WorkbenchVaultOptions = {}) {
    const directory = options.directory ?? join(homedir(), '.dsh')
    this.keyFile = join(directory, 'workbench-vault.key')
    this.dataFile = join(directory, 'workbench-vault.json')
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key !== undefined) return this.key
    await mkdir(join(this.keyFile, '..'), { recursive: true })
    if (!existsSync(this.keyFile)) {
      try {
        await writeFile(this.keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
    if (process.platform !== 'win32') await chmod(this.keyFile, 0o600)
    const key = await readFile(this.keyFile)
    if (key.length !== 32) throw new Error('Workbench vault key must be exactly 32 bytes')
    this.key = key
    return key
  }

  private async loadData(): Promise<VaultData> {
    if (this.data !== undefined) return this.data
    await this.loadKey()
    this.data = existsSync(this.dataFile)
      ? JSON.parse(await readFile(this.dataFile, 'utf8')) as VaultData
      : { version: 1, entries: {} }
    if (this.data.version !== 1 || typeof this.data.entries !== 'object') throw new Error('Unsupported Workbench vault format')
    return this.data
  }

  private async persist(): Promise<void> {
    const temporary = this.dataFile + '.next-' + process.pid.toString()
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataFile)
    if (process.platform !== 'win32') await chmod(this.dataFile, 0o600)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  async set(namespace: string, id: string, value: Record<string, unknown>): Promise<void> {
    await this.enqueue(async () => {
      const key = await this.loadKey()
      const data = await this.loadData()
      const recordId = entryKey(namespace, id)
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(Buffer.from(recordId))
      const plaintext = JSON.stringify(value)
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      data.entries[recordId] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'), updatedAt: Date.now() }
      await this.persist()
    })
  }

  async get<T extends Record<string, unknown>>(namespace: string, id: string): Promise<T | undefined> {
    await this.mutations
    const key = await this.loadKey()
    const recordId = entryKey(namespace, id)
    const record = (await this.loadData()).entries[recordId]
    if (record === undefined) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
    decipher.setAAD(Buffer.from(recordId))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    const plaintext = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8')
    return JSON.parse(plaintext) as T
  }

  async has(namespace: string, id: string): Promise<boolean> {
    await this.mutations
    return entryKey(namespace, id) in (await this.loadData()).entries
  }

  async delete(namespace: string, id: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.loadData()
      const recordId = entryKey(namespace, id)
      if (!(recordId in data.entries)) return
      delete data.entries[recordId]
      await this.persist()
    })
  }
}
