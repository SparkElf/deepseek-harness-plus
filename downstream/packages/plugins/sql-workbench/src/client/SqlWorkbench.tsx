// @ts-nocheck
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  VscAdd,
  VscClose,
  VscComment,
  VscDatabase,
  VscEdit,
  VscFile,
  VscFolderOpened,
  VscPlay,
  VscRefresh,
  VscSave,
  VscSearch,
  VscTable,
  VscTrash,
} from 'react-icons/vsc'
import { qualifiedObjectName } from '../dialects.ts'
import type {
  CatalogDatabase,
  CatalogObject,
  CatalogSnapshot,
  ConnectionConfig,
  ObjectPreviewRequest,
  QueryDraft,
  SavedQuery,
  WorkbenchState,
} from '../types.ts'
import { sqlApi, subscribeSqlState } from './api.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { ConnectionDialog } from './ConnectionDialog.tsx'
import { ConnectionPicker } from './ConnectionPicker.tsx'
import { useT } from './i18n.tsx'
import { ObjectDetailsPane } from './ObjectDetailsPane.tsx'
import { ObjectTree, type ObjectContextTarget } from './ObjectTree.tsx'
import { ResultGrid } from './ResultGrid.tsx'
import { createWorkbenchStore, useWorkbench, WorkbenchStoreContext } from './store.ts'
import css from './SqlWorkbench.module.css'
import { getComposerSessionId } from './composerBridge.ts'
import { copyText } from './clipboard.ts'

interface ConversationInput {
  state: { getSnapshot(): { draft: string } }
  setDraft(text: string): void
}

interface ConversationService {
  input: { for(scope: Context): ConversationInput }
}

type ClientContext = Omit<Context, 'sessions'> & {
  sessions: { scope(sessionId: string): Context | undefined }
  /** The conversation service owns the composer; it is a root service, not a scoped one. */
  conversation: { input: { for(scope: Context): ConversationInput } }
}

/** The main-view session binding; the right-Sidebar pane carries its own id. */
interface UiSessionBinding {
  current?: { getSnapshot(): { key?: string } }
}

interface MenuState {
  x: number
  y: number
  target:
    | ObjectContextTarget
    | { kind: 'draft'; draft: QueryDraft }
    | { kind: 'saved'; query: SavedQuery }
}

export interface SqlWorkbenchProps {
  ctx: Context
  sessionId: string
  visible: boolean
}

function qualifiedName(connection: ConnectionConfig, object: CatalogObject): string {
  return qualifiedObjectName(connection.kind, object)
}

function ContextMenu({ menu, onClose, children }: { menu: MenuState; onClose(): void; children: React.ReactNode }) {
  useEffect(() => {
    const close = (): void => { onClose() }
    document.addEventListener('pointerdown', close)
    return () => { document.removeEventListener('pointerdown', close) }
  }, [onClose])
  const left = Math.min(menu.x, window.innerWidth - 184)
  const top = Math.min(menu.y, window.innerHeight - 148)
  return <div className={css.contextMenu} style={{ left, top }} onPointerDown={event => { event.stopPropagation() }}>
    {children}
  </div>
}

interface ReferenceChip {
  id: string
  label: string
  block: string
}

interface AddDialogState {
  object: CatalogObject
}

interface ToastState {
  kind: 'ok' | 'error'
  message: string
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function trimSampleValue(value: unknown): unknown {
  if (typeof value === 'string') return value.length > 200 ? value.slice(0, 200) + '…' : value
  if (value instanceof Uint8Array) return '[binary ' + String(value.byteLength) + ' B]'
  if (typeof value === 'bigint') return String(value)
  return value
}

function sampleRowsOf(preview: WorkbenchState['preview']): Array<Record<string, unknown>> | null {
  if (preview === null || preview === undefined) return null
  return preview.rows.slice(0, 5).map(row => {
    const record: Record<string, unknown> = {}
    preview.columns.forEach((column, index) => { record[column] = trimSampleValue(row[index]) })
    return record
  })
}

/**
 * Serialise one object for the model.
 *
 * The attribute list repeats what the JSON body says because a reader of the raw
 * conversation can see the type and object without parsing 100 lines of JSON; the body
 * stays the single place a tool or prompt reads the actual metadata from.
 */
function referenceBlock(
  kind: string,
  connection: string,
  database: string,
  schema: string | null,
  object: string,
  payload: Record<string, unknown>,
): string {
  const attributes = [
    'kind="' + escapeAttribute(kind) + '"',
    'connection="' + escapeAttribute(connection) + '"',
    'database="' + escapeAttribute(database) + '"',
    'schema="' + escapeAttribute(schema ?? '') + '"',
    'object="' + escapeAttribute(object) + '"',
  ].join(' ')
  return '以下是用户从 SQL Workbench 添加的数据库对象上下文，请基于它回答；不要假设未提供的行或权限。\n'
    + '<sql_workbench_reference ' + attributes + '>\n'
    + JSON.stringify(payload, null, 2)
    + '\n</sql_workbench_reference>'
}

function SqlWorkbenchBody({ ctx, sessionId, visible }: SqlWorkbenchProps) {
  const t = useT()
  const server = useWorkbench(state => state.server)
  const catalog = useWorkbench(state => state.catalog)
  const selectedConnectionId = useWorkbench(state => state.selectedConnectionId)
  const selectedDatabase = useWorkbench(state => state.selectedDatabase)
  const selectedObject = useWorkbench(state => state.selectedObject)
  const mainMode = useWorkbench(state => state.mainMode)
  const explorerMode = useWorkbench(state => state.explorerMode)
  const loading = useWorkbench(state => state.loading)
  const error = useWorkbench(state => state.error)
  const adoptServer = useWorkbench(state => state.adoptServer)
  const setCatalog = useWorkbench(state => state.setCatalog)
  const selectConnection = useWorkbench(state => state.selectConnection)
  const selectDatabase = useWorkbench(state => state.selectDatabase)
  const selectObject = useWorkbench(state => state.selectObject)
  const setMainMode = useWorkbench(state => state.setMainMode)
  const setExplorerMode = useWorkbench(state => state.setExplorerMode)
  const setLoading = useWorkbench(state => state.setLoading)
  const setError = useWorkbench(state => state.setError)
  const updateDraftLocal = useWorkbench(state => state.updateDraftLocal)
  const [search, setSearch] = useState('')
  const [connectionDialog, setConnectionDialog] = useState<ConnectionConfig | null | undefined>(undefined)
  const [saveDialog, setSaveDialog] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [chips, setChips] = useState<ReferenceChip[]>([])
  const [addDialog, setAddDialog] = useState<AddDialogState | null>(null)
  const [addOptions, setAddOptions] = useState({ structure: true, samples: false, ddl: false })
  const [toast, setToast] = useState<ToastState | null>(null)
  const editorSql = useRef('')

  const current = server?.drafts.find(draft => draft.id === server.currentDraftId) ?? null
  const selectedConnection = server?.connections.find(connection => connection.id === selectedConnectionId) ?? null

  const perform = useCallback(async <T,>(label: string, action: () => Promise<T>): Promise<T | undefined> => {
    setLoading(label)
    setError(null)
    try {
      return await action()
    } catch (failure) {
      console.error('[dsh-sql-workbench] ' + label + ' failed', failure)
      setError(failure instanceof Error ? failure.message : String(failure))
      return undefined
    } finally {
      setLoading(null)
    }
  }, [setError, setLoading])

  useEffect(() => {
    if (!visible) return
    void perform(t('status.load'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('state', { sessionId }))
    })
    return subscribeSqlState(sessionId, adoptServer, failure => {
      console.error('[dsh-sql-workbench] state subscription failed', failure)
      setError(failure.message)
    })
  }, [adoptServer, perform, sessionId, setError, visible])

  useEffect(() => {
    if (!visible || selectedConnectionId === null) return
    void perform(t('status.catalog'), async () => {
      setCatalog(await sqlApi<CatalogSnapshot>('catalog.list', { connectionId: selectedConnectionId }))
    })
  }, [perform, selectedConnectionId, setCatalog, visible])

  useEffect(() => { editorSql.current = current?.sql ?? '' }, [current?.id, current?.sql])

  useEffect(() => {
    if (toast === null) return
    const timer = window.setTimeout(() => { setToast(null) }, 3200)
    return () => { window.clearTimeout(timer) }
  }, [toast])

  // A chip is a promise that its block is still in the draft. Sending clears the
  // draft, and the chip must disappear with it rather than outliving the message.
  useEffect(() => {
    if (chips.length === 0) return
    const timer = window.setInterval(() => {
      const input = conversationInput()
      if (input === null) return
      const draft = input.state.getSnapshot().draft
      setChips(previous => {
        const next = previous.filter(chip => draft.includes(chip.block))
        return next.length === previous.length ? previous : next
      })
    }, 1500)
    return () => { window.clearInterval(timer) }
  }, [chips])

  const updateSql = useCallback((sql: string): void => {
    if (current === null) return
    editorSql.current = sql
    updateDraftLocal(current.id, sql)
  }, [current, updateDraftLocal])

  const commitSql = useCallback((sql: string): void => {
    if (current === null) return
    editorSql.current = sql
    void sqlApi<WorkbenchState>('draft.update', { sessionId, draftId: current.id, sql }).catch(failure => {
      console.error('[dsh-sql-workbench] commit query draft failed', failure)
      setError(failure instanceof Error ? failure.message : String(failure))
    })
  }, [current, sessionId, setError])

  const conversationInput = useCallback((): ConversationInput | null => {
    try {
      const client = ctx as unknown as ClientContext
      // The right-Sidebar pane has its own session id, which is not always an open
      // DSH Session. The main-view binding is the conversation the reader is looking
      // at, so prefer it when it exists.
      // The dock bridge is authoritative: it is the only contribution that receives the
      // composer's own Session id. `uiSession.current` and the pane prop are fallbacks.
      const activeId = (ctx.get('uiSession') as UiSessionBinding | undefined)?.current?.getSnapshot().key
      const targetId = getComposerSessionId() ?? activeId ?? sessionId
      const scope = client.sessions.scope(targetId)
      if (scope === undefined) return null
      const conversation = client.conversation
      if (conversation === undefined || conversation.input === undefined) return null
      return conversation.input.for(scope)
    } catch {
      return null
    }
  }, [ctx, sessionId])

  /**
   * Put one reference block into the conversation draft.
   *
   * This never throws: a missing conversation scope is a Toast, because the reader
   * clicked a button and a dead control must say why it did nothing.
   */
  const appendToChat = useCallback((block: string): boolean => {
    const input = conversationInput()
    if (input === null) {
      setToast({ kind: 'error', message: t('add.scopeUnavailable') })
      return false
    }
    try {
      const draft = input.state.getSnapshot().draft
      input.setDraft(draft.trim() === '' ? block : draft.trimEnd() + '\n\n' + block)
      return true
    } catch (failure) {
      console.error('[dsh-sql-workbench] append to conversation failed', failure)
      setToast({ kind: 'error', message: failure instanceof Error ? failure.message : t('add.scopeUnavailable') })
      return false
    }
  }, [conversationInput, t])

  const removeChip = useCallback((chip: ReferenceChip): void => {
    const input = conversationInput()
    if (input !== null) {
      const draft = input.state.getSnapshot().draft
      if (draft.includes(chip.block)) {
        input.setDraft(draft.replace(chip.block, '').replace(/\n{3,}/gu, '\n\n').trim())
      }
    }
    setChips(previous => previous.filter(candidate => candidate.id !== chip.id))
  }, [conversationInput])

  const openAddDialog = useCallback((object: CatalogObject): void => {
    setAddOptions({ structure: true, samples: false, ddl: false })
    setAddDialog({ object })
  }, [])

  /**
   * Build and append one object reference.
   *
   * Details and sample rows are read on demand: the inspector may have been opened
   * for a different object, and a sampled SELECT must never be what makes the panel
   * switch to the results tab. Both calls are tolerant -- a failed sample is skipped
   * with a Toast rather than cancelling the whole reference.
   */
  const confirmAddDialog = useCallback(async (): Promise<void> => {
    const dialog = addDialog
    if (dialog === null || selectedConnectionId === null) return
    const object = dialog.object
    let details = server?.objectDetails ?? null
    if (details === null || details.object.name !== object.name || details.object.schema !== object.schema) {
      try {
        const next = await sqlApi<WorkbenchState>('object.details', { sessionId, connectionId: selectedConnectionId, object })
        details = next.objectDetails ?? null
      } catch (failure) {
        console.error('[dsh-sql-workbench] reference details failed', failure)
      }
    }
    let samples: Array<Record<string, unknown>> | null = null
    if (addOptions.samples) {
      try {
        const next = await sqlApi<WorkbenchState>('object.preview', {
          sessionId,
          connectionId: selectedConnectionId,
          request: { object, page: 1, pageSize: 5, filters: [], sort: null },
        })
        samples = sampleRowsOf(next.preview ?? null)
      } catch (failure) {
        console.error('[dsh-sql-workbench] reference samples failed', failure)
        setToast({ kind: 'error', message: t('add.sampleMissing') })
      }
    }
    const primary = new Set([
      ...(details?.indexes.filter(index => index.primary).flatMap(index => index.columns) ?? []),
      ...(details?.constraints.filter(constraint => constraint.kind === 'primary').flatMap(constraint => constraint.columns) ?? []),
    ])
    const ddl = details?.ddl ?? object.definition ?? null
    const payload: Record<string, unknown> = {
      kind: object.kind,
      qualifiedName: details?.qualifiedName ?? qualifiedName(selectedConnection as ConnectionConfig, object),
      comment: object.comment ?? null,
      estimatedRows: object.estimatedRows ?? null,
      columns: (addOptions.structure ? object.columns : []).map(column => ({
        name: column.name,
        type: column.dataType,
        nullable: column.nullable,
        default: column.defaultValue,
        primaryKey: primary.has(column.name),
        comment: column.comment ?? null,
      })),
      indexes: addOptions.structure ? details?.indexes ?? [] : [],
      foreignKeys: addOptions.structure ? details?.foreignKeys ?? [] : [],
      ddl: addOptions.ddl ? ddl : null,
      sampleRows: samples,
    }
    const block = referenceBlock(object.kind, selectedConnection?.name ?? '', object.database, object.schema, object.name, payload)
    if (!appendToChat(block)) {
      // The toast explains the missing scope; close the popover so it does not keep
      // covering the composer the reader has to use instead.
      setAddDialog(null)
      return
    }
    setChips(previous => [...previous, {
      id: object.name + ':' + String(Date.now()),
      label: '[' + object.kind + '] ' + object.name + ' · ' + t('add.columnCount', { count: object.columns.length }),
      block,
    }])
    setToast({ kind: 'ok', message: t('add.added') })
    setAddDialog(null)
  }, [addDialog, addOptions, appendToChat, selectedConnection, selectedConnectionId, server?.objectDetails, sessionId, t])

  const refreshCatalog = (): void => {
    if (selectedConnectionId === null) return
    void perform(t('status.refresh'), async () => {
      setCatalog(await sqlApi<CatalogSnapshot>('catalog.list', { connectionId: selectedConnectionId }))
    })
  }

  const deleteConnection = (): void => {
    if (selectedConnectionId === null) return
    void perform(t('status.deleteConnection'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('connections.delete', { sessionId, connectionId: selectedConnectionId }))
      setCatalog(null)
    })
  }

  const createDraft = (sql = ''): void => {
    if (selectedConnectionId === null || server === null) return
    const count = server.drafts.length + 1
    void perform(t('status.createQuery'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('draft.create', {
        sessionId,
        connectionId: selectedConnectionId,
        name: t('query.untitled', { count }),
        sql,
      }))
      setMainMode('query')
    })
  }

  const closeDraft = (draft: QueryDraft): void => {
    void perform(t('status.closeQuery'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('draft.delete', { sessionId, draftId: draft.id }))
    })
  }

  const setCurrent = (draft: QueryDraft): void => {
    void perform(t('status.switchQuery'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('draft.current', { sessionId, draftId: draft.id }))
      selectConnection(draft.connectionId)
      setMainMode('query')
    })
  }

  const openSaved = (query: SavedQuery): void => {
    void perform(t('status.openQuery'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('saved.open', { sessionId, savedQueryId: query.id }))
      selectConnection(query.connectionId)
      setMainMode('query')
    })
  }

  const runCurrent = (): void => {
    if (current === null) return
    void perform(t('status.runQuery'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('query.run', {
        sessionId,
        connectionId: current.connectionId,
        draftId: current.id,
        sql: editorSql.current,
      }))
      setMainMode('results')
    })
  }

  const showObjectDetails = (object: CatalogObject): void => {
    if (selectedConnectionId === null) return
    selectObject(object)
    setMainMode('objects')
    void perform(t('status.catalog'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('object.details', { sessionId, connectionId: selectedConnectionId, object }))
    })
  }

  const updatePreview = (request: ObjectPreviewRequest): void => {
    if (selectedConnectionId === null) return
    void perform(t('status.preview'), async () => {
      adoptServer(await sqlApi<WorkbenchState>('object.preview', { sessionId, connectionId: selectedConnectionId, request }))
      setMainMode('results')
    })
  }

  const previewObject = (object: CatalogObject): void => {
    updatePreview({ object, page: 1, pageSize: 50, filters: [], sort: null })
  }

  const saveCurrent = (): void => {
    if (current === null) return
    setSaveName(current.name)
    setSaveDialog(true)
  }

  const submitSave = (): void => {
    void perform(t('status.saveQuery'), async () => {
      if (current === null) return
      adoptServer(await sqlApi<WorkbenchState>('draft.save', {
        sessionId,
        draftId: current.id,
        sql: editorSql.current,
        name: saveName,
      }))
      setSaveDialog(false)
    })
  }

  const saveConnection = async (connection: ConnectionConfig): Promise<void> => {
    const next = await sqlApi<WorkbenchState>('connections.save', { sessionId, connection })
    adoptServer(next)
    const saved = connection.id === ''
      ? next.connections[next.connections.length - 1]
      : next.connections.find(item => item.id === connection.id)
    if (saved !== undefined) selectConnection(saved.id)
  }

  const testConnection = async (connection: ConnectionConfig): Promise<{ durationMs?: number }> => {
    return await sqlApi<{ durationMs?: number }>('connections.test', { connection })
  }

  const referenceConnection = selectedConnection
  const appendSimpleReference = (
    kind: string,
    objectName: string,
    label: string,
    payload: Record<string, unknown>,
  ): void => {
    const block = referenceBlock(
      kind,
      referenceConnection?.name ?? '',
      referenceConnection?.kind === 'sqlite' ? 'main' : referenceConnection?.database ?? '',
      null,
      objectName,
      payload,
    )
    if (!appendToChat(block)) return
    setChips(previous => [...previous, {
      id: kind + ':' + objectName + ':' + String(Date.now()),
      label,
      block,
    }])
    setToast({ kind: 'ok', message: t('add.added') })
  }
  const addObjectReference = (object: CatalogObject): void => {
    openAddDialog(object)
  }
  const addDatabaseReference = (database: CatalogDatabase): void => {
    appendSimpleReference(
      'database',
      database.name,
      '[database] ' + database.name,
      {
        kind: 'database',
        name: database.name,
        product: database.product ?? null,
        version: database.version ?? null,
        schemas: database.schemas.map(schema => ({
          name: schema.name,
          objects: schema.objects.length,
        })),
      },
    )
  }
  const addDraftReference = (draft: QueryDraft): void => {
    const connection = server?.connections.find(item => item.id === draft.connectionId)
    appendSimpleReference(
      'query-draft',
      draft.name,
      '[query] ' + draft.name,
      { kind: 'query-draft', name: draft.name, connection: connection?.name ?? null, sql: draft.sql },
    )
  }
  const addSavedReference = (query: SavedQuery): void => {
    const connection = server?.connections.find(item => item.id === query.connectionId)
    appendSimpleReference(
      'saved-query',
      query.name,
      '[saved query] ' + query.name,
      { kind: 'saved-query', name: query.name, connection: connection?.name ?? null, sql: query.sql },
    )
  }

  const objectSql = (object: CatalogObject): string => 'SELECT * FROM ' + qualifiedName(selectedConnection as ConnectionConfig, object) + ';'
  const menuTarget = menu?.target ?? null

  return <div className={css.root} data-dsh-sql-workbench data-mode={mainMode}>
    <div className={css.topbar}>
      <VscDatabase size={16} />
      <ConnectionPicker
        connections={server?.connections ?? []}
        selectedId={selectedConnectionId}
        onSelect={selectConnection}
      />
      <button className={css.iconButton} title={t('connection.new')} onClick={() => { setConnectionDialog(null) }}><VscAdd /></button>
      <button className={css.iconButton} title={t('connection.edit')} disabled={selectedConnection === null} onClick={() => { setConnectionDialog(selectedConnection) }}><VscEdit /></button>
      <button className={css.iconButton} title={t('connection.delete')} disabled={selectedConnection === null} onClick={deleteConnection}><VscTrash /></button>
      <button className={css.iconButton} title={t('connection.refresh')} disabled={selectedConnection === null} onClick={refreshCatalog}><VscRefresh /></button>
    </div>

    <div className={css.modebar}>
      <button data-active={mainMode === 'objects'} onClick={() => { setMainMode('objects') }}>{t('mode.objects')}</button>
      <button data-active={mainMode === 'query'} onClick={() => { setMainMode('query') }}>{t('mode.query')}</button>
      <button data-active={mainMode === 'results'} onClick={() => { setMainMode('results') }}>{t('mode.results')}</button>
    </div>

    {error !== null && <div className={css.errorBar}>{error}</div>}
    {loading !== null && <div className={css.loadingBar}>{loading}</div>}
    {chips.length > 0 && <div className={css.chipBar} data-sql-reference-chips>
      {chips.map(chip => <span className={css.referenceChip} key={chip.id}>
        <span className={css.referenceChipLabel}>{chip.label}</span>
        <button title={t('add.chipRemove')} onClick={() => { removeChip(chip) }}><VscClose size={12} /></button>
      </span>)}
    </div>}
    {toast !== null && <div className={css.toast} data-kind={toast.kind} role="status">{toast.message}</div>}

    <div className={css.body}>
      <aside className={css.explorer}>
        <div className={css.explorerTabs} data-sql-explorer-tabs>
          <button data-active={explorerMode === 'objects'} onClick={() => { setExplorerMode('objects') }}>{t('mode.objects')}</button>
          <button data-active={explorerMode === 'queries'} onClick={() => { setExplorerMode('queries') }}>{t('mode.query')}</button>
          <button className={css.iconButton} title={t('query.new')} onClick={() => { createDraft() }}><VscAdd /></button>
        </div>
        {explorerMode === 'objects' ? <>
          <label className={css.searchBox}><VscSearch size={14} /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder={t('search.objects')} /></label>
          <ObjectTree
            catalog={catalog}
            search={search}
            selectedDatabase={selectedDatabase}
            selected={selectedObject}
            onSelectDatabase={database => { selectDatabase(database); setMainMode('objects') }}
            onSelect={showObjectDetails}
            onPreview={previewObject}
            onContextMenu={(event, target) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, target }) }}
          />
        </> : <div className={css.queryList}>
          <div className={css.groupLabel}>{t('group.drafts')}</div>
          {server?.drafts.map(draft => <button
            key={draft.id}
            className={css.queryRow}
            data-current={draft.id === server.currentDraftId}
            onClick={() => { setCurrent(draft) }}
            onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, target: { kind: 'draft', draft } }) }}
          >
            <VscFile size={15} />
            <span>{draft.name}</span>
            {draft.dirty && <span className={css.dirtyDot} />}
          </button>)}
          <div className={css.groupLabel}>{t('group.saved')}</div>
          {server?.savedQueries.map(query => <button
            key={query.id}
            className={css.queryRow}
            onDoubleClick={() => { openSaved(query) }}
            onContextMenu={event => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY, target: { kind: 'saved', query } }) }}
          >
            <VscFolderOpened size={15} /><span>{query.name}</span>
          </button>)}
        </div>}
      </aside>

      <main className={css.workspace}>
        {mainMode === 'objects' ? <ObjectDetailsPane
          connection={selectedConnection}
          database={selectedDatabase}
          object={selectedObject}
          details={server?.objectDetails ?? null}
          onPreview={previewObject}
          onAdd={addObjectReference}
          onRefresh={showObjectDetails}
        /> : <>
          <div className={css.queryTabs}>
            {server?.drafts.map(draft => <div key={draft.id} className={css.queryTab} data-active={draft.id === server.currentDraftId}>
              <button className={css.queryTabMain} onClick={() => { setCurrent(draft) }}>
                <span>{draft.name}</span>
                {draft.dirty && <span className={css.dirtyDot} />}
              </button>
              <button className={css.queryTabClose} title={t('query.close')} onClick={() => { closeDraft(draft) }}><VscClose /></button>
            </div>)}
            <button className={css.iconButton} title={t('query.new')} onClick={() => { createDraft() }}><VscAdd /></button>
          </div>
          {mainMode === 'results' ? <section className={css.resultsPane}>
            <div className={css.resultTabs}><button data-active>{t('mode.results')}</button><button>{t('mode.messages')}</button></div>
            <ResultGrid result={server?.preview ?? server?.result ?? null} onPreviewChange={updatePreview} />
          </section> : current === null || selectedConnection === null ? <div className={css.workspaceEmpty}>
            <VscDatabase size={28} />
            <button className={css.primaryButton} disabled={selectedConnectionId === null} onClick={() => { createDraft() }}>{t('query.new')}</button>
          </div> : <>
            <div className={css.queryToolbar}>
              <button className={css.commandButton} title={t('query.run')} onClick={runCurrent}><VscPlay />{t('query.run.short')}</button>
              <button className={css.iconButton} title={t('query.save')} onClick={saveCurrent}><VscSave /></button>
              <button className={css.commandButton} title={t('query.addCurrent')} onClick={() => { addDraftReference(current) }}><VscComment />{t('menu.add')}</button>
              <span className={css.toolbarSpacer} />
              <span className={css.connectionMeta}>{selectedConnection.kind}</span>
            </div>
            <section className={css.editorPane}>
              <CodeEditor value={current.sql} kind={selectedConnection.kind} onChange={updateSql} onCommit={commitSql} />
            </section>
            <section className={css.resultsPane}>
              <div className={css.resultTabs}><button data-active>{t('mode.results')}</button><button>{t('mode.messages')}</button></div>
              <ResultGrid result={server?.preview ?? server?.result ?? null} onPreviewChange={updatePreview} />
            </section>
          </>}
        </>}
      </main>
    </div>

    {connectionDialog !== undefined && <ConnectionDialog
      connection={connectionDialog}
      onClose={() => { setConnectionDialog(undefined) }}
      onSave={saveConnection}
      onTest={testConnection}
    />}

    {addDialog !== null && <div className={css.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) setAddDialog(null) }}>
      <div className={css.addPopover} role="dialog" aria-label={t('add.title')}>
        <div className={css.dialogTitle}>{t('add.title')} · {addDialog.object.name}</div>
        <label className={css.addOption}><input type="checkbox" checked={addOptions.structure} onChange={event => { setAddOptions(current => ({ ...current, structure: event.target.checked })) }} />{t('add.structure')}</label>
        <label className={css.addOption}><input type="checkbox" checked={addOptions.samples} onChange={event => { setAddOptions(current => ({ ...current, samples: event.target.checked })) }} />{t('add.samples')}</label>
        <label className={css.addOption}><input type="checkbox" checked={addOptions.ddl} onChange={event => { setAddOptions(current => ({ ...current, ddl: event.target.checked })) }} />{t('add.ddl')}</label>
        <p className={css.addHint}>{t('add.hint')}</p>
        <div className={css.dialogActions}>
          <button onClick={() => { setAddDialog(null) }}>{t('action.cancel')}</button>
          <button className={css.primaryButton} onClick={() => { void confirmAddDialog() }}>{t('add.confirm')}</button>
        </div>
      </div>
    </div>}

    {saveDialog && <div className={css.dialogBackdrop} onMouseDown={event => { if (event.target === event.currentTarget) setSaveDialog(false) }}>
      <div className={css.dialog} role="dialog" aria-label={t('query.save')}>
        <div className={css.dialogTitle}>{t('query.save')}</div>
        <label className={css.field}><span>{t('query.name')}</span><input value={saveName} onChange={event => { setSaveName(event.target.value) }} /></label>
        <div className={css.dialogActions}><button onClick={() => { setSaveDialog(false) }}>{t('action.cancel')}</button><button className={css.primaryButton} onClick={submitSave}>{t('action.save')}</button></div>
      </div>
    </div>}

    {menu !== null && menuTarget !== null && <ContextMenu menu={menu} onClose={() => { setMenu(null) }}>
      {menuTarget.kind === 'database' && <button onClick={() => { addDatabaseReference(menuTarget.database); setMenu(null) }}><VscComment />{t('menu.addDatabase')}</button>}
      {menuTarget.kind === 'object' && <>
        <button onClick={() => { previewObject(menuTarget.object); setMenu(null) }}><VscTable />{t('menu.preview')}</button>
        <button onClick={() => { createDraft(objectSql(menuTarget.object)); setMenu(null) }}><VscAdd />{t('query.new')}</button>
        <button onClick={() => { addObjectReference(menuTarget.object); setMenu(null) }}><VscComment />{t('menu.add')}</button>
        <button onClick={() => { void perform(t('status.copyName'), async () => { if (!await copyText(qualifiedName(selectedConnection as ConnectionConfig, menuTarget.object))) throw new Error(t('inspector.copyFailed')) }); setMenu(null) }}><VscFile />{t('menu.copyName')}</button>
      </>}
      {menuTarget.kind === 'draft' && <>
        <button onClick={() => { setCurrent(menuTarget.draft); setMenu(null) }}><VscEdit />{t('query.current')}</button>
        <button onClick={() => { addDraftReference(menuTarget.draft); setMenu(null) }}><VscComment />{t('query.add')}</button>
        <button onClick={() => { setCurrent(menuTarget.draft); setSaveName(menuTarget.draft.name); setSaveDialog(true); setMenu(null) }}><VscSave />{t('query.save')}</button>
        <button onClick={() => { closeDraft(menuTarget.draft); setMenu(null) }}><VscClose />{t('query.close')}</button>
      </>}
      {menuTarget.kind === 'saved' && <>
        <button onClick={() => { openSaved(menuTarget.query); setMenu(null) }}><VscEdit />{t('query.openCopy')}</button>
        <button onClick={() => { addSavedReference(menuTarget.query); setMenu(null) }}><VscComment />{t('query.add')}</button>
        <button onClick={() => { void perform(t('status.deleteQuery'), async () => { adoptServer(await sqlApi<WorkbenchState>('saved.delete', { sessionId, savedQueryId: menuTarget.query.id })) }); setMenu(null) }}><VscTrash />{t('menu.delete')}</button>
      </>}
    </ContextMenu>}
  </div>
}

export function SqlWorkbench(props: SqlWorkbenchProps) {
  const store = useMemo(() => createWorkbenchStore(), [props.sessionId])
  return <WorkbenchStoreContext.Provider value={store}><SqlWorkbenchBody {...props} /></WorkbenchStoreContext.Provider>
}
