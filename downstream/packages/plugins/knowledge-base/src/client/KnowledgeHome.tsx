/**
 * The Home surface: the page's landing view.
 *
 * Three ways to start, over a tabbed list of what the reader already has. The tabs
 * select the SET, and the table shows that set's rows; nothing here invents data,
 * so a tab with no rows says so rather than filling the table with placeholders.
 *
 * The listing comes from the same route the tree uses. Categorising a document as
 * "owned by me" or "shared with me" would need an owner per file, and the
 * knowledge tree carries none: it is a directory of documents whose authorization
 * lives in DataOps grants. So the tabs narrow by what the tree can actually
 * answer, and the Owner column is drawn from the grant data only when a caller
 * supplies it. Filling that column with a guess would be worse than leaving it
 * blank.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { ownerLabelOf } from './ownerLabel.ts'
import { departmentPathLabels, folderLabelOf } from './departmentFolders.ts'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Button,
  IconFolderOpen16,
  IconListPenOutline16,
  IconPlusOutlineRegular,
  IconRightUpOutline14,
  Modal,
  Tag,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SegmentedTabs } from './ui/SegmentedTabs'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeHome.module.css'
import panelStyles from './KnowledgePanel.module.css'
import { KnowledgeTemplates } from './KnowledgeTemplates.tsx'
import { KnowledgeNewDocumentDialog } from './KnowledgeNewDocumentDialog.tsx'
import { KnowledgeCreateDialog, defaultDestination, type CreateMode } from './KnowledgeCreateDialog.tsx'
import { isFileDrag, planDrop, readDroppedFiles } from './useFileDrop.ts'
import {
  KnowledgeContextMenu,
  type ContextTarget,
  type TreeClipboard,
} from './KnowledgeContextMenu.tsx'
import { shareCopyFor } from './knowledgeMenuCopy.ts'
import { KnowledgeShareDialog } from './KnowledgeShareDialog.tsx'
import {
  mergeShareRows,
  shareRelationText,
  splitShareRelations,
  type PrincipalNameOf,
  type ShareGrant,
  type ShareRow,
} from './shareRelations.ts'
import { DEFAULT_PAGE_SIZE, needsPager, paginate } from './paging.ts'
import { bucketOfPath, isInOwnPersonalFolder } from './mineScope.ts'

/** One document row, as the table renders it. */
interface HomeRow {
  /** Path relative to the mount point. */
  relPath: string
  /** File name alone. */
  name: string
  /** Directory the file sits in, for the Location column. */
  location: string
  /** Last-modified instant in Unix ms, which is the tree's only timestamp. */
  mtimeMs?: number
  /** Host's answer: a `.md` sibling exists beside this non-text document. */
  hasMarkdown?: boolean
}

/** The tabs, in display order. */
type HomeTab = 'recent' | 'mine' | 'shared' | 'starred'

/** The three starting points. Order here is the render order. */
type CardId = 'new' | 'upload' | 'template'

/**
 * Which plate colour a card's glyph sits on.
 *
 * A name rather than a colour: the stylesheet resolves it to a real theme token,
 * so a palette change lands in one place and no literal can drift into the code.
 */
type CardTone = 'blue' | 'amber' | 'deepseek'

/**
 * One row in a card's menu, and the action it stands for.
 *
 * A `kind` rather than a callback: the menu is built from a table above the
 * handlers, so naming the action here keeps the data and the wiring separate and
 * makes the set of things a card can do greppable.
 */
interface CardItem {
  /** Locale-bound row label. */
  label: string
  /** Which handler the row runs. */
  kind: 'new-doc' | 'new-folder' | 'upload-file' | 'upload-folder' | 'open-templates'
}

/** Props for the Home surface. */
export interface KnowledgeHomeProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Real session key for the borrowed file explorer; absent uses its placeholder. */
  sessionId?: string
  /** The same explorer ordering the sidebar tree takes. */
  sort?: import('dsh-better-sidebar/src/client/file-tree-sort.ts').FileTreeSort
  /** Locale tag, so dates match the reader's language. */
  locale?: string
  /** Disabled when the tree is not mounted, so the cards cannot promise a tree. */
  mountPoint: string
  /** Open one document in the preview. */
  onOpen: (path: string) => void
  /** The client context, used to open a Session from the new-document chooser. */
  ctx?: unknown
  /** Authoritative storage root, used when a template is materialized for the agent. */
  actualRoot?: string
  /**
   * The caller's DataOps id, when the status route reported one.
   *
   * Used only to choose where a create lands by default: with no current directory
   * the reader's own `personal/<id>` folder is the one place a new draft cannot
   * surprise a colleague, so it is preferred over `global`.
   */
  callerId?: string
  /** The caller's own department code, so the owner cell can name it instead of a slug. */
  departmentCode?: string
  /** The caller's own department name; the code stands in when this is absent. */
  departmentName?: string
  /**
   * Display names for the three buckets.
   *
   * The same map the file tree uses, so one vocabulary covers both surfaces: a folder
   * called `personal` on disk reads as 「个人」 in the tree AND in this table's Location
   * column. A second mapping table here is exactly the two-truths defect this reuses the
   * tree's helper to avoid.
   */
  bucketLabels?: Readonly<Record<string, string>>
  /**
   * The caller's organization chain, codes first and names aligned.
   *
   * Passed the same way the tree takes it, so a nested department path reads as
   * 「部门/数据平台」 here instead of `department/data-platform`.
   */
  departmentPath?: { codes: readonly string[]; names: readonly string[] }
  /**
   * Whether the Host verified this caller may manage grants.
   *
   * This is the ONLY per-caller permission answer the client receives. There is no
   * per-path "may I write this" route: `grants` is admin-scoped and the list route
   * reports visibility, not writability. So the "Owned by me" tab uses this as its
   * whole answer for the shared buckets -- an administrator sees the shared documents
   * there, a plain reader does not -- and marks the rows whose answer it could not
   * narrow rather than pretending either way.
   */
  canManageGrants?: boolean
  /**
   * The tab whose card should take focus on mount.
   *
   * Set when a reader arrives here from the tree's empty state, which is asking
   * them to start a document: the blank-page card is the answer to that question,
   * so it is the one that should be reachable by keyboard immediately.
   */
  focusNew?: boolean
  /**
   * Star or unstar one row.
   *
   * The Home table is the surface a reader actually starts from, so the context menu
   * lives here as well as on the tree. Omitted by a caller with no favourites store,
   * which keeps the menu's star entry out rather than offering a write that cannot land.
   */
  onFavorite?: (path: string, favorite: boolean) => void
  /** Whether one path is currently favourited, so the row can draw its star. */
  isFavorite?: (path: string) => boolean
  /** Open the permission surface for one path. */
  onGrant?: (path: string) => void
  /** Insert a reference to this path into the conversation. */
  onReference?: (path: string, isDir: boolean) => void
  /** Pin or unpin one row, offered by the same menu the tree uses. */
  onPin?: (path: string, pinned: boolean) => void
  /** Whether one path is currently pinned. */
  isPinned?: (path: string) => boolean
  /**
   * Called after any menu action that changed the tree.
   *
   * The table holds its own rows, so a rename/delete/paste has to be followed by a
   * re-read; the page owns the tick that triggers it.
   */
  onTreeChanged?: () => void
  /**
   * Upload files dropped onto the table area.
   *
   * The table lists documents only -- there is no directory row here to aim at -- so
   * the whole surface is one target and the destination has to be decided rather than
   * read off the row under the pointer. `dropDirectory` carries that decision.
   * Omitted by a read-only caller, which keeps the surface from accepting a drop that
   * would then be refused on the Host.
   * @param directory - the tree-relative directory the files land in.
   * @param files - the dropped files with paths relative to that directory.
   */
  onUpload?: (directory: string, files: readonly { file: unknown; relativePath: string }[]) => void
  /**
   * Read the document rows for this mount.
   *
   * TEST SEAM, NOT AN EXTENSION POINT. It exists so a test can count how many times the
   * table re-reads when `refreshTick` bumps -- the only way to tell "the table refreshed"
   * apart from "a row happened to appear". It is optional and defaults to the real
   * implementation below, so production behaviour is unchanged; do not use it as a hook
   * for new features.
   */
  readHomeRows?: (mountPoint: string) => Promise<HomeRow[]>
  /**
   * Re-read trigger.
   *
   * A file uploaded from anywhere in the panel changes what this table should list, and
   * the panel already bumps one counter for exactly that. Without this the tree refreshed
   * and the table did not, so a reader who had just uploaded a file could not find it --
   * indistinguishable from the upload having failed.
   */
  refreshTick?: number
  /**
   * Where a drop on this table lands, tree-relative.
   *
   * The reader's own folder is the right default: `global` is the bucket everyone
   * reads, so defaulting there would publish a private draft without asking. Empty
   * means the mount root, which is what a caller with no personal bucket gets.
   */
  dropDirectory?: string
}

/**
 * Read the document rows for one mount.
 *
 * One level deep in each bucket, because documents live inside the buckets, not beside
 * them: the mount's own level holds only `global`/`department`/`personal`, so listing it
 * alone yields an empty table no matter how many documents exist. Each bucket is one
 * directory deep, which is where a document sits, so the walk stops there instead of
 * turning a landing page into a full filesystem scan.
 * @param mountPoint - the knowledge root, absolute.
 * @returns Every document row the table shows, in bucket order.
 */
async function loadHomeRows(mountPoint: string): Promise<HomeRow[]> {
  const listLevel = async (path: string): Promise<Array<{ relPath: string; name: string; isDir: boolean; mtimeMs?: number; hasMarkdown?: boolean }>> => {
    const response = await fetch(kbApiPath(KB_API.list), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    const body = await readKnowledgeJson<{
      entries?: Array<{ relPath: string; name: string; isDir: boolean; mtimeMs?: number; hasMarkdown?: boolean }>
    }>(response)
    return body.entries ?? []
  }
  const root = await listLevel('')
  // A bucket that cannot be read must not hide the others; the tree reports per-row
  // readability, so this surface stays a convenience listing.
  const buckets = root.filter(entry => entry.isDir).map(entry => entry.relPath)
  const nested = await Promise.all(buckets.map(async bucket => {
    try {
      return (await listLevel(bucket)).filter(entry => !entry.isDir)
    } catch {
      return []
    }
  }))
  return nested.flat().map(entry => ({
    relPath: entry.relPath,
    name: entry.name,
    location: locationOf(entry.relPath),
    ...(entry.mtimeMs === undefined ? {} : { mtimeMs: entry.mtimeMs }),
    ...(entry.hasMarkdown === true ? { hasMarkdown: true } : {}),
  }))
}

/** Whether a file is text (indexed) rather than a document (extracted). */
function isTextDocument(name: string): boolean {
  return /\.(md|markdown|txt)$/iu.test(name)
}

/** What the plugin's own SQLite index knows about one document. */
interface IndexStatusView {
  found: boolean
  docId?: number
  chunks?: number
  indexedAt?: number
  path?: string
  scope?: string
}

/** Read one document's index row from the Host. */
async function fetchIndexStatus(relPath: string): Promise<IndexStatusView> {
  try {
    const response = await fetch(kbApiPath(KB_API.indexStatus), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: relPath }),
      cache: 'no-store',
    })
    if (!response.ok) return { found: false }
    return (await response.json()) as IndexStatusView
  } catch {
    return { found: false }
  }
}

/** One row's status cell and the detail the modal shows. */
interface RowStatus {
  kind: 'extract' | 'index'
  state: 'done' | 'none'
  index?: IndexStatusView
}

/**
 * Resolve a Location cell to the reader's vocabulary.
 *
 * Reuses `folderLabelOf` and `departmentPathLabels` -- the two helpers the file tree
 * already resolves its own rows with -- instead of a second mapping. A path is walked from
 * its deepest segment up, translating the first prefix that has a label and keeping the
 * rest of the path as-is, which is what makes `department/data-platform/specs` read as
 * 「部门/数据平台/specs」 rather than as an untranslated slug or a bare bucket name.
 *
 * Only the DISPLAY changes: sorting and filtering still use the raw path, so a translated
 * label can never reorder rows.
 * @param relPath - the document's tree-relative path.
 * @param labels - bucket labels and department chain labels, already flattened.
 * @returns The text a reader should see.
 */
function locationLabelOf(
  location: string,
  bucketLabels: Readonly<Record<string, string>> | undefined,
  chainLabels: ReadonlyMap<string, string> | undefined,
): string {
  if (location === '—' || location === '') return location
  const segments = location.split('/')
  // Deepest prefix first: `department/ops/q1` must prefer the label for
  // `department/ops/q1` over the one for `department`.
  for (let take = segments.length; take >= 1; take -= 1) {
    const prefix = segments.slice(0, take).join('/')
    const label = folderLabelOf(prefix, bucketLabels, chainLabels)
    if (label !== undefined) {
      const rest = segments.slice(take)
      return rest.length === 0 ? label : label + '/' + rest.join('/')
    }
  }
  return location
}

/** Format one instant for the table, matching the preview's own absolute form. */
function formatStamp(mtimeMs: number | undefined, locale: string): string {
  if (mtimeMs === undefined) return '—'
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleDateString(locale.startsWith('zh') ? 'zh-CN' : 'en-US')
}

/** The directory part of a relative path, or a dash at the root. */
function locationOf(relPath: string): string {
  const cut = relPath.lastIndexOf('/')
  return cut === -1 ? '—' : relPath.slice(0, cut)
}

/** Props for the Share tab's single table. */
interface ShareTableProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** The rows on the current page, both directions. */
  rows: readonly ShareRow[]
  /** 1-based page shown. */
  page: number
  /** Total pages. */
  pageCount: number
  /** Total rows across both directions. */
  total: number
  /** Move to another page. */
  onPage: (page: number) => void
  /** What to say when there is no share in either direction. */
  empty: string
  /** Copy for a grant whose principal id is empty. */
  unknownAudience: string
  /** How one row's sharing relation reads. */
  relationOf: (row: ShareRow) => string
}

/**
 * The Share tab, as ONE table.
 *
 * It was two blocks while the two directions looked like two answer sets. They are not:
 * the reader asked for a single table where the direction is a column value, and that is
 * what this is. Splitting it also made the extra column pointless -- a direction column
 * only earns its place when both directions share a table.
 *
 * The direction travels on each row (`row.direction`), rendered through `relationOf`, so
 * the merged table states it per row instead of by which block drew the row.
 * @param props - the page's rows and copy.
 * @returns The Share tab's table.
 */
function ShareTable(props: ShareTableProps): ReactNode {
  const c = props.t
  if (props.total === 0) {
    // One empty state for the whole tab: with a merged table there is no per-direction
    // place to put a per-direction message.
    return <p className={styles.shareEmpty}>{props.empty}</p>
  }
  return (
    <section className={styles.shareBlock} aria-label={c('homeTabShared')}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>{c('homeColTitle')}</th>
            <th>{c('homeColLocation')}</th>
            <th>{c('shareColRelation')}</th>
            <th>{c('shareColAudience')}</th>
            <th>{c('shareColPermission')}</th>
          </tr>
        </thead>
        <tbody>
          {props.rows.map(row => (
            <tr key={row.id}>
              <td>{row.name}</td>
              <td className={styles.muted}>{row.location}</td>
              <td className={styles.muted}>{props.relationOf(row)}</td>
              {/* A grant whose principal id is empty has no audience to name; every
                  other row prints either the resolved label or the real id. */}
              <td className={styles.muted}>
                {row.audience === '' ? props.unknownAudience : row.audience}
              </td>
              <td className={styles.muted}>{row.action}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {props.pageCount > 1 && (
        <div className={styles.sharePager}>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.page <= 1}
            onClick={() => { props.onPage(props.page - 1) }}
          >
            {c('auditPagePrev')}
          </Button>
          <span className={styles.muted}>
            {c('auditPageOf').replace('{page}', String(props.page)).replace('{pages}', String(props.pageCount))}
          </span>
          <Button
            variant="ghost"
            size="sm"
            disabled={props.page >= props.pageCount}
            onClick={() => { props.onPage(props.page + 1) }}
          >
            {c('auditPageNext')}
          </Button>
        </div>
      )}
    </section>
  )
}

/**
 * Render the Home surface.
 * @param props - copy resolver, mount state, and the open callback.
 * @returns The Home view.
 */
export function KnowledgeHome(props: KnowledgeHomeProps) {
  const c = props.t
  const locale = props.locale ?? 'zh-CN'
  const [rows, setRows] = useState<HomeRow[]>([])
  /** True while a file drag is over the table, so the surface shows it will accept it. */
  const [dropActive, setDropActive] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [tab, setTab] = useState<HomeTab>('recent')
  /**
   * Which create/upload dialog is open, or undefined when none is.
   *
   * The reference opened a dropdown under each card and then a browser `prompt` for
   * the name, which cannot show or change where the file lands. The card is now a
   * trigger for one dialog that asks both questions at once.
   */
  const [dialog, setDialog] = useState<CreateMode | undefined>(undefined)
  /** The new-document type chooser, separate from the conventional folder/upload forms. */
  const [newDocumentOpen, setNewDocumentOpen] = useState(false)
  /**
   * What the last menu action did, so the reader sees an outcome.
   *
   * A single line rather than a toast: these actions run inside a dropdown, and a
   * transient overlay would outlive the menu that caused it. The text is replaced
   * by the next action, which is what makes it a report rather than a log.
   */
  const [notice, setNotice] = useState<string | null>(null)
  /** Whether the template library covers the surface. */
  const [templatesOpen, setTemplatesOpen] = useState(false)
  /**
   * The open context menu: which row, and where the pointer was.
   *
   * One menu for the whole table rather than one per row, because a row is re-created
   * on every re-read and an open menu owned by a row would unmount with it.
   */
  const [menu, setMenu] = useState<{ target: ContextTarget; at: { x: number; y: number } } | null>(null)
  /**
   * The row whose Share dialog is open, or null.
   *
   * The context menu mounts its own dialog for ITS share entry; the actions column needs
   * the same dialog for a row a reader never right-clicked, and it cannot reach into the
   * menu's state. One extra instance of the same component -- the dialog is self-contained
   * (path in, callbacks out), so this shares behaviour without sharing state, which is the
   * only thing that could drift.
   */
  const [shareTarget, setShareTarget] = useState<ContextTarget | null>(null)
  /** The row being deleted, so its button can show it is working. */
  const [deletingPath, setDeletingPath] = useState<string | undefined>(undefined)
  /**
   * The cut/copied entry, held for the clipboard's lifetime.
   *
   * Client state, like the tree's: nothing about a pending paste is worth persisting,
   * and paste goes through the Host's own `copy` / `move` routes.
   */
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null)
  /** Locale-resolved copy for the share dialog, whose strings are dialog-specific. */
  const shareCopy = useMemo(() => shareCopyFor(props.locale), [props.locale])
  /**
   * The label resolver for the Location column.
   *
   * Built from the same two inputs the file tree takes, so both surfaces name a folder
   * identically. `useMemo` keeps the map from being rebuilt per row.
   */
  const locationOfPath = useMemo(() => {
    const chainLabels = departmentPathLabels(props.departmentPath?.codes, props.departmentPath?.names)
    return (location: string): string => locationLabelOf(location, props.bucketLabels, chainLabels)
  }, [props.bucketLabels, props.departmentPath])

  /**
   * The two share groups, read from the grants route the permissions page already uses.
   *
   * No new endpoint: the same `grants` payload, split by direction. `null` means "not
   * read yet", which is distinct from "read and empty" -- the two need different copy,
   * and an empty array would let a failed read look like a clean bill of health.
   */
  const [share, setShare] = useState<{ received: ShareRow[]; given: ShareRow[] } | null>(null)
  /** Whether the grants read is in flight, so the block can say so instead of flashing empty. */
  const [shareLoading, setShareLoading] = useState(false)
  /** A failed grants read, surfaced in the block rather than silently showing nothing. */
  const [shareError, setShareError] = useState<string | undefined>(undefined)
  /** Local re-read trigger for table mutations (delete/share/star/rename/move). */
  const [localTick, setLocalTick] = useState(0)
  /** One pager: the merged table is one list, so it gets one page number. */
  const [sharePage, setSharePage] = useState(1)



  /**
   * Read the grants and split them into the two directions.
   *
   * Runs only while the Share tab is open: the grants route is admin-scoped and not
   * every reader may call it, so asking for it on mount would produce a refusal for
   * people who never opened the tab. A refusal is shown as itself rather than as an
   * empty list -- "you cannot see this" and "there is nothing here" are different facts.
   *
   * Principal names come from the same `principals` route the permission editor uses,
   * one call per kind, and a kind that fails simply yields no names -- the rows then
   * print their real principal ids, which is still true data.
   */
  const readShares = useCallback(async (): Promise<void> => {
    if (props.mountPoint === '') return
    setShareLoading(true)
    setShareError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.grants), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mountPoint: props.mountPoint }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const payload = await readKnowledgeJson<{
        grants?: ShareGrant[]
        supported?: boolean
        error?: { message?: string }
      }>(response)
      if (payload.supported === false) {
        // No permissions backend: the two groups are genuinely unknown, not empty.
        // Reuses the permissions surface's own wording rather than adding a key.
        setShare({ received: [], given: [] })
        setShareError(c('readFailed'))
        return
      }
      const grants = payload.grants ?? []
      // Collect the principal ids actually referenced, then resolve each kind once.
      const needed = new Map<ShareGrant['principalType'], Set<string>>()
      for (const grant of grants) {
        const bucket = needed.get(grant.principalType) ?? new Set<string>()
        bucket.add(grant.principalId)
        needed.set(grant.principalType, bucket)
      }
      const resolved = new Map<string, string>()
      await Promise.all([...needed.entries()].map(async ([kind, ids]) => {
        try {
          const answer = await fetch(kbApiPath(KB_API.principals), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ principalType: kind }),
            cache: 'no-store',
          })
          if (!answer.ok) return
          const body = await readKnowledgeJson<{ options?: Array<{ id: string; label: string }> }>(answer)
          for (const option of body.options ?? []) {
            if (ids.has(option.id)) resolved.set(kind + ':' + option.id, option.label)
          }
        } catch {
          // One kind failing leaves its rows printing their ids, which is still true.
        }
      }))
      const nameOf: PrincipalNameOf = (kind, id) => resolved.get(kind + ':' + id)
      setShare(splitShareRelations(grants, props.callerId, nameOf))
    } catch (error: unknown) {
      setShare({ received: [], given: [] })
      setShareError(error instanceof Error ? error.message : c('readFailed'))
    } finally {
      setShareLoading(false)
    }
  }, [props.mountPoint, props.callerId, c, localTick, props.refreshTick])

  // Read the shares when the tab is opened, and again whenever the caller identity
  // resolves (it arrives after mount), so the split is never computed against
  // "unknown caller" longer than necessary.
  useEffect(() => {
    if (tab !== 'shared') return
    void readShares()
  }, [tab, readShares])

  /**
   * The rows for one group, paged.
   *
   * Paged independently because the two groups answer different questions and their
   * sizes differ: a reader with fifty inbound grants and three outbound would otherwise
   * have to page past all fifty to see their own three.
   */
  const shareRows = useMemo(() => mergeShareRows(share ?? { received: [], given: [] }), [share])
  const pagedShare = useMemo(
    () => paginate(shareRows, sharePage, DEFAULT_PAGE_SIZE),
    [shareRows, sharePage],
  )

    // Read once per mount, one level deep in each bucket.
    //
    // Documents live inside the buckets, not beside them: the mount's own level holds
    // only the three bucket directories, so listing it alone yields an empty table no
    // matter how many documents exist. Each bucket is one directory deep, which is
    // where a document sits, so the walk stops there instead of turning a landing page
    // into a full filesystem scan.
    const read = useCallback(async (): Promise<void> => {
      if (props.mountPoint === '') {
        setState('error')
        return
      }
      setState('loading')
      try {
        // The loader is injectable so a test can count re-reads; in production it is the
        // module-level implementation, so this call is the same work it always was.
        const loaded = await (props.readHomeRows ?? loadHomeRows)(props.mountPoint)
        setRows(loaded)
        setState('ready')
      } catch {
        setState('error')
      }
    }, [props.mountPoint])

  useEffect(() => { void read() }, [read, props.refreshTick, localTick])

  /**
   * Re-read every table after a mutation.
   *
   * The parent's `refreshTick` is still bumped (the tree and other listing surfaces
   * listen to it), but the Home table also owns a local tick and awaits its own read:
   * a delete must not depend on a parent re-render racing the view sync.
   */
  const refreshRows = useCallback(async (): Promise<void> => {
    setLocalTick(value => value + 1)
    props.onTreeChanged?.()
    await read()
    if (tab === 'shared') await readShares()
  }, [props, read, readShares, tab])
  /**
   * Paste the Home table's clipboard into one directory.
   *
   * The upload dialog shares this clipboard with the table; a cut consumes it after a
   * successful move, while a copy stays available for a second destination.
   */
  const pasteClipboard = useCallback(async (directory: string): Promise<void> => {
    const clip = clipboard
    if (clip === null || clip.entries.length === 0) return
    for (const entry of clip.entries) {
      const response = await fetch(kbApiPath(clip.cut ? KB_API.move : KB_API.copy), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: entry.relPath, to: directory }),
        cache: 'no-store',
      })
      if (!response.ok) break
    }
    if (clip.cut) setClipboard(null)
    await refreshRows()
  }, [clipboard, refreshRows])

  /**
   * Delete one row to the trash, then re-read the table.
   *
   * The same route the context menu's Delete uses (`trash.remove` records a tombstone; it
   * does not unlink, which is why the tree and this table must both reload rather than
   * patch a row out locally). The confirmation is the browser's own, because the actions
   * column is a one-click control: a destructive icon a reader can hit by accident needs a
   * stop in front of it, and the menu's Delete has the row already named by the click.
   * @param row - the row to remove.
   */
  const removeRow = useCallback(async (row: HomeRow): Promise<void> => {
    const label = c('actionDelete') + ' ' + row.name
    if (typeof window !== 'undefined' && !window.confirm(label + '?')) return
    setDeletingPath(row.relPath)
    try {
      const response = await fetch(kbApiPath(KB_API.trashRemove), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: row.relPath, kind: 'file' }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      // Remove the row immediately, then re-read the authoritative listing. The
      // optimistic step is what makes the table move on the same click; the read is
      // what keeps the table honest after the view rebuild.
      setRows(current => current.filter(candidate => candidate.relPath !== row.relPath))
      await refreshRows()
    } catch {
      // A failed delete still re-reads: leaving a speculative removal on screen
      // would claim a delete that did not happen.
      await refreshRows()
    } finally {
      setDeletingPath(undefined)
    }
  }, [c, refreshRows])

  /**
   * Which create/upload flow one card row starts.
   *
   * The rows keep their `kind` vocabulary so the card table above stays data rather
   * than wiring, but every one of them now opens the shared dialog instead of
   * branching into a prompt or a hidden file input: the dialog is what makes "where
   * does it go" a question the reader can answer.
   */
  const openDialogFor = useCallback((kind: CardItem['kind']): void => {
    if (kind === 'open-templates') {
      setTemplatesOpen(true)
      return
    }
    if (kind === 'new-doc') {
      setNewDocumentOpen(true)
      return
    }
    setDialog(kind)
  }, [])

  /**
   * Open a conversation for the chosen artefact type.
   *
   * The composer's prompt is the product's draft contract, not a submitted turn:
   * the reader can add the subject before sending. The caret is parked after
   * 「一份」 so the next keystroke fills in what the document is about.
   */
  const startCreation = useCallback((prompt: string, caretOffset: number): void => {
    setNewDocumentOpen(false)
    const context = props.ctx as { get?: (name: string) => unknown } | undefined
    const uiWorkspace = context?.get?.('uiWorkspace') as
      | { startSession?: (workspaceId?: unknown, options?: { prompt?: string; clearPreviousDraft?: boolean }) => void }
      | undefined
    if (uiWorkspace?.startSession === undefined) {
      setNotice('当前工作区无法打开新会话，请从左侧新建会话。')
      return
    }
    uiWorkspace.startSession(undefined, { prompt, clearPreviousDraft: true })
    // `startSession` navigates asynchronously and mounts a Lexical composer in the
    // next frames. Poll briefly; if the host changes that surface the text is still
    // prefilled and only the caret hint is lost.
    const deadline = Date.now() + 4_000
    const place = (): void => {
      const input = document.querySelector<HTMLElement>('[data-composer-input="true"]')
      if (input !== null && (input.textContent ?? '').includes(prompt)) {
        input.focus()
        const selection = window.getSelection()
        const range = document.createRange()
        let remaining = caretOffset
        let placed = false
        const walker = document.createTreeWalker(input, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0
          if (remaining <= length) {
            range.setStart(node, remaining)
            range.collapse(true)
            selection?.removeAllRanges()
            selection?.addRange(range)
            placed = true
            break
          }
          remaining -= length
        }
        if (placed) return
      }
      if (Date.now() < deadline) window.setTimeout(place, 80)
    }
    window.setTimeout(place, 80)
  }, [props.ctx])

  // "Recently opened" is the only set the tree can answer: its one time field is
  // the modification instant. The other three need an owner or a star per file,
  // neither of which exists yet, so they render the empty line rather than a
  // fabricated set.
  /**
   * The rows the current tab shows.
   *
   * Only `recent` used to be implemented; the other three fell through to `[]`, which
   * made them read as "you have nothing" rather than "this tab is not wired up". The
   * starred tab is now real: it filters the rows already read by the caller's own
   * favourites, so starring a document makes it appear here without a second request.
   *
   * `mine` and `shared` still have no owner information behind them -- the tree carries
   * no owner per file, only DataOps grants -- so they keep the empty list and their own
   * empty-state wording rather than inventing a split the data cannot support.
   */
  /**
   * Which page of the document table is showing.
   *
   * Held here because this component renders the table: the page index and the rows it
   * slices have to live in the same scope, or the slice refers to a name the table cannot
   * see.
   */
  const [docPage, setDocPage] = useState(1)

  const visible = useMemo(() => {
    if (tab === 'recent') return [...rows].sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    if (tab === 'starred') {
      // Order by modification time like `recent`, so the same set reads the same way
      // whichever tab the reader is on.
      return rows
        .filter(row => props.isFavorite?.(row.relPath) === true)
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    }
    if (tab === 'mine') {
      // "Owned by me" used to fall through to `[]`, which is why it looked empty while
      // files sat in the personal folder: the branch was never written.
      //
      // The caller's own personal folder is theirs unconditionally. The shared buckets
      // are theirs too when the Host verified they may manage grants -- that is the one
      // per-caller permission answer this client receives, and an administrator asked
      // for exactly this. Absent means "not verified", never "yes": an unverified
      // caller keeps seeing only their personal folder rather than a claim the
      // deployment cannot back.
      const mayManageShared = props.canManageGrants === true
      return rows
        .filter(row => isInOwnPersonalFolder(row.relPath, props.callerId)
          || (mayManageShared && bucketOfPath(row.relPath) !== 'personal'))
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
    }
    return []
  }, [tab, rows, props.isFavorite, props.callerId, props.canManageGrants])

  /**
   * The rows the table actually draws, one page at a time.
   *
   * `paginate` owns the clamping: it keeps the page inside the available range, so a tab
   * switch that leaves fewer rows than the current page does not render an empty table.
   */
  const docPageRows = useMemo(
    () => paginate(visible, docPage, DEFAULT_PAGE_SIZE),
    [visible, docPage],
  )

  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({})
  const [statusDetail, setStatusDetail] = useState<{ row: HomeRow; status: RowStatus } | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const next: Record<string, RowStatus> = {}
      for (const row of docPageRows.rows) {
        if (isTextDocument(row.name)) {
          const index = await fetchIndexStatus(row.relPath)
          next[row.relPath] = { kind: 'index', state: index.found ? 'done' : 'none', index }
        } else {
          next[row.relPath] = { kind: 'extract', state: row.hasMarkdown === true ? 'done' : 'none' }
        }
      }
      if (alive) setRowStatus(next)
    }
    void load()
    return () => { alive = false }
  }, [docPageRows])

  // A tab switch changes the row set under a fixed page index, which would otherwise show
  // page 3 of a two-page list. Reset to the first page whenever the tab changes.
  useEffect(() => { setDocPage(1) }, [tab])

  // The product's own glyphs rather than drawn characters: a text glyph renders at
  // the font's weight and baseline, which reads heavier than the 1px icon stroke
  // every other control on this page uses.
  //
  // Each card carries a tone, because the reference draws the glyph on a coloured
  // rounded plate rather than bare on the card. The tone names a real theme token
  // (`--dsw-static-blue-500` and friends); the stylesheet maps it, so no colour
  // literal appears here.
  const cards: Array<{ id: CardId; title: string; body: string; tone: CardTone; glyph: ReactNode; items: CardItem[] }> = [
    {
      id: 'new',
      title: c('homeNewTitle'),
      body: c('homeNewBody'),
      tone: 'blue',
      glyph: <IconPlusOutlineRegular size={16} />,
      // Only the two the Host can actually perform. The reference lists eight more
      // (table, slides, mind map, whiteboard...); this plugin has no editor for any
      // of them, so offering them would be a control that does nothing.
      items: [
        { label: c('cardItemNewDoc'), kind: 'new-doc' as const },
        { label: c('cardItemNewFolder'), kind: 'new-folder' as const },
      ],
    },
    {
      id: 'upload',
      title: c('homeUploadTitle'),
      body: c('homeUploadBody'),
      tone: 'amber',
      glyph: <IconRightUpOutline14 size={16} />,
      items: [
        { label: c('cardItemUploadFile'), kind: 'upload-file' as const },
        { label: c('cardItemUploadFolder'), kind: 'upload-folder' as const },
      ],
    },
    {
      id: 'template',
      title: c('homeTemplateTitle'),
      body: c('homeTemplateBody'),
      // The reference's third plate is a multi-colour mark of its own; this plugin
      // has no equivalent artwork, so it takes the product's own brand tone. That is
      // a substitution, not a copy of the reference.
      tone: 'deepseek',
      glyph: <IconListPenOutline16 size={16} />,
      items: [{ label: c('cardItemOpenTemplates'), kind: 'open-templates' as const }],
    },
  ]

  return (
    <div className={styles.home}>
      <div className={styles.cards}>
        {/* A card, not a Button: the whole tile is the target and its own layout
            (plate, text, chevron) is the content. `Button` renders a fixed-height
            control whose label is a single line, so using it here would mean
            recreating the card inside it.

            Geometry follows the reference image, measured at
            `/root/projects/kb-notes/CARD-SPEC-VERIFIED-BY-KBUI.md`: a horizontal
            row, a 20.5 CSS px rounded colour plate, and the three parts vertically
            centred. The stylesheet carries the per-value provenance. */}
        {cards.map(card => (
          <div key={card.id} className={styles.cardSlot}>
            <button
              type="button"
              className={styles.card}
              data-card={card.id}
              aria-expanded={card.id === 'new' ? newDocumentOpen : (dialog !== undefined && card.items.some(item => item.kind === dialog))}
              aria-haspopup={card.id === 'template' ? 'dialog' : undefined}
              // Autofocus only the blank-page card, and only when the caller asked:
              // moving focus without being asked would steal it from the rail.
              autoFocus={props.focusNew === true && card.id === 'new'}
              disabled={props.mountPoint === ''}
              // One card, one intent: the blank-page card starts a document, the
              // upload card starts an upload, and the template card opens the library.
              // A card with more than one row (a document OR a folder, a file OR a
              // folder) still has a single obvious first action, so the extra rows
              // stay as the dialog's own choice instead of a dropdown.
              onClick={() => {
                const first = card.items[0]
                if (first !== undefined) openDialogFor(first.kind)
              }}
            >
              <span className={styles.cardPlate} data-tone={card.tone} aria-hidden="true">{card.glyph}</span>
              <span className={styles.cardText}>
                <span className={styles.cardTitle}>{card.title}</span>
                <span className={styles.cardBody}>{card.body}</span>
              </span>
            </button>
          </div>
        ))}
      </div>

      <KnowledgeNewDocumentDialog
        open={newDocumentOpen}
        onClose={() => { setNewDocumentOpen(false) }}
        onCreate={startCreation}
        onNewFolder={() => {
          setNewDocumentOpen(false)
          setDialog('new-folder')
        }}
        t={c}
      />

      {/* One dialog for all three actions. It asks the two questions the dropdown
          could not: what is it called, and where does it go. Escape, the mask and
          focus return belong to `Modal`, not to this file. */}
      <KnowledgeCreateDialog
        open={dialog !== undefined}
        mode={dialog ?? 'new-doc'}
        onClose={() => { setDialog(undefined) }}
        defaultPath={defaultDestination(undefined, props.callerId)}
        root={props.mountPoint}
        callerId={props.callerId}
        sessionId={props.sessionId}
        locale={props.locale}
        bucketLabels={props.bucketLabels}
        departmentPath={props.departmentPath}
        sort={props.sort}
        isFavorite={props.isFavorite}
        onToggleFavorite={(path, favorite) => { props.onFavorite?.(path, favorite); void refreshRows() }}
        onShare={(relPath) => { setShareTarget({ relPath, name: relPath.slice(relPath.lastIndexOf('/') + 1), isDir: false }) }}
        onClipboard={setClipboard}
        hasClipboard={clipboard !== null}
        onPasteInto={(directory) => { void pasteClipboard(directory) }}
        t={c}
        onDone={(message) => {
          setNotice(message)
          void read()
        }}
      />

      {/* The outcome of the last action. `role="status"` so a screen reader
          announces it without moving focus away from the menu. */}
      {notice !== null && <p className={panelStyles.notice} role="status">{notice}</p>}

      {templatesOpen && (
        <KnowledgeTemplates
          t={props.t}
          onClose={() => { setTemplatesOpen(false) }}
          mountPoint={props.mountPoint}
          callerId={props.callerId}
          actualRoot={props.actualRoot}
          // A template "use" opens a conversation with the materialized template as
          // a real file reference; preview opens that same file in the sidebar.
          onOpen={(path) => { props.onOpen(path) }}
          onStartSession={(prompt) => { startCreation(prompt, prompt.length) }}
        />
      )}

      <SegmentedTabs
        items={[
          { value: 'recent', label: c('homeTabRecent'), id: 'kb-home-recent', panelId: 'kb-home-panel' },
          { value: 'mine', label: c('homeTabMine'), id: 'kb-home-mine', panelId: 'kb-home-panel' },
          { value: 'shared', label: c('homeTabShared'), id: 'kb-home-shared', panelId: 'kb-home-panel' },
          { value: 'starred', label: c('homeTabStarred'), id: 'kb-home-starred', panelId: 'kb-home-panel' },
        ]}
        value={tab}
        onChange={setTab}
        label={c('homeTabRecent')}
      />

      <div id="kb-home-panel" role="tabpanel" aria-labelledby={'kb-home-' + tab}>
        {/* A real table, because this view is genuinely tabular: five columns that
            answer "where does this document live and when did it last change", and
            a header the reader can scan. `DisclosureRow` is the alternative the
            primitives offer, and it renders a two-level tree -- a document list has
            no nesting to disclose. */}
        <div
          className={styles.dropZone + (dropActive ? ' ' + styles.dropZoneActive : '')}
          // The table lists documents only, so there is no directory row to aim at:
          // the whole surface is the target and the destination is the prop's decision.
          onDragOver={props.onUpload === undefined ? undefined : (event) => {
            if (!isFileDrag(event.dataTransfer?.types)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = 'copy'
            setDropActive(true)
          }}
          onDragLeave={props.onUpload === undefined ? undefined : () => { setDropActive(false) }}
          onDrop={props.onUpload === undefined ? undefined : (event) => {
            setDropActive(false)
            if (!isFileDrag(event.dataTransfer?.types)) return
            event.preventDefault()
            // Must run inside the dispatch: the payload is protected afterwards.
            void readDroppedFiles(event.dataTransfer).then((files) => {
              const plan = planDrop(
                { relativePath: props.dropDirectory ?? '', isDirectory: true, drops: true },
                { hasFiles: files.length > 0, files },
              )
              if (plan.kind === 'upload') props.onUpload?.(plan.directory, plan.files)
            })
          }}
        >
        {tab !== 'shared' && (
        <table className={styles.table}>
          <thead>
            <tr>
              {/* Fixed widths, set on the columns rather than the cells: with
                  `table-layout: fixed` the browser distributes from these and a long
                  file name can then only ellipsise, never push the date columns out of
                  the surface (which is what the reported screenshot showed). */}
              <th className={styles.colTitle}>{c('homeColTitle')}</th>
              <th className={styles.colLocation}>{c('homeColLocation')}</th>
              <th className={styles.colOwner}>{c('homeColOwner')}</th>
              <th className={styles.colTime}>{c('homeColCreated')}</th>
              <th className={styles.colTime}>{c('homeColOpened')}</th>
              <th className={styles.colStatus}>{c('homeColStatus')}</th>
              <th className={styles.colActions}>{c('colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {state === 'loading' && (
              <tr className={styles.emptyRow}>
                <td colSpan={7}>{c('loading')}</td>
              </tr>
            )}
            {state === 'error' && (
              <tr className={styles.emptyRow}>
                <td colSpan={7}>{c('unavailable')}</td>
              </tr>
            )}
            {state === 'ready' && visible.length === 0 && (
              <tr className={styles.emptyRow}>
                {/* A starred tab with nothing in it is not an empty knowledge base; it
                    is "you have not starred anything yet". Saying the former would send
                    the reader looking for lost documents. */}
                <td colSpan={7}>{tab === 'starred' ? c('homeStarredEmpty') : c('homeEmpty')}</td>
              </tr>
            )}
            {docPageRows.rows.map(row => (
              <tr
                key={row.relPath}
                className={styles.docRow}
                // A click anywhere on the row opens the document, not only on the
                // title text: the row is the card the reader aims at. Controls inside
                // the row (star, status, action menu) keep their own behaviour; a
                // click that lands on one of them must not also open the document.
                onClick={(event) => {
                  const target = event.target as HTMLElement
                  if (target.closest('button, input, a, summary, [role="button"]') !== null) return
                  props.onOpen(row.relPath)
                }}
                // On the row root, not on a cell: a right-click lands on whichever
                // <td> the pointer happens to be over, and a handler on one cell would
                // silently miss the other four. `preventDefault` is what suppresses the
                // browser's own menu -- without it both menus open on top of each other.
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({
                    target: { relPath: row.relPath, name: row.name, isDir: false },
                    at: { x: event.clientX, y: event.clientY },
                  })
                }}
              >
                <td>
                  {/* The star sits beside the name, not in a date column: a mark that
                      says "this document" belongs with the document's own name.
                      A flex row lets the link truncate while the star keeps its width,
                      so a long file name ellipsises instead of pushing the star out of
                      view. */}
                  <span className={styles.titleCell}>
                    {/* The title is the link and the rest of the row is data, so the
                        control belongs inside the cell rather than wrapping the row.
                        `Button` would paint a bordered control where this reads as a
                        link.

                        The `Tooltip` is what makes the ellipsis honest: a truncated name
                        is unreadable in the one place a reader needs to tell two
                        documents apart, so hovering has to reveal it. `portal` keeps the
                        bubble out of the table's own clipping. */}
                    <Tooltip label={row.name} side="top">
                      <button
                        type="button"
                        className={styles.rowLink}
                        onClick={() => { props.onOpen(row.relPath) }}
                      >
                        {row.name}
                      </button>
                    </Tooltip>
                    {props.isFavorite?.(row.relPath) === true && (
                      <span
                        className={styles.favoriteMark}
                        aria-label={c('favoriteMark')}
                        title={c('favoriteMark')}
                      >
                        ★
                      </span>
                    )}
                  </span>
                </td>
                <td className={styles.muted}>{locationOfPath(row.location)}</td>
                {/* Ownership follows the bucket the document sits in, not a guess
                    from its name: shared documents belong to everyone, a department
                    folder to that department, and a personal folder to its owner. */}
                <td>
                  <Tag tone="quiet">
                    {ownerLabelOf(
                      row.relPath,
                      {
                        callerId: props.callerId,
                        departmentCode: props.departmentCode,
                        departmentName: props.departmentName,
                      },
                      {
                        global: c('ownerGlobal'),
                        self: c('ownerSelf'),
                        unknown: row.relPath.startsWith('department/') ? c('bucketDepartment') : c('bucketPersonal'),
                      },
                    ).label}
                  </Tag>
                </td>
                <td className={styles.muted}>{formatStamp(row.mtimeMs, locale)}</td>
                <td className={styles.muted}>{formatStamp(row.mtimeMs, locale)}</td>
                <td>
                  {(() => {
                    const status = rowStatus[row.relPath]
                    if (status === undefined) return <span className={styles.muted}>—</span>
                    const label = status.kind === 'index'
                      ? (status.state === 'done' ? c('homeStatusIndexed') : c('homeStatusNotIndexed'))
                      : (status.state === 'done' ? c('homeStatusExtracted') : c('homeStatusNotExtracted'))
                    return (
                      <button
                        type="button"
                        className={styles.statusButton}
                        data-kb-status={status.kind + ':' + status.state}
                        onClick={() => { setStatusDetail({ row, status }) }}
                      >
                        <Tag tone={status.state === 'done' ? 'success' : 'quiet'}>{label}</Tag>
                      </button>
                    )
                  })()}
                </td>
                {/* The actions column. Three controls, each with its own accessible
                    name: an icon-only button without one is unusable by keyboard and
                    invisible to a screen reader. */}
                <td className={styles.actionsCell}>
                  <span className={styles.rowActions}>
                    <Tooltip label={props.isFavorite?.(row.relPath) === true ? c('actionUnfavorite') : c('actionFavorite')} side="top">
                      <button
                        type="button"
                        className={props.isFavorite?.(row.relPath) === true ? styles.iconButtonOn : styles.iconButton}
                        aria-label={props.isFavorite?.(row.relPath) === true ? c('actionUnfavorite') : c('actionFavorite')}
                        aria-pressed={props.isFavorite?.(row.relPath) === true}
                        onClick={() => { props.onFavorite?.(row.relPath, props.isFavorite?.(row.relPath) !== true) }}
                      >
                        {props.isFavorite?.(row.relPath) === true ? '★' : '☆'}
                      </button>
                    </Tooltip>
                    <Tooltip label={c('actionShare')} side="top">
                      <button
                        type="button"
                        className={styles.iconButton}
                        aria-label={c('actionShare')}
                        onClick={() => { setShareTarget({ relPath: row.relPath, name: row.name, isDir: false }) }}
                      >
                        {/* A share knot: three nodes joined, drawn inline so this control
                            adds no dependency for one glyph. */}
                        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                          <circle cx="12" cy="3.4" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="4" cy="8" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
                          <circle cx="12" cy="12.6" r="1.9" fill="none" stroke="currentColor" strokeWidth="1.2" />
                          <path d="M5.7 7.1 10.3 4.3M5.7 8.9l4.6 2.8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                      </button>
                    </Tooltip>
                    <Tooltip label={c('actionDelete')} side="top">
                      <button
                        type="button"
                        className={styles.iconButtonDanger}
                        aria-label={c('actionDelete')}
                        disabled={deletingPath === row.relPath}
                        onClick={() => { void removeRow(row) }}
                      >
                        {/* A bin: lid, body, handle. */}
                        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                          <path d="M3 4.4h10M6.3 4.4V3.1h3.4v1.3M4.3 4.4l.6 8.2a1 1 0 0 0 1 .9h4.2a1 1 0 0 0 1-.9l.6-8.2" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </Tooltip>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        )}

        {/* The pager for the document table.

            Rendered on the same condition the audit trail uses (`needsPager`), so the
            control appears exactly when there is more than one page -- a pager reading
            "1 / 1" is noise on a short list.

            The counts come from `docPageRows`, which clamps the page, so the label always
            describes a page that exists. */}
        {tab !== 'shared' && needsPager(visible.length, DEFAULT_PAGE_SIZE) && (
          <div className={styles.docPager}>
            <Button
              variant="ghost"
              size="sm"
              disabled={docPageRows.page <= 1}
              onClick={() => { setDocPage(docPageRows.page - 1) }}
            >
              {c('auditPagePrev')}
            </Button>
            <span className={styles.muted}>
              {c('auditPageOf')
                .replace('{page}', String(docPageRows.page))
                .replace('{pages}', String(docPageRows.pageCount))}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={docPageRows.page >= docPageRows.pageCount}
              onClick={() => { setDocPage(docPageRows.page + 1) }}
            >
              {c('auditPageNext')}
            </Button>
          </div>
        )}

        {/* The Share tab is two tables, not one: the two directions answer different
            questions and are paged separately. Each block states its own empty case,
            because "nobody has shared with you" and "you have shared nothing" are
            different facts and a shared empty message would blur them. */}
        {tab === 'shared' && (
          <div className={styles.shareWrap}>
            {shareError !== undefined && <p className={styles.shareError} role="alert">{shareError}</p>}
            {shareLoading && share === null && <p className={styles.muted}>{c('loading')}</p>}
            {share !== null && (
              <ShareTable
                t={c}
                rows={pagedShare.rows}
                page={pagedShare.page}
                pageCount={pagedShare.pageCount}
                total={pagedShare.total}
                onPage={setSharePage}
                empty={c('shareEmpty')}
                unknownAudience={c('shareUnknownAudience')}
                relationOf={row => shareRelationText(row, c('shareReceivedRelation'), c('shareGivenRelation'))}
              />
            )}
          </div>
        )}
        </div>
      </div>

      {/* One menu for the whole table, mounted outside the scroll container so it is
          not clipped by it. Rows are re-read often; a menu owned by a row would unmount
          mid-interaction. */}
      <KnowledgeShareDialog
        relPath={shareTarget === null ? null : shareTarget.relPath}
        isDir={false}
        copy={shareCopy}
        onClose={() => { setShareTarget(null) }}
        onShared={() => {
          setShareTarget(null)
          void refreshRows()
        }}
      />

      <KnowledgeContextMenu
        target={menu?.target ?? null}
        at={menu?.at ?? null}
        t={c}
        shareCopy={shareCopy}
        pinned={menu === null ? false : props.isPinned?.(menu.target.relPath) === true}
        favorite={menu === null ? false : props.isFavorite?.(menu.target.relPath) === true}
        clipboard={clipboard}
        // Every row here is a file, so a paste lands beside it in its own directory.
        pasteInto={menu === null ? null : (menu.target.relPath.includes('/')
          ? menu.target.relPath.slice(0, menu.target.relPath.lastIndexOf('/'))
          : '')}
        onOpen={(path) => { props.onOpen(path) }}
        onClose={() => { setMenu(null) }}
        canManageGrants={props.canManageGrants === true}
        onGrant={(path) => { props.onGrant?.(path) }}
        onPin={(path, pinned) => { props.onPin?.(path, pinned) }}
        onFavorite={(path, favorite) => { props.onFavorite?.(path, favorite); void refreshRows() }}
        onReference={(path, isDir) => { props.onReference?.(path, isDir) }}
        onClipboard={(entry) => { setClipboard(entry) }}
        onRenamed={() => { void refreshRows() }}
        onDeleted={() => { void refreshRows() }}
        onMoved={() => {
          // A cut consumes the clipboard (its source is gone); a copy keeps it so the
          // same entry can be pasted into a second folder.
          setClipboard(current => (current?.cut === true ? null : current))
          void refreshRows()
        }}
      />

      <Modal
        open={statusDetail !== null}
        onClose={() => { setStatusDetail(null) }}
        title={statusDetail === null ? '' : statusDetail.row.name}
        closeLabel={c('statusClose')}
        footer={<Button variant="ghost" onClick={() => { setStatusDetail(null) }}>{c('statusClose')}</Button>}
      >
        {statusDetail === null ? null : (
          <dl className={styles.statusDetail}>
            <dt>{c('statusFileName')}</dt><dd>{statusDetail.row.name}</dd>
            <dt>{c('statusPath')}</dt><dd>{statusDetail.row.relPath}</dd>
            <dt>{c('statusType')}</dt>
            <dd>{isTextDocument(statusDetail.row.name) ? c('statusTypeText') : c('statusTypeNonText')} · {statusDetail.row.name.slice(statusDetail.row.name.lastIndexOf('.') + 1)}</dd>
            <dt>{c('statusExtract')}</dt>
            <dd>{statusDetail.status.kind === 'extract'
              ? (statusDetail.status.state === 'done' ? c('homeStatusExtracted') : c('homeStatusNotExtracted'))
              : '—'}</dd>
            <dt>{c('statusExtractTime')}</dt><dd>—</dd>
            <dt>{c('statusMdSize')}</dt><dd>—</dd>
            <dt>{c('statusIndex')}</dt>
            <dd>{statusDetail.status.index === undefined
              ? (statusDetail.status.kind === 'index' ? (statusDetail.status.state === 'done' ? c('homeStatusIndexed') : c('homeStatusNotIndexed')) : '—')
              : (statusDetail.status.index.found ? c('homeStatusIndexed') : c('homeStatusNotIndexed'))}</dd>
            <dt>{c('statusIndexTime')}</dt>
            <dd>{statusDetail.status.index?.indexedAt === undefined ? '—' : new Date(statusDetail.status.index.indexedAt).toLocaleString()}</dd>
            <dt>{c('statusChunks')}</dt>
            <dd>{statusDetail.status.index?.chunks === undefined ? '—' : String(statusDetail.status.index.chunks) + ' · #' + String(statusDetail.status.index.docId ?? '—')}</dd>
            <dt>{c('statusFailure')}</dt><dd>—</dd>
          </dl>
        )}
      </Modal>
    </div>
  )
}
