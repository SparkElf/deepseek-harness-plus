import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { SshCredentialRecords } from '../src/store.ts'

export class MemoryCredentialRecords implements SshCredentialRecords {
  readonly records = new Map<string, CredentialRecord>()
  describeRecord(key: CredentialKey): Promise<{ configured: boolean }> { return Promise.resolve({ configured: this.records.has(String(key)) }) }
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> { return Promise.resolve(this.records.get(String(key))) }
  async modifyRecord(key: CredentialKey, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>): Promise<CredentialRecord | undefined> { const current = this.records.get(String(key)); const next = await mutate(current); if (next !== undefined) this.records.set(String(key), next); return next ?? current }
  deleteRecord(key: CredentialKey): Promise<void> { this.records.delete(String(key)); return Promise.resolve() }
}
