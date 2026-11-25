import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

interface SecretRecord {
  iv: string
  tag: string
  ciphertext: string
}

interface VaultFile {
  version: 1
  entries: Record<string, SecretRecord>
}

export class CredentialVault {
  private readonly keyFile: string
  private readonly vaultFile: string
  private key: Buffer | undefined
  private data: VaultFile | undefined

  constructor(dataFile: string) {
    const directory = dirname(dataFile)
    this.keyFile = join(directory, 'sql-workbench-secrets.key')
    this.vaultFile = join(directory, 'sql-workbench-secrets.json')
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key !== undefined) return this.key
    await mkdir(dirname(this.keyFile), { recursive: true })
    if (!existsSync(this.keyFile)) {
      try {
        await writeFile(this.keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' })
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST') throw error
      }
    }
    const key = await readFile(this.keyFile)
    if (key.length !== 32) throw new Error('SQL credential vault key must be 32 bytes')
    this.key = key
    return key
  }

  private async load(): Promise<VaultFile> {
    if (this.data !== undefined) return this.data
    await this.loadKey()
    this.data = existsSync(this.vaultFile)
      ? JSON.parse(await readFile(this.vaultFile, 'utf8')) as VaultFile
      : { version: 1, entries: {} }
    if (this.data.version !== 1) throw new Error('Unsupported SQL credential vault version')
    return this.data
  }

  private async persist(): Promise<void> {
    const next = this.vaultFile + '.next'
    await writeFile(next, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(next, this.vaultFile)
  }

  async set(connectionId: string, password: string): Promise<void> {
    const key = await this.loadKey()
    const data = await this.load()
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(connectionId))
    const ciphertext = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()])
    data.entries[connectionId] = { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') }
    await this.persist()
  }

  async get(connectionId: string): Promise<string | undefined> {
    const key = await this.loadKey()
    const record = (await this.load()).entries[connectionId]
    if (record === undefined) return undefined
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'))
    decipher.setAAD(Buffer.from(connectionId))
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]).toString('utf8')
  }

  async delete(connectionId: string): Promise<void> {
    const data = await this.load()
    if (!(connectionId in data.entries)) return
    delete data.entries[connectionId]
    await this.persist()
  }
}
