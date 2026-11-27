/**
 * One official dialog behind the Home surface's three create/upload actions, plus the
 * destination picker and name field they all share.
 *
 * The reference had a dropdown per card whose rows opened a browser `window.prompt` for
 * a name and dropped the result into `global/`. Two things were wrong with that: a
 * prompt cannot show where the file will land, and it cannot offer to change it -- so
 * every new document silently published to the one bucket everybody reads.
 *
 * All three actions therefore share one dialog, because they ask the same two questions
 * (what is it called, and where does it go) and differ only in what they write: `create`
 * for a document, `create` with `kind: 'directory'` for a folder, and `upload` per file
 * for an upload. Keeping them together means the validation, the destination default and
 * the keyboard contract cannot drift apart between them.
 *
 * The dialog is a `Modal` and the fields are `Input`/`Button` from the primitives -- no
 * hand-built layer -- so Escape, the mask, focus return and the card chrome all come
 * from the same implementation every other DSH dialog uses. The directory picker reads
 * the live tree one level at a time through the Host's own listing route (`KB_API.list`),
 * so it can never offer a directory the caller may not read, and it takes a
 * `defaultPath` chosen by {@link defaultDestination} rather than guessing.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, FileTypeIcon, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgeCreateDialog.module.css'
import { KnowledgeFileTree } from './KnowledgeFileTree.tsx'
import { resolveUploadDir } from './dropTargetPath.ts'
import type { TreeClipboard } from './KnowledgeContextMenu.tsx'
import type { FileTreeSort } from 'dsh-better-sidebar/src/client/file-tree-sort.ts'

/** One directory level as the Host's listing route reports it. */
interface ListingEntry {
  relPath: string
  name: string
  isDir: boolean
}

/**
 * Where a create or upload should land when the reader has not said otherwise.
 *
 * The order is the whole point of this function, and it is deliberately not
 * "global first":
 *
 * 1. The directory the reader is looking at. If they navigated into
 *    `department/OPS/specs` and then pressed New, that is where they mean -- a
 *    create that jumps elsewhere makes the tree they are reading a lie.
 * 2. The reader's own personal directory. Without a current directory this is the
 *    only bucket that is theirs by construction, so it is the safe default: a file
 *    created there cannot surprise a colleague.
 * 3. `global`, last, and only as a last resort. It is the shared bucket, so
 *    defaulting to it is how a private draft becomes a team announcement.
 *
 * @param currentDir - the tree-relative directory the reader is browsing, if any.
 * @param userId - the caller's DataOps id, from the status route.
 * @returns A tree-relative directory that exists or is expected to.
 */
export function defaultDestination(currentDir: string | undefined, userId: string | undefined): string {
  if (currentDir !== undefined && currentDir !== '') return currentDir
  if (userId !== undefined && userId !== '') return 'personal/' + userId
  return 'global'
}

/**
 * Read one directory level from the Host.
 * @param path - tree-relative path; empty for the mount root.
 * @returns The directory's entries, or an empty list when it cannot be read.
 */
async function listLevel(path: string): Promise<ListingEntry[]> {
  const response = await fetch(kbApiPath(KB_API.list), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path }),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error('HTTP ' + String(response.status))
  const body = await readKnowledgeJson<{ entries?: ListingEntry[] }>(response)
  return (body.entries ?? []).filter(entry => entry.isDir)
}

/** Props for the destination picker. */
export interface KnowledgeDestinationPickerProps {
  /** Tree-relative directory currently selected. */
  value: string
  /** Called with a new tree-relative directory. */
  onChange: (path: string) => void
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Disables the control while the dialog is submitting. */
  disabled?: boolean
}

/**
 * A breadcrumb-style directory chooser: the current path, a way back up, and the
 * subdirectories of the level being shown.
 * @param props - the selected path and its change handler.
 * @returns The picker.
 */
export function KnowledgeDestinationPicker(props: KnowledgeDestinationPickerProps) {
  const { value, onChange, t, disabled } = props
  const [entries, setEntries] = useState<readonly ListingEntry[]>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')

  // Load whichever level is selected, so the list under the breadcrumb is always the
  // children of the path the reader is about to commit to.
  useEffect(() => {
    let cancelled = false
    setState('loading')
    void (async () => {
      try {
        const rows = await listLevel(value)
        if (cancelled) return
        setEntries(rows)
        setState('ready')
      } catch {
        if (cancelled) return
        setEntries([])
        setState('error')
      }
    })()
    return () => { cancelled = true }
  }, [value])

  /** The path one level up, or undefined at the top. */
  const parent = useMemo(() => {
    const cut = value.lastIndexOf('/')
    if (cut === -1) return undefined
    return value.slice(0, cut)
  }, [value])

  /** Segments for the breadcrumb, each carrying the path it stands for. */
  const crumbs = useMemo(() => {
    if (value === '') return []
    const parts = value.split('/')
    return parts.map((part, index) => ({ name: part, path: parts.slice(0, index + 1).join('/') }))
  }, [value])

  const goUp = useCallback((): void => {
    if (parent !== undefined) onChange(parent)
  }, [onChange, parent])

  const resetToRoot = useCallback((): void => { onChange('') }, [onChange])

  return (
    <div className={styles.picker}>
      <div className={styles.pickerBar}>
        <Button variant="ghost" size="sm" disabled={disabled} onClick={resetToRoot}>
          {t('createAtRoot')}
        </Button>
        {crumbs.map((crumb, index) => (
          <span key={crumb.path} className={styles.crumbWrap}>
            <span className={styles.crumbSep} aria-hidden="true">/</span>
            <button
              type="button"
              className={styles.crumb}
              disabled={disabled || index === crumbs.length - 1}
              onClick={() => { onChange(crumb.path) }}
            >
              {crumb.name}
            </button>
          </span>
        ))}
        {parent !== undefined && (
          <Button variant="ghost" size="sm" disabled={disabled} onClick={goUp}>
            {t('createAtUp')}
          </Button>
        )}
      </div>

      {/* The chosen path, always visible: the reader has to be able to read where the
          file will land without inferring it from the breadcrumb. */}
      <p className={styles.pickerPath}>
        <span className={styles.pickerPathLabel}>{t('createDestination')}</span>
        <code className={styles.pickerPathValue}>{'/' + (value === '' ? '' : value)}</code>
      </p>

      <div className={styles.pickerList} role="group" aria-label={t('createDestination')}>
        {state === 'loading' && <p className={styles.pickerMuted}>{t('createLoading')}</p>}
        {state === 'error' && <p className={styles.pickerMuted}>{t('createListingFailed')}</p>}
        {state === 'ready' && entries.length === 0 && (
          <p className={styles.pickerMuted}>{t('createNoSubfolders')}</p>
        )}
        {state === 'ready' && entries.map(entry => (
          <button
            key={entry.relPath}
            type="button"
            className={styles.pickerRow}
            disabled={disabled}
            onClick={() => { onChange(entry.relPath) }}
          >
            {entry.name}
          </button>
        ))}
      </div>
    </div>
  )
}

/** Props for the name field, shared by the document and folder forms. */
export interface KnowledgeNameFieldProps {
  /** What the reader has typed so far. */
  value: string
  /** Called on every keystroke. */
  onChange: (next: string) => void
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Placeholder naming the kind being created. */
  placeholder: string
  /** Set while submitting. */
  disabled?: boolean
  /** A validation message to show under the field. */
  error?: string
}

/**
 * Reject a name this tree cannot store.
 *
 * The rule mirrors the Host's `isContainedRelPath`: a name may not be empty, may not
 * contain a separator (that would silently make the "name" a path), and may not be
 * a traversal segment. Rejecting it here turns a refused request into an inline
 * sentence before the reader presses Create.
 * @param name - the candidate name, without any directory part.
 * @returns A locale key naming the problem, or undefined when the name is fine.
 */
export function validateEntryName(name: string): 'createNameEmpty' | 'createNameSeparator' | 'createNameTraversal' | undefined {
  const trimmed = name.trim()
  if (trimmed === '') return 'createNameEmpty'
  if (trimmed.includes('/') || trimmed.includes('\\')) return 'createNameSeparator'
  if (trimmed === '.' || trimmed === '..') return 'createNameTraversal'
  return undefined
}

/**
 * The name field with its inline validation.
 * @param props - the field's state.
 * @returns The labelled input.
 */
export function KnowledgeNameField(props: KnowledgeNameFieldProps) {
  const { value, onChange, t, placeholder, disabled, error } = props
  return (
    <label className={styles.field}>
      <span className={styles.fieldLabel}>{t('createName')}</span>
      <Input
        value={value}
        placeholder={placeholder}
        aria-label={t('createName')}
        aria-invalid={error !== undefined}
        disabled={disabled}
        onChange={(event) => { onChange(event.target.value) }}
        data-modal-autofocus
      />
      {error !== undefined && <span className={styles.fieldError} role="alert">{t(error)}</span>}
    </label>
  )
}


/** Render one folder row and, when opened, its child folders. */
function FolderNode(props: {
  path: string
  name: string
  depth: number
  value: string
  onChange: (path: string) => void
  disabled?: boolean
}): ReactNode {
  const { path, name, depth, value, onChange, disabled } = props
  const [open, setOpen] = useState(false)
  const [children, setChildren] = useState<ListingEntry[] | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || children !== null || loading) return
    let cancelled = false
    setLoading(true)
    void listLevel(path).then(rows => {
      if (!cancelled) setChildren(rows)
    }).catch(() => {
      if (!cancelled) setChildren([])
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [children, loading, open, path])

  return (
    <li>
      <div className={styles.treeRow} style={{ paddingInlineStart: `${8 + depth * 18}px` }} data-selected={value === path ? 'true' : 'false'}>
        <button
          type="button"
          className={styles.treeToggle}
          aria-label={open ? '收起文件夹' : '展开文件夹'}
          disabled={disabled}
          onClick={() => { setOpen(current => !current) }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ transform: open ? 'rotate(90deg)' : undefined }}>
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        <button
          type="button"
          className={styles.treeName}
          disabled={disabled}
          onClick={() => { onChange(path) }}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          {name}
        </button>
      </div>
      {open && children !== null && children.length > 0 && (
        <ul className={styles.treeChildren}>
          {children.map(child => (
            <FolderNode
              key={child.relPath}
              path={child.relPath}
              name={child.name}
              depth={depth + 1}
              value={value}
              onChange={onChange}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
      {open && loading && <p className={styles.treeMuted} style={{ paddingInlineStart: `${26 + depth * 18}px` }}>加载中…</p>}
    </li>
  )
}

/**
 * Upload destination tree.
 *
 * It is the same `KnowledgeFileTree` the sidebar renders (which is the product's
 * `FileTree`), not a second folder-only widget: rows keep the sidebar's 28px rhythm,
 * 22px indent steps, folder glyphs, hover/selected fills, per-file mtime, and the
 * explorer's context menu. Upload adds one interaction the sidebar does not need:
 * toggling a folder also makes it the destination, painted through `selectedPath`.
 *
 * The mount root is a separate row because the explorer's root row is decorative
 * (`RootRow` has no click handler); everything below it is the real tree.
 */
function UploadDestinationTree(props: {
  root: string
  value: string
  onChange: (path: string) => void
  callerId?: string
  sessionId?: string
  locale?: string
  bucketLabels?: Readonly<Record<string, string>>
  departmentPath?: { codes: readonly string[]; names: readonly string[] }
  sort?: FileTreeSort
  isFavorite?: (relPath: string) => boolean
  onToggleFavorite?: (relPath: string, next: boolean) => void
  onShare?: (relPath: string, isDir: boolean) => void
  onClipboard?: (entry: TreeClipboard) => void
  hasClipboard?: boolean
  onPasteInto?: (directory: string) => void
  disabled?: boolean
  t: (key: string) => string
}): ReactNode {
  const {
    root, value, onChange, callerId, sessionId, locale, bucketLabels, departmentPath, sort,
    isFavorite, onToggleFavorite, onShare, onClipboard, hasClipboard, onPasteInto, disabled, t,
  } = props
  const [expanded, setExpanded] = useState<string[]>([])
  const [favorites, setFavorites] = useState<ReadonlySet<string>>(() => new Set())
  const [localClipboard, setLocalClipboard] = useState<TreeClipboard | null>(null)
  const [treeRefresh, setTreeRefresh] = useState(0)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const relativeOf = useCallback((absolute: string): string | undefined => {
    const base = root.endsWith('/') ? root.slice(0, -1) : root
    if (absolute === base) return ''
    if (!absolute.startsWith(base + '/')) return undefined
    return absolute.slice(base.length + 1)
  }, [root])

  const toggle = useCallback((absolute: string): void => {
    setExpanded(current => current.includes(absolute)
      ? current.filter(item => item !== absolute)
      : [...current, absolute])
    const relPath = relativeOf(absolute)
    if (relPath !== undefined) {
      // A folder row names the virtual bucket `personal`; the write route needs the
      // caller segment, and the dialog should show the real destination it will send.
      onChange(resolveUploadDir(relPath, callerId) ?? relPath)
      setNotice(undefined)
    }
  }, [onChange, relativeOf])

  const pasteLocal = useCallback(async (directory: string): Promise<void> => {
    const clip = localClipboard
    if (clip === null || clip.entries.length === 0) return
    for (const entry of clip.entries) {
      const response = await fetch(kbApiPath(clip.cut ? KB_API.move : KB_API.copy), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: entry.relPath, to: directory }),
        cache: 'no-store',
      })
      if (!response.ok) { setNotice((await response.json().catch(() => ({})) as { error?: string }).error ?? 'HTTP ' + String(response.status)); return }
    }
    if (clip.cut) setLocalClipboard(null)
    setTreeRefresh(t => t + 1)
    setNotice(t('settingsSaved'))
    onPasteInto?.(directory)
  }, [localClipboard, onPasteInto, t])

  return (
    <div className={styles.tree}>
      <KnowledgeFileTree
        sessionId={sessionId ?? '@kb-explorer'}
        root={root}
        locale={locale}
        bucketLabels={bucketLabels}
        departmentPath={departmentPath}
        sort={sort}
        expanded={expanded}
        revealed={[]}
        onToggle={toggle}
        onOpenFile={() => undefined}
        onReferenceFile={() => undefined}
        onUploadRequest={() => undefined}
        busy={disabled === true}
        refreshTick={treeRefresh}
        hideRoot
        selectedPath={value}
        callerId={callerId}
        isFavorite={relPath => (isFavorite ?? (path => favorites.has(path)))(relPath)}
        onToggleFavorite={(relPath, next) => {
          if (onToggleFavorite !== undefined) { onToggleFavorite(relPath, next); return }
          setFavorites(current => {
            const copy = new Set(current)
            if (next) copy.add(relPath); else copy.delete(relPath)
            return copy
          })
        }}
        favoriteMarkLabel={t('actionFavorite')}
        onShare={onShare}
        onClipboard={(entry) => { setLocalClipboard(entry); onClipboard?.(entry) }}
        hasClipboard={localClipboard !== null || hasClipboard === true}
        onPasteInto={(directory) => { if (localClipboard !== null) { void pasteLocal(directory) } else { onPasteInto?.(directory) } }}
        onExtractionQueued={(relPath) => { setNotice(t('menuExtractMarkdown') + ': ' + relPath) }}
        onExtractionFailed={(_relPath, reason) => { setNotice(reason) }}
      />
      {notice !== undefined && <p className={styles.treeNotice} role="status">{notice}</p>}
    </div>
  )
}

// ── the dialog itself ───────────────────────────────────────────────────────────

/**
 * Which of the three flows the dialog is running.
 *
 * `upload-file` and `upload-folder` differ only in how the browser's picker is
 * configured (`webkitdirectory`), not in what the dialog asks; the destination is a
 * single choice for the whole selection, which is what "choose where these go"
 * means.
 */
export type CreateMode = 'new-doc' | 'new-folder' | 'upload-file' | 'upload-folder'

/** One file a reader chose, with the path it should land at. */
export interface PendingUpload {
  /** The file as the browser handed it over. */
  file: File
  /** Its name relative to the picked root: a folder upload keeps its shape. */
  relative: string
}

/** Props for the dialog. */
export interface KnowledgeCreateDialogProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Which flow to run. */
  mode: CreateMode
  /** Close without writing anything. */
  onClose: () => void
  /** The directory the dialog should start in, from {@link defaultDestination}. */
  defaultPath: string
  /** Absolute mount root, for the upload tree (the same root the sidebar uses). */
  root?: string
  /** Caller identity, so personal extraction rows can be addressed authoritatively. */
  callerId?: string
  /** Real session key for the borrowed explorer; absent uses the KB placeholder. */
  sessionId?: string
  /** Locale tag for tree dates and labels. */
  locale?: string
  /** The same bucket labels the sidebar tree takes. */
  bucketLabels?: Readonly<Record<string, string>>
  /** The same department code/name chain the sidebar tree takes. */
  departmentPath?: { codes: readonly string[]; names: readonly string[] }
  /** The same explorer ordering the sidebar tree takes. */
  sort?: FileTreeSort
  isFavorite?: (relPath: string) => boolean
  onToggleFavorite?: (relPath: string, next: boolean) => void
  onShare?: (relPath: string, isDir: boolean) => void
  onClipboard?: (entry: TreeClipboard) => void
  hasClipboard?: boolean
  onPasteInto?: (directory: string) => void
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /**
   * Report the outcome and refresh the caller's listing.
   * @param message - a locale-bound sentence to show under the cards.
   */
  onDone: (message: string) => void
}

/** Join a directory and a name into a tree-relative path. */
function joinRel(directory: string, name: string): string {
  return directory === '' ? name : directory + '/' + name
}

/** Human-readable file size for the upload queue. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * The create/upload dialog.
 * @param props - the flow, its starting directory, and the outcome channel.
 * @returns The dialog, or null while closed.
 */
export function KnowledgeCreateDialog(props: KnowledgeCreateDialogProps) {
  const {
    open, mode, onClose, defaultPath, root, callerId, sessionId, locale, bucketLabels,
    departmentPath, sort, isFavorite, onToggleFavorite, onShare, onClipboard, hasClipboard,
    onPasteInto, t, onDone,
  } = props

  const [name, setName] = useState('')
  const [destination, setDestination] = useState(defaultPath)
  const [pending, setPending] = useState<readonly PendingUpload[]>([])
  const [busy, setBusy] = useState(false)
  /** How many files of the current upload are done, for the progress line. */
  const [progress, setProgress] = useState<{ done: number; total: number } | undefined>(undefined)
  /** A refusal from the Host, shown in the dialog's own words. */
  const [serverError, setServerError] = useState<string | undefined>(undefined)
  /** Whether a file drag is over the drop zone. */
  const [dragOver, setDragOver] = useState(false)
  /** Upload is a two-step flow: choose files, then choose the folder in the tree. */
  const [step, setStep] = useState<1 | 2>(1)
  /** The native picker behind the drop zone; the zone is the visible control. */
  const inputRef = useRef<HTMLInputElement>(null)

  const isUpload = mode === 'upload-file' || mode === 'upload-folder'
  const isFolder = mode === 'new-folder'

  // A fresh open starts from the caller's default destination and an empty name: the
  // previous run's answers belong to a different intent.
  useEffect(() => {
    if (!open) return
    setName('')
    setDestination(defaultPath)
    setPending([])
    setBusy(false)
    setProgress(undefined)
    setServerError(undefined)
    setDragOver(false)
    setStep(1)
  }, [open, defaultPath, mode])

  /** The name as it will be stored: a document gains `.md` when it has no extension. */
  const storedName = useMemo(() => {
    const trimmed = name.trim()
    if (isFolder || isUpload) return trimmed
    return trimmed.endsWith('.md') ? trimmed : trimmed + '.md'
  }, [isFolder, isUpload, name])

  const nameError = useMemo(() => validateEntryName(name), [name])

  /** The absolute-ish target the reader is about to write, for the summary line. */
  const target = useMemo(() => joinRel(destination, storedName), [destination, storedName])

  /** Write a document or a folder through the existing create route. */
  const submitCreate = useCallback(async (): Promise<void> => {
    setBusy(true)
    setServerError(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.create), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ relPath: target, kind: isFolder ? 'directory' : 'file' }),
        cache: 'no-store',
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        // The Host names the reason (no write access, name already taken), so it is
        // shown rather than flattened into "failed".
        setServerError(body.error ?? t('cardCreateFailed'))
        return
      }
      onDone(t('createDone').replace('{path}', target))
      onClose()
    } catch {
      setServerError(t('cardCreateFailed'))
    } finally {
      setBusy(false)
    }
  }, [isFolder, onClose, onDone, t, target])

  /** Write every chosen file, one request each, and report a per-file summary. */
  const submitUpload = useCallback(async (): Promise<void> => {
    if (pending.length === 0) return
    setBusy(true)
    setServerError(undefined)
    setProgress({ done: 0, total: pending.length })
    let done = 0
    const failed: PendingUpload[] = []
    for (const item of pending) {
      try {
        const content = await item.file.text()
        const response = await fetch(kbApiPath(KB_API.upload), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: joinRel(destination, item.relative), content }),
          cache: 'no-store',
        })
        if (response.ok) done += 1
        else failed.push(item)
      } catch {
        failed.push(item)
      }
      // Every completion moves the line, which is what makes a long upload legible.
      setProgress({ done: done + failed.length, total: pending.length })
    }
    setProgress(undefined)
    setBusy(false)
    if (failed.length === 0) {
      onDone(t('uploadDone').replace('{n}', String(done)))
      onClose()
      return
    }
    // Keep the dialog open with only the failures in the queue. Successful files are
    // already written; retrying must not upload them a second time.
    setPending(failed)
    setServerError(
      t('uploadPartial')
        .replace('{ok}', String(done))
        .replace('{failed}', String(failed.length))
        .replace('{names}', failed.slice(0, 3).map(item => item.relative).join('、')),
    )
    onDone(t('uploadPartial')
      .replace('{ok}', String(done))
      .replace('{failed}', String(failed.length))
      .replace('{names}', failed.slice(0, 3).map(item => item.relative).join('、')))
  }, [destination, onClose, onDone, pending, t])

  /** Run whichever flow this dialog is in. */
  const submit = useCallback((): void => {
    if (busy) return
    if (isUpload) {
      if (pending.length === 0) return
      if (step === 1) {
        setStep(2)
        return
      }
      void submitUpload()
      return
    }
    if (nameError !== undefined) return
    void submitCreate()
  }, [busy, isUpload, nameError, pending.length, step, submitCreate, submitUpload])

  /** Enter submits, except while a field is refusing the value. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Enter') return
    // A textarea or a button keeps its own Enter behavior.
    const tag = (event.target as HTMLElement | null)?.tagName
    if (tag === 'TEXTAREA') return
    event.preventDefault()
    submit()
  }, [submit])

  /** The browser's own picker fills the pending list; the dialog decides the path. */
  const chooseFiles = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const chosen = [...(event.target.files ?? [])]
    // Cleared so picking the same files twice fires again.
    event.target.value = ''
    setPending(chosen.map(file => ({
      file,
      // A folder upload carries the picked root plus the file's place inside it, so
      // recreating the shape is the honest reading of "upload this folder".
      relative: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    })))
  }, [])

  /** Accept files dropped on the zone, keeping the same relative-path contract. */
  const dropFiles = useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragOver(false)
    const chosen = [...(event.dataTransfer.files ?? [])]
    if (chosen.length === 0) return
    setPending(chosen.map(file => ({
      file,
      relative: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name,
    })))
  }, [])

  const removePending = useCallback((relative: string): void => {
    setPending(current => current.filter(item => item.relative !== relative))
  }, [])

  const title = isUpload
    ? (mode === 'upload-folder' ? t('homeUploadTitle') : t('cardItemUploadFile'))
    : (isFolder ? t('cardItemNewFolder') : t('cardItemNewDoc'))

  const disabled = busy || (isUpload ? pending.length === 0 : nameError !== undefined)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t('cancel')}
      className={styles.modal}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
          {isUpload && step === 2 && (
            <Button variant="ghost" disabled={busy} onClick={() => { setStep(1) }}>{t('createStepBack')}</Button>
          )}
          <Button
            variant="primary"
            disabled={isUpload && step === 1 ? pending.length === 0 : disabled}
            onClick={() => {
              if (isUpload && step === 1) { setStep(2); return }
              submit()
            }}
          >
            {busy
              ? (progress === undefined
                ? t('cardBusyCreating')
                : t('createProgress').replace('{done}', String(progress.done)).replace('{total}', String(progress.total)))
              : (isUpload ? (step === 1 ? '下一步' : `${t('createUpload')} (${pending.length})`) : t('createSubmit'))}
          </Button>
        </div>
      )}
    >
      <div className={styles.dialog} onKeyDown={onKeyDown}>
        {!isUpload && (
          <KnowledgeNameField
            value={name}
            onChange={setName}
            t={t}
            placeholder={isFolder ? t('createFolderPlaceholder') : t('createDocPlaceholder')}
            disabled={busy}
            error={nameError}
          />
        )}

        {isUpload && step === 1 && (
          <div className={styles.uploadLayout} data-empty={pending.length === 0 ? 'true' : 'false'}>
            <input
              ref={inputRef}
              type="file"
              multiple
              className={styles.visuallyHiddenInput}
              disabled={busy}
              tabIndex={-1}
              {...(mode === 'upload-folder' ? { webkitdirectory: '' } : {})}
              onChange={chooseFiles}
            />
            <div
              className={styles.dropzone}
              data-active={dragOver ? 'true' : 'false'}
              role="button"
              tabIndex={0}
              aria-label={t('createPickFiles')}
              onClick={() => { if (!busy) inputRef.current?.click() }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  if (!busy) inputRef.current?.click()
                }
              }}
              onDragOver={(event) => { event.preventDefault(); setDragOver(true) }}
              onDragLeave={() => { setDragOver(false) }}
              onDrop={dropFiles}
            >
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" />
                <path d="M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
              </svg>
              <span className={styles.dropzoneTitle}>{t('createDropTitle')}</span>
            </div>
            <div className={styles.uploadQueue}>
            {pending.length === 0 ? null : (
              <div className={styles.uploadSummary}>
                <span>{t('createSelectedCount').replace('{n}', String(pending.length))}</span>
                {progress === undefined ? null : <span>{`${progress.done}/${progress.total}`}</span>}
              </div>
            )}
            {pending.length === 0 ? null : (
              <ul className={styles.uploadList}>
                {pending.map(item => (
                  <li key={item.relative} className={styles.uploadRow}>
                    <FileTypeIcon path={item.relative} size={18} />
                    <span className={styles.uploadName} title={item.relative}>{item.relative}</span>
                    <span className={styles.fileTarget} title={joinRel(destination, item.relative)}>{joinRel(destination, item.relative)}</span>
                    <span className={styles.uploadSize}>{formatBytes(item.file.size)}</span>
                    <button
                      type="button"
                      className={styles.removeFile}
                      aria-label={t('createRemoveFile').replace('{name}', item.relative)}
                      disabled={busy}
                      onClick={() => { removePending(item.relative) }}
                    >×</button>
                  </li>
                ))}
              </ul>
            )}
            </div>
          </div>
        )}

        {(!isUpload || step === 2) && (
          <div className={styles.field}>
            {!isUpload && <span className={styles.fieldLabel}>{t('createDestinationPicker')}</span>}
            {isUpload
              ? <UploadDestinationTree
                  root={root ?? '/workspace/kb'}
                  value={destination}
                  onChange={setDestination}
                  callerId={callerId}
                  sessionId={sessionId}
                  locale={locale}
                  bucketLabels={bucketLabels}
                  departmentPath={departmentPath}
                  sort={sort}
                  isFavorite={isFavorite}
                  onToggleFavorite={onToggleFavorite}
                  onShare={onShare}
                  onClipboard={onClipboard}
                  hasClipboard={hasClipboard}
                  onPasteInto={onPasteInto}
                  disabled={busy}
                  t={t}
                />
              : (
                <KnowledgeDestinationPicker
                  value={destination}
                  onChange={setDestination}
                  t={t}
                  disabled={busy}
                />
              )}
          </div>
        )}

        {/* The composed target, restated in full: the two controls above are the
            inputs to it, and this is the answer. */}
        {!isUpload && nameError === undefined && (
          <p className={styles.summary}>{t('createWillCreate').replace('{path}', '/' + target)}</p>
        )}

        {serverError !== undefined && <p className={styles.fieldError} role="alert">{serverError}</p>}
      </div>
    </Modal>
  )
}
