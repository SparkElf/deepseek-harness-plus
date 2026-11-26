/**
 * The knowledge-base management page.
 *
 * Selected by the left-sidebar entry and rendered into the `main` slot, so it
 * replaces the conversation area. The page carries its own master-detail layout:
 * the rail holds a menu above the knowledge tree, and the content region shows
 * whichever surface the rail selected (a file preview, permissions, or indexing).
 *
 * The tree is this package's own listing rather than the file component from
 * `dsh-better-sidebar`. That component renders icon and name only and builds its
 * context menu internally, so it has nowhere to show whether a row is readable and
 * nowhere to add a grant entry, while the actions its menu does offer (rename,
 * delete, upload) edit a shared curated store rather than deciding who may see a
 * document. The one thing worth keeping from it is the `@`-reference action, reused
 * through its own helper so both trees insert the same reference.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import {
  IconCheckOutline16,
  IconChevronDownOutlineRegular,
  IconChevronUpOutline14,
  IconLightOutline16,
  IconPanelLeftOutline16,
  IconPlusOutlineRegular,
  IconSearchOutlineRegular,
  IconSettingsOutline16,
  Input,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson, type KnowledgeConfigView, type KnowledgeStatusView } from '../api.ts'

/** Extensions that are plain text and must be sent as text, not base64. */
const TEXT_EXTENSIONS = new Set([
  '.md', '.txt', '.text', '.markdown', '.rst',
  '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.log', '.xml', '.html', '.htm', '.css', '.scss', '.less',
  '.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
  '.sh', '.bash', '.zsh', '.ps1', '.bat', '.sql', '.graphql', '.proto',
])

/** Content types the browser reports for text it already decoded. */
const TEXT_MIME_TYPES = new Set([
  'application/json', 'application/xml', 'application/javascript',
  'application/x-yaml', 'application/yaml', 'application/x-sh',
])

/**
 * Last path segment's extension, lowercased, including the dot.
 *
 * Written inline rather than imported from `node:path`: this file runs in the
 * browser, where that module does not exist.
 *
 * @param path - a path or bare file name.
 * @returns the extension, or an empty string when there is none.
 */
function extname(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot).toLowerCase()
}
import { KnowledgeLoading } from './KnowledgeLoading.tsx'
import { closeSidebar, openInSidebar, readColumnExpanded } from './openInSidebar.ts'
import { publishActor, setMountPointResolver } from './saveAudit.ts'
import { KnowledgeHome } from './KnowledgeHome.tsx'
import { KnowledgeTrash } from './KnowledgeTrash.tsx'
import { KnowledgeMenuBrand, sectionGlyph } from './MenuGlyphs.tsx'
import { KnowledgeAudit } from './KnowledgeAudit.tsx'
import { KnowledgeSettings } from './KnowledgeSettings.tsx'
import { KnowledgeMemory, type MemoryEntryView } from './KnowledgeMemory.tsx'
import { KnowledgeSearch, useKnowledgeSearch } from './KnowledgeSearch.tsx'
import { KB_DRAG_MIME, KnowledgeListing } from './KnowledgeListing.tsx'
import { KnowledgeProgressPopover } from './KnowledgeProgressPopover.tsx'
import {
  failureReason,
  type FailedExtractionView,
  type OptimisticExtraction,
  type UploadTaskView,
} from './progressRules.ts'
import {
  forgetExtractionFailure,
  readExtractionFailures,
  rememberExtractionFailure,
} from './extractionHistory.ts'
import { resolveUploadDir } from './dropTargetPath.ts'
import { uploadJsonWithProgress } from './uploadTransport.ts'
import { KnowledgeShareDialog } from './KnowledgeShareDialog.tsx'
import { shareCopyFor } from './knowledgeMenuCopy.ts'
import { KnowledgeIconButton, KnowledgeSectionHeader } from './KnowledgeSectionHeader.tsx'
import { KnowledgeScopeTabs, type KnowledgePanelScope } from './graph/KnowledgeScopeTabs.tsx'
import { KnowledgeGraphTree } from './graph/KnowledgeGraphTree.tsx'
import { KnowledgeGraphView } from './graph/KnowledgeGraphView.tsx'
import { useKnowledgeGraph } from './graph/useKnowledgeGraph.ts'
import { knowledgeGraphsOf } from '../graphTypes.ts'
import { useFavorites } from './useFavorites.ts'
import { KnowledgeContextMenu, type ContextTarget, type TreeClipboard } from './KnowledgeContextMenu.tsx'
import { usePinnedPaths } from './usePinnedPaths.ts'
import { useTreeState } from './useTreeState.ts'
import { DEFAULT_TREE_SORT, TREE_SORT_KEYS, useTreeSort } from './useTreeSort.ts'
import { KnowledgeFileTree } from './KnowledgeFileTree.tsx'
import { KnowledgeFilePreview } from './KnowledgeFilePreview.tsx'
import { KnowledgeReferencePicker } from './KnowledgeReferencePicker.tsx'
import { KnowledgeSelectionBar } from './KnowledgeSelectionBar.tsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './KnowledgePanel.module.css'
import { Menu } from './ui/Menu'
import { MenuItemButton } from './ui/MenuItemButton'
import listingStyles from './KnowledgeListing.module.css'

/**
 * The session binding the page scopes its file tree with.
 *
 * It is a subscribable observable rather than a plain value because the session it
 * names appears only after a Workspace is chosen, which regularly happens after
 * this page has already mounted.
 */
export interface SessionSource {
  /** Current binding; `key` is the session id, absent before a session exists. */
  getSnapshot: () => { key?: unknown }
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void
}

/** Values the `main` slot injects into the page. */
export interface KnowledgePanelInjected {
  /** Locale-bound copy for this package's namespace. */
  t: (key: string) => string
  /** Locale tag the slot bound for this namespace, so dates match the reader. */
  locale?: string
  /** Source of the session the file tree resolves its scope from. */
  sessionSource: SessionSource
  /**
   * The client context, needed by the borrowed tree's `@` helper.
   *
   * That helper resolves the workspace root and the conversation input service
   * itself, so it needs the context rather than the values it reads from it.
   */
  ctx: unknown
}

/** Props the page receives. */
export interface KnowledgePanelProps extends Partial<KnowledgePanelInjected> {}

/**
 * Join the mount point with a listing-relative path.
 *
 * The borrowed tree and the conversation draft both address files by absolute
 * path, while a listing row carries a path relative to the mount. Kept as a plain
 * join rather than `node:path` because this runs in the browser, where only POSIX
 * separators occur.
 * @param mountPoint - absolute mount directory.
 * @param relPath - path relative to it.
 * @returns The absolute path.
 */
function joinPath(mountPoint: string, relPath: string): string {
  const base = mountPoint.endsWith('/') ? mountPoint.slice(0, -1) : mountPoint
  return base + '/' + relPath
}

/**
 * Turn an absolute path under the knowledge root back into a tree-relative one.
 *
 * The product's file explorer speaks absolute paths because it is a workspace browser;
 * every other surface here keys previews and grants by the tree-relative path, because a
 * relative path is what survives the caller's view being rebuilt at a different location.
 * The two meet at this function.
 * @param mountPoint - absolute mount directory.
 * @param absolute - a path the explorer reported.
 * @returns The path relative to the mount point (the input unchanged if it is not under it).
 */
function relativeToRoot(mountPoint: string, absolute: string): string {
  const base = mountPoint.endsWith('/') ? mountPoint.slice(0, -1) : mountPoint
  if (absolute === base) return ''
  return absolute.startsWith(base + '/') ? absolute.slice(base.length + 1) : absolute
}

/**
 * The title the header shows for the current selection.
 *
 * A file shows its own name, so the header answers "what am I looking at" while the
 * breadcrumb line answers "where is it". A section shows its menu label, which
 * keeps the header and the highlighted menu row saying the same thing.
 * @param t - copy resolver.
 * @param selection - the current selection.
 * @returns The heading text.
 */
function sectionTitle(t: (key: string) => string, selection: Selection): string {
  if (selection.kind === 'home') return t('menu.home')
  if (selection.kind === 'memory') return t('menu.memory')
  if (selection.kind === 'trash') return t('menu.trash')
  if (selection.kind === 'audit') return t('menu.audit')
  if (selection.kind === 'settings') return t('menu.settings')
  if (selection.kind === 'file') {
    const path = selection.path
    return path.slice(path.lastIndexOf('/') + 1)
  }
  return t('menu.search')
}

/** Which content the right-hand region shows. */
type Selection =
  | { kind: 'search' }
  | { kind: 'home' }
  | { kind: 'memory' }
  | { kind: 'trash' }
  | { kind: 'audit' }
  | { kind: 'settings' }
  | { kind: 'file'; path: string }

/**
 * The rail's fold state, persisted per browser.
 *
 * A fold is a per-device preference rather than a document fact, so it belongs in
 * browser storage: a reader who collapsed the rail on a laptop has not expressed
 * anything about the shared tree, and syncing the choice through the view
 * directory would move another reader's layout. Absent storage, or a value that is
 * not the one token written, reads as expanded, which is the state a first visit
 * should show.
 */
const RAIL_FOLDED_KEY = 'dsh-knowledge-rail-folded'

/**
 * The session key this page scopes host requests by when no conversation is open.
 *
 * The knowledge page has no conversation of its own, so `sessionId` is undefined on a
 * fresh visit -- exactly when a reader browses the tree or clicks a document. The host
 * routes only require a stable non-empty key (they do not verify that a conversation
 * with that id exists), so an absent one gets this placeholder: stable so caches hold
 * between renders, and distinct from any real session id so it cannot collide with one.
 */
const KB_EXPLORER_SESSION = '@kb-explorer'

/** Read the stored fold state, tolerating storage that is unavailable or corrupt. */
function readFolded(): boolean {
  try {
    return window.localStorage.getItem(RAIL_FOLDED_KEY) === '1'
  } catch {
    return false
  }
}

/** Persist the fold state, ignoring a storage that refuses to write. */
function writeFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(RAIL_FOLDED_KEY, folded ? '1' : '0')
  } catch {
    // Private-mode or full storage: the fold still applies for this session.
  }
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; config: KnowledgeConfigView; status: KnowledgeStatusView }
  | { kind: 'unavailable' }

/**
 * Read one knowledge-base API method.
 * @param method - method name from {@link KB_API}.
 * @returns The parsed response body.
 */
async function readApi<T>(method: string): Promise<T> {
  const response = await fetch(kbApiPath(method as never), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  // Read through the tolerant helper: a 2xx carrying a non-JSON body (a proxy line, an
  // HTML error page) used to reach the page as a raw JSON.parse error message.
  const body = await readKnowledgeJson<T & Record<string, unknown>>(response)
  if (body.error !== undefined) throw new Error(body.error)
  return body as T
}

/**
 * Render the knowledge-base management page.
 * @param props - injected locale copy and the current session id.
 * @returns The master-detail page.
 */
export function KnowledgePanel(props: KnowledgePanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [selection, setSelection] = useState<Selection>({ kind: 'home' })

  /**
   * Which data source the rail tree and the content region show.
   *
   * The two pills replace the band's title; this state is the only thing they
   * switch. `selection` (the KB page) is deliberately left untouched while the
   * graph tab is open, so moving back restores the same page instead of resetting
   * to Home.
   */
  const [scope, setScope] = useState<KnowledgePanelScope>('kb')
  /** The permission-filtered graph tree, loaded lazily on first activation. */
  const graph = useKnowledgeGraph(scope === 'graph')
  const graphNodes = useMemo(() => knowledgeGraphsOf(graph.tree), [graph.tree])
  const [activeGraphId, setActiveGraphId] = useState<string | undefined>(undefined)
  const [activeTopicId, setActiveTopicId] = useState<string | undefined>(undefined)
  const activeGraph = graphNodes.find(node => node.id === activeGraphId)

  // The canvas needs a graph as soon as the tab has one. Keeping the current
  // selection when it is still present is what makes a reload non-destructive.
  useEffect(() => {
    if (scope !== 'graph' || graph.kind !== 'ready' || graphNodes.length === 0) return
    setActiveGraphId(current => (
      current !== undefined && graphNodes.some(node => node.id === current)
        ? current
        // Prefer a stored graph on first entry: an empty 总图 is a valid view but
        // a blank canvas is a poor first impression. 总图 stays one click away.
        : (graphNodes.find(node => node.computed !== true) ?? graphNodes[0])?.id
    ))
  }, [scope, graph.kind, graphNodes])

  const selectGraph = useCallback((graphId: string): void => {
    setActiveGraphId(graphId)
    setActiveTopicId(undefined)
  }, [])

  const selectTopic = useCallback((graphId: string, topicId: string): void => {
    setActiveGraphId(graphId)
    setActiveTopicId(topicId)
  }, [])

  /**
   * The open document's modification instant, reported by the preview.
   *
   * Held here rather than in the preview because the header draws it: the header is
   * outside the preview's subtree, so the value has to reach this level. Cleared
   * whenever the selection changes, so a slow read for the previous file can never
   * label the next one.
   */
  const [fileMtimeMs, setFileMtimeMs] = useState<number | undefined>(undefined)

  /** A real Session created for host-owned previews opened from this panel. */
  const explorerSessionRef = useRef<string | undefined>(undefined)

  /**
   * A real session id for a session-scoped resource address.
   *
   * The fs tree may key its routes with `@kb-explorer`, but a resource address is
   * persisted by the sidebar and resolved as a real Session after a restart. Never
   * let that path see the placeholder: use the active conversation, or create one
   * explorer Session and reuse it, or let the caller degrade without opening.
   */
  const ensureExplorerSession = useCallback(async (): Promise<string | undefined> => {
    const current = props.sessionSource?.getSnapshot().key
    if (typeof current === 'string' && current !== '') return current
    if (explorerSessionRef.current !== undefined) return explorerSessionRef.current
    const context = props.ctx as { get?: (name: string) => unknown } | undefined
    const sessions = context?.get?.('sessions') as
      | { create?: (input: Record<string, never>) => Promise<string> }
      | undefined
    if (typeof sessions?.create !== 'function') return undefined
    try {
      const created = await sessions.create({})
      if (typeof created === 'string' && created !== '') {
        explorerSessionRef.current = created
        return created
      }
    } catch {
      // A profile without session creation still gets the graceful path below.
    }
    return undefined
  }, [props.ctx, props.sessionSource])

  /**
   * Open a document the way the rest of the product does: in the host's own file
   * preview window, not in this page.
   *
   * The knowledge page stays a browsing surface. A reader who opens a document gets
   * the tab strip, the path input, and the preview/edit toggle they already know from
   * the sidebar, because it IS that window -- this plugin draws none of it.
   *
   * When the host service is absent the page cannot conjure a viewer, so the click
   * reports it rather than appearing to do nothing.
   */
  const openDocument = async (path: string): Promise<void> => {
    // Opening a document leaves the graph canvas as well: `scope` gates the whole
    // content region, so a selection change alone would keep the canvas on screen.
    setScope('kb')
    setSelection({ kind: 'file', path })
    // A markdown preview has an absolute-address claimant and needs no session. A
    // host-owned type (.pdf/.docx/.xlsx) gets a session-scoped address, so resolve a
    // REAL session first; the placeholder is valid only for fs routes, not for a
    // resource the sidebar persists across restarts.
    const current = props.sessionSource?.getSnapshot().key
    const outcome = await openInSidebar(
      props.ctx,
      typeof current === 'string' && current !== '' ? current : undefined,
      '/workspace',
      joinPath(config.mountPoint, path),
      ensureExplorerSession,
    )
    // The host column is a progressive enhancement: on a global panel it has no session
    // surface to render into. Remember why it failed so the page can fall back to its own
    // preview; a successful open clears the previous failure.
    setOpenFailure(outcome === 'opened' ? undefined : outcome)
  }
  const [refreshTick, setRefreshTick] = useState(0)
  /**
   * The active page's primary control.
   *
   * Each management page owns the handler and the disabled state of its one action;
   * the panel owns where it is drawn. Publishing it here is what lets the header be
   * the only band at the top of the page. A page clears the slot on unmount so a
   * switch to another surface cannot inherit the previous page's button.
   */
  const [pageAction, setPageAction] = useState<ReactNode>(undefined)

  /**
   * Whether a dropped file must be sent as base64 rather than as text.
   *
   * The decision is made from the extension and the browser's own content type:
   * a file the browser already recognises as text is read as text, and anything
   * else is treated as bytes. Guessing from the extension alone would corrupt a
   * `.md` that happens to carry an unusual name, and trusting the content type
   * alone would corrupt a document the browser reports as `application/octet-stream`.
   *
   * @param file - the dropped file.
   * @param relPath - its name inside the knowledge tree.
   * @returns true when the bytes must survive verbatim.
   */
  function needsBase64(file: File, relPath: string): boolean {
    if (TEXT_EXTENSIONS.has(extname(relPath).toLowerCase())) return false
    if (file.type.startsWith('text/')) return false
    if (TEXT_MIME_TYPES.has(file.type)) return false
    return true
  }

  /** Base64 of a buffer, from bytes rather than a binary string. */
  function base64Of(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer)
    // `String.fromCharCode(...bytes)` overflows the argument list on a large
    // document, so the buffer is chunked before it is turned into a string.
    let binary = ''
    const CHUNK = 0x8000
    for (let offset = 0; offset < bytes.length; offset += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
    }
    return btoa(binary)
  }

  /**
   * Upload files into one directory, as the product's explorer asks.
   *
   * The explorer hands over `File` objects and an absolute directory; this plugin's upload
   * route speaks one file at a time as text plus a tree-relative path. Each file is read
   * here and posted individually so one failure does not discard the rest of a drop: a
   * batch that all-or-nothing would lose nine good files to one large one.
   * @param dir - absolute directory the drop landed in.
   * @param items - the dropped files with their relative names.
   */
  const uploadInto = useCallback(async (
    mountPoint: string,
    dir: string,
    items: readonly { file: File; relativePath: string }[],
  ): Promise<void> => {
    const parent = relativeToRoot(mountPoint, dir)
    // One row per file, in drop order, so the progress area can show the whole batch
    // from the first byte rather than growing a row per completed file.
    const queuedAt = new Date().toISOString()
    const queue: UploadTaskView[] = items.map(item => ({
      name: item.relativePath,
      // The directory the file lands in, tree-relative: what the reader recognises.
      dir: parent === '' ? '' : parent,
      state: 'waiting',
      at: queuedAt,
    }))
    setUploadTasks(queue)
    setUploadBusy(true)

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      const target = parent === '' ? item.relativePath : parent + '/' + item.relativePath
      setUploadTasks(current => current.map((task, at) => (
        at === index ? { ...task, state: 'uploading' } : task
      )))
      try {
        // A document is bytes, not text. Reading a .docx through `file.text()`
        // would decode it as UTF-8 and post a corrupted body, so the route is told
        // which encoding it is receiving and the browser hands over base64 for
        // anything that is not plain text. The server extracts those documents to
        // a `.md` sibling after writing them, which is what makes them greppable.
        const binary = needsBase64(item.file, item.relativePath)
        const content = binary
          ? base64Of(await item.file.arrayBuffer())
          : await item.file.text()
        // XHR rather than `fetch`: this is the only browser API that reports bytes sent,
        // and the reader asked for a real percentage rather than a spinner. The request
        // itself is unchanged -- same route, same body, same content type.
        const attempt = await uploadJsonWithProgress(
          kbApiPath(KB_API.upload),
          binary ? { relPath: target, content, encoding: 'base64' } : { relPath: target, content },
          (percent) => {
            setUploadTasks(current => current.map((task, at) => (
              at === index ? { ...task, percent } : task
            )))
          },
        )
        const response = {
          ok: attempt.status >= 200 && attempt.status < 300,
          status: attempt.status,
        }
        if (attempt.transportError !== undefined) {
          // The request never reached the server. The reason names the transport rather
          // than a status code, because "HTTP 0" tells a reader nothing.
          throw new Error(attempt.transportError)
        }
        if (response.ok) {
          setUploadTasks(current => current.map((task, at) => (
            at === index ? { ...task, state: 'done', percent: undefined } : task
          )))
        } else {
          // The route answers a refusal with `{error, code}`: a taken name, a size
          // limit, a permission denial. That text is the only thing that tells the
          // reader whether to rename, split, or ask for access, so it travels with the
          // row instead of the row just saying "failed".
          // A gateway answering 502 sends HTML, so `json()` rejects on it. That
          // rejection must not escape: it would leave the row saying "failed" with no
          // reason at all, which is the silence this whole path exists to remove.
          const body = attempt.body as { error?: string; code?: string; limitBytes?: number } | undefined
          const reason = failureReason(body, response.status)
          setUploadTasks(current => current.map((task, at) => (
            at === index ? { ...task, state: 'failed', reason, percent: undefined } : task
          )))
        }
      } catch (error: unknown) {
        // A file that could not be read is a failure like any other, and the reason
        // matters most here: nothing on the server ever saw it.
        setUploadTasks(current => current.map((task, at) => (
          at === index ? { ...task, state: 'failed', reason: error instanceof Error ? error.message : 'could not read the file', percent: undefined } : task
        )))
      }
    }
    setUploadBusy(false)
    setRefreshTick(t => t + 1)
  }, [])

  const [folded, setFolded] = useState<boolean>(readFolded)
  // The tree header's own narrowing, which costs no request. Kept apart from the
  // rail's search term: one narrows what is displayed, the other queries the tree.
  const [treeFilter, setTreeFilter] = useState('')
  // The graph tab has its own narrowing. Sharing the KB term would hide every graph
  // as soon as a filename filter happened to match no graph name.
  const [graphFilter, setGraphFilter] = useState('')
  const [filterOpen, setFilterOpen] = useState(false)
  const activeFilter = scope === 'graph' ? graphFilter : treeFilter
  const setActiveFilter = (value: string): void => {
    if (scope === 'graph') setGraphFilter(value)
    else setTreeFilter(value)
  }
  // The pinned band's fold, which is a view state rather than a stored one: the
  // band's existence is the fact worth persisting, and a band the reader collapsed
  // reopens expanded so its contents are not lost behind a stale toggle.
  const [pinnedOpen, setPinnedOpen] = useState(true)
  // Set when the reader arrived at Home from the tree's empty state, whose button
  // asks to start a document. It is a one-shot: consuming it on the next selection
  // change keeps the New card from grabbing focus every time Home is revisited.
  const [focusNew, setFocusNew] = useState(false)

  // Subscribed rather than read once: a Workspace chosen after this page mounted is
  // what first supplies a session, and without the subscription the tree would stay
  // unrendered for the life of the view.
  //
  // Declared above the loading/unavailable early returns on purpose. Hooks run in
  // call order, so a hook below them changes the hook count between their renders
  // and React aborts the subtree -- measured in a browser on 2026-10-15, where the
  // panel rendered nothing at all.
  // The slot supplies the namespace's resolver; the fallback keeps the page
  // renderable when a slot host passes none, which is how a missing locale shows up.
  const t = props.t ?? ((key: string) => key)

  const sessionSource = props.sessionSource
  const sessionId = useSyncExternalStore(
    useCallback(
      (listener: () => void) => sessionSource?.subscribe(listener) ?? (() => {}),
      [sessionSource],
    ),
    () => sessionSource?.getSnapshot().key as string | undefined,
  )

  /**
   * The session key the product's file explorer scopes its requests by.
   *
   * The knowledge page has no conversation of its own, so `sessionId` is undefined on a
   * fresh visit -- which is exactly when a reader wants to browse the tree, and why the
   * explorer branch used to be skipped entirely. The explorer's host route only requires a
   * non-empty string to key its level cache by; it does not check that a conversation with
   * that id exists (measured: `POST /sidebar/api/fs.trees {sessionId:'not-a-real-session'}`
   * answers 200 with the directory's entries). So an absent conversation gets a stable
   * placeholder: stable so the tree keeps its cache between renders, and distinct from any
   * real session id so it can never collide with one.
   */
  const explorerSessionId = sessionId ?? KB_EXPLORER_SESSION

  /**
   * The knowledge root as an absolute path, for the surfaces that speak absolute paths.
   *
   * Only branches that already established `config.mountPoint !== ''` read this, so it is
   * never empty there; the empty fallback exists so the constant is well typed rather than
   * to gate a render.
   */
  const kbRoot = state.kind === 'ready' ? state.config.mountPoint : ''

  // Directories the product's explorer has open, by absolute path.
  //
  // Kept by a hook rather than a `useState` here because the set has to survive the
  // page: it is stored in the caller's view directory beside `.view-mode.json`, so a
  // reader who opened `department/platform` finds it open after a reload or on another
  // machine. The hook also coalesces saves -- opening one deep path toggles once per
  // level, and each toggle must not become its own round trip. It stays disabled until
  // the root is known, which is the only state with no view directory to read.
  const treeState = useTreeState(kbRoot !== '', kbRoot)
  const explorerExpanded = treeState.expanded

  /**
   * The entry whose `@` button is asking which conversation to land in.
   *
   * Null while nothing is being referenced. Set only when there is no conversation
   * otherwise: with one open, `@` stays a one-click insert as it is in the sidebar.
   */
  /** The path whose Share dialog is open, or null. One dialog for the whole page. */
  const [shareTarget, setShareTarget] = useState<string | null>(null)
  const [referencing, setReferencing] = useState<
    { path: string; isDir: boolean; targets?: readonly { path: string; isDir: boolean }[] } | undefined
  >(undefined)
  /** The only feedback a reader gets when the target conversation is not on screen. */
  const [referenceNote, setReferenceNote] = useState<string | undefined>(undefined)
  /** True while a dropped batch is uploading, so a second drop cannot start. */
  const [uploadBusy, setUploadBusy] = useState(false)
  /** The batch's per-file rows, shown in the progress strip at the panel's foot. */
  const [uploadTasks, setUploadTasks] = useState<UploadTaskView[]>([])
  /**
   * Bumped when something outside the polling loop changes what extraction is doing.
   *
   * The progress panel polls only while it already knows about pending work, so a manually
   * queued extraction -- the case where it knows about none -- would never appear. This is
   * the same signal shape the tree and the table already use: one counter, one re-read.
   */
  const [progressRefresh, setProgressRefresh] = useState(0)
  /**
   * Documents the reader asked to extract that the Host has not reported yet.
   *
   * A guess, held separately from the Host's tasks: the panel draws it as queued and drops
   * it as soon as `extract.status` mentions the path, so a guess can never outlive the
   * truth. It expires on its own (`OPTIMISTIC_TTL_MS`) because a request can fail in ways
   * the browser never reports -- a dropped connection, a proxy that swallows the body --
   * and a row stuck on "queued" forever is worse than no row.
   */
  const [optimisticExtractions, setOptimisticExtractions] = useState<OptimisticExtraction[]>([])

  /**
   * Extraction requests this page session saw refused before the Host created a task.
   *
   * The menu's own errors cannot be left in the sidebar: a persistent line under the tree
   * competes with the content for the rest of the session. The progress panel is where a
   * reader looks for "what happened to my extraction", so these rows live there -- and
   * they come from {@link readExtractionFailures} rather than component state so a
   * navigation away and back does not erase the record.
   */
  const [extractionFailures, setExtractionFailures] = useState<FailedExtractionView[]>(
    () => readExtractionFailures(),
  )

  // Publish the knowledge root and the caller identity to the plugin-scope save-audit
  // registration. The registration exists before any page mounts (an edit in the
  // sidebar is still a knowledge-base edit), but only the page knows these two
  // values: the mount point comes from the Host's config, the identity from the
  // status call. Pushing them here is what lets the listener tell a knowledge-base
  // save from any other file's save and name the person who made it.
  useEffect(() => {
    if (kbRoot !== '') setMountPointResolver(() => kbRoot)
  }, [kbRoot])
  useEffect(() => {
    if (state.kind === 'ready' && state.status.caller !== undefined) {
      publishActor(state.status.caller.userId)
    }
  }, [state])

  const load = useCallback(async () => {
    try {
      const config = await readApi<KnowledgeConfigView>(KB_API.config)
      const status = await readApi<KnowledgeStatusView>(KB_API.status)
      setState({ kind: 'ready', config, status })
    } catch {
      setState({ kind: 'unavailable' })
    }
  }, [])

  useEffect(() => { void load() }, [load])

  // Declared above the early returns for the same reason as the subscription
  // above: a hook below them changes the hook count between renders. The mount is
  // empty until config arrives, which the hook reads as "nothing to search yet".
  const search = useKnowledgeSearch(state.kind === 'ready' ? state.config.mountPoint : '')

  /**
   * Whether the Host verified that this caller may manage grants.
   *
   * Read from the status the Host sent, never computed here: the permission is the
   * backend's to decide, and a browser-side test would govern rendering while the
   * check that matters lives in DataOps. `!== true` rather than a truthy test so a
   * missing field on an older Host hides the surface instead of showing it.
   *
   * Derived above the early returns so the refusal effect below can be declared
   * alongside the other hooks; a hook after them would change the hook count
   * between renders and abort the subtree.
   */
  const permissionKeys = state.kind === 'ready' ? state.status.permissions : undefined
  const hasPermission = (key: string): boolean =>
    permissionKeys === undefined ? true : permissionKeys.includes(key)
  const canSeeHome = permissionKeys === undefined || hasPermission('kb:file:read')
  // Memory is part of the knowledge base's own read surface: anyone who may read
  // the tree may see and manage their own memory page.
  const canSeeMemory = permissionKeys === undefined || hasPermission('kb:file:read')
  const canSeeTrash = permissionKeys === undefined || hasPermission('kb:file:delete')
  const canSeeAudit = permissionKeys === undefined || hasPermission('kb:audit:read')
  const canSeeSettings = permissionKeys === undefined || hasPermission('kb:config:manage')
    && (permissionKeys === undefined || hasPermission('kb:grant:manage'))

  /**
   * The caller's own organization chain, for labelling the department folders.
   *
   * Resolved once here rather than inside the tree: the tree is a pure renderer over
   * paths, and the profile lives on the status the page already loaded. Kept as a
   * single object (rather than two separate values) so the tree receives one optional
   * prop and an un-upgraded backend — which reports neither array — simply omits it,
   * leaving the folders to print their codes exactly as before.
   */
  /**
   * Report a drop that had no safe destination.
   *
   * Shown as a failed row in the progress strip rather than swallowed: the reader
   * dragged a file and is watching for it to appear, and "nothing happened" is the one
   * outcome that gives them nothing to act on. The reason names the missing fact.
   */
  const reportDropRefused = useCallback((): void => {
    setUploadTasks([{ name: t('dropRefusedNoCaller'), dir: '', state: 'failed', reason: t('dropRefusedNoCallerReason') }])
  }, [t])

  /**
   * The id the Host reports for this caller, used to place a drop in `personal`.
   *
   * The view hides the owner segment, so a tree row carries `personal`; every write has
   * to put the id back. Kept as one value so the three drop entry points cannot disagree.
   */
  const callerId = state.kind === 'ready' ? state.status.caller?.userId : undefined

  const callerPath = useMemo((): { codes: readonly string[]; names: readonly string[] } | undefined => {
    const caller = state.kind === 'ready' ? state.status.caller : undefined
    const codes = caller?.departmentPathCodes
    const names = caller?.departmentPathNames
    if (codes === undefined || names === undefined) return undefined
    // Index-aligned by contract; a mismatch would label a row with another
    // department's name, so it is treated as "no translation" instead.
    if (codes.length === 0 || codes.length !== names.length) return undefined
    return { codes, names }
  }, [state])

  /**
   * The caller's pins, read from their own view directory through the Host.
   *
   * Declared here, above the early returns, for the same reason the subscription
   * and the search hook are: a hook below them changes the hook count between
   * renders and aborts the subtree. Gated on the mount being known so the first
   * render does not post a request naming a tree that does not exist yet.
   */
  const pins = usePinnedPaths(state.kind === 'ready' && state.config.mountPoint !== '')

  /**
   * The caller's favourites, read from their own view directory.
   *
   * Gated on the mount being known for the same reason the pins are: a favourites
   * request before the view exists would name a tree that is not there yet.
   */
  const favorites = useFavorites(state.kind === 'ready' && state.config.mountPoint !== '')

  /** The caller's list/grid preference, read from their own view directory. */
  // The layout preference is no longer switchable (the reader does not change views), so
  // the rail keeps one mode. The hook is retained rather than inlined because the stored
  // value still has to be READ: a reader who once chose the explorer keeps it.
  // Knowledge base always uses the Better Sidebar explorer; list/grid are no longer offered.
  const viewMode: { mode: 'list' | 'grid' | 'explorer' } = { mode: 'explorer' }
  /** The tree's row order, remembered in this browser (see `useTreeSort`). */
  const sort = useTreeSort(state.kind === 'ready' ? state.config.mountPoint : '')

  /**
   * The row context menu for the surfaces THIS component owns.
   *
   * One instance for the whole page rather than one per surface: the home table and the
   * tree must offer the same actions, and two instances would be two places to keep in
   */
  /** The cut/copied entry, shared by both surfaces so a copy on one pastes on the other. */
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null)

  /**
   * The knowledge tree's own row menu.
   *
   * Held here rather than inside `KnowledgeFileTree` because the menu outlives the row
   * that opened it: the explorer re-renders rows on every refresh, and a menu owned by a
   * row would unmount mid-interaction. `selection` is present only when the right-click
   * landed inside a multi-selection; the menu decides whether each entry is a batch one
   * from that list.
   */
  const [treeMenu, setTreeMenu] = useState<{
    target: ContextTarget
    at: { x: number; y: number }
    selection?: readonly ContextTarget[]
  } | null>(null)

  /**
   * Remember that the reader asked to extract one document.
   * @param relPath - the document, tree-relative.
   */
  const noteExtractionRequested = useCallback((relPath: string): void => {
    setOptimisticExtractions(current => [
      // Replacing an existing entry for the same path rather than appending: two clicks on
      // one document are one task, not two rows.
      ...current.filter(entry => entry.relPath !== relPath),
      { relPath, requestedAt: Date.now() },
    ])
    // The badge and the panel both read this, so the count moves the instant the reader
    // clicks -- which is the whole point of the optimistic entry.
    setProgressRefresh(n => n + 1)
  }, [])

  /**
   * Report that an extraction request was refused, and withdraw the queued row.
   *
   * The failure goes to the progress panel, not to the page's batch-error line: an
   * extraction can fail long after the tree settled, and a sentence pinned under the
   * sidebar keeps claiming attention for the rest of the session. Recording it in the
   * session store is what lets the reader open 「进度」 and see the file, the readable
   * reason, and the raw reason side by side.
   * @param relPath - the document, in the authoritative path the request used.
   * @param reason - what the Host (or the transport) said.
   */
  const noteExtractionFailed = useCallback((relPath: string, reason: string): void => {
    setOptimisticExtractions(current => current.filter(entry => entry.relPath !== relPath))
    rememberExtractionFailure({ relPath, reason })
    setExtractionFailures(readExtractionFailures())
    setProgressRefresh(n => n + 1)
  }, [])

  /**
   * Paste the clipboard into one directory.
   *
   * The batch bar and the shared row menu both call this, so there is one implementation
   * of what "paste" means: a cut moves, a copy duplicates, and a cut clears the clipboard
   * once everything landed.
   * @param into - the tree-relative directory to paste into.
   */
  const pasteInto = useCallback(async (into: string): Promise<void> => {
    const clip = clipboard
    if (clip === null) return
    // Both ends of a move name the AUTHORITATIVE tree, not the view. The view hides the
    // owner segment of `personal` (`personal/<file>` is really `personal/<uid>/<file>`), so
    // passing a view path to `move` addresses a path that does not exist -- the route
    // answers 409 "source and destination are the same path", and the paste silently does
    // nothing. Resolving both ends through `resolveUploadDir` is what puts the id back.
    const destination = resolveUploadDir(into, callerId)
    if (destination === undefined) {
      setBatchError(t('dropRefusedNoCaller'))
      return
    }
    setBatchBusy(true)
    setBatchError(undefined)
    try {
      for (const entry of clip.entries) {
        const source = resolveUploadDir(entry.relPath, callerId)
        if (source === undefined) {
          setBatchError(t('dropRefusedNoCaller'))
          return
        }
        const response = await fetch(kbApiPath(clip.cut ? KB_API.move : KB_API.copy), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: source, to: destination }),
          cache: 'no-store',
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'HTTP ' + String(response.status))
        }
      }
      if (clip.cut) setClipboard(null)
      setSelectedPaths([])
    } catch (failure: unknown) {
      setBatchError(t('moveFailed').replace('{reason}', failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setBatchBusy(false)
      setRefreshTick(t => t + 1)
    }
  }, [clipboard, callerId, t])


  /**
   * The directory a paste would land in for one row.
   *
   * A folder pastes into itself; a file pastes beside itself. `''` is the tree root,
   * which is a real destination rather than "unknown".
   * @param relPath - the row the menu was opened on.
   * @param isDir - whether that row is a folder.
   * @returns The tree-relative destination directory.
   */
  const pasteTargetFor = (relPath: string, isDir: boolean): string =>
    isDir ? relPath : (relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '')

  /**
   * Move one tree row into a typed destination directory.
   *
   * Both ends are resolved through `resolveUploadDir`: the view hides the owner segment
   * of `personal`, and a move that sent the view path unchanged would address a path the
   * Host does not know. The menu owns the prompt and the close; this handler owns only
   * the request and its refusal.
   * @param row - the row the reader right-clicked.
   * @param destination - the tree-relative directory the reader typed.
   */
  const moveTreeRow = useCallback(async (row: ContextTarget, destination: string): Promise<void> => {
    const from = resolveUploadDir(row.relPath, callerId)
    const to = resolveUploadDir(destination, callerId)
    if (from === undefined || to === undefined) throw new Error(t('dropRefusedNoCaller'))
    const response = await fetch(kbApiPath(KB_API.move), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from, to }),
      cache: 'no-store',
    })
    const body = await readKnowledgeJson<{ error?: string }>(response)
    if (!response.ok || body.error !== undefined) {
      throw new Error(body.error ?? 'HTTP ' + String(response.status))
    }
  }, [callerId, t])

  /**
   * The rows the batch bar acts on.
   *
   * Held here rather than in the listing because two surfaces consume it: the tree
   * that fills it, and the bar that acts on it -- and the bar outlives the tree's
   * own render, since the listing is remounted when the refresh tick changes.
   */
  const [selectedPaths, setSelectedPaths] = useState<readonly string[]>([])
  /** Held while a batch move is in flight, so the same paths cannot be sent twice. */
  const [batchBusy, setBatchBusy] = useState(false)
  /** The last batch failure, shown where the bar is rather than as a page error. */
  const [batchError, setBatchError] = useState<string | undefined>(undefined)
  /**
   * Whether a knowledge row is being dragged right now.
   *
   * Tracked at the panel because the PIN drop target lives here while the rows that
   * start the drag live in the listing. A resting pin band cannot serve as that
   * target: it is hidden while the caller has pinned nothing, so on a fresh tree
   * there would be nowhere to drop. The strip appears only while a drag is in
   * flight, which leaves the resting rail exactly as the layout calls for and still
   * gives the gesture somewhere to land.
   *
   * It is armed by the drag's own MIME type rather than a flag the listing sets, so
   * a drag of anything else across this panel cannot arm the zone.
   */
  const [dragActive, setDragActive] = useState(false)
  /** The display-setting menu, opened from the section band's control. */
  const [sortMenuOpen, setSortMenuOpen] = useState(false)

  /**
   * The folder a batch move should target.
   *
   * A prompt rather than a drag for the batch case: dragging many rows into one
   * folder is a gesture with no clear target when the destination is collapsed, and
   * typing a path is what an operator managing grants already does elsewhere on this
   * page. The path is resolved against the mount point on the Host, which refuses
   * anything uncontained.
   */
  const promptBatchTarget = (): string | undefined => {
    const answer = window.prompt(t('moveSelected'))
    if (answer === null) return undefined
    const trimmed = answer.trim()
    return trimmed === '' ? undefined : trimmed
  }

  /**
   * Move every selected path into one folder, then re-read the tree.
   *
   * Sequential rather than parallel: each move resynchronizes the caller's view, and
   * two concurrent syncs over the same view would interleave their link and unlink
   * passes. The first refusal stops the batch and is reported, because a partial
   * batch reported as success would leave the reader believing every row moved.
   */
  const moveSelected = async (toDirectory: string): Promise<void> => {
    setBatchBusy(true)
    setBatchError(undefined)
    try {
      for (const from of selectedPaths) {
        const response = await fetch(kbApiPath(KB_API.move), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: toDirectory }),
          cache: 'no-store',
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          throw new Error(body.error ?? 'HTTP ' + String(response.status))
        }
      }
      setSelectedPaths([])
      setRefreshTick(n => n + 1)
    } catch (failure: unknown) {
      setBatchError(t('moveFailed').replace('{reason}', failure instanceof Error ? failure.message : String(failure)))
    } finally {
      setBatchBusy(false)
    }
  }

  /**
   * Move one row dropped onto a folder.
   *
   * The Host resolves the destination name from the source, so this sends the folder
   * rather than a full path: a caller cannot rename by dragging, which keeps the
   * gesture's authority to exactly "put it in there".
   */
  const moveOne = async (from: string, toDirectory: string): Promise<void> => {
    setBatchError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.move), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from, to: toDirectory }),
        cache: 'no-store',
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      setRefreshTick(n => n + 1)
    } catch (failure: unknown) {
      setBatchError(t('moveFailed').replace('{reason}', failure instanceof Error ? failure.message : String(failure)))
    }
  }

  // The rail only offers surfaces the backend permission keys allow; reset a surface
  // that was selected before a role change so it cannot linger as a dead end.
  useEffect(() => {
    if (canSeeTrash && canSeeAudit && canSeeSettings && canSeeHome && canSeeMemory) return
    setSelection(current => {
      if (current.kind === 'memory' && !canSeeMemory) return { kind: 'search' }
      if (current.kind === 'trash' && !canSeeTrash) return { kind: 'search' }
      if (current.kind === 'audit' && !canSeeAudit) return { kind: 'search' }
      if (current.kind === 'settings' && !canSeeSettings) return { kind: 'search' }
      if (current.kind === 'home' && !canSeeHome) return { kind: 'search' }
      return current
    })
  }, [canSeeAudit, canSeeHome, canSeeMemory, canSeeSettings, canSeeTrash])

  /**
   * Whether the selected document is being drawn by the host's file window.
   *
   * The knowledge page is a global panel and the host's right column survives it (see
   * the sidebar-right patch this plugin ships with), so a document opened from here is
   * rendered over there. In that state this column's own content region would only
   * hold a pointer sentence, and keeping it costs the reader the width the document
   * itself wants.
   */
  // Whether this page has handed a document to the reader's file window.
  //
  // This is a page-level intent: "the reader asked to read a file". It deliberately does
  // NOT consult the column's own expanded flag. That flag is the thing this page DRIVES
  // (open on select, close on leaving), so reading it back into the decision would make
  // the page's state depend on an effect it causes -- and it would keep the page in
  // preview mode while the reader was back on the list, suppressing the content column
  // and leaving the frame with a blank third track.
  // The page's own preview is always the visible surface; the host column, when it
  // exists, is allowed to show the same document beside it.
  const [openFailure, setOpenFailure] = useState<string | undefined>(undefined)
  // A selected document lives in the host's right-hand file window. When that window is
  // unavailable (`openInSidebar` answered anything but 'opened'), the page falls back to its
  // own preview column; the value is derived, never hardcoded, because the fallback has to
  // stay reachable on a host without the column.
  const documentInSidebar = selection.kind === 'file' && openFailure === undefined


  // Follow the host column's own expanded flag while a document is selected.
  //
  // The column exposes no change subscription for its expanded state -- the `subscribe`
  // it does expose belongs to the tab registry -- so the page polls it. The interval only
  // runs while a document is selected. This is what lets the reader close the file window
  // with the host's own control and still get their content column back: without it the
  // page never learns the column went away, keeps suppressing its content, and the frame
  // is left showing an empty middle column.
  const [columnExpanded, setColumnExpanded] = useState(true)
  // Opening the file window is asynchronous: the host may still report the collapsed
  // track for a poll or two while it reveals the column. Do not treat that transient as
  // a reader close, or selecting a document folds the window immediately.
  const [columnOpenedOnce, setColumnOpenedOnce] = useState(false)
  useEffect(() => {
    if (selection.kind !== 'file') return
    const read = (): void => {
      const next = readColumnExpanded(props.ctx)
      setColumnExpanded(next)
      if (next) setColumnOpenedOnce(true)
    }
    read()
    const timer = window.setInterval(read, 400)
    return () => { window.clearInterval(timer) }
  }, [selection.kind, props.ctx])
  useEffect(() => {
    if (!documentInSidebar) setColumnOpenedOnce(false)
  }, [documentInSidebar])
  // `openInSidebar` can answer 'opened' on a host that has the controller but no
  // session surface to render into: `openResource` returns without throwing, the
  // track never expands, and suppressing this column would leave a blank frame.
  // Give the host a moment to reveal the track; if it never does, fall back to the
  // page's own preview and say why instead of silently showing nothing.
  useEffect(() => {
    if (!documentInSidebar || columnOpenedOnce) return
    const timer = window.setTimeout(() => {
      if (!columnOpenedOnce) setOpenFailure('no-column')
    }, 2000)
    return () => { window.clearTimeout(timer) }
  }, [documentInSidebar, columnOpenedOnce])
  /** True while the reader is actually on screen holding this page's document. */
  const readerOnScreen = documentInSidebar && columnExpanded


  // Publish "the knowledge page has handed its content column to the reader" on the
  // document element. The host frame decides how wide the reader's track is, and it
  // cannot see this page's React state; a DOM attribute is the one channel both sides
  // share. The host's stylesheet keys the reader-wide layout off this attribute, so the
  // frame changes at the same instant the content column disappears -- no state left
  // behind when the reader navigates back to the list.
  useEffect(() => {
    const root = document.documentElement
    if (readerOnScreen) root.setAttribute('data-kb-reader-open', '')
    else root.removeAttribute('data-kb-reader-open')
    return () => { root.removeAttribute('data-kb-reader-open') }
  }, [readerOnScreen])

  // Hand the frame back when the reader leaves the document.
  //
  // The two states need different frames: a document is read in the host's file window
  // on the right and the page's own content column yields to it, while every other
  // surface (home, permissions, trash, settings) needs that column back. Without this
  // the column would stay open after the reader navigated away, and the page would keep
  // yielding width to a window that no longer shows anything of this document.
  //
  // Kept ABOVE the loading/unavailable early returns on purpose: a hook below one of
  // those runs only on renders that get past it, so the loading render and the loaded
  // render would disagree about how many hooks exist. React reports that as error #310
  // and unmounts the boundary.
  useEffect(() => {
    // This panel draws the preview itself (`documentInSidebar` is false), so there is no host
    // frame to hand back. Running the hand-back below on every render both closed a frame this
    // surface does not own and reset a just-selected file to home, which looked like the preview
    // flashing open and collapsing in the same paint.
    if (!documentInSidebar) return
    if (readerOnScreen) return
    // A selected document has not finished opening yet; the host's collapsed track is
    // not a user close. Wait until the column has been seen expanded at least once.
    if (documentInSidebar && !columnOpenedOnce) return
    closeSidebar(props.ctx)
    // A reader who closes the file window leaves the document behind; send them back
    // to the knowledge home rather than to whatever list they opened it from. Only acts
    // on a file selection, so ordinary rail clicks are untouched.
    setSelection(current => (current.kind === 'file' ? (canSeeHome ? { kind: 'home' } : { kind: 'search' }) : current))
  }, [documentInSidebar, columnExpanded, columnOpenedOnce, props.ctx, canSeeHome])

  if (state.kind === 'loading') {
    // Localised and animated: the hardcoded English sentence was the only loading
    // copy in the surface that never reached the dictionary.
    return (
      <div className={styles.page}>
        <KnowledgeLoading label={t('loading')} announce={t('loading')} />
      </div>
    )
  }
  if (state.kind === 'unavailable') {
    return (
      <div className={styles.page}>
        {/* This screen exists because the page could not reach its Host, so it
            deliberately depends on nothing that the failing load would have
            provided -- including the primitive layer. The copy is still read
            from this plugin's own dictionary, and the glyph is inline, so the
            failure reads as a product state rather than a raw English error. */}
        <div className={styles.errorPanel} role="alert">
          <span className={styles.errorGlyph} aria-hidden="true">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7.5v5.5" />
              <path d="M12 16.5h.01" />
            </svg>
          </span>
          <h2 className={styles.errorTitle}>{t('unavailable')}</h2>
          <p className={styles.errorDetail}>{t('unavailableDetail')}</p>
          <button type="button" className={styles.retry} onClick={() => { void load() }}>{t('retry')}</button>
        </div>
      </div>
    )
  }

  const { config, status } = state

  /**
   * Ask where a reference should go, for every surface that offers one.
   *
   * Always the dialog -- never a direct insert. The direct path was the bug: with a
   * conversation open (the ordinary case) it called `referenceInChat` and returned, so
   * `setReferencing` was never reached and the picker never opened; the insert itself
   * then failed inside `referenceInChat` because this page's ctx lacked the `sessions`
   * injection, and a `try/catch` there turned that into a `console.warn` nobody read.
   * The reader saw a click with no effect.
   *
   * The dialog's first row is the current conversation, so the one-click gesture is
   * preserved; what it adds is the reader seeing where the reference will land.
   */
  const askReferenceTarget = (
    relPath: string,
    isDir: boolean,
    targets?: readonly { relPath: string; isDir: boolean }[],
  ): void => {
    const mount = config.mountPoint
    setReferencing({
      path: joinPath(mount, relPath),
      isDir,
      targets: targets === undefined
        ? undefined
        : targets.map(entry => ({ path: joinPath(mount, entry.relPath), isDir: entry.isDir })),
    })
  }



  /**
   * The rail's menu rows, in order, with the copy key each renders.
   *
   * Search is deliberately absent: it is the page's leading action and now
   * renders as the rail's own input above this list, because a row that merely
   * selected a search surface made the reader click twice to type one term.
   *
   * Permissions is absent for a caller who may not manage grants. Hiding the row is
   * not by itself the rule -- the content region below refuses the surface and the
   * listing's grant entry is withdrawn -- but a row that opens a refused surface is
   * a dead end, so it is not offered either.
   */
  const SECTIONS = [
    ...(canSeeHome ? [{ kind: 'home', key: 'menu.home' }] as const : []),
    ...(canSeeMemory ? [{ kind: 'memory', key: 'menu.memory' }] as const : []),
    ...(canSeeTrash ? [{ kind: 'trash', key: 'menu.trash' }] as const : []),
    ...(canSeeAudit ? [{ kind: 'audit', key: 'menu.audit' }] as const : []),
    ...(canSeeSettings ? [{ kind: 'settings', key: 'menu.settings' }] as const : []),
  ] as const

  const rendered: Selection = selection

  return (
    <div className={styles.page}>
      <div className={
        styles.body
        + (folded ? ' ' + styles.bodyCollapsed : '')
        // A document is shown in the host's file window on the right, so this
        // column has nothing left to draw for it. Collapsing it hands the width back
        // to that window instead of leaving a column that only repeats "opened over
        // there" -- the notice is a fallback for a host without the column, not a
        // resting state for this one.
        + (documentInSidebar ? ' ' + styles.bodyDocument : '')
      }>
      <aside className={styles.rail}>
        {/* The rail's own top line, and the page's top-left corner. The header
            below covers only the content column, so this row is what occupies the
            rail's first 36px and keeps the brand reachable when the rail folds. */}
        <div className={styles.railTop}>
          <span className={styles.railBrand}>
            <KnowledgeMenuBrand folded={folded} />
            {!folded && <span className={styles.railBrandName}>{t('brand')}</span>}
          </span>
          <span className={styles.railTopSpacer} />
          <KnowledgeIconButton
            label={t(folded ? 'expandRail' : 'collapseRail')}
            pressed={folded}
            onClick={() => {
              setFolded((current) => {
                writeFolded(!current)
                return !current
              })
            }}
          >
            <IconPanelLeftOutline16 size={16} />
          </KnowledgeIconButton>
        </div>
        {/* The search field, above the menu rows rather than among them: it takes
            text, so it is the one control in this rail that is not a destination.
            Selecting it moves the content region to the results. Hidden while
            folded, where the strip has no room for a field. */}
        {!folded && (
          <div className={styles.searchBox}>
            <Input
              type="search"
              value={search.term}
              icon={<IconSearchOutlineRegular size={16} />}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              onFocus={() => { setSelection({ kind: 'search' }) }}
              onChange={(event) => {
                search.setTerm(event.target.value)
                setSelection({ kind: 'search' })
              }}
              onKeyDown={(event) => {
                search.onKeyDown(event)
                // Enter opens the highlighted row here rather than in the field's
                // own handler, which only knows how to move the highlight.
                if (event.key === 'Enter') {
                  const hit = search.hits[search.active]
                  if (hit !== undefined) {
                    event.preventDefault()
                    openDocument(hit.relPath)
                  }
                }
              }}
            />
          </div>
        )}
        {/* Native buttons rather than `Button`/`MenuItemButton`: these rows carry
            the sidebar's own row contract (`min-height:36px`, `padding:7px 8px`,
            `--dsw-radius-md`, one hover fill for both hover and selected). That is
            a row-shaped control the primitive set does not render, and the sidebar
            it is modelled on uses bare elements for the same reason. */}
        <nav className={folded ? styles.menuFolded : styles.menu} aria-label={t('menu')}>
          {SECTIONS.map((section) => {
            const active = rendered.kind === section.kind
            return (
              <button
                key={section.kind}
                type="button"
                className={active ? styles.menuRowActive : styles.menuRow}
                aria-current={active ? 'page' : undefined}
                // The strip keeps the glyph and drops the label, so the accessible
                // name has to travel on the button rather than in a hidden span.
                {...(folded ? { 'aria-label': t(section.key), title: t(section.key) } : {})}
                onClick={() => {
                  // The graph tab owns a separate `scope`; selecting a rail section must
                  // leave that mode or every section stays hidden behind the canvas.
                  setScope('kb')
                  setSelection({ kind: section.kind } as Selection)
                }}
              >
                <span className={styles.menuGlyph}>
                  {section.kind === 'memory'
                    ? <IconLightOutline16 size={16} />
                    : sectionGlyph(section.kind)}
                </span>
                {!folded && <span className={styles.menuLabel}>{t(section.key)}</span>}
              </button>
            )
          })}
        </nav>
        {!folded && (
        <div
          className={styles.railBody}
          // The drag's own payload type arms the pin strip: the listing sets it on
          // start and clears it on end, so the zone is live exactly while a row is
          // being carried and never for any other drag crossing the page.
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes(KB_DRAG_MIME)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDragActive(true)
          }}
          onDragLeave={(event) => {
            // Only when the pointer has actually left the rail: moving between two
            // rows inside it fires leave-then-over, and clearing unconditionally
            // would flicker the strip off under the pointer.
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
            setDragActive(false)
          }}
          onDrop={(event) => {
            setDragActive(false)
            if (!event.dataTransfer.types.includes(KB_DRAG_MIME)) return
            event.preventDefault()
          }}
        >
          {/* The pin drop zone. It appears only while a row is being dragged: the
              resting band is hidden when nothing is pinned (a titled empty region
              would take a line from the tree), so a drag needs its own target or
              pinning by drag would be unreachable on a fresh tree. Dropping here
              pins; dropping on a folder row moves, which is the distinction the two
              targets carry. */}
          {dragActive && (
            <div
              className={listingStyles.pinDropZone}
              data-testid="kb-pin-drop-zone"
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(KB_DRAG_MIME)) return
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              }}
              onDrop={(event) => {
                event.preventDefault()
                setDragActive(false)
                try {
                  const raw = event.dataTransfer.getData(KB_DRAG_MIME)
                  const parsed = JSON.parse(raw) as { relPath?: unknown }
                  if (typeof parsed.relPath === 'string') pins.setPinned(parsed.relPath, true)
                } catch {
                  // A payload this surface cannot read is not a drop it should
                  // honour: the row simply stays where it was.
                }
              }}
            >
              {t('pinSelected')}
            </div>
          )}
          {/* The pinned band sits above the tree, inside the rail's own 8px inset
              so its rows line up with the tree's. The whole band is hidden when
              the caller has pinned nothing: an empty "置顶" title would name a
              region with no content and take a line from the tree. */}
          {pins.relPaths.length > 0 && (
            <section className={styles.pinnedBand} aria-label={t('sectionPinned')}>
              <KnowledgeSectionHeader
                name={t('sectionPinned')}
                actions={(
                  <KnowledgeIconButton
                    label={t('sectionPinned')}
                    pressed={pinnedOpen}
                    onClick={() => { setPinnedOpen(current => !current) }}
                  >
                    {pinnedOpen
                      ? <IconChevronUpOutline14 size={16} />
                      : <IconChevronDownOutlineRegular size={16} />}
                  </KnowledgeIconButton>
                )}
              />
              {pinnedOpen && (
                <KnowledgeListing
                  t={t}
                  locale={props.locale}
                  refreshTick={refreshTick}
                  onRenamed={() => { setRefreshTick(t => t + 1) }}
                  expandAll
                  unpinOnly
                  pinnedPaths={pins.relPaths}
                  isPinned={pins.has}
                  onPin={(path, pinned) => { pins.setPinned(path, pinned) }}
                  onOpen={(path) => { openDocument(path) }}
                  onReference={(path, isDir) => { askReferenceTarget(path, isDir) }}
                />
              )}
            </section>
          )}
          <section className={styles.treeBand} aria-label={scope === 'graph' ? t('scopeGraph') : t('sectionKnowledge')}>
            <KnowledgeSectionHeader
              name={(
                <KnowledgeScopeTabs
                  value={scope}
                  onChange={setScope}
                  label={t('sectionKnowledge')}
                  knowledgeLabel={t('scopeKnowledge')}
                  graphLabel={t('scopeGraph')}
                />
              )}
              actions={(
                <>
                  <KnowledgeIconButton
                    label={t('actionFilter')}
                    pressed={filterOpen}
                    onClick={() => {
                      setFilterOpen((current) => {
                        // Closing the control clears the narrowing: a filter that
                        // is invisible but still applied would hide rows with no
                        // visible cause.
                        if (current) setActiveFilter('')
                        return !current
                      })
                    }}
                  >
                    <IconSearchOutlineRegular size={16} />
                  </KnowledgeIconButton>
                  {/* ONE menu on the FIRST slider, holding the two things that change how
                      the tree READS: its order, then its filter.

                      This REPLACES the filter button that used to sit here; it does not add
                      a control. The previous attempt put a second sliders button beside the
                      new-document one, which left the toolbar with two identical glyphs and
                      is exactly what the reader rejected. The filter action itself is not
                      lost -- it moved down into this menu as its own row, so the band still
                      carries the same number of 28px buttons.

                      The old view-mode switcher also lived here; the reader does not switch
                      views, so it is gone. `useViewMode` is still read (see below) so a
                      preference already stored keeps applying. */}
                  <Menu
                    open={sortMenuOpen}
                    anchor={(
                      <KnowledgeIconButton
                        label={t('actionSortAndFilter')}
                        pressed={sortMenuOpen}
                        onClick={() => { setSortMenuOpen(current => !current) }}
                      >
                        <IconSettingsOutline16 size={16} />
                      </KnowledgeIconButton>
                    )}
                    onClose={() => { setSortMenuOpen(false) }}

                  >
                    <span className={styles.menuGroupLabel}>{t('sortHeading')}</span>
                    {TREE_SORT_KEYS.map(key => (
                      <MenuItemButton
                        key={key}
                        icon={sort.key === key
                          ? <IconCheckOutline16 size={16} />
                          : <span />}
                        onSelect={() => {
                          sort.setKey(key)
                          setSortMenuOpen(false)
                        }}
                      >
                        {key === 'mtime' ? t('sortByMtime')
                          : key === 'name' ? t('sortByName')
                            : key === 'size' ? t('sortBySize')
                              : t('sortByType')}
                      </MenuItemButton>
                    ))}
                    {/* A separator, not a second control: sorting and filtering are two
                        halves of one question, and splitting them across two icons is what
                        produced the duplicate toolbar in the first place. */}
                    <span className={styles.menuSeparator} aria-hidden="true" />
                    <span className={styles.menuGroupLabel}>{t('filterHeading')}</span>
                    <MenuItemButton
                      icon={filterOpen || activeFilter !== ''
                        ? <IconCheckOutline16 size={16} />
                        : <span />}
                      onSelect={() => {
                        // The behaviour the first slider had on click, now a row in the
                        // menu: opening the in-place narrowing the search glyph also uses.
                        setFilterOpen(true)
                        setSortMenuOpen(false)
                      }}
                    >
                      {t('actionFilter')}
                    </MenuItemButton>
                  </Menu>
                  <KnowledgeIconButton
                    label={t('actionNew')}
                    onClick={() => { setSelection({ kind: 'home' }) }}
                  >
                    <IconPlusOutlineRegular size={16} />
                  </KnowledgeIconButton>
                </>
              )}
            />
            {filterOpen && (
              <div className={styles.treeFilter}>
                <Input
                  type="search"
                  value={activeFilter}
                  icon={<IconSearchOutlineRegular size={16} />}
                  placeholder={t('filterPlaceholder')}
                  aria-label={t('filterPlaceholder')}
                  autoFocus
                  onChange={(event) => { setActiveFilter(event.target.value) }}
                />
              </div>
            )}
            <div className={styles.treeScroll}>
              {scope === 'graph' && (
                <KnowledgeGraphTree
                  state={graph}
                  t={t}
                  {...(activeGraphId === undefined ? {} : { activeGraphId })}
                  {...(activeTopicId === undefined ? {} : { activeTopicId })}
                  filter={graphFilter}
                  onSelectGraph={selectGraph}
                  onSelectTopic={selectTopic}
                  onRetry={() => { void graph.reload() }}
                />
              )}
              {scope !== 'graph' && (config.mountPoint === ''
                ? <p className={styles.muted}>{t('mountPointMissing')}</p>
                : viewMode.mode === 'explorer' ? (
                  // The product's own file explorer, pointed at the knowledge root.
                  //
                  // This is the tree from the workspace sidebar itself, not a copy of it:
                  // `KnowledgeFileTree` renders `FileTree` from `dsh-better-sidebar`, whose
                  // cwd is a plain absolute path. `/workspace/kb` is a symlink into the
                  // caller's view, so the explorer reads the knowledge tree through the
                  // same fs API it uses for any other directory -- measured with
                  // `POST /sidebar/api/fs.trees {cwd:'/workspace/kb'}`, which answers the
                  // tree's entries. It brings sort, inline rename, drag-and-drop and the
                  // upload strip, none of which a hand-built copy would keep in step.
                  //
                  // The listing beside it remains the default because it shows knowledge
                  // state the explorer has no concept of: whether a row is readable, its
                  // pinned mark, and multi-select for a batch grant.
                  <KnowledgeFileTree
                    sessionId={explorerSessionId}
                    // The three buckets name an AUDIENCE, not a path: the folders on
                    // disk are global/department/personal, and renaming them would
                    // change the shared layout the view is built from. Only these
                    // three paths carry a label; everything below is a document the
                    // reader named.
                    locale={props.locale}
                    bucketLabels={{
                      global: t('bucketGlobal'),
                      department: t('bucketDepartment'),
                      personal: t('bucketPersonal'),
                    }}
                    // The department bucket's folders are named on disk by CODE, which
                    // is what makes a department rename unable to move a document. The
                    // reader knows their organization by NAME, so the caller's own chain
                    // is translated for display. This is passed only when the backend
                    // reported a usable chain: without it the folders keep showing their
                    // codes, which is the pre-hierarchy behaviour rather than a broken
                    // label. The root row is not in the map, so 「部门」 keeps its
                    // audience name.
                    departmentPath={callerPath === undefined
                      ? undefined
                      : { codes: callerPath.codes, names: callerPath.names }}
                    root={kbRoot}
                    expanded={explorerExpanded}
                    revealed={[]}
                    onToggle={(path) => {
                      // The hook owns both halves: it updates what the tree renders and
                      // coalesces the save, so a reader opening four levels produces one
                      // write rather than four.
                      treeState.toggle(path)
                    }}
                    onOpenFile={(path) => {
                      // The explorer speaks absolute paths; the page keys previews by the
                      // tree-relative path every other surface uses.
                      openDocument(relativeToRoot(kbRoot, path))
                    }}
                    onReferenceFile={(path, isDir) => {
                      // ALWAYS ask, even with a conversation open.
                      //
                      // This used to insert straight into the current session and
                      // `return`, which made the button look dead: with a conversation
                      // open (the ordinary case) `setReferencing` was never reached, so
                      // the picker's `open` stayed false; and the insert it took instead
                      // failed inside `referenceInChat` -- this page's `ctx` has no
                      // `sessions` inject -- where a `try/catch` turned it into a
                      // `console.warn`. Nothing above it read the result, so the click
                      // had no visible effect at all.
                      //
                      // The dialog still offers the current conversation as one click
                      // (its first row), so the shortcut is preserved; what it adds is
                      // the reader seeing where the reference is going, which is the
                      // part that was missing.
                      setReferencing({ path, isDir })
                    }}
                    onUploadRequest={(dir, items) => {
                      // `dir` arrives absolute under the mount; the view calls the personal
                      // bucket plain `personal`, so the owner segment has to be put back
                      // before anything is written.
                      const viewRel = relativeToRoot(kbRoot, dir)
                      const target = resolveUploadDir(viewRel, callerId)
                      if (target === undefined) {
                        // Refused rather than written to `personal` bare: that path is
                        // invisible in the view, so a silent write would look like a
                        // successful upload the reader can never find.
                        reportDropRefused()
                        return
                      }
                      void uploadInto(kbRoot, target === '' ? kbRoot : joinPath(kbRoot, target), items)
                    }}
                    // A drop during an upload is ignored rather than queued: two batches
                    // writing the same folder at once would interleave their progress
                    // rows and make the strip's counts meaningless.
                    busy={uploadBusy}
                    refreshTick={refreshTick}
                    onPathRenamed={() => { setRefreshTick(t => t + 1) }}
                    // The same favourites the home table reads, so one file shows its
                    // star in both places instead of each surface keeping its own set.
                    isFavorite={favorites.has}
                    onToggleFavorite={(relPath, next) => { favorites.setFavorite(relPath, next) }}
                    // The page owns the row menu, the share dialog and the clipboard, so the tree
                    // and the table offer one action set rather than two that can drift.
                    onRowContextMenu={(target, at, selection) => {
                      setTreeMenu({ target, at, ...(selection === undefined ? {} : { selection }) })
                    }}
                    onShare={(relPath) => { setShareTarget(relPath) }}
                    onClipboard={(entry) => { setClipboard(entry) }}
                    hasClipboard={clipboard !== null}
                    onPasteInto={(directory) => { void pasteInto(directory) }}
                    // The caller's id, so the tree can turn the view path a row carries
                    // (`personal/<file>`) into the authoritative one the Host reads
                    // (`personal/<uid>/<file>`). Without it every extraction of a personal
                    // document answered 404 "no such file" for a file that was right there.
                    callerId={callerId}
                    // A manual extraction is the one case the progress panel cannot see
                    // coming: it polls only while it already knows about pending work.
                    onExtractionQueued={noteExtractionRequested}
                    onExtractionFailed={noteExtractionFailed}
                    // The ordering the reader chose in the header menu. The explorer owns
                    // the comparators; this only says which one to use.
                    sort={{ key: sort.key === 'mtime' || sort.key === 'size' ? 'name' : sort.key, dirsFirst: true }}
                    // The same term the filter field holds, applied to the explorer's own
                    // rows. This mode used to ignore it silently: the field opened, typing
                    // changed nothing, and the reader had no way to tell why.
                    nameFilter={treeFilter}
                    favoriteMarkLabel={t('favoriteMark')}
                  />
                ) : (
                  // The plugin's own listing rather than the borrowed tree.
                  //
                  // The borrowed tree renders icon and name only and builds its context
                  // menu inside itself, so it has nowhere to show whether a row is
                  // readable and nowhere to add a grant entry. What its menu offers
                  // instead (rename, delete, upload, drag-and-drop) are edits to a
                  // shared, curated store, which is not what this page is for: the page
                  // decides who may see a document, and the preview reads one. The `@`
                  // reference is kept, being the one action a reader wants from here.
                  <KnowledgeListing
                    t={t}
                    locale={props.locale}
                    // A desktop file dropped on a directory row uploads there. Paths
                    // arrive relative to that row, which is what `uploadInto` appends
                    // to the row's own path.
                    onUpload={(relPath, files) => {
                      // The row's own path, with the owner segment restored for `personal`.
                      // A root-level drop has no row of its own, so `relPath` is '' and the
                      // target is the mount root.
                      const target = resolveUploadDir(relPath, callerId)
                      if (target === undefined) {
                        reportDropRefused()
                        return
                      }
                      void uploadInto(kbRoot, target === '' ? kbRoot : joinPath(kbRoot, target), files as never)
                    }}
                    refreshTick={refreshTick}
                    onRenamed={() => { setRefreshTick(t => t + 1) }}
                    filter={treeFilter}
                    viewMode={viewMode.mode === 'grid' ? 'grid' : 'list'}
                    selection={selectedPaths}
                    onSelectionChange={setSelectedPaths}
                    isPinned={pins.has}
                    onPin={(path, pinned) => { pins.setPinned(path, pinned) }}
                    onMove={(from, to) => { void moveOne(from, to) }}
                    onOpen={(path) => { openDocument(path) }}
                    onReference={(path, isDir) => { askReferenceTarget(path, isDir) }}
                    // An empty tree offers the way to make a document. It does not
                    // create one: there is no create route, and a button that
                    // silently did nothing would be worse than none. It navigates to
                    // the surface where creating will live.
                    emptyAction={(
                      // NAVIGATION, not creation: this plugin has no create route, so
                      // pressing this opens Home and focuses the New card rather than
                      // making a document. The label names what the reader is going to
                      // do; the action takes them to where it happens. A control that
                      // appeared to create and silently did nothing would be worse than
                      // one that visibly navigates.
                      <Button
                        variant="outline"
                        onClick={() => {
                          setFocusNew(true)
                          setSelection({ kind: 'home' })
                        }}
                      >
                        {t('actionNew')}
                      </Button>
                    )}
                  />
                ))}
              {/* The batch bar closes the tree's own scroll container, so it sits
                  below every row rather than over them and never shifts the tree the
                  way a top bar would. It appears only while rows are selected: an
                  always-present toolbar would take a line from the tree to offer
                  actions with nothing to act on. */}
              {selectedPaths.length > 0 && (
                <KnowledgeSelectionBar
                  t={t}
                  count={selectedPaths.length}
                  busy={batchBusy}
                  onMove={() => {
                    const target = promptBatchTarget()
                    if (target !== undefined) void moveSelected(target)
                  }}
                  onPin={() => {
                    for (const path of selectedPaths) pins.setPinned(path, true)
                    setSelectedPaths([])
                  }}
                  // The actions that used to be reached by right-clicking a row. The
                  // explorer's own menu cannot be extended, so they live here instead
                  // of replacing it.
                  allPinned={selectedPaths.length > 0 && selectedPaths.every(path => pins.has(path))}
                  allFavorite={selectedPaths.length > 0 && selectedPaths.every(path => favorites.has(path))}
                  onFavorite={() => {
                    const all = selectedPaths.every(path => favorites.has(path))
                    for (const path of selectedPaths) favorites.setFavorite(path, !all)
                    setSelectedPaths([])
                  }}
                  onReference={() => {
                    const first = selectedPaths[0]
                    if (first === undefined) return
                    askReferenceTarget(
                      first,
                      false,
                      selectedPaths.map(path => ({ relPath: path, isDir: false })),
                    )
                  }}
                  onCut={() => {
                    setClipboard({
                      entries: selectedPaths.map(path => ({ relPath: path, name: path.split('/').pop() ?? path })),
                      cut: true,
                    })
                    setSelectedPaths([])
                  }}
                  onPaste={() => {
                    // Paste lands in the directory shared by the selection; a selection
                    // spanning two directories has no single destination, so the first
                    // row's directory is used and the bar states the count.
                    const first = selectedPaths[0]
                    if (first === undefined) return
                    const cut = first.lastIndexOf('/')
                    const into = cut === -1 ? '' : first.slice(0, cut)
                    const clip = clipboard
                    if (clip === null) return
                    void (async () => {
                      setBatchBusy(true)
                      try {
                        for (const entry of clip.entries) {
                          const response = await fetch(kbApiPath(clip.cut ? KB_API.move : KB_API.copy), {
                            method: 'POST',
                            headers: { 'content-type': 'application/json' },
                            body: JSON.stringify({ from: entry.relPath, to: into }),
                            cache: 'no-store',
                          })
                          if (!response.ok) {
                            const body = (await response.json().catch(() => ({}))) as { error?: string }
                            throw new Error(body.error ?? 'HTTP ' + String(response.status))
                          }
                        }
                        if (clip.cut) setClipboard(null)
                        setSelectedPaths([])
                        setRefreshTick(t => t + 1)
                      } catch (failure: unknown) {
                        setBatchError(t('moveFailed').replace('{reason}', failure instanceof Error ? failure.message : String(failure)))
                        setRefreshTick(t => t + 1)
                      } finally {
                        setBatchBusy(false)
                      }
                    })()
                  }}
                  canPaste={clipboard !== null && selectedPaths.length > 0}
                  onClear={() => { setSelectedPaths([]) }}
                />
              )}
              {batchError !== undefined && (
                <p className={styles.muted} role="alert">{batchError}</p>
              )}
            </div>
          </section>
        </div>
        )}
      </aside>
      {!readerOnScreen && (
        <div className={styles.contentColumn}>
          {/* The header covers only the content column now, so the rail keeps its
              own top-left corner. It still states what this surface is and which
              tree it governs, once for the page. */}
          {scope === 'graph' ? null : <header className={styles.header}>
            <h2 className={styles.headerTitle}>
              {sectionTitle(t, rendered)}
            </h2>
            {/* The fact is the second item on the title's own line, not a line under it:
                the page names itself and says how big the tree is in one glance. It is
                allowed to shrink and ellipsize; the title and the actions keep their
                natural width. */}
            {/* Always rendered: the progress bell is a panel-level entry that must
                survive every section, so the row cannot depend on a page action.
                Note the bell disappears while a document is open in the right-hand
                window, because `contentColumn` itself is conditional (`!readerOnScreen`)
                -- moving it out would mean lifting it to the `styles.body` layer, which
                is a structural change nobody has asked for yet. */}
            <div className={styles.headerActions}>
              <KnowledgeProgressPopover
                t={t}
                headless
                uploads={uploadTasks}
                watchExtraction={config.mountPoint !== ''}
                refreshSignal={progressRefresh}
                optimistic={optimisticExtractions}
                failures={extractionFailures}
                onRetried={(relPath) => {
                  // The Host accepted the retry, so its own task is now the authority
                  // for this path and the recorded refusal must stop shadowing it.
                  forgetExtractionFailure(relPath)
                  setExtractionFailures(readExtractionFailures())
                  setRefreshTick(t => t + 1)
                  // A retry is also a manual queue: same reason as the menu's entry.
                  setProgressRefresh(n => n + 1)
                }}
              />
              {pageAction}
            </div>
            {/* Only for the state the reader can act on: the pointer resolves itself,
                and saying so keeps them from hunting for the rebuild button. Its own
                full-width line, because it is a sentence rather than a header fact. */}
            {status.mountState === 'pointer-missing' && (
              <p className={styles.headerHint}>{t('viewNotBuiltHint')}</p>
            )}
          </header>}
          <section
            className={styles.content}
            // The canvas owns the whole column: its pan surface must not be inset by
            // the document column's reading padding, and the page itself already
            // draws the graph's header facts.
            style={scope === 'graph'
              ? { padding: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }
              : undefined}
          >
            {selection.kind === 'file' && openFailure !== undefined && (
              <div className={styles.openFailure} role="alert">
                <strong>{t('openFailureTitle')}</strong>
                <span>{t('openFailureBody')}</span>
              </div>
            )}
            {scope === 'graph' && (
              <KnowledgeGraphView
                state={graph}
                t={t}
                {...(activeGraphId === undefined ? {} : { activeGraphId })}
                {...(activeTopicId === undefined ? {} : { activeTopicId })}
                onRetry={() => { void graph.reload() }}
                onOpenDocument={(path) => { void openDocument(path) }}
                onOpenSourceGraph={selectTopic}
              />
            )}
            {scope !== 'graph' && rendered.kind === 'home' && (
              <KnowledgeHome
                t={t}
                locale={props.locale}
                sessionId={explorerSessionId}
                mountPoint={config.mountPoint}
                sort={{ key: sort.key === 'mtime' || sort.key === 'size' ? 'name' : sort.key, dirsFirst: true }}
                focusNew={focusNew}
                ctx={props.ctx}
                actualRoot={config.actualRoot}
                // The same two label inputs the tree takes, so the Location column and
                // the tree name a folder identically.
                bucketLabels={{
                  global: t('bucketGlobal'),
                  department: t('bucketDepartment'),
                  personal: t('bucketPersonal'),
                }}
                departmentPath={callerPath === undefined
                  ? undefined
                  : { codes: callerPath.codes, names: callerPath.names }}
                // The same counter the tree and the list view already re-read on. One
                // signal for every surface that shows the tree's contents, so an upload
                // cannot be visible in one place and stale in another.
                refreshTick={refreshTick}
                // A file dropped anywhere on the table lands in the reader's own
                // folder: `global` is the bucket everyone reads, so defaulting there
                // would publish a private draft without asking.
                // The reader's own folder. `resolveUploadDir` refuses when the Host has
                // not reported an id yet, which the drop handler turns into a visible
                // refusal instead of writing somewhere invisible.
                dropDirectory={resolveUploadDir('personal', callerId) ?? ''}
                onUpload={(directory, files) => {
                  void uploadInto(config.mountPoint, directory === '' ? config.mountPoint : joinPath(config.mountPoint, directory), files as never)
                }}
                onOpen={(path) => { openDocument(path) }}
                // The Home table is the surface a reader starts from, so the same
                // context menu the tree carries is wired here too -- including the
                // star, the share dialog, and the cut/copy/paste pair.
                isFavorite={favorites.has}
                onFavorite={(path, favorite) => { favorites.setFavorite(path, favorite) }}
                isPinned={pins.has}
                onPin={(path, pinned) => { pins.setPinned(path, pinned) }}
                onReference={(path, isDir) => { askReferenceTarget(path, isDir) }}
                onTreeChanged={() => { setRefreshTick(t => t + 1) }}
                // Where a create lands when the reader has not opened a directory:
                // their own personal bucket rather than the shared one.
                callerId={state.kind === 'ready' ? state.status.caller?.userId : undefined}
                departmentCode={state.kind === 'ready' ? state.status.caller?.departmentCode : undefined}
                departmentName={state.kind === 'ready' ? state.status.caller?.departmentName : undefined}
                // The one per-caller permission answer this client has: it decides
                // whether the shared buckets join "Owned by me".
                canManageGrants={false}
              />
            )}
            {scope !== 'graph' && rendered.kind === 'memory' && (
              <KnowledgeMemory
                t={t}
                {...(props.locale === undefined ? {} : { locale: props.locale })}
                onOpenSource={(entry: MemoryEntryView) => {
                  const sessionId = entry.source?.sessionId ?? entry.sourceRefs?.[0]?.sessionId
                  if (sessionId === undefined || sessionId === '') return
                  try {
                    const navigator = (props.ctx as { get?: (name: string) => unknown } | undefined)?.get
                    const workspace = typeof navigator === 'function'
                      ? navigator.call(props.ctx, 'uiWorkspace') as { openSession?: (target: unknown) => void } | undefined
                      : undefined
                    workspace?.openSession?.({ kind: 'known', sessionId })
                  } catch {
                    // Keeping the memory page usable beats failing navigation loudly.
                  }
                }}
              />
            )}
            {scope !== 'graph' && rendered.kind === 'trash' && <KnowledgeTrash t={t} />}
            {scope !== 'graph' && rendered.kind === 'audit' && <KnowledgeAudit t={t} />}
            {scope !== 'graph' && rendered.kind === 'settings' && <KnowledgeSettings t={t} />}
            {scope !== 'graph' && rendered.kind === 'search' && (
              <KnowledgeSearch
                t={t}
                search={search}
                locale={props.locale}
                onOpen={(path) => { openDocument(path) }}
                idle={<KnowledgeListing
                  t={t}
                  locale={props.locale}
                  refreshTick={refreshTick}
                  onRenamed={() => { setRefreshTick(t => t + 1) }}
                  onOpen={(path) => { openDocument(path) }}
                  // A right-click on a row opens the grant form with that path already
                  // filled in: a row is where an operator has a path in mind.
                  onGrant={undefined}
                  onReference={(path, isDir) => { askReferenceTarget(path, isDir) }}
                />}
              />
            )}
            {scope !== 'graph' && rendered.kind === 'file' && !documentInSidebar && (
              <KnowledgeFilePreview
                path={rendered.path}
                t={t}
                onClose={() => { setSelection(canSeeHome ? { kind: 'home' } : { kind: 'search' }) }}
              />
            )}
          </section>
        </div>
      )}
      </div>

      {/* One row menu for the knowledge tree. Rendered outside the tree's scroll
          container so it is never clipped, and outside the explorer so the workspace
          file menu is not reused: this menu carries the knowledge actions (preview,
          save, rename, move, trash) and the permission entry only when the Host says
          this caller may manage grants. */}
      <KnowledgeContextMenu
        target={treeMenu?.target ?? null}
        at={treeMenu?.at ?? null}
        {...(treeMenu?.selection === undefined ? {} : { selection: treeMenu.selection })}
        t={t}
        shareCopy={shareCopyFor(props.locale)}
        pinned={treeMenu === null ? false : pins.has(treeMenu.target.relPath)}
        favorite={treeMenu === null ? false : favorites.has(treeMenu.target.relPath)}
        clipboard={clipboard}
        pasteInto={treeMenu === null ? null : pasteTargetFor(treeMenu.target.relPath, treeMenu.target.isDir)}
        // The knowledge permission admin page is not part of this build; the Host still
        // answers `canManageGrants`, but there is no surface to open, so the entry stays
        // withdrawn instead of offering a dead dialog.
        canManageGrants={false}
        onOpen={(path) => { openDocument(path) }}
        onClose={() => { setTreeMenu(null) }}
        onPin={(path, pinned) => { pins.setPinned(path, pinned) }}
        onFavorite={(path, favorite) => { favorites.setFavorite(path, favorite) }}
        onReference={(path, isDir) => { askReferenceTarget(path, isDir) }}
        onClipboard={(entry) => { setClipboard(entry) }}
        onMove={moveTreeRow}
        onRenamed={() => { setRefreshTick(t => t + 1) }}
        onDeleted={() => { setRefreshTick(t => t + 1) }}
        onMoved={() => {
          // A cut consumes the clipboard; a copy keeps it so one entry can be pasted
          // into a second folder.
          setClipboard(current => (current?.cut === true ? null : current))
          setRefreshTick(t => t + 1)
        }}
      />

      {/* One Share dialog for the whole page. The tree's own menu and the table's
          actions column both open it through state on this component: the dialog is
          self-contained (path in, callbacks out), so mounting it once here is what keeps
          two surfaces from drifting apart in behaviour. */}
      <KnowledgeShareDialog
        relPath={shareTarget}
        isDir={false}
        copy={shareCopyFor(props.locale)}
        onClose={() => { setShareTarget(null) }}
        onShared={() => {
          setShareTarget(null)
          setRefreshTick(t => t + 1)
        }}
      />

      {/* The `@`-mention target picker. Mounted here rather than inside the tree so
          it survives a view switch -- a reader who opens the dialog, changes their
          mind about the layout, and comes back finds it still asking the same
          question instead of quietly losing the click. */}
      <KnowledgeReferencePicker
        open={referencing !== undefined}
        onClose={() => { setReferencing(undefined) }}
        path={referencing?.path ?? ''}
        isDir={referencing?.isDir ?? false}
        ctx={props.ctx}
        t={t}
        locale={props.locale}
        selectedSessionId={() => sessionSource?.getSnapshot().key as string | undefined}
        onReferenced={() => {
          // Name the destination, because the conversation this landed in is
          // usually not the one on screen: the page has no chat of its own.
          setReferenceNote(t('refPickerDone'))
        }}
      />

      {referenceNote !== undefined && (
        // A dismissible line rather than a toast: the note has to outlive a glance
        // for a reader who was looking at the tree, and it must not stack up.
        <p className={styles.referenceNote} role="status">
          <span>{referenceNote}</span>
          <button
            type="button"
            className={styles.referenceNoteDismiss}
            aria-label={t('refPickerDismiss')}
            onClick={() => { setReferenceNote(undefined) }}
          >
            ×
          </button>
        </p>
      )}
    </div>
  )
}
