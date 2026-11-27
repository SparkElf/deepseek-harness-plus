/**
 * A directory listing with the modification time each entry carries.
 *
 * The row is the file explorer's own row from `dsh-better-sidebar`, copied from
 * `src/client/FileTree.tsx` (`FileRow`/`DirRow`) and `src/client/sidebar.module.css`
 * (`.explorerRow`): the same `div[role=button]`, the same 14px glyph, the same
 * ellipsised name, the same trailing modified time that yields its right edge to
 * the same hover-revealed `@` reference button, and the same `depth * 22 + 6`
 * indent. A reader sees that tree in this window's right sidebar, so a second
 * design beside it reads as bolted on -- which is why this is a copy rather than
 * a re-drawing.
 *
 * What the borrowed tree cannot carry is why this list exists. Its host entry
 * shape (`FsEntry`: name, path, isDir, hidden, isSymlink, broken) has no
 * timestamp, so a row built from it can never show when a document last changed;
 * and its rows decide visibility from a shared curated store rather than from
 * per-user grants. This panel reads the same directories through the plugin's own
 * route, which stats each child, and its row carries a right-click into the grant
 * form the tree has no place for.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import { isFileDrag, planDrop, readDroppedFiles, summarizeDrop } from './useFileDrop.ts'
import {
  FileTypeIcon,
  IconFolderOpen16,
  IconArchiveOutline20,
  IconPlusOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './KnowledgeListing.module.css'
import { filterLevel, normaliseNeedle } from './listingFilter.ts'
import { KnowledgeLoading } from './KnowledgeLoading.tsx'
import {
  KnowledgeContextMenu,
  type ContextTarget,
  type TreeClipboard,
} from './KnowledgeContextMenu.tsx'
import { shareCopyFor } from './knowledgeMenuCopy.ts'

/** One entry, as the Host returns it. */
interface Entry {
  /** Path relative to the mount point. */
  relPath: string
  /** Name alone. */
  name: string
  /** Whether this entry is a directory. */
  isDir: boolean
  /** Last-modified instant in Unix ms. */
  mtimeMs?: number
  /** Size in bytes for files. */
  size?: number
  /** Whether the caller may read this path, as DataOps resolved it. */
  readable?: boolean
  /** Child count for a directory row. */
  childCount?: number
}

/** Props for the listing panel. */
export interface KnowledgeListingProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Called with a chosen path so the page can show its preview. */
  onOpen: (path: string) => void
  /** Re-read trigger, so a rescan from elsewhere refreshes this too. */
  refreshTick?: number
  /** Locale tag, so dates match the reader's language. */
  locale?: string
  /**
   * Open the permission surface for one path.
   *
   * Exists because the borrowed tree's context menu is built inside it with no way
   * to add a row, so the grant entry lives here instead: this is the plugin's own
   * listing, where a right-click can mean what the knowledge base needs it to mean.
   */
  onGrant?: (path: string) => void
  /**
   * Insert one row's reference into the conversation draft.
   *
   * The borrowed tree reveals this affordance on hover; the listing mirrors that so
   * a reader gets the same `@` action from either tree.
   */
  onReference?: (path: string, isDir: boolean) => void
  /**
   * Pin or unpin one row.
   *
   * Omitted by a caller that has no pin store, which is how the search results list
   * stays free of an action that would only make sense inside the tree.
   */
  onPin?: (path: string, pinned: boolean) => void
  /** Whether one path is currently pinned, so the row can mark it. */
  isPinned?: (path: string) => boolean
  /**
   * Star or unstar one row.
   *
   * Omitted by a caller with no favourites store, which is how the search results list
   * stays free of an entry that would only make sense inside the tree. A folder is
   * favoured the same way a file is: the star marks a row, not a document.
   */
  onFavorite?: (path: string, favorite: boolean) => void
  /** Whether one path is currently favourited, so the row can draw its star. */
  isFavorite?: (path: string) => boolean
  /**
   * The path a paste would land in, given the row this menu was opened on.
   *
   * A directory row pastes INTO itself; a file row pastes beside itself. Kept a
   * callback rather than derived in the menu because only the listing knows whether a
   * row is the tree's root, which has no parent to paste beside.
   */
  pasteTargetFor?: (relPath: string, isDir: boolean) => string | null
  /**
   * Upload external files dropped onto a directory row.
   *
   * Distinct from the row-to-row move handled above: a file dragged in from the
   * desktop carries no `KB_DRAG_MIME`, so it is the only case this callback serves.
   * Omitted by a read-only caller, which keeps the rows from accepting a drop that
   * would then be refused on the Host.
   * @param relPath - the directory the files were dropped onto.
   * @param files - the dropped files with paths relative to that directory.
   */
  onUpload?: (relPath: string, files: readonly { file: unknown; relativePath: string }[]) => void
  /**
   * Called after a menu-driven delete or paste succeeded.
   *
   * Both change paths this component is currently holding -- a delete removes one, a
   * paste adds one and empties another -- so the page has to reload rather than the
   * component guessing which levels moved.
   */
  onTreeChanged?: () => void
  /**
   * Called after a rename succeeded, so the page reloads the tree.
   *
   * The listing cannot reload itself: it reads through `refreshTick`, which the page
   * owns, and a rename changes the paths this component is currently holding.
   */
  onRenamed?: () => void
  /**
   * Render one row's action as "unpin" rather than "pin".
   *
   * The pinned band lists paths that are already pinned, so every row there offers
   * the opposite action; deriving it from a flag keeps one row shape for both bands.
   */
  unpinOnly?: boolean
  /**
   * Narrow the tree to rows whose name contains this text.
   *
   * Filtering happens over the rows already read, so it costs no request: the tree
   * section header's search is the in-place narrowing, while the rail's field is the
   * cross-directory search. A filter that matched nothing read as an empty tree, so
   * the two empty states are kept apart.
   */
  filter?: string
  /**
   * Start with every directory expanded.
   *
   * Used by the pinned band, where a pinned folder is only useful if its contents
   * are already visible.
   */
  expandAll?: boolean
  /**
   * Restrict the rows to these pinned paths and their ancestors.
   *
   * The pinned band is a list of pins, not a second copy of the whole tree: without
   * this the band rendered every top-level entry and called all of them pinned.
   */
  pinnedPaths?: readonly string[]
  /**
   * The action offered when the tree genuinely holds no documents.
   *
   * Distinct from a filter that matched nothing: an empty tree wants a way to make
   * a document, while an unmatched filter wants a different search term.
   */
  emptyAction?: ReactNode
  /**
   * Move one entry into a directory, or pin it when the target is the pin band.
   *
   * Omitted by a caller that must stay read-only, which is how the search results
   * list keeps its rows free of a gesture the Host would refuse there.
   */
  onMove?: (from: string, toDirectory: string) => void
  /**
   * The layout to render. `list` is the tree; `grid` is the document cards.
   *
   * Defaults to the tree so a caller that does not persist a preference behaves
   * exactly as it did before the card view existed.
   */
  viewMode?: 'list' | 'grid'
  /**
   * Enter multi-select. A callback rather than internal state because the batch
   * bar's actions are the host's (they move and pin through the same routes a
   * single drag uses), so the selection has to be visible to it.
   */
  onSelectionChange?: (paths: readonly string[]) => void
  /** The current selection, so a batch action can act on it. */
  selection?: readonly string[]
}

/**
 * The explorer's `formatModified`, copied: the clock for a file touched today,
 * the date otherwise. A relative span reads well for the recent past but hides
 * which of two old documents is newer, and a listing is usually scanned for that.
 * @param mtimeMs - the instant, in Unix ms.
 * @returns A short fixed-width label, or an empty string for an unreadable stamp.
 */
function formatModified(mtimeMs: number): string {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  const now = new Date()
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  return sameDay
    ? String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0')
    : String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0')
}

/**
 * The explorer's `formatModifiedTitle`: the full stamp behind the row's tooltip.
 * @param mtimeMs - the instant, in Unix ms.
 * @param locale - locale tag for the absolute form.
 * @returns The locale string, or an empty string for an unreadable timestamp.
 */
function formatModifiedTitle(mtimeMs: number, locale: string): string {
  const date = new Date(mtimeMs)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(locale.startsWith('zh') ? 'zh-CN' : 'en-US')
}

/**
 * The drag payload's MIME type.
 *
 * Exported because the drop target that pins is NOT in this component: the pin
 * band lives in the panel, and the two have to agree on the name of the thing
 * being carried. The native drag payload is used rather than lifted React state
 * for exactly that reason -- it crosses the component boundary the gesture
 * crosses, without the panel having to hold a second copy of the tree's state.
 */
export const KB_DRAG_MIME = 'application/x-dsh-kb-path'

/** The dragged path, or null when the payload was not this list's. */
function readDragPayload(transfer: DataTransfer | null): { relPath: string; isDir: boolean } | null {
  if (transfer === null) return null
  const raw = transfer.getData(KB_DRAG_MIME)
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw) as { relPath?: unknown; isDir?: unknown }
    if (typeof parsed.relPath !== 'string') return null
    return { relPath: parsed.relPath, isDir: parsed.isDir === true }
  } catch {
    return null
  }
}

/**
 * Render the listing for the mount's top level, and one level per expanded
 * directory.
 * @param props - copy resolver and the open callback.
 * @returns The listing panel.
 */
export function KnowledgeListing(props: KnowledgeListingProps) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [open, setOpen] = useState<readonly string[]>([])
  const [children, setChildren] = useState<Record<string, Entry[]>>({})
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  /** The path a drag is currently hovering, so the row can show the drop target. */
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined)
  /** Whether this listing accepts files dragged in from outside the page. */
  const uploadable = props.onUpload !== undefined
  // The open context menu: which row, and where the pointer was. Both are needed because
  // the menu is positioned from the pointer, not from the row's own control.
  const [menu, setMenu] = useState<{ target: ContextTarget; at: { x: number; y: number } } | null>(null)
  /** The path being dragged, so a row cannot be dropped into itself. */
  const dragSource = useRef<string | undefined>(undefined)
  /**
   * The cut/copied entry, held for the clipboard's lifetime.
   *
   * Client state, not a Host write: nothing about a pending paste is worth persisting,
   * and a clipboard that survived a reload would be a paste the reader could no longer
   * see they had armed. Paste always goes through `move`, so a copy request currently
   * behaves as a move request -- the menu says which one it is in the label.
   */
  const [clipboard, setClipboard] = useState<TreeClipboard | null>(null)
  /** Locale-resolved copy for the share dialog, whose strings are dialog-specific. */
  const shareCopy = useMemo(() => shareCopyFor(props.locale), [props.locale])

  const read = useCallback(async (path: string): Promise<Entry[]> => {
    const response = await fetch(kbApiPath(KB_API.list), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
      cache: 'no-store',
    })
    if (!response.ok) throw new Error(String(response.status))
    // A 2xx with a non-JSON body must not surface a JSON.parse message as the reason the
    // listing failed; the helper turns it into a readable HTTP description.
    const body = await readKnowledgeJson<{ entries?: Entry[] }>(response)
    if (body.error !== undefined) throw new Error(body.error)
    return body.entries ?? []
  }, [])

  useEffect(() => {
    let cancelled = false
    setState('loading')
    void read('').then((rows) => {
      if (cancelled) return
      setEntries(rows)
      setState('ready')
    }).catch(() => { if (!cancelled) setState('error') })
    return () => { cancelled = true }
  }, [read, props.refreshTick])

  // A pinned folder is only useful with its contents already showing, so the
  // pinned band opens every directory it was handed.
  useEffect(() => {
    if (props.expandAll !== true) return
    setOpen((current) => {
      const added = entries.filter(entry => entry.isDir).map(entry => entry.relPath)
      const next = [...current]
      for (const path of added) if (!next.includes(path)) next.push(path)
      return next.length === current.length ? current : next
    })
  }, [props.expandAll, entries])

  // The grid has no collapsing: a card names its own folder, so a folder the
  // reader never opened would only hide documents the layout can show. Every
  // directory is therefore marked open while the grid is up, which is what makes
  // the level effect below read them.
  useEffect(() => {
    if (props.viewMode !== 'grid') return
    setOpen((current) => {
      const all = new Set(current)
      const sweep = (rows: Entry[]): void => {
        for (const entry of rows) {
          if (!entry.isDir) continue
          all.add(entry.relPath)
          const kids = children[entry.relPath]
          if (kids !== undefined) sweep(kids)
        }
      }
      sweep(entries)
      const next = [...all]
      return next.length === current.length ? current : next
    })
  }, [props.viewMode, entries, children])

  // Expanded directories keep their own children, so collapsing and reopening one
  // does not re-read it.
  useEffect(() => {
    let cancelled = false
    for (const path of open) {
      if (children[path] !== undefined) continue
      void read(path).then((rows) => {
        if (cancelled) return
        setChildren(current => ({ ...current, [path]: rows }))
      }).catch(() => { /* a failed level simply shows nothing */ })
    }
    return () => { cancelled = true }
  }, [open, children, read])

  const locale = props.locale ?? 'zh-CN'
  /** Dragging is offered only where a move can actually be performed. */
  const draggable = props.onMove !== undefined
  /** Multi-select is offered only where a batch action exists to consume it. */
  const selectable = props.onSelectionChange !== undefined
  const selected = props.selection ?? []
  const selectionOn = selected.length > 0

  /**
   * Toggle a directory, or open a file.
   *
   * The explorer splits this between its file and directory rows; one row shape
   * here covers both, so the branch lives in one place and the click and keyboard
   * paths share it.
   */
  const activate = (entry: Entry): void => {
    if (entry.isDir) {
      setOpen(current => current.includes(entry.relPath)
        ? current.filter(item => item !== entry.relPath)
        : [...current, entry.relPath])
      return
    }
    props.onOpen(entry.relPath)
  }

  /**
   * Render one row, indented by depth.
   *
   * Copied from the explorer's `FileRow`/`DirRow`: the same element, then the
   * leading 14px glyph, then the name, then the time, then the reference button.
   * The permission lamp and the size column this list used to carry are gone:
   * neither exists in the tree this row is copied from, and an unreadable path is
   * removed on the Host rather than drawn as a marker.
   */
  const row = (entry: Entry, depth: number) => (
    <div
      key={entry.relPath}
      role="button"
      tabIndex={0}
      className={entry.isDir ? styles.entry + ' ' + styles.entryDir : styles.entry}
      // The explorer's own indent step: 22px per level plus its 6px inset.
      style={{ paddingLeft: depth * 22 + 6 }}
      title={entry.relPath}
      // The drop target's own class, copied from the explorer's
      // `.explorerRowDropTarget`: a dashed outline and the accent hover fill, so a
      // folder under the pointer reads as the destination.
      {...(dropTarget === entry.relPath ? { 'data-drop-target': 'true' } : {})}
      {...(draggable ? { draggable: true } : {})}
      onDragStart={draggable ? (event) => {
        dragSource.current = entry.relPath
        event.dataTransfer.effectAllowed = 'move'
        // Both a custom type and text/plain: the custom one is what the pin band
        // and the rows read, and the plain one keeps the drag legible to anything
        // else on the page that accepts a drop.
        event.dataTransfer.setData(KB_DRAG_MIME, JSON.stringify({ relPath: entry.relPath, isDir: entry.isDir }))
        event.dataTransfer.setData('text/plain', entry.relPath)
      } : undefined}
      onDragEnd={draggable ? () => {
        dragSource.current = undefined
        setDropTarget(undefined)
      } : undefined}
      onDragOver={(entry.isDir && (draggable || uploadable)) ? (event) => {
        // An external file drag (a desktop file) and an in-list row drag arrive on the
        // same row. `Files` in `types` is what separates them: only the external one
        // has it, and only during `dragover` is `types` readable at all.
        if (isFileDrag(event.dataTransfer?.types)) {
          if (!uploadable) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          if (dropTarget !== entry.relPath) setDropTarget(entry.relPath)
          return
        }
        const source = dragSource.current
        // A folder cannot be dropped into itself, and dropping a path back into
        // its own parent is a no-op that would still cost a round trip.
        if (source === undefined || source === entry.relPath) return
        if (source.startsWith(entry.relPath + '/')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (dropTarget !== entry.relPath) setDropTarget(entry.relPath)
      } : undefined}
      onDragLeave={entry.isDir && draggable ? () => {
        // Only clears when this row is still the marked one: moving between a
        // parent row and its own child fires leave-then-over, and clearing
        // unconditionally would flicker the highlight off.
        setDropTarget(current => (current === entry.relPath ? undefined : current))
      } : undefined}
      onDrop={(entry.isDir && (draggable || uploadable)) ? (event) => {
        setDropTarget(undefined)
        // An external file drop uploads; anything else is the in-list move below.
        if (isFileDrag(event.dataTransfer?.types)) {
          if (!uploadable) return
          event.preventDefault()
          // `readDroppedFiles` must be called from the drop handler itself: the
          // dataTransfer enters protected mode once this dispatch ends.
          void readDroppedFiles(event.dataTransfer).then((files) => {
            const plan = planDrop({ relativePath: entry.relPath, isDirectory: true, drops: true }, {
              hasFiles: files.length > 0,
              files,
            })
            if (plan.kind === 'upload') props.onUpload?.(plan.directory, plan.files)
          })
          return
        }
        event.preventDefault()
        const payload = readDragPayload(event.dataTransfer)
        dragSource.current = undefined
        if (payload === null) return
        if (payload.relPath === entry.relPath) return
        // Refuses a folder dropped into its own descendant, which the kernel would
        // answer with EINVAL; catching it here keeps the error out of the tree.
        if (payload.isDir && entry.relPath.startsWith(payload.relPath + '/')) return
        props.onMove?.(payload.relPath, entry.relPath)
      } : undefined}
      onClick={() => { activate(entry) }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          activate(entry)
        }
      }}
      onContextMenu={(event) => {
        // A real menu, at the pointer. It carries the permission entry the old
        // right-click jumped straight to, plus the actions a file list is expected to
        // offer (save, rename, pin, reference).
        event.preventDefault()
        setMenu({
          target: { relPath: entry.relPath, name: entry.name, isDir: entry.isDir },
          at: { x: event.clientX, y: event.clientY },
        })
      }}
    >
      <span className={styles.entryGlyph} aria-hidden="true">
        {entry.isDir
          // The explorer draws a directory with the one folder glyph the host ships.
          ? <IconFolderOpen16 size={14} />
          : <FileTypeIcon path={entry.name} size={14} />}
      </span>
      {/* Multi-select. Drawn only while a selection is live, so the ordinary tree
          keeps the explorer's row metrics exactly (task-16 measured them against
          `.explorerRow`) and gains no column a reader did not ask for. */}
      {selectable && selectionOn && (
        <input
          type="checkbox"
          className={styles.entryCheck}
          checked={selected.includes(entry.relPath)}
          aria-label={entry.name}
          onChange={(event) => { event.stopPropagation(); toggleSelected(entry.relPath) }}
          onClick={(event) => { event.stopPropagation() }}
        />
      )}
      <span className={styles.entryName}>{entry.name}</span>
      {/* Favourites star, immediately BEFORE the date column.
          The reader asked for exactly that placement: the star is a mark on the row
          the reader recognises, and putting it after the timestamp would leave it
          floating at the row's trailing edge where the hover actions live and the
          eye no longer reads it as belonging to the name. `margin-left: auto` on
          `.entryTime` still pushes the pair to the right edge, so the column stays
          aligned with rows that carry no star. */}
      {props.isFavorite?.(entry.relPath) === true && (
        <span
          className={styles.entryFavorite}
          aria-label={props.t('favoriteMark')}
          title={props.t('favoriteMark')}
        >
          ★
        </span>
      )}
      {entry.mtimeMs !== undefined && (
        <span className={styles.entryTime} title={formatModifiedTitle(entry.mtimeMs, locale)}>
          {formatModified(entry.mtimeMs)}
        </span>
      )}
      {/* Native, because these appear inside a row that is itself a button: a
          nested `Button` would add its own padding and background to a 20px
          hover affordance and break the row's single-line height. */}
      {props.onReference !== undefined && (
        <button
          type="button"
          className={styles.entryRef}
          aria-label={props.t('referenceFile')}
          title={props.t('referenceFile')}
          onClick={(event) => {
            // Stops the row's own click: referencing a file must not also open it.
            event.stopPropagation()
            props.onReference?.(entry.relPath, entry.isDir)
          }}
        >
          @
        </button>
      )}
      {props.onPin !== undefined && (
        <button
          type="button"
          className={styles.entryPin}
          aria-label={props.t(props.unpinOnly === true ? 'unpinFile' : 'pinFile')}
          title={props.t(props.unpinOnly === true ? 'unpinFile' : 'pinFile')}
          // The row keeps the affordance visible while the path is pinned, so the
          // state is readable without hovering.
          data-pinned={props.isPinned?.(entry.relPath) === true ? 'true' : undefined}
          onClick={(event) => {
            // Stops the row's own click: pinning must not also open the document.
            event.stopPropagation()
            const next = !(props.isPinned?.(entry.relPath) === true)
            props.onPin?.(entry.relPath, next)
          }}
        >
          {props.unpinOnly === true || props.isPinned?.(entry.relPath) === true
            ? <IconArchiveOutline20 size={14} />
            : <IconPlusOutlineRegular size={14} />}
        </button>
      )}
    </div>
  )

  /**
   * Add or remove one path from the batch selection.
   *
   * Owned by the caller so the batch bar can act on the same list; this only
   * reports the next value.
   */
  const toggleSelected = (relPath: string): void => {
    const next = selected.includes(relPath)
      ? selected.filter(item => item !== relPath)
      : [...selected, relPath]
    props.onSelectionChange?.(next)
  }

  /**
   * Render one document as a card for the grid layout.
   *
   * The grid is a separate class family rather than a re-styling of `.entry`,
   * because the row metrics are a measured copy of the explorer's `.explorerRow`
   * (28px high, 12px ink, an 8px inset) and a card has none of those: reusing the
   * row class would either break that copy or force the card to inherit a height
   * it cannot use. The card carries what the grid is for -- the glyph, the title,
   * where the document lives, and when it changed.
   */
  const card = (entry: Entry) => (
    <li key={entry.relPath} className={styles.cardItem}>
      <div
        role="button"
        tabIndex={0}
        className={entry.isDir ? styles.card + ' ' + styles.cardDir : styles.card}
        title={entry.relPath}
        {...(draggable ? { draggable: true } : {})}
        onDragStart={draggable ? (event) => {
          dragSource.current = entry.relPath
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData(KB_DRAG_MIME, JSON.stringify({ relPath: entry.relPath, isDir: entry.isDir }))
          event.dataTransfer.setData('text/plain', entry.relPath)
        } : undefined}
        onDragEnd={draggable ? () => { dragSource.current = undefined } : undefined}
        onDragOver={entry.isDir && draggable ? (event) => {
          const source = dragSource.current
          if (source === undefined || source === entry.relPath) return
          if (source.startsWith(entry.relPath + '/')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'move'
          setDropTarget(entry.relPath)
        } : undefined}
        onDrop={entry.isDir && draggable ? (event) => {
          event.preventDefault()
          setDropTarget(undefined)
          const payload = readDragPayload(event.dataTransfer)
          dragSource.current = undefined
          if (payload === null || payload.relPath === entry.relPath) return
          if (payload.isDir && entry.relPath.startsWith(payload.relPath + '/')) return
          props.onMove?.(payload.relPath, entry.relPath)
        } : undefined}
        onClick={() => { activate(entry) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            activate(entry)
          }
        }}
      >
        <span className={styles.cardGlyph} aria-hidden="true">
          {entry.isDir
            ? <IconFolderOpen16 size={20} />
            : <FileTypeIcon path={entry.name} size={20} />}
        </span>
        <span className={styles.cardName}>{entry.name}</span>
        {/* The location, which the flat grid loses and the tree implies: without
            it two documents of the same name in different folders are the same
            card. The row path already carries it, so it is derived rather than
            fetched. */}
        <span className={styles.cardMeta}>{entry.relPath.includes('/')
          ? entry.relPath.slice(0, entry.relPath.lastIndexOf('/'))
          : props.t('gridRoot')}</span>
        {entry.mtimeMs !== undefined && (
          <span
            className={styles.cardTime}
            title={formatModifiedTitle(entry.mtimeMs, locale)}
          >
            {formatModified(entry.mtimeMs)}
          </span>
        )}
      </div>
    </li>
  )

  /** One level, plus each expanded child directory's own level. */
  const level = (rows: Entry[], depth: number): JSX.Element[] =>
    rows.map((entry) => {
      const expanded = open.includes(entry.relPath)
      return (
        <li key={entry.relPath}>
          {row(entry, depth)}
          {entry.isDir && expanded && children[entry.relPath] !== undefined && (
            <ul className={styles.entryChildren}>{level(children[entry.relPath] ?? [], depth + 1)}</ul>
          )}
        </li>
      )
    })

  /**
   * The rows a filter leaves, matched on name.
   *
   * A filtered directory keeps its place so the tree still shows where a match
   * lives, and the walk is recursive so a match nested inside a collapsed folder is
   * still found. Kept as a name match rather than a content one because this is the
   * in-place narrowing: reading file bodies is what the rail's own search is for.
   */
  const needle = normaliseNeedle(props.filter ?? '')
  const pinnedSet = useMemo(() => new Set(props.pinnedPaths ?? []), [props.pinnedPaths])
  /** Keep a row when it is pinned or contains a pinned descendant. */
  const restrictPinned = useCallback((rows: Entry[]): Entry[] => {
    if (props.pinnedPaths === undefined) return rows
    return rows.filter(entry => pinnedSet.has(entry.relPath)
      || [...pinnedSet].some(path => path.startsWith(entry.relPath + '/')))
  }, [pinnedSet, props.pinnedPaths])
  const pinnedEntries = useMemo(() => restrictPinned(entries), [entries, restrictPinned])
  // The walk lives in `listingFilter.ts` so its rules can be tested without mounting this
  // component; what stays here is only the memo wiring.
  const visible = useMemo(
    // The rule set lives in the explorer package (`listing-filter.ts`) so the tree and this
    // listing cannot drift apart; what differs between the two is only how a row's children
    // are found, which is the callback below.
    () => filterLevel(pinnedEntries, (entry: Entry) => (entry.isDir ? restrictPinned(children[entry.relPath] ?? []) : undefined), needle),
    [pinnedEntries, children, needle, restrictPinned],
  )

  // The product's shared centered panel state, not a bare grey sentence.
  if (state === 'loading') {
    // The listing is the page's main surface, so the animation stands in for the
    // table rather than a sentence inside it.
    return <KnowledgeLoading label={props.t('loading')} announce={props.t('loading')} />
  }
  if (state === 'error') {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle} role="alert">{props.t('searchFailed')}</p>
      </div>
    )
  }
  // Two different empties, deliberately not merged. An unmatched filter means the
  // reader should change the term, so it keeps a sentence and offers no action. A
  // tree with nothing in it means there is no document yet, so it offers the one
  // entry point that leads to making one.
  if (needle !== '' && visible.length === 0) {
    return (
      <div className={styles.empty} role="status">
        <p className={styles.emptyTitle}>{props.t('filterNoMatch')}</p>
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className={styles.empty} role="status">
        {/* The tree's own wording, not the search-miss one: a tree that holds
            nothing has not failed to match a term, and telling the reader no
            document matches would send them looking for a search box. */}
        <p className={styles.emptyTitle}>{props.t('treeEmpty')}</p>
        {props.emptyAction !== undefined && (
          <div className={styles.emptyAction}>{props.emptyAction}</div>
        )}
      </div>
    )
  }

  // The grid flattens what the tree nests. Every directory is expanded for the
  // walk because a card names its own folder rather than sitting inside one, so a
  // collapsed folder would simply hide documents that the layout has room to show.
  if (props.viewMode === 'grid') {
    const flat: Entry[] = []
    const collect = (rows: Entry[]): void => {
      for (const entry of rows) {
        flat.push(entry)
        if (entry.isDir) {
          const kids = children[entry.relPath]
          if (kids !== undefined) collect(kids)
          // A directory the reader has not opened still has children on the Host;
          // the grid reads them when the level is opened, which the panel does by
          // marking every directory open in grid mode.
        }
      }
    }
    collect(visible)
    return (
      <ul className={styles.cards} data-view-mode="grid">
        {flat.map(entry => card(entry))}
      </ul>
    )
  }

  return (
    <>
      <ul className={styles.entries} data-view-mode="list">{level(visible, 0)}</ul>
      {/* One menu for the whole tree rather than one per row: a row is re-created on every
          parent re-render, and an open menu owned by a row would unmount with it. */}
      <KnowledgeContextMenu
        target={menu?.target ?? null}
        at={menu?.at ?? null}
        t={props.t}
        shareCopy={shareCopy}
        pinned={menu === null ? false : props.isPinned?.(menu.target.relPath) === true}
        favorite={menu === null ? false : props.isFavorite?.(menu.target.relPath) === true}
        clipboard={clipboard}
        pasteInto={menu === null ? null : (props.pasteTargetFor?.(menu.target.relPath, menu.target.isDir) ?? null)}
        onOpen={(path) => { props.onOpen(path) }}
        onClose={() => { setMenu(null) }}
        canManageGrants={props.onGrant !== undefined}
        onGrant={(path) => { props.onGrant?.(path) }}
        onPin={(path, pinned) => { props.onPin?.(path, pinned) }}
        onFavorite={(path, favorite) => { props.onFavorite?.(path, favorite) }}
        onReference={(path, isDir) => { props.onReference?.(path, isDir) }}
        onClipboard={(entry) => { setClipboard(entry) }}
        onRenamed={() => { props.onRenamed?.() }}
        onDeleted={() => { props.onTreeChanged?.() }}
        onMoved={() => {
          // A cut consumes the clipboard: its source path no longer exists, so a second
          // paste would target something gone. A copy keeps it -- pasting one entry into
          // two folders is the ordinary reason to copy rather than cut, and clearing here
          // would make the second paste impossible without re-copying.
          setClipboard(current => (current?.cut === true ? null : current))
          props.onTreeChanged?.()
        }}
      />
    </>
  )
}
