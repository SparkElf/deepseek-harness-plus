import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ConnectionConfig,
  QueryDraft,
  QueryResult,
  SavedQuery,
  StoredWorkbenchData,
  WorkbenchState,
} from './types.ts'
import { CredentialVault } from './credential-vault.ts'

const DATA_FILE = join(homedir(), '.dsh', 'sql-workbench.json')

function withoutPassword(connection: ConnectionConfig): ConnectionConfig {
  const { password: _password, ...metadata } = connection as ConnectionConfig & { password?: string }
  return metadata as ConnectionConfig
}

/** SQL 工作台的唯一持久化 owner，连接、草稿、当前查询与保存查询都在这里更新。 */
export class WorkbenchStore {
  private data: StoredWorkbenchData | undefined
  private readonly dataFile: string
  private readonly credentials: CredentialVault
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor(dataFile = DATA_FILE) {
    this.dataFile = dataFile
    this.credentials = new CredentialVault(dataFile)
  }

  subscribe(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private emit(sessionId: string): void {
    for (const listener of this.listeners) listener(sessionId)
  }

  /** 首次访问时读取 profile 级数据文件，首次安装则创建空工作台。 */
  private async getData(): Promise<StoredWorkbenchData> {
    if (this.data !== undefined) return this.data
    await mkdir(dirname(this.dataFile), { recursive: true })
    if (!existsSync(this.dataFile)) {
      this.data = { connections: [], savedQueries: [], drafts: [], currentBySession: {} }
      await this.persist()
      return this.data
    }
    this.data = JSON.parse(await readFile(this.dataFile, 'utf8')) as StoredWorkbenchData
    let migrated = false
    for (let index = 0; index < this.data.connections.length; index++) {
      const connection = this.data.connections[index]
      if (connection === undefined) continue
      if ('password' in connection && typeof connection.password === 'string' && connection.password !== '') {
        await this.credentials.set(connection.id, connection.password)
        this.data.connections[index] = withoutPassword(connection)
        migrated = true
      }
    }
    if (migrated) await this.persist()
    return this.data
  }

  private async persist(): Promise<void> {
    const next = this.dataFile + '.next'
    await writeFile(next, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    await rename(next, this.dataFile)
  }

  async state(sessionId: string, result: QueryResult | null): Promise<WorkbenchState> {
    const data = await this.getData()
    return {
      connections: data.connections.map(withoutPassword),
      savedQueries: data.savedQueries,
      drafts: data.drafts.filter(draft => draft.sessionId === sessionId),
      currentDraftId: data.currentBySession[sessionId] ?? null,
      result,
    }
  }

  async listConnections(): Promise<ConnectionConfig[]> {
    return (await this.getData()).connections.map(withoutPassword)
  }

  async saveConnection(connection: ConnectionConfig): Promise<ConnectionConfig> {
    const data = await this.getData()
    const candidate = { ...connection, id: connection.id === '' ? randomUUID() : connection.id } as ConnectionConfig
    if ('password' in candidate && typeof candidate.password === 'string' && candidate.password !== '') {
      await this.credentials.set(candidate.id, candidate.password)
    }
    const stored = withoutPassword(candidate)
    const index = data.connections.findIndex(item => item.id === candidate.id)
    if (index === -1) data.connections.push(stored)
    else data.connections[index] = stored
    await this.persist()
    for (const sessionId of Object.keys(data.currentBySession)) this.emit(sessionId)
    return stored
  }

  async deleteConnection(connectionId: string): Promise<void> {
    const data = await this.getData()
    data.connections = data.connections.filter(connection => connection.id !== connectionId)
    await this.credentials.delete(connectionId)
    await this.persist()
    for (const sessionId of Object.keys(data.currentBySession)) this.emit(sessionId)
  }

  async connection(connectionId: string): Promise<ConnectionConfig> {
    const connection = (await this.getData()).connections.find(item => item.id === connectionId)
    if (connection === undefined) throw new Error('SQL connection not found: ' + connectionId)
    if ('host' in connection) {
      const password = await this.credentials.get(connectionId)
      return { ...connection, ...(password === undefined ? {} : { password }) } as ConnectionConfig
    }
    return connection
  }

  async createDraft(sessionId: string, connectionId: string, name: string, sql: string): Promise<QueryDraft> {
    const data = await this.getData()
    const draft: QueryDraft = {
      id: randomUUID(),
      sessionId,
      connectionId,
      name,
      sql,
      savedQueryId: null,
      dirty: true,
      updatedAt: Date.now(),
    }
    data.drafts.push(draft)
    data.currentBySession[sessionId] = draft.id
    await this.persist()
    this.emit(sessionId)
    return draft
  }

  async currentDraft(sessionId: string): Promise<QueryDraft> {
    const data = await this.getData()
    const currentId = data.currentBySession[sessionId]
    const draft = data.drafts.find(item => item.id === currentId && item.sessionId === sessionId)
    if (draft === undefined) throw new Error('This conversation has no current SQL query')
    return draft
  }

  async updateDraft(sessionId: string, draftId: string, sql: string, name?: string): Promise<QueryDraft> {
    const data = await this.getData()
    const draft = data.drafts.find(item => item.id === draftId && item.sessionId === sessionId)
    if (draft === undefined) throw new Error('SQL draft not found: ' + draftId)
    draft.sql = sql
    if (name !== undefined) draft.name = name
    draft.dirty = true
    draft.updatedAt = Date.now()
    await this.persist()
    this.emit(sessionId)
    return draft
  }

  async updateCurrentDraft(sessionId: string, sql: string, name?: string): Promise<QueryDraft> {
    const draft = await this.currentDraft(sessionId)
    return this.updateDraft(sessionId, draft.id, sql, name)
  }

  async setCurrent(sessionId: string, draftId: string): Promise<void> {
    const data = await this.getData()
    data.currentBySession[sessionId] = draftId
    await this.persist()
    this.emit(sessionId)
  }

  async openSaved(sessionId: string, savedQueryId: string): Promise<QueryDraft> {
    const data = await this.getData()
    const saved = data.savedQueries.find(query => query.id === savedQueryId)
    if (saved === undefined) throw new Error('Saved SQL query not found: ' + savedQueryId)
    const draft: QueryDraft = {
      id: randomUUID(),
      sessionId,
      connectionId: saved.connectionId,
      name: saved.name,
      sql: saved.sql,
      savedQueryId: saved.id,
      dirty: false,
      updatedAt: Date.now(),
    }
    data.drafts.push(draft)
    data.currentBySession[sessionId] = draft.id
    await this.persist()
    this.emit(sessionId)
    return draft
  }

  async saveCurrent(sessionId: string, name: string): Promise<SavedQuery> {
    const data = await this.getData()
    const draft = await this.currentDraft(sessionId)
    let saved = data.savedQueries.find(query => query.id === draft.savedQueryId)
    if (saved === undefined) {
      saved = { id: randomUUID(), connectionId: draft.connectionId, name, sql: draft.sql, updatedAt: Date.now() }
      data.savedQueries.push(saved)
      draft.savedQueryId = saved.id
    } else {
      saved.name = name
      saved.connectionId = draft.connectionId
      saved.sql = draft.sql
      saved.updatedAt = Date.now()
    }
    draft.name = name
    draft.dirty = false
    draft.updatedAt = saved.updatedAt
    await this.persist()
    this.emit(sessionId)
    return saved
  }

  async deleteDraft(sessionId: string, draftId: string): Promise<void> {
    const data = await this.getData()
    data.drafts = data.drafts.filter(draft => draft.id !== draftId)
    if (data.currentBySession[sessionId] === draftId) {
      const next = data.drafts.find(draft => draft.sessionId === sessionId)
      if (next === undefined) delete data.currentBySession[sessionId]
      else data.currentBySession[sessionId] = next.id
    }
    await this.persist()
    this.emit(sessionId)
  }

  async deleteSaved(savedQueryId: string): Promise<void> {
    const data = await this.getData()
    data.savedQueries = data.savedQueries.filter(query => query.id !== savedQueryId)
    await this.persist()
    for (const sessionId of Object.keys(data.currentBySession)) this.emit(sessionId)
  }
}
