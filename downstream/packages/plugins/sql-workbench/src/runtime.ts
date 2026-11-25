// @ts-nocheck
import { loadCatalog, loadObjectDetails, previewObjectPage, runQuery, testConnection } from './drivers.ts'
import { WorkbenchStore } from './store.ts'
import type {
  CatalogObject,
  CatalogSnapshot,
  ObjectDetails,
  ObjectPreviewRequest,
  PagedQueryResult,

  ConnectionConfig,
  QueryDraft,
  QueryResult,
  SavedQuery,
  WorkbenchState,
} from './types.ts'

/** Host 运行时把持久化、数据库驱动、最近结果和订阅汇成唯一业务入口。 */
export class SqlWorkbenchRuntime {
  readonly store = new WorkbenchStore()
  private readonly results = new Map<string, QueryResult>()
  private readonly details = new Map<string, ObjectDetails>()
  private readonly previews = new Map<string, PagedQueryResult>()
  private readonly listeners = new Set<(sessionId: string) => void>()

  constructor() {
    this.store.subscribe(sessionId => { this.publish(sessionId) })
  }

  subscribe(listener: (sessionId: string) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(sessionId: string): void {
    for (const listener of this.listeners) listener(sessionId)
  }

  async state(sessionId: string): Promise<WorkbenchState> {
    return {
      ...await this.store.state(sessionId, this.results.get(sessionId) ?? null),
      objectDetails: this.details.get(sessionId) ?? null,
      preview: this.previews.get(sessionId) ?? null,
    }
  }

  async saveConnection(sessionId: string, connection: ConnectionConfig): Promise<ConnectionConfig> {
    const saved = await this.store.saveConnection(connection)
    this.publish(sessionId)
    return saved
  }

  async deleteConnection(sessionId: string, connectionId: string): Promise<void> {
    await this.store.deleteConnection(connectionId)
    this.publish(sessionId)
  }

  async test(connection: ConnectionConfig): Promise<QueryResult> {
    return testConnection(connection)
  }

  async catalog(connectionId: string): Promise<CatalogSnapshot> {
    return loadCatalog(await this.store.connection(connectionId))
  }

  async createDraft(sessionId: string, connectionId: string, name: string, sql: string): Promise<QueryDraft> {
    return this.store.createDraft(sessionId, connectionId, name, sql)
  }

  async updateDraft(sessionId: string, draftId: string, sql: string, name?: string): Promise<QueryDraft> {
    return this.store.updateDraft(sessionId, draftId, sql, name)
  }

  async updateCurrent(sessionId: string, sql: string, name?: string): Promise<QueryDraft> {
    return this.store.updateCurrentDraft(sessionId, sql, name)
  }

  current(sessionId: string): Promise<QueryDraft> {
    return this.store.currentDraft(sessionId)
  }

  setCurrent(sessionId: string, draftId: string): Promise<void> {
    return this.store.setCurrent(sessionId, draftId)
  }

  openSaved(sessionId: string, savedQueryId: string): Promise<QueryDraft> {
    return this.store.openSaved(sessionId, savedQueryId)
  }

  saveCurrent(sessionId: string, name: string): Promise<SavedQuery> {
    return this.store.saveCurrent(sessionId, name)
  }

  deleteDraft(sessionId: string, draftId: string): Promise<void> {
    return this.store.deleteDraft(sessionId, draftId)
  }

  async deleteSaved(sessionId: string, savedQueryId: string): Promise<void> {
    await this.store.deleteSaved(savedQueryId)
    this.publish(sessionId)
  }

  async run(sessionId: string, connectionId: string, sql: string): Promise<QueryResult> {
    const result = await runQuery(await this.store.connection(connectionId), sql)
    this.results.set(sessionId, result)
    this.publish(sessionId)
    return result
  }

  async runCurrent(sessionId: string, sql?: string, connectionId?: string): Promise<QueryResult> {
    const draft = await this.store.currentDraft(sessionId)
    return this.run(sessionId, connectionId ?? draft.connectionId, sql ?? draft.sql)
  }

  async objectDetails(sessionId: string, connectionId: string, object: CatalogObject): Promise<ObjectDetails> {
    const details = await loadObjectDetails(await this.store.connection(connectionId), object)
    this.details.set(sessionId, details)
    this.publish(sessionId)
    return details
  }

  async preview(sessionId: string, connectionId: string, request: ObjectPreviewRequest): Promise<PagedQueryResult> {
    const result = await previewObjectPage(await this.store.connection(connectionId), request)
    this.results.set(sessionId, result)
    this.previews.set(sessionId, result)
    this.publish(sessionId)
    return result
  }
}
