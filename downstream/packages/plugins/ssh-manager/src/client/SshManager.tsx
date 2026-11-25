import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import {
  VscAdd,
  VscArrowUp,
  VscChevronDown,
  VscChevronRight,
  VscClearAll,
  VscClose,
  VscCloudDownload,
  VscCloudUpload,
  VscComment,
  VscCopy,
  VscDebugDisconnect,
  VscDownload,
  VscEdit,
  VscFile,
  VscFiles,
  VscFolder,
  VscFolderOpened,
  VscHistory,
  VscInfo,
  VscKey,
  VscKebabVertical,
  VscLayoutSidebarLeft,
  VscPlay,
  VscPlug,
  VscPulse,
  VscRefresh,
  VscRemoteExplorer,
  VscSearch,
  VscServerEnvironment,
  VscTerminal,
  VscTrash,
  VscWarning,
} from 'react-icons/vsc'
import type {
  SshCluster,
  SshCredentialInput,
  SshEnvironment,
  SshFileDownload,
  SshFileListing,
  SshHost,
  SshManagerState,
  SshPortForward,
  SshPortForwardRequest,
  SshTerminalSession,
} from '../types.ts'
import { loadSshState, sshApi } from './api.ts'
import {
  canTestHost, formatBytes, fingerprintOf, joinedPath, parentPath, pathBreadcrumbs, recentHosts,
  type HostTestResult, type HostUsage,
} from './model.ts'
import { Select, type SelectOption } from './Select.tsx'
import { useT, type TranslationKey } from './i18n.tsx'
import { TerminalPane, type TerminalPaneHandle } from './TerminalPane.tsx'
import { ConnectionWizard } from './ConnectionWizard.tsx'
import { StatusTag, type StatusTagProps, type StatusTone } from './StatusTag.tsx'
import css from './SshManager.module.css'

interface ConversationInput { state: { getSnapshot(): { draft: string } }; setDraft(text: string): void }
interface ClientServices { sessions: { scope(sessionId: string): Context | undefined }; conversation: { input: { for(scope: Context): ConversationInput } } }
type WorkspaceView = 'hosts' | 'terminal' | 'files' | 'tunnels'
type InventoryContextMenu =
  | { kind: 'host'; id: string; x: number; y: number }
  | { kind: 'cluster'; id: string; x: number; y: number }
interface SavedCommand { id: string; label: string; command: string }

const EMPTY: SshManagerState = { clusters: [], hosts: [] }
const ENVIRONMENTS: SshEnvironment[] = ['development', 'testing', 'staging', 'production', 'other']
const ENVIRONMENT_LABELS: Record<SshEnvironment, TranslationKey> = {
  development: 'environment.development',
  testing: 'environment.testing',
  staging: 'environment.staging',
  production: 'environment.production',
  other: 'environment.other',
}
const AUTH_OPTION_KEYS: Array<{ value: SshHost['authKind']; label: TranslationKey; description: TranslationKey }> = [
  { value: 'password', label: 'auth.password', description: 'auth.passwordDescription' },
  { value: 'private-key', label: 'auth.privateKey', description: 'auth.privateKeyDescription' },
  { value: 'agent', label: 'auth.agent', description: 'auth.agentDescription' },
]
const DIRECTION_OPTION_KEYS: Array<{ value: SshPortForwardRequest['direction']; label: TranslationKey; description: TranslationKey }> = [
  { value: 'local', label: 'tunnels.local', description: 'tunnels.localDescription' },
  { value: 'remote', label: 'tunnels.remote', description: 'tunnels.remoteDescription' },
]
const VIEW_ITEMS: Array<{ id: WorkspaceView; label: TranslationKey; icon: typeof VscTerminal }> = [
  { id: 'hosts', label: 'view.hosts', icon: VscServerEnvironment },
  { id: 'terminal', label: 'view.terminal', icon: VscTerminal },
  { id: 'files', label: 'view.files', icon: VscFiles },
  { id: 'tunnels', label: 'view.tunnels', icon: VscPlug },
]
const TERMINAL_STATE_LABELS: Record<SshTerminalSession['state'], TranslationKey> = {
  connecting: 'terminal.state.connecting',
  connected: 'terminal.state.connected',
  disconnected: 'terminal.state.disconnected',
  failed: 'terminal.state.failed',
}
const FORWARD_STATE_LABELS: Record<SshPortForward['state'], TranslationKey> = {
  active: 'tunnels.state.active',
  disconnected: 'tunnels.state.disconnected',
  failed: 'tunnels.state.failed',
}
const USAGE_KEY = 'ssh-manager.usage.v1'
const COMMANDS_KEY = 'ssh-manager.commands.v1'

function readStored<T>(key: string, fallback: T): T {
  if (typeof localStorage === 'undefined') return fallback
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : JSON.parse(raw) as T
  } catch { return fallback }
}

function writeStored(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage may be denied in a sandboxed frame */ }
}

/** Copy without requiring a secure context: the LAN UI is plain HTTP. */
async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true } catch { /* fall through */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    area.remove()
    return copied
  } catch { return false }
}

function quoteShell(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}

function emptyHost(): SshHost {
  return { id: '', name: '', description: '', tags: [], clusterId: null, environment: 'development', hostname: '', port: 22, username: '', authKind: 'password', credentialId: null, credentialConfigured: false, jumpHostId: null, knownHostFingerprint: null, keepAliveSeconds: 30, defaultDirectory: '' }
}

function emptyForward(hostId: string): SshPortForwardRequest {
  return { hostId, direction: 'local', bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 80 }
}

function encodeFile(buffer: ArrayBuffer): string {
  const data = new Uint8Array(buffer)
  let binary = ''
  for (let offset = 0; offset < data.length; offset += 0x8000) binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000))
  return btoa(binary)
}

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={css.iconButton} title={label} aria-label={label} {...props}>{children}</button>
}

export function SshManager({ ctx, sessionId, visible }: { ctx: Context; sessionId: string; visible: boolean }) {
  const t = useT()
  const [state, setState] = useState(EMPTY)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [hostForm, setHostForm] = useState<SshHost | null>(null)
  const [credential, setCredential] = useState<SshCredentialInput>({})
  const [clusterForm, setClusterForm] = useState<SshCluster | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wizardTest, setWizardTest] = useState<StatusTagProps | null>(null)
  const [wizardResult, setWizardResult] = useState<{ latencyMs: number; fingerprint: string } | null>(null)
  const [wizardBusy, setWizardBusy] = useState(false)
  const [probing, setProbing] = useState(false)
  const [terminals, setTerminals] = useState<SshTerminalSession[]>([])
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null)
  const [pendingInput, setPendingInput] = useState<Record<string, string | undefined>>({})
  const [view, setView] = useState<WorkspaceView>('hosts')
  const [inventoryOpen, setInventoryOpen] = useState(true)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [filePath, setFilePath] = useState('.')
  const [files, setFiles] = useState<SshFileListing | null>(null)
  const [fileBusy, setFileBusy] = useState(false)
  const [forwards, setForwards] = useState<SshPortForward[]>([])
  const [forwardForm, setForwardForm] = useState<SshPortForwardRequest | null>(null)
  const [contextMenu, setContextMenu] = useState<InventoryContextMenu | null>(null)
  const [usage, setUsage] = useState<Record<string, HostUsage>>(() => readStored(USAGE_KEY, {}))
  const [commandMap, setCommandMap] = useState<Record<string, SavedCommand[]>>(() => readStored(COMMANDS_KEY, {}))
  const [commandLabel, setCommandLabel] = useState('')
  const [commandText, setCommandText] = useState('')
  const [testingHosts, setTestingHosts] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState<string | null>(null)
  const contextMenuRef = useRef<HTMLDivElement | null>(null)
  const uploadInput = useRef<HTMLInputElement | null>(null)
  const terminalRefs = useRef(new Map<string, TerminalPaneHandle>())

  const selected = state.hosts.find(host => host.id === selectedId) ?? null
  const activeTerminal = terminals.find(terminal => terminal.id === activeTerminalId) ?? null
  const filtered = useMemo(() => {
    const value = search.trim().toLowerCase()
    return value === '' ? state.hosts : state.hosts.filter(host => [host.name, host.hostname, host.description, ...host.tags].some(field => field.toLowerCase().includes(value)))
  }, [search, state.hosts])
  const groups = useMemo(() => [...state.clusters.map(cluster => ({ cluster, hosts: filtered.filter(host => host.clusterId === cluster.id) })), { cluster: null, hosts: filtered.filter(host => host.clusterId === null) }], [filtered, state.clusters])
  const hostForwards = selected === null ? [] : forwards.filter(forward => forward.hostId === selected.id)
  const recent = useMemo(() => recentHosts(filtered, usage, 4), [filtered, usage])
  const hostTerminals = useMemo(() => selected === null ? [] : terminals.filter(terminal => terminal.hostId === selected.id).sort((left, right) => right.connectedAt - left.connectedAt), [selected, terminals])
  const commands = selected === null ? [] : commandMap[selected.id] ?? []
  const environmentOptions = useMemo<SelectOption[]>(() => ENVIRONMENTS.map(value => ({ value, label: t(ENVIRONMENT_LABELS[value]) })), [t])
  const authOptions = useMemo<SelectOption[]>(() => AUTH_OPTION_KEYS.map(option => ({ value: option.value, label: t(option.label), description: t(option.description) })), [t])
  const directionOptions = useMemo<SelectOption[]>(() => DIRECTION_OPTION_KEYS.map(option => ({ value: option.value, label: t(option.label), description: t(option.description) })), [t])
  const clusterOptions = useMemo<SelectOption[]>(() => [{ value: '', label: t('inventory.unclustered') }, ...state.clusters.map(cluster => ({ value: cluster.id, label: cluster.name }))], [state.clusters, t])
  const jumpHostOptions = useMemo<SelectOption[]>(() => [{ value: '', label: t('host.none') }, ...state.hosts.filter(host => host.id !== hostForm?.id).map(host => ({ value: host.id, label: host.name, description: host.username + '@' + host.hostname }))], [hostForm?.id, state.hosts, t])

  const remember = (hostId: string, patch: HostUsage): void => {
    setUsage(current => {
      const next = { ...current, [hostId]: { ...current[hostId], ...patch } }
      writeStored(USAGE_KEY, next)
      return next
    })
  }
  const saveCommands = (hostId: string, list: SavedCommand[]): void => {
    setCommandMap(current => {
      const next = { ...current, [hostId]: list }
      writeStored(COMMANDS_KEY, next)
      return next
    })
  }
  const flash = (message: string): void => {
    setNotice(message)
    window.setTimeout(() => { setNotice(current => current === message ? null : current) }, 2600)
  }

  const report = (failure: unknown): void => { setError(messageOf(failure)) }
  const beginHost = (clusterId: string | null = null): void => {
    setHostForm({ ...emptyHost(), clusterId })
    setCredential({})
    setWizardTest(null)
    setWizardResult(null)
    setContextMenu(null)
  }
  const editHost = (host: SshHost): void => {
    setHostForm({ ...host })
    setCredential({})
    setWizardTest(null)
    setWizardResult(null)
    setContextMenu(null)
  }
  const beginCluster = (cluster: SshCluster = { id: '', name: '', description: '', tags: [], hostIds: [] }): void => {
    setClusterForm({ ...cluster, tags: [...cluster.tags], hostIds: [...cluster.hostIds] })
    setContextMenu(null)
  }
  const deleteHost = async (hostId: string): Promise<void> => {
    const host = state.hosts.find(item => item.id === hostId)
    if (host !== undefined && !window.confirm(t('host.deleteConfirm', { name: host.name }))) return
    try {
      const next = await sshApi<SshManagerState>('hosts.delete', { hostId })
      setState(next)
      setSelectedId(current => current === hostId ? next.hosts[0]?.id ?? null : current)
      setContextMenu(null)
      setError(null)
    } catch (failure) { report(failure) }
  }
  const deleteCluster = async (clusterId: string): Promise<void> => {
    try {
      setState(await sshApi<SshManagerState>('clusters.delete', { clusterId }))
      setContextMenu(null)
      setError(null)
    } catch (failure) { report(failure) }
  }
  const openContextMenu = (kind: InventoryContextMenu['kind'], id: string, x: number, y: number): void => {
    const width = 190
    const height = kind === 'host' ? 164 : 100
    setContextMenu({
      kind,
      id,
      x: Math.max(6, Math.min(x, window.innerWidth - width - 6)),
      y: Math.max(6, Math.min(y, window.innerHeight - height - 6)),
    } as InventoryContextMenu)
  }
  const showPointerContextMenu = (event: ReactMouseEvent<HTMLElement>, kind: InventoryContextMenu['kind'], id: string): void => {
    event.preventDefault()
    event.stopPropagation()
    if (kind === 'host') setSelectedId(id)
    openContextMenu(kind, id, event.clientX, event.clientY)
  }
  const showKeyboardContextMenu = (event: ReactKeyboardEvent<HTMLElement>, kind: InventoryContextMenu['kind'], id: string): void => {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    if (kind === 'host') setSelectedId(id)
    openContextMenu(kind, id, rect.left + Math.min(rect.width - 12, 150), rect.top + 24)
  }
  const refresh = async (): Promise<void> => {
    try {
      const [nextState, nextTerminals, nextForwards] = await Promise.all([
        loadSshState(),
        sshApi<SshTerminalSession[]>('terminals.list', { sessionId }),
        sshApi<SshPortForward[]>('forwards.list', { sessionId }),
      ])
      setState(nextState)
      setSelectedId(current => current ?? nextState.hosts[0]?.id ?? null)
      setTerminals(nextTerminals)
      setActiveTerminalId(current => current ?? nextTerminals.at(-1)?.id ?? null)
      setForwards(nextForwards)
      setError(null)
    } catch (failure) { report(failure) }
  }

  useEffect(() => { if (visible) void refresh() }, [visible, sessionId])
  useEffect(() => {
    setFiles(null)
    setFilePath('.')
    setForwardForm(selectedId === null ? null : emptyForward(selectedId))
    setCommandLabel('')
    setCommandText('')
  }, [selectedId])
  useEffect(() => {
    if (contextMenu === null) return
    requestAnimationFrame(() => { contextMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() })
    const close = (event: MouseEvent): void => {
      if (contextMenuRef.current?.contains(event.target as Node) !== true) setContextMenu(null)
    }
    const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') setContextMenu(null) }
    const blur = (): void => { setContextMenu(null) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('blur', blur)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('blur', blur)
    }
  }, [contextMenu])

  const chooseView = (next: WorkspaceView): void => {
    setView(next)
    if (next === 'hosts') setInventoryOpen(true)
    else setInventoryOpen(false)
    if (next === 'files' && selected !== null && files === null) void browse(selected)
  }

  const saveHost = async (): Promise<void> => {
    if (hostForm === null) return
    try {
      setWizardBusy(true)
      const next = await sshApi<SshManagerState>('hosts.save', { host: hostForm, credential })
      setState(next)
      const saved = next.hosts.find(host => host.id === hostForm.id || host.name === hostForm.name)
      setSelectedId(saved?.id ?? null)
      // The wizard's successful test is the host's first known status; carry it into the
      // list/detail instead of showing "untested" right after a green test tag.
      if (saved !== undefined && wizardResult !== null) remember(saved.id, { test: { ok: true, latencyMs: wizardResult.latencyMs, fingerprint: wizardResult.fingerprint, at: Date.now() } })
      setHostForm(null)
      setCredential({})
      setWizardTest(null)
      setWizardResult(null)
      setError(null)
    } catch (failure) { report(failure) } finally { setWizardBusy(false) }
  }

  const saveCluster = async (): Promise<void> => {
    if (clusterForm === null) return
    try { setState(await sshApi('clusters.save', { cluster: clusterForm })); setClusterForm(null); setError(null) } catch (failure) { report(failure) }
  }

  const sendToConversation = (host: SshHost): void => {
    const scope = (ctx as unknown as ClientServices).sessions.scope(sessionId)
    if (scope === undefined) return
    const input = (ctx as unknown as ClientServices).conversation.input.for(scope)
    const cluster = state.clusters.find(item => item.id === host.clusterId)
    const reference = [t('conversation.hostReference'), JSON.stringify({ id: host.id, name: host.name, description: host.description, tags: host.tags, cluster: cluster?.name ?? null, environment: host.environment, hostname: host.hostname, port: host.port, username: host.username, authKind: host.authKind, credentialConfigured: host.credentialConfigured, jumpHost: state.hosts.find(item => item.id === host.jumpHostId)?.name ?? null, knownHostFingerprint: host.knownHostFingerprint }, null, 2)].join('\n')
    const current = input.state.getSnapshot().draft
    input.setDraft(current === '' ? reference : current + '\n\n' + reference)
  }

  const testWizardDraft = async (): Promise<void> => {
    if (hostForm === null) return
    setWizardBusy(true)
    setWizardTest({ tone: 'testing', label: t('host.connectionTesting') })
    try {
      const result = await sshApi<{ latencyMs: number; fingerprint: string; pinned: boolean }>('hosts.testDraft', { host: hostForm, credential })
      setHostForm(current => current === null ? null : { ...current, knownHostFingerprint: result.fingerprint })
      setWizardResult({ latencyMs: result.latencyMs, fingerprint: result.fingerprint })
      setWizardTest({
        tone: 'ok',
        label: t('wizard.testOk', { latency: result.latencyMs }),
        detail: t('wizard.testOkDetail', { fingerprint: result.fingerprint }),
      })
    } catch (failure) {
      setWizardTest({ tone: 'fail', label: t('wizard.testFail'), detail: messageOf(failure) })
    } finally { setWizardBusy(false) }
  }

  const probeFingerprint = async (): Promise<void> => {
    if (hostForm === null) return
    setProbing(true)
    try {
      const result = await sshApi<{ fingerprint: string }>('hosts.probe', { host: hostForm })
      setHostForm(current => current === null ? null : { ...current, knownHostFingerprint: result.fingerprint })
      setWizardTest({ tone: 'idle', label: t('wizard.fingerprintObserved'), detail: result.fingerprint })
    } catch (failure) {
      setWizardTest({ tone: 'fail', label: t('wizard.probeFail'), detail: messageOf(failure) })
    } finally { setProbing(false) }
  }

  const testSavedHost = async (host: SshHost): Promise<void> => {
    setTestingHosts(current => new Set(current).add(host.id))
    try {
      const result = await sshApi<{ latencyMs: number; fingerprint: string; pinned: boolean }>('hosts.testDraft', { host, credential: {} })
      if (!result.pinned) {
        // Trust on first use, on the user's explicit test: persist the observed key so the
        // terminal that follows connects instead of failing on a missing fingerprint.
        setState(await sshApi<SshManagerState>('hosts.save', { host: { ...host, knownHostFingerprint: result.fingerprint }, credential: {} }))
      }
      remember(host.id, { test: { ok: true, latencyMs: result.latencyMs, fingerprint: result.fingerprint, at: Date.now() } })
      setError(null)
    } catch (failure) {
      const result: HostTestResult = { ok: false, error: messageOf(failure), at: Date.now() }
      remember(host.id, { test: result })
    } finally {
      setTestingHosts(current => { const next = new Set(current); next.delete(host.id); return next })
    }
  }

  const openTerminal = async (host: SshHost, initialInput?: string): Promise<void> => {
    try {
      const result = await sshApi<{ terminal: SshTerminalSession; terminals: SshTerminalSession[] }>('terminals.open', { sessionId, hostId: host.id, cols: 80, rows: 24 })
      setTerminals(result.terminals)
      setActiveTerminalId(result.terminal.id)
      setView('terminal')
      remember(host.id, { openedAt: Date.now() })
      const directory = host.defaultDirectory?.trim() ?? ''
      const input = initialInput ?? (directory === '' ? undefined : 'cd ' + quoteShell(directory))
      if (input !== undefined && input !== '') setPendingInput(current => ({ ...current, [result.terminal.id]: input }))
      setError(null)
    } catch (failure) { report(failure) }
  }

  const reconnectTerminal = async (terminalId: string): Promise<void> => {
    try {
      const result = await sshApi<{ terminal: SshTerminalSession; terminals: SshTerminalSession[] }>('terminals.reconnect', { sessionId, terminalId, cols: 80, rows: 24 })
      setTerminals(result.terminals)
      setActiveTerminalId(result.terminal.id)
      setError(null)
    } catch (failure) { report(failure) }
  }

  const closeTerminal = async (terminalId: string): Promise<void> => {
    try {
      const next = await sshApi<SshTerminalSession[]>('terminals.close', { sessionId, terminalId })
      setTerminals(next)
      setActiveTerminalId(current => current === terminalId ? next.at(-1)?.id ?? null : current)
    } catch (failure) { report(failure) }
  }

  const updateTerminal = (value: SshTerminalSession): void => { setTerminals(current => current.map(terminal => terminal.id === value.id ? value : terminal)) }

  const activeHandle = (): TerminalPaneHandle | undefined => activeTerminal === null ? undefined : terminalRefs.current.get(activeTerminal.id)

  const copyTerminal = async (): Promise<void> => {
    const handle = activeHandle()
    if (handle === undefined) return
    const text = handle.selection() === '' ? handle.transcript() : handle.selection()
    flash(await copyText(text) ? t('terminal.copied') : t('terminal.copyFailed'))
  }

  const clearTerminal = (): void => { activeHandle()?.clear() }

  const downloadTerminal = (): void => {
    const handle = activeHandle()
    if (handle === undefined || activeTerminal === null) return
    const blob = new Blob([handle.transcript()], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = activeTerminal.title.replace(/[^\w.-]+/gu, '_') + '-' + new Date().toISOString().replace(/[:.]/gu, '-') + '.log'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const browse = async (host: SshHost, path = filePath): Promise<void> => {
    try {
      setFileBusy(true)
      const result = await sshApi<SshFileListing>('sftp.list', { hostId: host.id, path })
      setFiles(result)
      setFilePath(result.path)
      setError(null)
    } catch (failure) { report(failure) } finally { setFileBusy(false) }
  }

  const download = async (host: SshHost, path: string): Promise<void> => {
    try {
      setFileBusy(true)
      const result = await sshApi<SshFileDownload>('sftp.download', { hostId: host.id, path })
      const binary = atob(result.data)
      const data = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index++) data[index] = binary.charCodeAt(index)
      const url = URL.createObjectURL(new Blob([data]))
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = result.name
      anchor.click()
      URL.revokeObjectURL(url)
      setError(null)
    } catch (failure) { report(failure) } finally { setFileBusy(false) }
  }

  const upload = async (host: SshHost, file: File): Promise<void> => {
    try {
      setFileBusy(true)
      const path = joinedPath(filePath, file.name)
      await sshApi('sftp.upload', { hostId: host.id, path, data: encodeFile(await file.arrayBuffer()) })
      await browse(host, filePath)
      setError(null)
    } catch (failure) { report(failure) } finally {
      setFileBusy(false)
      if (uploadInput.current !== null) uploadInput.current.value = ''
    }
  }

  const openForward = async (): Promise<void> => {
    if (forwardForm === null) return
    try {
      const result = await sshApi<{ forward: SshPortForward; forwards: SshPortForward[] }>('forwards.open', { sessionId, forward: forwardForm })
      setForwards(result.forwards)
      setForwardForm(emptyForward(forwardForm.hostId))
      setError(null)
    } catch (failure) { report(failure) }
  }

  const reconnectForward = async (forwardId: string): Promise<void> => {
    try {
      const result = await sshApi<{ forward: SshPortForward; forwards: SshPortForward[] }>('forwards.reconnect', { sessionId, forwardId })
      setForwards(result.forwards)
      setError(null)
    } catch (failure) { report(failure) }
  }

  const closeForward = async (forwardId: string): Promise<void> => {
    try { setForwards(await sshApi<SshPortForward[]>('forwards.close', { sessionId, forwardId })); setError(null) } catch (failure) { report(failure) }
  }

  const addCommand = (): void => {
    if (selected === null || commandText.trim() === '') return
    const label = commandLabel.trim() === '' ? commandText.trim().split(/\s+/u)[0] : commandLabel.trim()
    // The LAN UI runs over plain HTTP, where `crypto.randomUUID` is not exposed: a secure
    // context is required. Fall back to a timestamp+counter id; it only has to be unique
    // inside one host's local command list.
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const entry: SavedCommand = { id, label, command: commandText.trim() }
    saveCommands(selected.id, [...commands, entry])
    setCommandLabel('')
    setCommandText('')
  }

  const insertCommand = async (host: SshHost, command: string): Promise<void> => {
    const existing = terminals.find(terminal => terminal.hostId === host.id)
    if (existing === undefined) { await openTerminal(host, command); return }
    setActiveTerminalId(existing.id)
    setView('terminal')
    await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
    const handle = terminalRefs.current.get(existing.id)
    if (handle === undefined) { await openTerminal(host, command); return }
    handle.insert(command)
  }

  const toggleGroup = (key: string): void => {
    setCollapsedGroups(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const testLabel = (host: SshHost): StatusTagProps => {
    if (testingHosts.has(host.id)) return { tone: 'testing', label: t('status.testing') }
    const result = usage[host.id]?.test
    if (result === undefined) return { tone: 'idle', label: t('status.untested') }
    if (result.ok) return { tone: 'ok', label: t('status.connectedLatency', { latency: result.latencyMs ?? 0 }), detail: result.fingerprint === undefined ? undefined : t('status.fingerprint', { fingerprint: result.fingerprint }) }
    return { tone: 'fail', label: t('status.failed'), detail: result.error ?? t('status.failed') }
  }

  const renderContextMenu = () => {
    if (contextMenu === null) return null
    const host = contextMenu.kind === 'host' ? state.hosts.find(item => item.id === contextMenu.id) : undefined
    const cluster = contextMenu.kind === 'cluster' ? state.clusters.find(item => item.id === contextMenu.id) : undefined
    if (host === undefined && cluster === undefined) return null
    const label = host === undefined
      ? t('inventory.clusterActions', { name: cluster?.name ?? '' })
      : t('inventory.hostActions', { name: host.name })
    return createPortal(<div
      ref={contextMenuRef}
      className={css.contextMenu}
      role="menu"
      aria-label={label}
      style={{ left: contextMenu.x, top: contextMenu.y }}
      onContextMenu={event => { event.preventDefault() }}
      onKeyDown={event => {
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=menuitem]:not(:disabled)')]
        const current = items.indexOf(document.activeElement as HTMLButtonElement)
        if (event.key === 'ArrowDown') { event.preventDefault(); items[(current + 1) % items.length]?.focus() }
        else if (event.key === 'ArrowUp') { event.preventDefault(); items[(current - 1 + items.length) % items.length]?.focus() }
        else if (event.key === 'Home') { event.preventDefault(); items[0]?.focus() }
        else if (event.key === 'End') { event.preventDefault(); items.at(-1)?.focus() }
        else if (event.key === 'Escape') { event.preventDefault(); setContextMenu(null) }
      }}
    >
      {host !== undefined ? <>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void openTerminal(host) }}><VscTerminal /><span>{t('host.openTerminal')}</span></button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); void testSavedHost(host) }}><VscPulse /><span>{t('host.testConnection')}</span></button>
        <button type="button" role="menuitem" onClick={() => { setContextMenu(null); sendToConversation(host) }}><VscComment /><span>{t('host.sendToConversation')}</span></button>
        <button type="button" role="menuitem" onClick={() => { editHost(host) }}><VscEdit /><span>{t('host.edit')}</span></button>
        <button type="button" role="menuitem" data-separator="true" data-danger="true" onClick={() => { void deleteHost(host.id) }}><VscTrash /><span>{t('host.delete')}</span></button>
      </> : <>
        <button type="button" role="menuitem" onClick={() => { beginHost(cluster?.id ?? null) }}><VscAdd /><span>{t('inventory.addHostToCluster')}</span></button>
        <button type="button" role="menuitem" onClick={() => { if (cluster !== undefined) beginCluster(cluster) }}><VscEdit /><span>{t('inventory.editCluster')}</span></button>
        <button type="button" role="menuitem" data-separator="true" data-danger="true" onClick={() => { if (cluster !== undefined) void deleteCluster(cluster.id) }}><VscTrash /><span>{t('inventory.deleteClusterAction')}</span></button>
      </>}
    </div>, document.body)
  }

  const renderHostRow = (host: SshHost) => {
    const result = usage[host.id]?.test
    const tone: StatusTone = testingHosts.has(host.id) ? 'testing' : result === undefined ? 'idle' : result.ok ? 'ok' : 'fail'
    const detail = testingHosts.has(host.id) ? t('status.testing') : result === undefined ? t(host.credentialConfigured ? 'inventory.credentialConfigured' : 'inventory.credentialMissing') : result.ok ? t('status.connectedLatency', { latency: result.latencyMs ?? 0 }) : result.error ?? t('status.failed')
    return <button
      type="button"
      className={css.hostRow}
      data-selected={host.id === selectedId}
      data-production={host.environment === 'production'}
      data-tone={tone}
      key={host.id}
      onClick={() => { setSelectedId(host.id) }}
      onDoubleClick={() => { void openTerminal(host) }}
      onContextMenu={event => { showPointerContextMenu(event, 'host', host.id) }}
      onKeyDown={event => { showKeyboardContextMenu(event, 'host', host.id) }}
    >
      <VscServerEnvironment aria-hidden="true" />
      <span>
        <strong>{host.name}</strong>
        <small>{host.username}@{host.hostname}:{host.port}</small>
        {host.tags.length > 0 && <em className={css.rowTags}>{host.tags.slice(0, 3).map(tag => <span key={tag}>{tag}</span>)}</em>}
      </span>
      <i data-tone={tone} title={detail} aria-label={detail} />
    </button>
  }

  const renderInventory = () => <aside className={css.inventory} aria-label={t('inventory.label')} data-overlay={view !== 'hosts'}>
    <header className={css.inventoryHeader}>
      <span title={t('inventory.label')}>{filtered.length}</span>
      <IconButton label={t('inventory.addCluster')} onClick={() => { beginCluster() }}><VscFolder /></IconButton>
      <IconButton label={t('inventory.newConnection')} onClick={() => { beginHost() }}><VscAdd /></IconButton>
      {view !== 'hosts' && <IconButton label={t('inventory.close')} onClick={() => { setInventoryOpen(false) }}><VscClose /></IconButton>}
    </header>
    <label className={css.search}><VscSearch aria-hidden="true" /><input value={search} onChange={event => { setSearch(event.target.value) }} placeholder={t('inventory.search')} aria-label={t('inventory.search')} /></label>
    <div className={css.tree}>
      {recent.length > 0 && <section className={css.recentSection} aria-label={t('inventory.recent')}>
        <div className={css.recentHeader}><VscHistory aria-hidden="true" /><span>{t('inventory.recent')}</span></div>
        {recent.map(renderHostRow)}
      </section>}
      {groups.map(group => {
        const key = group.cluster?.id ?? 'unclustered'
        if (group.hosts.length === 0 && group.cluster === null) return null
        const collapsed = collapsedGroups.has(key)
        return <section key={key}>
          <div className={css.group}>
            <button
              type="button"
              className={css.groupToggle}
              aria-expanded={!collapsed}
              onClick={() => { toggleGroup(key) }}
              onContextMenu={group.cluster === null ? undefined : event => { showPointerContextMenu(event, 'cluster', group.cluster?.id ?? '') }}
              onKeyDown={group.cluster === null ? undefined : event => { showKeyboardContextMenu(event, 'cluster', group.cluster?.id ?? '') }}
            >
              {collapsed ? <VscChevronRight /> : <VscChevronDown />}
              {collapsed ? <VscFolder /> : <VscFolderOpened />}
              <span>{group.cluster?.name ?? t('inventory.unclustered')}</span>
              <small>{group.hosts.length}</small>
            </button>
            {group.cluster !== null && <IconButton
              label={t('inventory.clusterActions', { name: group.cluster.name })}
              aria-haspopup="menu"
              onClick={event => {
                const rect = event.currentTarget.getBoundingClientRect()
                openContextMenu('cluster', group.cluster?.id ?? '', rect.right, rect.bottom)
              }}
            ><VscKebabVertical /></IconButton>}
          </div>
          {!collapsed && group.hosts.map(renderHostRow)}
        </section>
      })}
      {state.hosts.length === 0 && <div className={css.emptyState}>
        <VscServerEnvironment aria-hidden="true" />
        <strong>{t('inventory.emptyTitle')}</strong>
        <span>{t('inventory.emptyDescription')}</span>
        <button type="button" className={css.primary} onClick={() => { beginHost() }}><VscAdd />{t('inventory.newConnection')}</button>
      </div>}
      {state.hosts.length > 0 && filtered.length === 0 && <div className={css.emptySmall}>{t('inventory.empty')}</div>}
    </div>
  </aside>

  const renderHostHeader = (title: string) => <header className={css.workHeader}>
    <div className={css.workTitle}><VscServerEnvironment /><span><strong>{title}</strong><small>{selected === null ? t('host.chooseFromExplorer') : selected.username + '@' + selected.hostname + ':' + selected.port.toString()}</small></span>{selected !== null && selected.environment === 'production' && <span className={css.productionBadge}>{t('environment.production')}</span>}</div>
    {selected !== null && <div className={css.workActions}>
      <IconButton label={t('host.openTerminal')} onClick={() => { void openTerminal(selected) }}><VscTerminal /></IconButton>
      <IconButton label={t('host.testConnection')} onClick={() => { void testSavedHost(selected) }}><VscPulse /></IconButton>
      <IconButton label={t('host.sendToConversation')} onClick={() => { sendToConversation(selected) }}><VscComment /></IconButton>
      <IconButton label={t('host.edit')} onClick={() => { editHost(selected) }}><VscEdit /></IconButton>
      <IconButton label={t('host.delete')} onClick={() => { void deleteHost(selected.id) }}><VscTrash /></IconButton>
    </div>}
  </header>

  const renderOverview = () => <section className={css.workView} aria-label={t('host.overviewLabel')}>
    {renderHostHeader(selected?.name ?? t('host.overviewTitle'))}
    {selected === null ? <div className={css.empty}>
      <VscServerEnvironment aria-hidden="true" />
      <strong>{t('host.select')}</strong>
      <span>{t('host.selectDescription')}</span>
      <button type="button" className={css.primary} onClick={() => { beginHost() }}><VscAdd />{t('inventory.newConnection')}</button>
    </div> : <div className={css.detailScroll}>
      <section className={css.detailSection} aria-label={t('detail.connection')}>
        <div className={css.detailHeader}><strong>{t('detail.connection')}</strong><StatusTag {...testLabel(selected)} /></div>
        {testLabel(selected).tone === 'fail' && usage[selected.id]?.test?.error !== undefined && <p className={css.testReason}>{usage[selected.id]?.test?.error}</p>}
        <dl className={css.hostFacts}>
          <div><dt>{t('host.address')}</dt><dd>{selected.hostname}:{selected.port}</dd></div>
          <div><dt>{t('host.user')}</dt><dd>{selected.username}</dd></div>
          <div><dt>{t('host.environment')}</dt><dd><span className={css.environment} data-environment={selected.environment}>{t(ENVIRONMENT_LABELS[selected.environment])}</span></dd></div>
          <div><dt>{t('host.cluster')}</dt><dd>{state.clusters.find(cluster => cluster.id === selected.clusterId)?.name ?? t('inventory.unclustered')}</dd></div>
          <div><dt>{t('host.authentication')}</dt><dd><VscKey />{t(selected.authKind === 'password' ? 'auth.password' : selected.authKind === 'private-key' ? 'auth.privateKey' : 'auth.agent')} · {t(selected.credentialConfigured ? 'host.configured' : 'host.notConfigured')}</dd></div>
          <div><dt>{t('host.jumpHost')}</dt><dd>{state.hosts.find(host => host.id === selected.jumpHostId)?.name ?? t('host.none')}</dd></div>
          <div><dt>{t('host.keepalive')}</dt><dd>{selected.keepAliveSeconds === 0 ? t('host.disabled') : t('host.seconds', { count: selected.keepAliveSeconds })}</dd></div>
          <div><dt>{t('host.defaultDirectory')}</dt><dd>{selected.defaultDirectory === undefined || selected.defaultDirectory === '' ? t('host.none') : selected.defaultDirectory}</dd></div>
          <div className={css.full}><dt>{t('host.fingerprint')}</dt><dd>{fingerprintOf(selected) === '' ? t('host.notPinned') : fingerprintOf(selected)}</dd></div>
        </dl>
        <div className={css.description}><strong>{t('host.description')}</strong><p>{selected.description || t('host.noDescription')}</p>{selected.tags.length > 0 && <div className={css.tags}>{selected.tags.map(tag => <span key={tag}>{tag}</span>)}</div>}</div>
      </section>

      <section className={css.detailSection} aria-label={t('detail.tunnels')}>
        <div className={css.detailHeader}>
          <strong>{t('detail.tunnels')}</strong><span className={css.count}>{hostForwards.length}</span>
          <button type="button" className={css.linkButton} onClick={() => { chooseView('tunnels') }}>{t('detail.manage')}</button>
        </div>
        {hostForwards.length === 0 ? <p className={css.sectionEmpty}>{t('detail.noTunnels')}</p> : <ul className={css.forwardList}>
          {hostForwards.map(forward => <li key={forward.id}>
            <VscPlug aria-hidden="true" />
            <span><strong>{forward.direction === 'local' ? t('tunnels.local') : t('tunnels.remote')} {forward.bindHost}:{forward.bindPort}</strong><small>→ {forward.targetHost}:{forward.targetPort}</small></span>
            <i data-state={forward.state} />
            <IconButton label={t('tunnels.close')} onClick={() => { void closeForward(forward.id) }}><VscClose /></IconButton>
          </li>)}
        </ul>}
        {forwardForm !== null && <div className={css.quickForward}>
          <Select label={t('tunnels.direction')} value={forwardForm.direction} options={directionOptions} onChange={value => { setForwardForm({ ...forwardForm, direction: value as SshPortForwardRequest['direction'] }) }} />
          <input aria-label={t('tunnels.bindPort')} type="number" min={0} max={65535} value={forwardForm.bindPort} onChange={event => { setForwardForm({ ...forwardForm, bindPort: Number(event.target.value) }) }} />
          <input aria-label={t('tunnels.targetHost')} value={forwardForm.targetHost} onChange={event => { setForwardForm({ ...forwardForm, targetHost: event.target.value }) }} />
          <input aria-label={t('tunnels.targetPort')} type="number" min={1} max={65535} value={forwardForm.targetPort} onChange={event => { setForwardForm({ ...forwardForm, targetPort: Number(event.target.value) }) }} />
          <IconButton label={t('tunnels.open')} onClick={() => { void openForward() }}><VscAdd /></IconButton>
        </div>}
      </section>

      <section className={css.detailSection} aria-label={t('detail.commands')}>
        <div className={css.detailHeader}><strong>{t('detail.commands')}</strong><span className={css.count}>{commands.length}</span></div>
        {commands.length === 0 ? <p className={css.sectionEmpty}>{t('detail.noCommands')}</p> : <ul className={css.commandList}>
          {commands.map(command => <li key={command.id}>
            <span><strong>{command.label}</strong><code>{command.command}</code></span>
            <IconButton label={t('detail.copyCommand', { name: command.label })} onClick={() => { void copyText(command.command).then(ok => { flash(ok ? t('detail.copied') : t('detail.copyFailed')) }) }}><VscCopy /></IconButton>
            <IconButton label={t('detail.insertCommand', { name: command.label })} onClick={() => { void insertCommand(selected, command.command) }}><VscPlay /></IconButton>
            <IconButton label={t('detail.removeCommand', { name: command.label })} onClick={() => { saveCommands(selected.id, commands.filter(item => item.id !== command.id)) }}><VscTrash /></IconButton>
          </li>)}
        </ul>}
        <div className={css.commandAdd}>
          <input aria-label={t('detail.commandLabel')} placeholder={t('detail.commandLabel')} value={commandLabel} onChange={event => { setCommandLabel(event.target.value) }} />
          <input aria-label={t('detail.commandText')} placeholder={t('detail.commandExample')} value={commandText} onChange={event => { setCommandText(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') addCommand() }} />
          <IconButton label={t('detail.addCommand')} disabled={commandText.trim() === ''} onClick={addCommand}><VscAdd /></IconButton>
        </div>
      </section>

      <section className={css.detailSection} aria-label={t('detail.recentSessions')}>
        <div className={css.detailHeader}><strong>{t('detail.recentSessions')}</strong><span className={css.count}>{hostTerminals.length}</span></div>
        {hostTerminals.length === 0 ? <p className={css.sectionEmpty}>{t('detail.noSessions')}</p> : <ul className={css.sessionList}>
          {hostTerminals.map(terminal => <li key={terminal.id}>
            <button type="button" onClick={() => { setActiveTerminalId(terminal.id); setView('terminal') }}>
              <VscTerminal aria-hidden="true" />
              <span><strong>{terminal.title}</strong><small>{new Date(terminal.connectedAt).toLocaleString()}</small></span>
              <em data-state={terminal.state}>{t(TERMINAL_STATE_LABELS[terminal.state])}</em>
            </button>
          </li>)}
        </ul>}
      </section>
    </div>}
  </section>

  const renderTerminal = () => <section className={css.terminalWorkspace} aria-label={t('terminal.workspace')}>
    <header className={css.terminalBar}>
      <div className={css.terminalTabs} role="tablist" aria-label={t('terminal.sessions')}>
        {terminals.map(terminal => <div className={css.terminalTab} data-active={terminal.id === activeTerminalId} key={terminal.id}>
          <button type="button" role="tab" aria-selected={terminal.id === activeTerminalId} onClick={() => { setActiveTerminalId(terminal.id) }}><VscTerminal /><span>{terminal.title}</span><i data-state={terminal.state} /></button>
          <IconButton label={t('terminal.closeNamed', { name: terminal.title })} onClick={() => { void closeTerminal(terminal.id) }}><VscClose /></IconButton>
        </div>)}
      </div>
      <div className={css.terminalActions}>
        <IconButton label={t('terminal.new')} disabled={selected === null} onClick={() => { if (selected !== null) void openTerminal(selected) }}><VscAdd /></IconButton>
        <IconButton label={t('terminal.clear')} disabled={activeTerminal === null} onClick={clearTerminal}><VscClearAll /></IconButton>
        <IconButton label={t('terminal.copy')} disabled={activeTerminal === null} onClick={() => { void copyTerminal() }}><VscCopy /></IconButton>
        <IconButton label={t('terminal.downloadLog')} disabled={activeTerminal === null} onClick={downloadTerminal}><VscDownload /></IconButton>
        <IconButton label={t('terminal.reconnect')} disabled={activeTerminal === null} onClick={() => { if (activeTerminal !== null) void reconnectTerminal(activeTerminal.id) }}><VscRefresh /></IconButton>
        <IconButton label={t('terminal.closeActive')} disabled={activeTerminal === null} onClick={() => { if (activeTerminal !== null) void closeTerminal(activeTerminal.id) }}><VscDebugDisconnect /></IconButton>
      </div>
    </header>
    {activeTerminal !== null && (activeTerminal.state === 'failed' || activeTerminal.state === 'disconnected') && <div className={css.reconnectBar} role="status">
      <VscWarning aria-hidden="true" />
      <span>{activeTerminal.state === 'failed' ? t('terminal.failedHint') : t('terminal.disconnectedHint')}</span>
      <button type="button" onClick={() => { void reconnectTerminal(activeTerminal.id) }}><VscRefresh />{t('terminal.reconnect')}</button>
    </div>}
    <div className={css.terminalStage}>
      {terminals.map(terminal => <TerminalPane
        key={terminal.id}
        ref={node => { if (node === null) terminalRefs.current.delete(terminal.id); else terminalRefs.current.set(terminal.id, node) }}
        sessionId={sessionId}
        terminal={terminal}
        active={terminal.id === activeTerminalId}
        initialInput={pendingInput[terminal.id]}
        onInitialInputConsumed={() => { setPendingInput(current => { const next = { ...current }; delete next[terminal.id]; return next }) }}
        onSnapshot={updateTerminal}
      />)}
      {activeTerminal === null && <div className={css.empty}><VscTerminal /><strong>{t('terminal.empty')}</strong><span>{selected === null ? t('terminal.selectHost') : t('terminal.openOn', { name: selected.name })}</span>{selected !== null && <button type="button" className={css.primary} onClick={() => { void openTerminal(selected) }}><VscAdd />{t('terminal.new')}</button>}</div>}
    </div>
    <footer className={css.statusBar}>
      <span><i data-state={activeTerminal?.state ?? 'disconnected'} />{activeTerminal === null ? t('terminal.noSession') : t(TERMINAL_STATE_LABELS[activeTerminal.state])}</span>
      <span>{activeTerminal?.cwd ?? t('terminal.cwdUnavailable')}</span>
      <span className={css.spacer} />
      <span>{t(terminals.length === 1 ? 'terminal.sessionCountOne' : 'terminal.sessionCountMany', { count: terminals.length })}</span>
      {selected !== null && <span>{selected.name}</span>}
    </footer>
  </section>

  const renderFiles = () => <section className={css.workView} aria-label={t('files.label')}>
    {renderHostHeader(t('view.files'))}
    {selected === null ? <div className={css.empty}><VscFiles /><strong>{t('host.select')}</strong><span>{t('files.selectDescription')}</span></div> : <div className={css.fileWorkbench}>
      <div className={css.fileToolbar}>
        <IconButton label={t('files.parentDirectory')} disabled={filePath === '.' || filePath === '/'} onClick={() => { void browse(selected, parentPath(filePath)) }}><VscArrowUp /></IconButton>
        <nav className={css.breadcrumbs} aria-label={t('files.remotePath')}>{pathBreadcrumbs(filePath).map((crumb, index, crumbs) => <span key={crumb.path}><button type="button" disabled={index === crumbs.length - 1} onClick={() => { void browse(selected, crumb.path) }}>{crumb.label}</button>{index < crumbs.length - 1 && <VscChevronRight />}</span>)}</nav>
        <IconButton label={t('files.refresh')} disabled={fileBusy} onClick={() => { void browse(selected) }}><VscRefresh /></IconButton>
        <IconButton label={t('files.upload')} disabled={fileBusy} onClick={() => { uploadInput.current?.click() }}><VscCloudUpload /></IconButton>
        <input ref={uploadInput} className={css.hiddenInput} type="file" onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void upload(selected, file) }} />
      </div>
      <div className={css.pathEditor}><span>{t('files.path')}</span><input aria-label={t('files.remotePath')} value={filePath} onChange={event => { setFilePath(event.target.value) }} onKeyDown={event => { if (event.key === 'Enter') void browse(selected) }} /><button type="button" disabled={fileBusy} onClick={() => { void browse(selected) }}>{t('files.go')}</button></div>
      <div className={css.tableScroll}>
        <table className={css.fileTable}>
          <thead><tr><th>{t('files.name')}</th><th>{t('files.size')}</th><th>{t('files.modified')}</th><th><span className={css.srOnly}>{t('common.actions')}</span></th></tr></thead>
          <tbody>{files?.entries.map(entry => <tr key={entry.path}>
            <td><button type="button" className={css.fileName} disabled={entry.type !== 'directory'} onClick={() => { if (entry.type === 'directory') void browse(selected, entry.path) }}>{entry.type === 'directory' ? <VscFolder /> : <VscFile />}<span>{entry.name}</span></button></td>
            <td>{entry.type === 'directory' ? t('files.folder') : formatBytes(entry.size)}</td>
            <td><time>{new Date(entry.modifiedAt).toLocaleString()}</time></td>
            <td>{entry.type === 'file' && <IconButton label={t('files.download') + ' ' + entry.name} disabled={fileBusy} onClick={() => { void download(selected, entry.path) }}><VscCloudDownload /></IconButton>}</td>
          </tr>)}</tbody>
        </table>
        {files === null && <div className={css.emptySmall}>{fileBusy ? t('files.loading') : t('files.openPath')}</div>}
        {files !== null && files.entries.length === 0 && <div className={css.emptySmall}>{t('files.empty')}</div>}
      </div>
    </div>}
  </section>

  const renderTunnels = () => <section className={css.workView} aria-label={t('tunnels.label')}>
    {renderHostHeader(t('view.tunnels'))}
    {selected === null || forwardForm === null ? <div className={css.empty}><VscPlug /><strong>{t('host.select')}</strong><span>{t('tunnels.selectDescription')}</span></div> : <div className={css.tunnelWorkbench}>
      <section className={css.forwardComposer} aria-label={t('tunnels.new')}>
        <header><strong>{t('tunnels.new')}</strong><span>{t('tunnels.forwardThrough', { name: selected.name })}</span></header>
        <div className={css.forwardForm}>
          <label>{t('tunnels.direction')}<Select label={t('tunnels.direction')} value={forwardForm.direction} options={directionOptions} onChange={value => { setForwardForm({ ...forwardForm, direction: value as SshPortForwardRequest['direction'] }) }} /></label>
          <label>{t('tunnels.bindHost')}<input value={forwardForm.bindHost} onChange={event => { setForwardForm({ ...forwardForm, bindHost: event.target.value }) }} /></label>
          <label>{t('tunnels.bindPort')}<input type="number" min={0} max={65535} value={forwardForm.bindPort} onChange={event => { setForwardForm({ ...forwardForm, bindPort: Number(event.target.value) }) }} /></label>
          <span className={css.forwardArrow}>{t('tunnels.to')}</span>
          <label>{t('tunnels.targetHost')}<input value={forwardForm.targetHost} onChange={event => { setForwardForm({ ...forwardForm, targetHost: event.target.value }) }} /></label>
          <label>{t('tunnels.targetPort')}<input type="number" min={1} max={65535} value={forwardForm.targetPort} onChange={event => { setForwardForm({ ...forwardForm, targetPort: Number(event.target.value) }) }} /></label>
          <button type="button" className={css.primary} title={t('tunnels.openTitle')} onClick={() => { void openForward() }}><VscAdd />{t('tunnels.open')}</button>
        </div>
      </section>
      <div className={css.tableScroll}>
        <table className={css.tunnelTable}>
          <thead><tr><th>{t('tunnels.direction')}</th><th>{t('tunnels.listenAddress')}</th><th>{t('tunnels.target')}</th><th>{t('tunnels.status')}</th><th><span className={css.srOnly}>{t('common.actions')}</span></th></tr></thead>
          <tbody>{hostForwards.map(forward => <tr key={forward.id}>
            <td><span className={css.direction}><VscPlug />{forward.direction === 'local' ? t('tunnels.local') : t('tunnels.remote')}</span></td>
            <td>{forward.bindHost}:{forward.bindPort}</td>
            <td>{forward.targetHost}:{forward.targetPort}</td>
            <td><span className={css.forwardState} data-state={forward.state}><i />{t(('tunnels.state.' + forward.state) as TranslationKey)}</span>{forward.error !== undefined && <small className={css.danger}>{forward.error}</small>}</td>
            <td><div className={css.rowActions}>{forward.state !== 'active' && <IconButton label={t('tunnels.reconnect')} onClick={() => { void reconnectForward(forward.id) }}><VscRefresh /></IconButton>}<IconButton label={t('tunnels.close')} onClick={() => { void closeForward(forward.id) }}><VscDebugDisconnect /></IconButton></div></td>
          </tr>)}</tbody>
        </table>
        {hostForwards.length === 0 && <div className={css.emptySmall}>{t('tunnels.empty')}</div>}
      </div>
    </div>}
  </section>

  return <div className={css.root} data-dsh-ssh-manager>
    <header className={css.toolbar}>
      <div className={css.brand}><VscRemoteExplorer size={18} /><strong>{t('app.title')}</strong></div>
      <nav className={css.viewSwitch} aria-label={t('app.workspaceView')}>{VIEW_ITEMS.map(item => {
        const Icon = item.icon
        return <button type="button" key={item.id} data-active={view === item.id} aria-pressed={view === item.id} onClick={() => { chooseView(item.id) }}><Icon /><span>{t(item.label)}</span>{item.id === 'terminal' && terminals.length > 0 && <small>{terminals.length}</small>}</button>
      })}</nav>
      <div className={css.globalActions}>
        <IconButton label={t(inventoryOpen ? 'app.hideExplorer' : 'app.showExplorer')} aria-pressed={inventoryOpen} onClick={() => { setInventoryOpen(current => !current) }}><VscLayoutSidebarLeft /></IconButton>
        <IconButton label={t('inventory.addCluster')} onClick={() => { beginCluster() }}><VscFolder /></IconButton>
        <IconButton label={t('inventory.newConnection')} onClick={() => { beginHost() }}><VscAdd /></IconButton>
      </div>
    </header>
    {error !== null && <div className={css.error} role="alert"><VscInfo />{error}<IconButton label={t('action.dismissError')} onClick={() => { setError(null) }}><VscClose /></IconButton></div>}
    {notice !== null && <div className={css.notice} role="status">{notice}</div>}
    <div className={css.workspace} data-inventory={inventoryOpen} data-overlay={view !== 'hosts'}>
      {inventoryOpen && renderInventory()}
      <main className={css.mainWorkspace}>{view === 'hosts' ? renderOverview() : view === 'terminal' ? renderTerminal() : view === 'files' ? renderFiles() : renderTunnels()}</main>
    </div>
    {renderContextMenu()}

    {hostForm !== null && <ConnectionWizard
      mode={hostForm.id === '' ? 'create' : 'edit'}
      host={hostForm}
      credential={credential}
      clusters={state.clusters}
      hosts={state.hosts}
      busy={wizardBusy}
      probing={probing}
      testTag={wizardTest}
      onChangeHost={next => { setHostForm(next) }}
      onChangeCredential={next => { setCredential(next) }}
      onTest={() => { void testWizardDraft() }}
      onSave={() => { void saveHost() }}
      onClose={() => { setHostForm(null); setCredential({}); setWizardTest(null); setWizardResult(null) }}
      onProbe={() => { void probeFingerprint() }}
    />}

    {clusterForm !== null && <div className={css.backdrop}>
      <div className={css.dialog} role="dialog" aria-modal="true" aria-label={t('dialog.cluster')}>
        <header><div><strong>{t(clusterForm.id === '' ? 'dialog.addCluster' : 'dialog.editCluster')}</strong><span>{t('dialog.clusterDescription')}</span></div><IconButton label={t('action.close')} onClick={() => { setClusterForm(null) }}><VscClose /></IconButton></header>
        <div className={css.form}><label className={css.full}>{t('field.name')}<input autoFocus value={clusterForm.name} onChange={event => { setClusterForm({ ...clusterForm, name: event.target.value }) }} /></label><label className={css.full}>{t('field.description')}<textarea value={clusterForm.description} onChange={event => { setClusterForm({ ...clusterForm, description: event.target.value }) }} /></label></div>
        <footer><button type="button" onClick={() => { setClusterForm(null) }}>{t('action.cancel')}</button><button type="button" className={css.primary} disabled={clusterForm.name.trim() === ''} onClick={() => { void saveCluster() }}>{t('action.saveCluster')}</button></footer>
      </div>
    </div>}
  </div>
}
