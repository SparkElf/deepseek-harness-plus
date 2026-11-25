import { useEffect, useMemo, useRef, useState } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  VscAdd,
  VscClose,
  VscCloud,
  VscCloudDownload,
  VscCloudUpload,
  VscCode,
  VscComment,
  VscCopy,
  VscEdit,
  VscFolder,
  VscHistory,
  VscJson,
  VscPlay,
  VscSave,
  VscSearch,
  VscTrash,
  VscSymbolVariable,
} from 'react-icons/vsc'
import type {
  ApiAuthKind,
  ApiAuthSecretInput,
  ApiBodyKind,
  ApiClientState,
  ApiCollection,
  ApiEnvironment,
  ApiEnvironmentVariable,
  ApiKeyValue,
  ApiMethod,
  ApiMultipartPart,
  ApiRequest,
  ApiResponse,
  ApiWorkspace,
} from '../types.ts'
import { apiClientCall, type ApiExchangeFormat, type ExecuteResult, type ExportResult, type ImportResult, loadApiState } from './api.ts'
import { ActionMenu, Select, type SelectOption } from './Dropdown.tsx'
import { useT, type Translate, type TranslationKey } from './i18n.tsx'
import { cloneRequest, findUndefinedVariables, readMultipartParts, requestFingerprint, responseCookies, responseForRequest, validateJsonBody, writeMultipartParts } from './model.ts'
import { parseCurl } from '../curl.ts'
import { JsonTree, parseJsonValue } from './JsonTree.tsx'
import { copyText } from './clipboard.ts'
import css from './ApiClient.module.css'

interface ConversationInput { state: { getSnapshot(): { draft: string } }; setDraft(text: string): void }
interface ClientServices { sessions: { scope(sessionId: string): Context | undefined }; conversation: { input: { for(scope: Context): ConversationInput } } }
type EditorTab = 'params' | 'headers' | 'auth' | 'body'
type ResponseTab = 'pretty' | 'raw' | 'headers' | 'cookies' | 'history'
type NarrowView = 'explorer' | 'request' | 'response'
type CreateKind = 'workspace' | 'collection' | 'environment'
const EDITOR_TAB_KEYS: Record<EditorTab, TranslationKey> = { params: 'request.params', headers: 'request.headers', auth: 'request.auth', body: 'request.body' }
const RESPONSE_TAB_KEYS: Record<ResponseTab, TranslationKey> = { pretty: 'response.pretty', raw: 'response.raw', headers: 'response.headers', cookies: 'response.cookies', history: 'response.history' }
const NARROW_VIEW_KEYS: Record<NarrowView, TranslationKey> = { explorer: 'nav.explorer', request: 'nav.request', response: 'nav.response' }
const RESOURCE_KEYS: Record<CreateKind, TranslationKey> = { workspace: 'resource.workspace', collection: 'resource.collection', environment: 'resource.environment' }
interface RequestDraftTab {
  key: string
  draft: ApiRequest
  savedFingerprint: string | null
  authSecret: ApiAuthSecretInput
  selectedResponseId: string | null
}

const EMPTY: ApiClientState = { workspaces: [], collections: [], environments: [], requests: [], history: [] }
const METHODS: ApiMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const METHOD_OPTIONS: SelectOption<ApiMethod>[] = METHODS.map(value => ({ value, label: value }))
function authOptions(t: Translate): SelectOption<ApiAuthKind>[] {
  return [
    { value: 'none', label: t('auth.none') },
    { value: 'inherit', label: t('auth.inherit') },
    { value: 'basic', label: t('auth.basic') },
    { value: 'bearer', label: t('auth.bearer') },
    { value: 'api-key', label: t('auth.apiKey') },
    { value: 'oauth2', label: t('auth.oauth2') },
  ]
}
function bodyOptions(t: Translate): SelectOption<ApiBodyKind>[] {
  return [
    { value: 'none', label: t('body.noneOption') },
    { value: 'json', label: 'JSON' },
    { value: 'text', label: t('body.text') },
    { value: 'xml', label: 'XML' },
    { value: 'form', label: 'x-www-form-urlencoded' },
    { value: 'multipart', label: 'form-data' },
    { value: 'graphql', label: 'GraphQL' },
    { value: 'binary', label: t('body.binary') },
  ]
}

function emptyRequest(collectionId: string, name: string): ApiRequest {
  return { id: '', collectionId, name, description: '', method: 'GET', url: 'https://', query: [], headers: [], auth: { kind: 'none', credentialId: null, options: {} }, body: { kind: 'none', content: '' }, environmentId: null }
}
function emptyRow(): ApiKeyValue { return { key: '', value: '', enabled: true } }
function isDirty(tab: RequestDraftTab): boolean { return tab.savedFingerprint === null || tab.savedFingerprint !== requestFingerprint(tab.draft) }

function IconButton({ label, disabled, onClick, children }: { label: string; disabled?: boolean; onClick(): void; children: React.ReactNode }) {
  return <button type="button" className={css.iconButton} title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
}

function KeyValues({ values, onChange, valueLabel }: { values: ApiKeyValue[]; onChange(values: ApiKeyValue[]): void; valueLabel?: string }) {
  const t = useT()
  const resolvedValueLabel = valueLabel ?? t('table.value')
  return <div className={css.keyValues}>
    <div className={css.tableHead}><span /><span>{t('table.key')}</span><span>{resolvedValueLabel}</span><span /></div>
    {values.map((item, index) => <div className={css.keyRow} key={index}>
      <input aria-label={t('table.enableRow', { index: index + 1 })} type="checkbox" checked={item.enabled} onChange={event => { const next = [...values]; next[index] = { ...item, enabled: event.target.checked }; onChange(next) }} />
      <input aria-label={t('table.keyIndex', { index: index + 1 })} placeholder={t('table.key')} value={item.key} onChange={event => { const next = [...values]; next[index] = { ...item, key: event.target.value }; onChange(next) }} />
      <input aria-label={t('table.valueIndex', { label: resolvedValueLabel, index: index + 1 })} placeholder={resolvedValueLabel} value={item.value} onChange={event => { const next = [...values]; next[index] = { ...item, value: event.target.value }; onChange(next) }} />
      <IconButton label={t('table.deleteRow')} onClick={() => { onChange(values.filter((_, row) => row !== index)) }}><VscTrash /></IconButton>
    </div>)}
    <button type="button" className={css.addRow} onClick={() => { onChange([...values, emptyRow()]) }}><VscAdd />{t('table.addRow')}</button>
  </div>
}

function MultipartEditor({ content, onChange }: { content: string; onChange(content: string): void }) {
  const t = useT()
  const parts = readMultipartParts(content)
  const options = [{ value: 'text', label: t('part.text') }, { value: 'file', label: t('part.file') }]
  const update = (index: number, patch: Partial<ApiMultipartPart>): void => { const next = [...parts]; next[index] = { ...next[index] as ApiMultipartPart, ...patch }; onChange(writeMultipartParts(next)) }
  return <div className={css.keyValues}>
    <div className={[css.tableHead, css.multipartHead].join(' ')}><span /><span>{t('multipart.name')}</span><span>{t('table.value')}</span><span>{t('multipart.type')}</span><span /></div>
    {parts.map((part, index) => <div className={[css.keyRow, css.multipartRow].join(' ')} key={index}>
      <input aria-label={t('multipart.enablePart', { index: index + 1 })} type="checkbox" checked={part.enabled} onChange={event => { update(index, { enabled: event.target.checked }) }} />
      <input aria-label={t('multipart.nameIndex', { index: index + 1 })} placeholder={t('multipart.name')} value={part.key} onChange={event => { update(index, { key: event.target.value }) }} />
      <input aria-label={t('multipart.valueIndex', { index: index + 1 })} placeholder={part.type === 'file' ? t('multipart.fileData') : t('table.value')} value={part.value} onChange={event => { update(index, { value: event.target.value }) }} />
      <Select label={t('multipart.typeIndex', { index: index + 1 })} value={part.type} options={options} onChange={type => { update(index, { type: type as ApiMultipartPart['type'] }) }} />
      <IconButton label={t('multipart.deletePart')} onClick={() => { onChange(writeMultipartParts(parts.filter((_, row) => row !== index))) }}><VscTrash /></IconButton>
    </div>)}
    <button type="button" className={css.addRow} onClick={() => { onChange(writeMultipartParts([...parts, { key: '', value: '', enabled: true, type: 'text' }])) }}><VscAdd />{t('multipart.addPart')}</button>
  </div>
}

function ResponseViewer({ response, history, tab, onTab, onHistory, onCopyCurl, copiedCurl }: { response: ApiResponse | null; history: ApiResponse[]; tab: ResponseTab; onTab(tab: ResponseTab): void; onHistory(id: string): void; onCopyCurl(): void; copiedCurl: boolean }) {
  const t = useT()
  const cookies = response === null ? [] : responseCookies(response)
  const json = response === null ? undefined : parseJsonValue(response.body)
  const tabLabels: Record<ResponseTab, string> = { pretty: t('response.pretty'), raw: t('response.raw'), headers: t('response.headers'), cookies: t('response.cookies'), history: t('response.history') }
  return <section className={css.responsePane} data-response-pane aria-label={t('response.title')}>
    <header className={css.responseHeader}>
      <strong>{t('response.title')}</strong>
      {response !== null && <div className={css.responseMetrics}><span data-status={response.status}>{response.status} {response.statusText}</span><span>{response.durationMs} ms</span><span>{response.sizeBytes.toLocaleString()} B</span>{response.bodyTruncated && <span>{t('response.truncated')}</span>}</div>}
      {response !== null && <button type="button" className={css.responseCopy} aria-label={t('response.copyCurl')} onClick={onCopyCurl}><VscCopy aria-hidden="true" /><span>{copiedCurl ? t('response.copied') : t('response.copyCurl')}</span></button>}
    </header>
    <nav className={css.tabs} aria-label={t('response.views')}>
      {(['pretty', 'raw', 'headers', 'cookies', 'history'] as ResponseTab[]).map(value => <button type="button" data-active={tab === value} key={value} onClick={() => { onTab(value) }}>{tabLabels[value]}{value === 'history' && history.length > 0 ? ' (' + history.length.toString() + ')' : ''}</button>)}
    </nav>
    <div className={css.responseContent}>
      {tab !== 'history' && response === null && <div className={css.empty}>{t('response.empty')}</div>}
      {response !== null && tab === 'pretty' && (json === undefined ? <pre className={css.code}>{response.body}</pre> : <JsonTree value={json} />)}
      {response !== null && tab === 'raw' && <pre className={css.code}>{response.body}</pre>}
      {response !== null && tab === 'headers' && <div className={css.responseTable}>{response.headers.map((header, index) => <div key={index}><strong>{header.key}</strong><span>{header.value}</span></div>)}</div>}
      {response !== null && tab === 'cookies' && (cookies.length === 0 ? <div className={css.empty}>{t('response.noCookies')}</div> : <div className={css.responseTable}>{cookies.map((cookie, index) => <div key={index}><strong>{cookie.name}</strong><span>{cookie.value}</span><small>{cookie.attributes}</small></div>)}</div>)}
      {tab === 'history' && <div className={css.history} aria-label={t('history.recent')}>{history.length === 0 ? <div className={css.empty}>{t('response.noHistory')}</div> : history.map(item => <button type="button" key={item.id} data-selected={item.id === response?.id} onClick={() => { onHistory(item.id) }}><strong data-status={item.status}>{item.status}</strong><span>{new Date(item.receivedAt).toLocaleString()}</span><span>{item.durationMs} ms</span><span>{item.sizeBytes.toLocaleString()} B</span></button>)}</div>}
    </div>
  </section>
}

export function ApiClient({ ctx, sessionId, visible }: { ctx: Context; sessionId: string; visible: boolean }) {
  const t = useT()
  const [state, setState] = useState(EMPTY)
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const [activeEnvironmentId, setActiveEnvironmentId] = useState<string | null>(null)
  const [requestTabs, setRequestTabs] = useState<RequestDraftTab[]>([])
  const [activeTabKey, setActiveTabKey] = useState<string | null>(null)
  const [editorTab, setEditorTab] = useState<EditorTab>('params')
  const [responseTab, setResponseTab] = useState<ResponseTab>('pretty')
  const [narrowView, setNarrowView] = useState<NarrowView>('explorer')
  const [search, setSearch] = useState('')
  const [createKind, setCreateKind] = useState<CreateKind | null>(null)
  const [createName, setCreateName] = useState('')
  const [editResourceId, setEditResourceId] = useState<string | null>(null)
  const [environmentVariables, setEnvironmentVariables] = useState<ApiEnvironmentVariable[]>([])
  const [curlOpen, setCurlOpen] = useState(false)
  const [curlText, setCurlText] = useState('')
  const [curlError, setCurlError] = useState<string | null>(null)
  const [sendingRequestId, setSendingRequestId] = useState<string | null>(null)
  const [copiedCurl, setCopiedCurl] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const importInput = useRef<HTMLInputElement | null>(null)
  const newTabId = useRef(0)

  const workspace = state.workspaces.find(item => item.id === workspaceId) ?? state.workspaces[0] ?? null
  const collections = state.collections.filter(item => item.workspaceId === workspace?.id)
  const environments = state.environments.filter(item => item.workspaceId === workspace?.id)
  const activeTab = requestTabs.find(item => item.key === activeTabKey) ?? null
  const draft = activeTab?.draft ?? null
  const activeAuthSecret = activeTab?.authSecret ?? {}
  const requests = useMemo(() => {
    const ids = new Set(collections.flatMap(item => item.requestIds))
    const needle = search.trim().toLowerCase()
    return state.requests.filter(item => ids.has(item.id) && (needle === '' || [item.name, item.url, item.description].some(value => value.toLowerCase().includes(needle))))
  }, [collections, search, state.requests])
  const response = responseForRequest(state.history, draft?.id, activeTab?.selectedResponseId ?? null)

  const updateActiveTab = (update: (tab: RequestDraftTab) => RequestDraftTab): void => { if (activeTabKey !== null) setRequestTabs(items => items.map(item => item.key === activeTabKey ? update(item) : item)) }
  const updateDraft = (update: (draft: ApiRequest) => ApiRequest): void => { updateActiveTab(item => ({ ...item, draft: update(item.draft) })) }
  const updateAuthSecret = (value: ApiAuthSecretInput): void => { updateActiveTab(item => ({ ...item, authSecret: value })) }
  const updateEnvironmentVariable = (index: number, patch: Partial<ApiEnvironmentVariable>): void => {
    setEnvironmentVariables(items => items.map((item, row) => row === index ? { ...item, ...patch } : item))
  }

  const refresh = async (): Promise<void> => {
    try {
      const next = await loadApiState()
      setState(next)
      setWorkspaceId(current => current ?? next.workspaces[0]?.id ?? null)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  useEffect(() => { if (visible) void refresh() }, [visible])

  const activateRequest = (request: ApiRequest): void => {
    const existing = requestTabs.find(item => item.draft.id === request.id)
    if (existing !== undefined) setActiveTabKey(existing.key)
    else {
      const next: RequestDraftTab = { key: request.id, draft: cloneRequest(request), savedFingerprint: requestFingerprint(request), authSecret: {}, selectedResponseId: null }
      setRequestTabs(items => [...items, next])
      setActiveTabKey(next.key)
    }
    setActiveEnvironmentId(request.environmentId)
    setEditorTab('params')
    setNarrowView('request')
  }
  const createRequest = (collectionId: string): void => {
    const request = emptyRequest(collectionId, t('request.new'))
    const key = 'new-' + (++newTabId.current).toString()
    setRequestTabs(items => [...items, { key, draft: request, savedFingerprint: null, authSecret: {}, selectedResponseId: null }])
    setActiveTabKey(key)
    setEditorTab('params')
    setNarrowView('request')
  }
  const closeRequestTab = (key: string): void => {
    const index = requestTabs.findIndex(item => item.key === key)
    const next = requestTabs.filter(item => item.key !== key)
    setRequestTabs(next)
    if (activeTabKey === key) setActiveTabKey(next[Math.min(index, next.length - 1)]?.key ?? null)
  }
  const save = async (): Promise<ApiRequest | null> => {
    if (activeTab === null) return null
    try {
      const next = await apiClientCall<ApiClientState>('requests.save', { request: activeTab.draft, authSecret: activeAuthSecret })
      const saved = next.requests.find(item => item.id === activeTab.draft.id) ?? [...next.requests].reverse().find(item => item.collectionId === activeTab.draft.collectionId && item.name === activeTab.draft.name) ?? null
      setState(next)
      if (saved !== null) setRequestTabs(items => items.map(item => item.key === activeTab.key ? { ...item, draft: cloneRequest(saved), savedFingerprint: requestFingerprint(saved), authSecret: {} } : item))
      setError(null)
      return saved
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return null }
  }
  const send = async (): Promise<void> => {
    setSending(true)
    try {
      const request = await save()
      if (request === null) return
      setSendingRequestId(request.id)
      const result = await apiClientCall<ExecuteResult>('requests.execute', { requestId: request.id })
      setState(result.state)
      updateActiveTab(item => ({ ...item, selectedResponseId: result.response.id }))
      setResponseTab('pretty')
      setNarrowView('response')
      setError(null)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message === 'API request cancelled' ? t('request.cancelled') : message)
    } finally { setSending(false); setSendingRequestId(null) }
  }
  const cancelSend = async (): Promise<void> => {
    if (sendingRequestId === null) return
    try { await apiClientCall('requests.cancel', { requestId: sendingRequestId }) } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const copyCurl = async (): Promise<void> => {
    if (response === null) return
    try {
      const result = await apiClientCall<{ curl: string }>('requests.curl', { requestId: response.requestId })
      if (!await copyText(result.curl)) throw new Error(t('request.copyCurlFailed'))
      setCopiedCurl(true)
      window.setTimeout(() => { setCopiedCurl(false) }, 1_500)
      setError(null)
    } catch (failure) { setError(t('request.copyCurlFailed') + ': ' + (failure instanceof Error ? failure.message : String(failure))) }
  }
  const importCurl = async (): Promise<void> => {
    if (curlText.trim() === '') return
    try {
      const parsed = parseCurl(curlText)
      if (workspace === null) throw new Error(t('error.workspaceRequired'))
      let collectionId: string | undefined = collections[0]?.id
      if (collectionId === undefined) {
        const next = await apiClientCall<ApiClientState>('collections.save', { collection: { id: '', workspaceId: workspace.id, parentId: null, name: t('curl.importedName'), description: '', tags: [], requestIds: [] } satisfies ApiCollection })
        setState(next)
        collectionId = next.collections.find(item => item.workspaceId === workspace.id)?.id
      }
      if (collectionId === undefined) throw new Error(t('error.workspaceRequired'))
      const name = (() => {
        try {
          const parsedUrl = new URL(parsed.url)
          return parsedUrl.pathname.split('/').filter(Boolean).at(-1) ?? parsedUrl.hostname
        } catch { return t('curl.importedName') }
      })()
      const nextRequest: ApiRequest = {
        ...emptyRequest(collectionId, name),
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
        auth: { ...parsed.auth, credentialId: null },
        environmentId: selectedEnvironmentId === '' ? null : selectedEnvironmentId,
      }
      const key = 'curl-' + (++newTabId.current).toString()
      setRequestTabs(items => [...items, { key, draft: nextRequest, savedFingerprint: null, authSecret: parsed.authSecret, selectedResponseId: null }])
      setActiveTabKey(key)
      setEditorTab(parsed.body.kind === 'none' ? 'headers' : 'body')
      setNarrowView('request')
      setCurlOpen(false)
      setCurlText('')
      setCurlError(null)
      setError(null)
    } catch (failure) { setCurlError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const formatJsonBody = (): void => {
    if (draft === null || draft.body.kind !== 'json') return
    try {
      const pretty = JSON.stringify(JSON.parse(draft.body.content), null, 2)
      updateDraft(item => ({ ...item, body: { ...item.body, content: pretty } }))
    } catch {
      // The status line already says why; formatting cannot improve invalid JSON.
    }
  }
  const openHistoryResponse = (responseId: string): void => {
    const item = state.history.find(entry => entry.id === responseId)
    if (item === undefined) return
    const request = state.requests.find(entry => entry.id === item.requestId)
    if (request === undefined) return
    activateRequest(request)
    setRequestTabs(items => items.map(entry => entry.draft.id === request.id ? { ...entry, selectedResponseId: responseId } : entry))
    setResponseTab('pretty')
  }
  const sendToConversation = (): void => {
    if (draft === null) return
    const scope = (ctx as unknown as ClientServices).sessions.scope(sessionId)
    if (scope === undefined) return
    const input = (ctx as unknown as ClientServices).conversation.input.for(scope)
    const collection = state.collections.find(item => item.id === draft.collectionId)
    const reference = t('conversation.reference') + String.fromCharCode(10) + JSON.stringify({ id: draft.id || null, workspace: workspace?.name ?? null, collection: collection?.name ?? null, name: draft.name, description: draft.description, method: draft.method, url: draft.url, query: draft.query.filter(item => item.enabled), headers: draft.headers.filter(item => item.enabled).map(item => ({ ...item, value: item.key.toLowerCase() === 'authorization' ? t('conversation.redacted') : item.value })), auth: { kind: draft.auth.kind, options: draft.auth.options }, body: draft.body, environment: environments.find(item => item.id === draft.environmentId)?.name ?? null }, null, 2)
    const current = input.state.getSnapshot().draft
    input.setDraft(current === '' ? reference : current + String.fromCharCode(10, 10) + reference)
  }

  const beginResource = (kind: CreateKind, id: string | null = null): void => {
    setCreateKind(kind)
    setEditResourceId(id)
    if (kind === 'workspace') setCreateName(state.workspaces.find(item => item.id === id)?.name ?? '')
    else if (kind === 'collection') setCreateName(state.collections.find(item => item.id === id)?.name ?? '')
    else {
      const environment = state.environments.find(item => item.id === id)
      setCreateName(environment?.name ?? '')
      setEnvironmentVariables(environment === undefined
        ? [{ key: 'baseUrl', value: '', credentialId: null, enabled: true, secret: false }]
        : environment.variables.map(variable => ({ ...variable })))
    }
  }
  const deleteResource = async (kind: CreateKind, id: string): Promise<void> => {
    try {
      const next = await apiClientCall<ApiClientState>(kind + 's.delete', { [kind + 'Id']: id })
      setState(next)
      if (kind === 'workspace') {
        setWorkspaceId(next.workspaces[0]?.id ?? null)
        setRequestTabs([])
        setActiveTabKey(null)
      } else {
        setRequestTabs(items => items.filter(item => item.draft.id === '' || next.requests.some(request => request.id === item.draft.id)).map(item => kind === 'environment' && item.draft.environmentId === id ? { ...item, draft: { ...item.draft, environmentId: null } } : item))
      }
      if (kind === 'environment' && activeEnvironmentId === id) setActiveEnvironmentId(null)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const deleteRequest = async (): Promise<void> => {
    if (draft?.id === undefined || draft.id === '') { if (activeTab !== null) closeRequestTab(activeTab.key); return }
    try {
      const next = await apiClientCall<ApiClientState>('requests.delete', { requestId: draft.id })
      setState(next)
      if (activeTab !== null) closeRequestTab(activeTab.key)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const exportWorkspace = async (format: ApiExchangeFormat): Promise<void> => {
    if (workspace === null) return
    try {
      const result = await apiClientCall<ExportResult>('workspaces.export', { workspaceId: workspace.id, format })
      const url = URL.createObjectURL(new Blob([JSON.stringify(result.document, null, 2)], { type: result.mimeType }))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.fileName
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }
  const importWorkspace = async (file: File): Promise<void> => {
    try {
      const document = JSON.parse(await file.text()) as unknown
      const format: ApiExchangeFormat = typeof document === 'object' && document !== null && 'openapi' in document ? 'openapi' : 'postman'
      const result = await apiClientCall<ImportResult>('workspaces.import', { format, document })
      setState(result.state)
      setWorkspaceId(result.workspaceId)
      setRequestTabs([])
      setActiveTabKey(null)
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) } finally { if (importInput.current !== null) importInput.current.value = '' }
  }
  const create = async (): Promise<void> => {
    if (createKind === null || createName.trim() === '') return
    try {
      let next: ApiClientState
      if (createKind === 'workspace') {
        const existing = state.workspaces.find(item => item.id === editResourceId)
        next = await apiClientCall('workspaces.save', { workspace: { id: editResourceId ?? '', name: createName, description: existing?.description ?? '', collectionIds: existing?.collectionIds ?? [], environmentIds: existing?.environmentIds ?? [] } satisfies ApiWorkspace })
      } else if (createKind === 'collection') {
        if (workspace === null) throw new Error(t('error.workspaceRequired'))
        const existing = state.collections.find(item => item.id === editResourceId)
        next = await apiClientCall('collections.save', { collection: { id: editResourceId ?? '', workspaceId: workspace.id, parentId: existing?.parentId ?? null, name: createName, description: existing?.description ?? '', tags: existing?.tags ?? [], requestIds: existing?.requestIds ?? [] } satisfies ApiCollection })
      } else {
        if (workspace === null) throw new Error(t('error.workspaceRequired'))
        const variables = environmentVariables
          .map(variable => ({ ...variable, key: variable.key.trim() }))
          .filter(variable => variable.key !== '')
        next = await apiClientCall('environments.save', { environment: { id: editResourceId ?? '', workspaceId: workspace.id, name: createName, variables } satisfies ApiEnvironment })
      }
      setState(next)
      if (createKind === 'workspace') setWorkspaceId(editResourceId ?? next.workspaces.at(-1)?.id ?? null)
      setCreateKind(null)
      setEditResourceId(null)
      setCreateName('')
      setEnvironmentVariables([])
      setError(null)
    } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
  }

  const workspaceOptions = state.workspaces.map(item => ({ value: item.id, label: item.name }))
  const environmentOptions = [{ value: '', label: t('environment.none') }, ...environments.map(item => ({ value: item.id, label: item.name, description: t('environment.variableCount', { count: item.variables.length }) }))]
  const authorizationOptions = authOptions(t)
  const requestBodyOptions = bodyOptions(t)
  const locationOptions = [{ value: 'header', label: t('location.header') }, { value: 'query', label: t('location.query') }]
  const selectedEnvironmentId = draft?.environmentId ?? activeEnvironmentId ?? ''
  // Values are irrelevant for "is this name defined?"; only the enabled keys matter.
  const environmentKeys = useMemo(() => {
    const environment = environments.find(item => item.id === selectedEnvironmentId)
    const values: Record<string, string> = {}
    for (const variable of environment?.variables ?? []) if (variable.enabled) values[variable.key] = ''
    return values
  }, [environments, selectedEnvironmentId])
  const undefinedNames = draft === null ? [] : findUndefinedVariables(draft, environmentKeys)
  const jsonCheck = draft !== null && draft.body.kind === 'json' ? validateJsonBody(draft.body.content) : null
  const narrowLabels: Record<NarrowView, TranslationKey> = { explorer: 'nav.explorer', request: 'nav.request', response: 'nav.response' }
  const editorLabels: Record<EditorTab, TranslationKey> = { params: 'request.params', headers: 'request.headers', auth: 'request.auth', body: 'request.body' }
  const resourceLabel = createKind === null ? '' : t(RESOURCE_KEYS[createKind])
  const resourceDialogTitle = createKind === null ? '' : t(editResourceId === null ? 'resource.create' : 'resource.edit', { resource: resourceLabel })

  return <div className={css.root} data-dsh-api-client data-narrow-view={narrowView}>
    <header className={css.projectHeader}>
      <div className={css.brand}><VscCloud aria-hidden="true" /><span>{t('app.title')}</span></div>
      <Select className={css.workspaceSelect} searchable label={t('field.workspace')} value={workspace?.id ?? ''} options={workspaceOptions} placeholder={t('placeholder.selectWorkspace')} onChange={value => { setWorkspaceId(value); setActiveEnvironmentId(null); setRequestTabs([]); setActiveTabKey(null); setNarrowView('explorer') }} />
      <span className={css.headerDivider} />
      <VscSymbolVariable className={css.headerIcon} aria-hidden="true" />
      <Select className={css.environmentSelect} searchable label={t('field.environment')} value={selectedEnvironmentId} options={environmentOptions} onChange={value => { const environmentId = value || null; setActiveEnvironmentId(environmentId); if (draft !== null) updateDraft(item => ({ ...item, environmentId })) }} />
      <ActionMenu label={t('menu.environmentActions')} items={[
        { id: 'new-environment', label: t('menu.newEnvironment'), icon: <VscAdd />, disabled: workspace === null, onSelect: () => { beginResource('environment') } },
        { id: 'edit-environment', label: t('menu.editEnvironment'), icon: <VscEdit />, disabled: selectedEnvironmentId === '', onSelect: () => { if (selectedEnvironmentId !== '') beginResource('environment', selectedEnvironmentId) } },
        { id: 'delete-environment', label: t('menu.deleteEnvironment'), icon: <VscTrash />, danger: true, disabled: selectedEnvironmentId === '', onSelect: () => { if (selectedEnvironmentId !== '') void deleteResource('environment', selectedEnvironmentId) } },
      ]} />
      <input ref={importInput} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void importWorkspace(file) }} />
      <ActionMenu label={t('menu.projectActions')} items={[
        { id: 'new-workspace', label: t('menu.newWorkspace'), icon: <VscAdd />, onSelect: () => { beginResource('workspace') } },
        { id: 'edit-workspace', label: t('menu.renameWorkspace'), icon: <VscEdit />, disabled: workspace === null, onSelect: () => { if (workspace !== null) beginResource('workspace', workspace.id) } },
        { id: 'delete-workspace', label: t('menu.deleteWorkspace'), icon: <VscTrash />, danger: true, disabled: workspace === null, onSelect: () => { if (workspace !== null) void deleteResource('workspace', workspace.id) } },
        { id: 'import', label: t('menu.import'), icon: <VscCloudUpload />, separator: true, onSelect: () => { importInput.current?.click() } },
        { id: 'import-curl', label: t('menu.importCurl'), icon: <VscCode />, onSelect: () => { setCurlOpen(true); setCurlText(''); setCurlError(null) } },
        { id: 'export-postman', label: t('menu.exportPostman'), icon: <VscJson />, disabled: workspace === null, onSelect: () => { void exportWorkspace('postman') } },
        { id: 'export-openapi', label: t('menu.exportOpenApi'), icon: <VscCode />, disabled: workspace === null, onSelect: () => { void exportWorkspace('openapi') } },
      ]} />
    </header>
    <nav className={css.modeSwitch} aria-label={t('nav.workbenchPanel')}>
      {(['explorer', 'request', 'response'] as NarrowView[]).map(value => <button type="button" key={value} data-active={narrowView === value} disabled={value !== 'explorer' && draft === null} onClick={() => { setNarrowView(value) }}>{t(narrowLabels[value])}</button>)}
    </nav>
    {error !== null && <div className={css.error} role="alert"><span>{error}</span><IconButton label={t('error.dismiss')} onClick={() => { setError(null) }}><VscClose /></IconButton></div>}
    <div className={css.content}>
      <aside className={css.inventory} aria-label={t('explorer.label')}>
        <header className={css.explorerHeader}><strong>{t('explorer.collections')}</strong><IconButton label={t('explorer.addCollection')} disabled={workspace === null} onClick={() => { beginResource('collection') }}><VscAdd /></IconButton></header>
        <label className={css.search}><VscSearch aria-hidden="true" /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder={t('explorer.searchRequests')} aria-label={t('explorer.searchRequests')} /></label>
        <div className={css.tree}>
          {workspace === null && <div className={css.emptyAside}>{t('explorer.createOrImport')}</div>}
          {workspace !== null && collections.length === 0 && <div className={css.emptyAside}>{t('explorer.noCollections')}</div>}
          {collections.map(collection => <section key={collection.id}>
            <div className={css.collection}><VscFolder aria-hidden="true" /><strong>{collection.name}</strong><span>{requests.filter(request => request.collectionId === collection.id).length}</span><ActionMenu label={t('explorer.collectionActions', { name: collection.name })} items={[
              { id: 'add-request', label: t('request.new'), icon: <VscAdd />, onSelect: () => { createRequest(collection.id) } },
              { id: 'rename-collection', label: t('explorer.renameCollection'), icon: <VscEdit />, onSelect: () => { beginResource('collection', collection.id) } },
              { id: 'delete-collection', label: t('explorer.deleteCollection'), icon: <VscTrash />, danger: true, separator: true, onSelect: () => { void deleteResource('collection', collection.id) } },
            ]} /></div>
            {requests.filter(request => request.collectionId === collection.id).map(request => <button type="button" className={css.requestRow} data-selected={request.id === draft?.id} key={request.id} onClick={() => { activateRequest(request) }}><b data-method={request.method}>{request.method}</b><span><strong>{request.name}</strong><small>{request.url || t('request.noUrl')}</small></span></button>)}
          </section>)}
        </div>
      </aside>
      <main className={css.workbench}>
        <nav className={css.requestTabs} aria-label={t('request.openRequests')}>
          {requestTabs.length === 0 && <span>{t('request.noOpenRequests')}</span>}
          {requestTabs.map(item => <div key={item.key} data-active={item.key === activeTabKey}><button type="button" title={item.draft.name} onClick={() => { setActiveTabKey(item.key); setNarrowView('request') }}><b data-method={item.draft.method}>{item.draft.method}</b><span>{item.draft.name || t('request.untitled')}</span>{isDirty(item) && <i aria-label={t('request.unsavedChanges')} />}</button><IconButton label={t('request.close', { name: item.draft.name || t('request.fallbackName') })} onClick={() => { closeRequestTab(item.key) }}><VscClose /></IconButton></div>)}
        </nav>
        {draft === null ? <div className={css.empty}>{t('request.selectFromExplorer')}</div> : <div className={css.split}>
          <section className={css.requestPane} data-request-pane aria-label={t('request.editor')}>
            <div className={css.requestBar}>
              <Select className={css.methodSelect} label={t('request.httpMethod')} value={draft.method} options={METHOD_OPTIONS} onChange={method => { updateDraft(item => ({ ...item, method })) }} renderValue={option => <b data-method={option?.value}>{option?.label}</b>} />
              <input className={css.urlInput} aria-label={t('request.url')} value={draft.url} onChange={event => { updateDraft(item => ({ ...item, url: event.target.value })) }} onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void send() }} placeholder="https://api.example.com/resource" />
              <IconButton label={t('request.save')} onClick={() => { void save() }}><VscSave /></IconButton>
              <IconButton label={t('request.sendToConversation')} onClick={sendToConversation}><VscComment /></IconButton>
              {sending
                ? <button type="button" className={css.cancel} onClick={() => { void cancelSend() }}><VscClose aria-hidden="true" /><span>{t('request.cancel')}</span></button>
                : <button type="button" className={css.send} onClick={() => { void send() }}><VscPlay aria-hidden="true" /><span>{t('request.send')}</span></button>}
            </div>
            {undefinedNames.length > 0 && <div className={css.variableWarning} role="status">{t('environment.undefined', { names: undefinedNames.join(', ') })}</div>}
            <div className={css.requestMeta}>
              <input aria-label={t('request.name')} value={draft.name} onChange={event => { updateDraft(item => ({ ...item, name: event.target.value })) }} placeholder={t('request.name')} />
              <span className={css.collectionPath}><VscFolder aria-hidden="true" />{state.collections.find(item => item.id === draft.collectionId)?.name ?? t('request.unknownCollection')}</span>
              <ActionMenu label={t('request.actions')} items={[{ id: 'delete-request', label: draft.id === '' ? t('request.discard') : t('request.delete'), icon: <VscTrash />, danger: true, onSelect: () => { void deleteRequest() } }]} />
            </div>
            <nav className={css.tabs} aria-label={t('request.editorTabs')}>
              {(['params', 'headers', 'auth', 'body'] as EditorTab[]).map(value => <button type="button" data-active={editorTab === value} key={value} onClick={() => { setEditorTab(value) }}>{t(editorLabels[value])}{value === 'params' && draft.query.length > 0 ? ' (' + draft.query.length.toString() + ')' : value === 'headers' && draft.headers.length > 0 ? ' (' + draft.headers.length.toString() + ')' : ''}</button>)}
            </nav>
            <div className={css.editorContent}>
              {editorTab === 'params' && <KeyValues values={draft.query} onChange={query => { updateDraft(item => ({ ...item, query })) }} />}
              {editorTab === 'headers' && <KeyValues values={draft.headers} onChange={headers => { updateDraft(item => ({ ...item, headers })) }} />}
              {editorTab === 'auth' && <div className={css.authEditor}>
                <label><span>{t('auth.type')}</span><Select label={t('auth.authorizationType')} value={draft.auth.kind} options={authorizationOptions} onChange={kind => { updateDraft(item => ({ ...item, auth: { kind, credentialId: item.auth.credentialId, options: {} } })); updateAuthSecret({}) }} /></label>
                {draft.auth.kind === 'basic' && <><label><span>{t('auth.username')}</span><input value={activeAuthSecret.username ?? ''} onChange={event => { updateAuthSecret({ ...activeAuthSecret, username: event.target.value }) }} /></label><label><span>{t('auth.password')}</span><input type="password" autoComplete="new-password" value={activeAuthSecret.password ?? ''} onChange={event => { updateAuthSecret({ ...activeAuthSecret, password: event.target.value }) }} placeholder={draft.auth.credentialId ? t('auth.keepCurrent') : ''} /></label></>}
                {(draft.auth.kind === 'bearer' || draft.auth.kind === 'oauth2') && <label><span>{t('auth.token')}</span><input type="password" autoComplete="new-password" value={activeAuthSecret.token ?? ''} onChange={event => { updateAuthSecret({ token: event.target.value }) }} placeholder={draft.auth.credentialId ? t('auth.keepCurrent') : ''} /></label>}
                {draft.auth.kind === 'api-key' && <><label><span>{t('auth.keyName')}</span><input value={draft.auth.options.name ?? ''} onChange={event => { updateDraft(item => ({ ...item, auth: { ...item.auth, options: { ...item.auth.options, name: event.target.value } } })) }} /></label><label><span>{t('auth.location')}</span><Select label={t('auth.apiKeyLocation')} value={draft.auth.options.location ?? 'header'} options={locationOptions} onChange={location => { updateDraft(item => ({ ...item, auth: { ...item.auth, options: { ...item.auth.options, location } } })) }} /></label><label><span>{t('auth.value')}</span><input type="password" autoComplete="new-password" value={activeAuthSecret.key ?? ''} onChange={event => { updateAuthSecret({ key: event.target.value }) }} placeholder={draft.auth.credentialId ? t('auth.keepCurrent') : ''} /></label></>}
                {(draft.auth.kind === 'none' || draft.auth.kind === 'inherit') && <p className={css.hint}>{draft.auth.kind === 'inherit' ? t('auth.inheritHint') : t('auth.noneHint')}</p>}
              </div>}
              {editorTab === 'body' && <div className={css.bodyEditor}>
                <Select className={css.bodyType} label={t('body.requestType')} value={draft.body.kind} options={requestBodyOptions} onChange={kind => { updateDraft(item => ({ ...item, body: { ...item.body, kind } })) }} />
                {draft.body.kind === 'json' && <div className={css.bodyToolbar}>
                  <button type="button" disabled={jsonCheck === null || !jsonCheck.valid || draft.body.content.trim() === ''} onClick={formatJsonBody}>{t('body.format')}</button>
                  <span className={css.bodyStatus} data-valid={jsonCheck?.valid === true}>{jsonCheck?.valid ? t('body.valid') : t('body.invalid', { reason: jsonCheck?.message ?? '' })}</span>
                </div>}
                {draft.body.kind === 'none' ? <div className={css.empty}>{t('body.empty')}</div> : draft.body.kind === 'multipart' ? <MultipartEditor content={draft.body.content} onChange={bodyContent => { updateDraft(item => ({ ...item, body: { ...item.body, content: bodyContent } })) }} /> : <textarea aria-label={t('body.editor')} spellCheck={false} value={draft.body.content} onChange={event => { updateDraft(item => ({ ...item, body: { ...item.body, content: event.target.value } })) }} />}
              </div>}
            </div>
          </section>
          <div className={css.splitter} aria-hidden="true" />
          <ResponseViewer response={response} history={state.history} tab={responseTab} onTab={setResponseTab} onHistory={openHistoryResponse} onCopyCurl={() => { void copyCurl() }} copiedCurl={copiedCurl} />
        </div>}
      </main>
    </div>
    {createKind !== null && <div className={css.backdrop} onMouseDown={event => { if (event.currentTarget === event.target) setCreateKind(null) }}><div className={css.dialog} role="dialog" aria-modal="true" aria-label={resourceDialogTitle}>
      <header><strong>{resourceDialogTitle}</strong><IconButton label={t('action.close')} onClick={() => { setCreateKind(null) }}><VscClose /></IconButton></header>
      <label><span>{t('field.name')}</span><input autoFocus value={createName} onChange={event => { setCreateName(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void create() }} /></label>
      {createKind === 'environment' && <><label><span>{t('environment.variables')}</span></label>
        <div className={css.envTable}>
          {environmentVariables.map((variable, index) => <div className={css.envRow} key={index}>
            <input type="checkbox" aria-label={t('environment.enableVariable', { index: index + 1 })} checked={variable.enabled} onChange={event => { updateEnvironmentVariable(index, { enabled: event.target.checked }) }} />
            <input type="text" aria-label={t('field.variableKey')} placeholder={t('field.variableKey')} value={variable.key} onChange={event => { updateEnvironmentVariable(index, { key: event.target.value }) }} />
            <input type={variable.secret ? 'password' : 'text'} aria-label={t('field.variableValue')} placeholder={variable.secret && variable.value === null ? t('auth.keepCurrent') : t('field.variableValue')} value={variable.value ?? ''} onChange={event => { updateEnvironmentVariable(index, { value: event.target.value }) }} />
            <label className={css.envSecret}><input type="checkbox" aria-label={t('environment.secretVariable', { index: index + 1 })} checked={variable.secret} onChange={event => { updateEnvironmentVariable(index, { secret: event.target.checked }) }} /><span>{t('field.storeSecret')}</span></label>
            <IconButton label={t('environment.deleteVariable', { index: index + 1 })} onClick={() => { setEnvironmentVariables(items => items.filter((_, row) => row !== index)) }}><VscTrash /></IconButton>
          </div>)}
          <button type="button" className={css.envAdd} onClick={() => { setEnvironmentVariables(items => [...items, { key: '', value: '', credentialId: null, enabled: true, secret: false }]) }}><VscAdd />{t('environment.addVariable')}</button>
        </div></>}
      <footer><button type="button" onClick={() => { setCreateKind(null) }}>{t('action.cancel')}</button><button type="button" className={css.primary} disabled={createName.trim() === ''} onClick={() => { void create() }}>{editResourceId === null ? t('action.create') : t('action.save')}</button></footer>
    </div></div>}
    {curlOpen && <div className={css.backdrop} onMouseDown={event => { if (event.currentTarget === event.target) setCurlOpen(false) }}><div className={[css.dialog, css.curlDialog].join(' ')} role="dialog" aria-modal="true" aria-label={t('curl.title')}>
      <header><strong>{t('curl.title')}</strong><IconButton label={t('action.close')} onClick={() => { setCurlOpen(false) }}><VscClose /></IconButton></header>
      <textarea aria-label={t('curl.title')} placeholder={t('curl.placeholder')} spellCheck={false} value={curlText} onChange={event => { setCurlText(event.target.value); setCurlError(null) }} />
      {curlError !== null && <p className={css.curlError} role="alert">{t('curl.error', { reason: curlError })}</p>}
      <p className={css.hint}>{t('curl.hint')}</p>
      <footer><button type="button" onClick={() => { setCurlOpen(false) }}>{t('action.cancel')}</button><button type="button" className={css.primary} disabled={curlText.trim() === ''} onClick={() => { void importCurl() }}>{t('curl.import')}</button></footer>
    </div></div>}
  </div>
}
