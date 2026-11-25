import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { WorkbenchVault } from '@sparkelf/dsh-workbench-vault'
import type { SshCluster, SshCredentialInput, SshHost, SshManagerState } from './types.ts'

interface StoredData { version: 1; clusters: SshCluster[]; hosts: SshHost[] }
export interface SshCredentialRecords {
  describeRecord(key: CredentialKey): Promise<{ configured: boolean }>
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
}
type LegacyVault = Pick<WorkbenchVault, 'has' | 'get' | 'delete'>

export function sshCredentialKey(credentialId: string): CredentialKey {
  const digest = createHash('sha256').update(credentialId).digest('hex').slice(0, 32)
  return credentialKey('ssh-manager', 'host-' + digest)
}

function credentialPayload(record: CredentialRecord | undefined): SshCredentialInput | undefined {
  if (record?.kind !== 'grant' || typeof record.payload !== 'object' || record.payload === null || Array.isArray(record.payload)) return undefined
  const payload = record.payload as Record<string, unknown>
  const credential: SshCredentialInput = {}
  if (typeof payload.password === 'string' && payload.password !== '') credential.password = payload.password
  if (typeof payload.privateKey === 'string' && payload.privateKey !== '') credential.privateKey = payload.privateKey
  if (typeof payload.passphrase === 'string' && payload.passphrase !== '') credential.passphrase = payload.passphrase
  return Object.keys(credential).length === 0 ? undefined : credential
}

function grant(credential: SshCredentialInput): CredentialRecord {
  return { kind: 'grant', payload: Object.fromEntries(Object.entries(credential).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')) }
}

export class SshManagerStore {
  private readonly dataFile: string
  private readonly credentials: SshCredentialRecords
  private readonly legacyVault: LegacyVault | undefined
  private data: StoredData | undefined
  private legacyMigration: Promise<void> | undefined
  private mutations: Promise<void> = Promise.resolve()

  constructor(options: { credentials: SshCredentialRecords; dataFile?: string; legacyVault?: LegacyVault }) {
    this.dataFile = options.dataFile ?? join(homedir(), '.dsh', 'ssh-manager.json')
    this.credentials = options.credentials
    this.legacyVault = options.legacyVault
  }

  private async load(): Promise<StoredData> {
    if (this.data !== undefined) return this.data
    await mkdir(dirname(this.dataFile), { recursive: true })
    this.data = existsSync(this.dataFile) ? JSON.parse(await readFile(this.dataFile, 'utf8')) as StoredData : { version: 1, clusters: [], hosts: [] }
    if (this.data.version !== 1) throw new Error('Unsupported SSH Manager data format')
    return this.data
  }

  private async migrateLegacy(data: StoredData): Promise<void> {
    const legacyVault = this.legacyVault
    if (legacyVault === undefined) return
    this.legacyMigration ??= (async () => {
      for (const host of data.hosts) {
        const id = host.credentialId
        if (id === null || !await legacyVault.has('ssh', id)) continue
        const key = sshCredentialKey(id)
        const info = await this.credentials.describeRecord(key)
        if (!info.configured) {
          const legacy = await legacyVault.get<SshCredentialInput & Record<string, unknown>>('ssh', id)
          if (legacy !== undefined) await this.credentials.modifyRecord(key, async () => grant(legacy))
        }
        if ((await this.credentials.describeRecord(key)).configured) await legacyVault.delete('ssh', id)
      }
    })()
    await this.legacyMigration
  }

  private async persist(): Promise<void> {
    const temporary = this.dataFile + '.next-' + process.pid.toString()
    await writeFile(temporary, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, this.dataFile)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(operation, operation)
    this.mutations = result.then(() => undefined, () => undefined)
    return result
  }

  private configured(credentialId: string | null): Promise<boolean> {
    return credentialId === null ? Promise.resolve(false) : this.credentials.describeRecord(sshCredentialKey(credentialId)).then(info => info.configured)
  }

  async state(): Promise<SshManagerState> {
    await this.mutations
    const data = await this.load()
    await this.migrateLegacy(data)
    const hosts = await Promise.all(data.hosts.map(async host => ({ ...host, credentialConfigured: await this.configured(host.credentialId) })))
    return { clusters: data.clusters.map(cluster => ({ ...cluster, hostIds: [...cluster.hostIds], tags: [...cluster.tags] })), hosts }
  }

  async saveCluster(input: SshCluster): Promise<SshCluster> {
    return this.enqueue(async () => {
      const data = await this.load()
      const cluster: SshCluster = { ...input, id: input.id === '' ? randomUUID() : input.id, name: input.name.trim(), description: input.description.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))], hostIds: [...new Set(input.hostIds)] }
      if (cluster.name === '') throw new Error('SSH cluster name is required')
      const index = data.clusters.findIndex(item => item.id === cluster.id)
      if (index === -1) data.clusters.push(cluster); else data.clusters[index] = cluster
      await this.persist()
      return cluster
    })
  }

  async deleteCluster(clusterId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      data.clusters = data.clusters.filter(cluster => cluster.id !== clusterId)
      data.hosts = data.hosts.map(host => host.clusterId === clusterId ? { ...host, clusterId: null } : host)
      await this.persist()
    })
  }

  async saveHost(input: SshHost, credential?: SshCredentialInput): Promise<SshHost> {
    return this.enqueue(async () => {
      const data = await this.load()
      await this.migrateLegacy(data)
      const id = input.id === '' ? randomUUID() : input.id
      if (input.name.trim() === '' || input.hostname.trim() === '' || input.username.trim() === '') throw new Error('SSH host name, hostname, and username are required')
      if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error('SSH host port is invalid')
      if (input.clusterId !== null && !data.clusters.some(cluster => cluster.id === input.clusterId)) throw new Error('SSH cluster not found: ' + input.clusterId)
      if (input.jumpHostId === id) throw new Error('SSH host cannot use itself as a jump host')
      if (input.jumpHostId !== null && !data.hosts.some(host => host.id === input.jumpHostId)) throw new Error('SSH jump host not found: ' + input.jumpHostId)
      const credentialId = input.credentialId ?? id
      if (credential !== undefined && Object.values(credential).some(value => value !== undefined && value !== '')) await this.credentials.modifyRecord(sshCredentialKey(credentialId), async () => grant(credential))
      const host: SshHost = { ...input, id, name: input.name.trim(), description: input.description.trim(), hostname: input.hostname.trim(), username: input.username.trim(), tags: [...new Set(input.tags.map(tag => tag.trim()).filter(Boolean))], credentialId, credentialConfigured: await this.configured(credentialId) }
      const index = data.hosts.findIndex(item => item.id === id)
      if (index === -1) data.hosts.push(host); else data.hosts[index] = host
      for (const cluster of data.clusters) cluster.hostIds = cluster.id === host.clusterId ? [...new Set([...cluster.hostIds, host.id])] : cluster.hostIds.filter(hostId => hostId !== host.id)
      await this.persist()
      return host
    })
  }

  async deleteHost(hostId: string): Promise<void> {
    await this.enqueue(async () => {
      const data = await this.load()
      const host = data.hosts.find(item => item.id === hostId)
      if (host === undefined) return
      data.hosts = data.hosts.filter(item => item.id !== hostId).map(item => item.jumpHostId === hostId ? { ...item, jumpHostId: null } : item)
      data.clusters = data.clusters.map(cluster => ({ ...cluster, hostIds: cluster.hostIds.filter(id => id !== hostId) }))
      if (host.credentialId !== null) {
        await this.credentials.deleteRecord(sshCredentialKey(host.credentialId))
        const legacyVault = this.legacyVault
        if (legacyVault !== undefined && await legacyVault.has('ssh', host.credentialId)) await legacyVault.delete('ssh', host.credentialId)
      }
      await this.persist()
    })
  }

  async host(hostId: string): Promise<SshHost> {
    const host = (await this.state()).hosts.find(item => item.id === hostId)
    if (host === undefined) throw new Error('SSH host not found: ' + hostId)
    return host
  }

  async credential(hostId: string): Promise<SshCredentialInput | undefined> {
    const host = await this.host(hostId)
    return host.credentialId === null ? undefined : credentialPayload(await this.credentials.readRecord(sshCredentialKey(host.credentialId)))
  }
}
