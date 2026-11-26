/**
 * The row context menu for the knowledge tree.
 *
 * A right-click on a row used to jump straight to the permission surface, which meant a
 * reader looking for "save this file" got an operator's dialog instead. The menu is the
 * affordance a file list is expected to have, and it is built on the product's own `Menu`
 * primitive rather than a hand-rolled popover: keyboard walking, Escape, outside click,
 * and post-selection focus return are the primitive's behaviour, and a local copy of that
 * would drift.
 *
 * The menu is positioned from the pointer rather than from an anchor element, which is
 * what the primitive's `getAnchorRect` hook is for: a context menu opens where the reader
 * clicked, not below the row's own control.
 *
 * Every action here is a call to a route that already exists. Sharing is `grant`, the
 * star is `favorites.set`, and paste dispatches on what the clipboard holds: a cut pastes
 * through `move`, a copy through `copy`. Both resolve the destination from the entry's own
 * name, so a paste cannot rename; both carry a directory's whole subtree. The clipboard is
 * a client-side pair of paths and a flag -- nothing about a pending paste is worth a
 * server-side record, and a clipboard that survived a reload would be a paste the reader
 * could no longer see they had armed.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useState } from 'react'
import { Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import { KnowledgeShareDialog, type ShareDialogCopy } from './KnowledgeShareDialog.tsx'
import { batchLabel, batchRowsFor, referenceTargetsFor } from './referenceTargets.ts'

/** One row the menu can act on. */
export interface ContextTarget {
  /** Path relative to the knowledge root. */
  relPath: string
  /** Display name, used as the rename dialog's starting value. */
  name: string
  /** Whether the row is a directory (renaming one renames the directory). */
  isDir: boolean
}

/** The clipboard the copy/cut entries fill. */
export interface TreeClipboard {
  /**
   * Every entry taken, in the order they were selected.
   *
   * A list rather than one path because a multi-row copy is a normal gesture and the
   * paste has to put all of them somewhere. A single-row copy is a one-element list,
   * which is why there is no separate single-row clipboard: one shape means the paste
   * path cannot be right for one row and wrong for five.
   */
  entries: readonly { relPath: string; name: string }[]
  /** True when the source is removed on paste (cut); false for a copy request. */
  cut: boolean
}

/** Props for the context menu. */
export interface KnowledgeContextMenuProps {
  /** The row the menu is open on, or null when closed. */
  target: ContextTarget | null
  /**
   * Every row the menu acts on, when the reader right-clicked inside a multi-selection.
   *
   * Absent or shorter than two means single-row behaviour, which is why the component
   * stays one menu rather than gaining a batch twin: the entries, the handlers and the
   * clipboard are identical, and only the LABELS change to say how many rows they will
   * touch. A second menu is how the two surfaces drifted apart before.
   *
   * `target` is still the row under the pointer -- it anchors the menu and supplies the
   * name used by rename/download, which have no batch meaning.
   */
  selection?: readonly ContextTarget[]
  /** Where the pointer was, in viewport coordinates. */
  at: { x: number; y: number } | null
  /** Copy resolver for this package's namespace. */
  t: (key: string) => string
  /** Copy for the share dialog, which carries its own key set. */
  shareCopy: ShareDialogCopy
  /** Close the menu. */
  onClose: () => void
  /** Open one file for preview. Absent on a surface with no preview. */
  onOpen?: (path: string) => void
  /**
   * Move one row into a destination directory, both tree-relative.
   *
   * The destination is typed by the reader and resolved by the caller, because only the
   * page knows the caller's authoritative `personal/<id>/...` path. Absent means this
   * surface has no move route and the entry is not offered.
   */
  onMove?: (row: ContextTarget, destination: string) => Promise<void> | void
  /** Open the permission surface for this path. */
  onGrant?: (path: string) => void
  /**
   * Whether the caller may manage grants.
   *
   * The permission entry is hidden unless this is exactly true AND `onGrant` is present:
   * a row that opens a surface the backend will refuse is worse than no row, and the
   * answer comes from the Host rather than being derived here.
   */
  canManageGrants?: boolean
  /** Toggle the pin state for this path. */
  onPin: (path: string, pinned: boolean) => void
  /** Whether this path is currently pinned. */
  pinned: boolean
  /** Toggle the favourite state for this path. */
  onFavorite: (path: string, favorite: boolean) => void
  /** Whether this path is currently favourited. */
  favorite: boolean
  /**
   * Insert references into a conversation, via the picker.
   *
   * `targets` is present only for a multi-row selection; the single-row case passes the
   * one path. The picker renders one dialog either way.
   */
  onReference: (path: string, isDir: boolean, targets?: readonly ContextTarget[]) => void
  /** Called after a rename succeeds, so the page reloads the tree. */
  onRenamed: () => void
  /** Called after a delete-to-trash succeeds, so the page reloads the tree. */
  onDeleted: () => void
  /** What the clipboard currently holds, or null when it is empty. */
  clipboard: TreeClipboard | null
  /** Put one entry on the clipboard. Recording only; nothing moves until paste. */
  onClipboard: (entry: TreeClipboard | null) => void
  /**
   * The directory a paste would land in.
   *
   * For a directory row the target is that directory; for a file it is the file's
   * parent. The menu states it so a paste never lands somewhere the reader cannot see,
   * and `null` means the destination is unknown, which disables the entry rather than
   * guessing.
   */
  pasteInto: string | null
  /** Called after a paste succeeds, so the page reloads both affected levels. */
  onMoved: () => void
}

/**
 * Trigger a browser download from a base64 payload.
 *
 * The bytes arrive as JSON (see the Host's `download` route) because the plugin's bridge
 * is JSON-only. Blob + an anchor click is the standard way to save from a page without a
 * second origin request, and `URL.revokeObjectURL` must follow or the blob stays resident
 * for the document's lifetime.
 * @param name - the file name the save dialog suggests.
 * @param base64 - the file's bytes.
 * @param mime - the MIME type to label the blob with.
 */
function saveBase64(name: string, base64: string, mime: string): void {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  // Some engines ignore a click on a detached node, so it joins the document for the
  // duration of the click and is removed immediately after.
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/**
 * The knowledge tree's row context menu.
 * @param props - the target row, the pointer position, and the actions.
 * @returns The menu, or nothing when it is closed.
 */
export function KnowledgeContextMenu(props: KnowledgeContextMenuProps) {
  const { target, at, t, onClose } = props
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /**
   * The row the share dialog is open for, captured when the menu row is chosen.
   *
   * The menu and the dialog have different lifetimes: choosing "Share" closes the menu,
   * and the parent then clears `target` -- so a dialog reading the live target would
   * unmount in the same commit that opened it. Holding the row here is what lets the
   * dialog outlive the menu.
   */
  const [shareTarget, setShareTarget] = useState<ContextTarget | null>(null)

  /**
   * Position the dropdown at the pointer.
   *
   * Recomputed on every frame the primitive asks for, because the pointer does not move
   * once the menu is open: returning the same rect is correct and cheaper than letting
   * the primitive measure a zero-size wrapper.
   */
  const getAnchorRect = useCallback((): DOMRect | null => {
    if (at === null) return null
    return new DOMRect(at.x, at.y, 0, 0)
  }, [at])

  /** Save one file to disk. */
  const download = async (row: ContextTarget): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.download), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: row.relPath }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ name?: string; base64?: string; mime?: string }>(response)
      if (!response.ok || body.error !== undefined || body.base64 === undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      saveBase64(body.name ?? row.name, body.base64, body.mime ?? 'application/octet-stream')
      onClose()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('downloadFailed'))
    } finally {
      setBusy(false)
    }
  }

  /** Rename the row, keeping it in its directory. */
  const rename = async (row: ContextTarget): Promise<void> => {
    // A prompt rather than an inline editor: the tree is a dense list and an inline field
    // would reflow it. The starting value is the current name so a small edit is cheap.
    const next = window.prompt(t('renamePrompt'), row.name)
    if (next === null) { onClose(); return }
    const name = next.trim()
    if (name === '' || name === row.name) { onClose(); return }
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.rename), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ from: row.relPath, name }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ error?: string }>(response)
      if (!response.ok || body.error !== undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      onClose()
      props.onRenamed()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('renameFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Move one row into a typed destination directory.
   *
   * The prompt is the same gesture the batch bar uses, and the page resolves both ends
   * through the caller's authoritative path -- a view path for `personal` omits the
   * owner segment, so sending the view path unchanged would move a path the Host does
   * not know. The caller's handler owns that resolution and reports its own refusal;
   * this component only closes and refreshes on success.
   */
  const move = async (row: ContextTarget): Promise<void> => {
    if (props.onMove === undefined) { onClose(); return }
    const answer = window.prompt(t('moveSelected'), '')
    if (answer === null) { onClose(); return }
    const destination = answer.trim()
    if (destination === '') { onClose(); return }
    setBusy(true); setNotice(undefined)
    try {
      await props.onMove(row, destination)
      onClose()
      props.onMoved()
    } catch (error: unknown) {
      setNotice(t('moveFailed').replace('{reason}', error instanceof Error ? error.message : String(error)))
    } finally {
      setBusy(false)
    }
  }

  /** Remove the row into the caller's own trash. */
  /**
   * Run one request per row and report how many failed.
   *
   * Sequential rather than `Promise.all`: these are writes to a shared export, and
   * firing two hundred of them at once turns one slow request into a stalled tree. The
   * count is what the caller reports -- a batch that half-succeeded must not claim it
   * fully worked, which is the failure mode that made the old single-row paths look
   * fine while doing nothing.
   */
  const forEachRow = async (rows: readonly ContextTarget[], run: (row: ContextTarget) => Promise<unknown>): Promise<number> => {
    let failed = 0
    for (const row of rows) {
      try {
        await run(row)
      } catch {
        failed += 1
      }
    }
    return failed
  }

  /** Favourite or unfavourite every selected row. */
  const favoriteMany = (favorite: boolean): void => {
    // Client state, so this is synchronous: the store coalesces its own write. Doing it
    // through one call per row keeps the single-row path unchanged.
    for (const entry of batch) props.onFavorite(entry.relPath, favorite)
    onClose()
  }

  /** Delete every selected row to the trash, then reload once. */
  const removeMany = async (): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const failed = await forEachRow(batch, async (entry) => {
        const response = await fetch(kbApiPath(KB_API.trashRemove), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ relPath: entry.relPath, kind: entry.isDir ? 'directory' : 'file' }),
          cache: 'no-store',
        })
        const body = await readKnowledgeJson<{ error?: string }>(response)
        if (!response.ok || body.error !== undefined) {
          throw new Error(body.error ?? 'HTTP ' + String(response.status))
        }
      })
      if (failed > 0) {
        // Reload anyway: the rows that DID go must disappear from the tree.
        props.onDeleted()
        setNotice(t('deleteFailed'))
        return
      }
      onClose()
      props.onDeleted()
    } finally {
      setBusy(false)
    }
  }

  /**
   * Put every selected row on the clipboard, for a cut or a copy.
   *
   * One call with the whole list rather than one call per row: the clipboard is a
   * single value, and assigning it repeatedly would leave only the last row on it.
   * A single-row menu passes a one-element list and takes exactly the old path.
   */
  const clipMany = (cut: boolean): void => {
    const rows = batch.length > 0 ? batch : (row === null ? [] : [row])
    if (rows.length === 0) return
    props.onClipboard({
      entries: rows.map(entry => ({ relPath: entry.relPath, name: entry.name })),
      cut,
    })
    onClose()
  }

  const remove = async (row: ContextTarget): Promise<void> => {
    setBusy(true); setNotice(undefined)
    try {
      const response = await fetch(kbApiPath(KB_API.trashRemove), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // `kind` lets the tombstone say a whole directory disappeared rather than a
        // file, which is what the trash page words its rows from.
        body: JSON.stringify({ relPath: row.relPath, kind: row.isDir ? 'directory' : 'file' }),
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<{ error?: string }>(response)
      if (!response.ok || body.error !== undefined) {
        throw new Error(body.error ?? 'HTTP ' + String(response.status))
      }
      onClose()
      props.onDeleted()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('deleteFailed'))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Paste the clipboard entry into this row's directory.
   *
   * The route follows the clipboard's own flag, because those are the two different
   * promises the reader was made: a cut pastes through `move` and the source disappears,
   * a copy through `copy` and the source stays. Doing both with `move` would delete a
   * file the reader asked to duplicate. Both routes resolve the destination name from the
   * source path, so neither can rename, and both carry a directory's whole subtree.
   *
   * The refusal is surfaced rather than swallowed, because a paste that silently did
   * nothing is the one outcome a clipboard must not have.
   */
  const paste = async (): Promise<void> => {
    const clip = props.clipboard
    const into = props.pasteInto
    if (clip === null || into === null || clip.entries.length === 0) return
    setBusy(true); setNotice(undefined)
    try {
      // One request per entry, sequentially. Each is an independent copy/move on the
      // Host, and the destination is the same directory for all of them, so a batch is
      // a loop rather than a new route. The first failure names itself; the rows that
      // already landed stay where they are, because undoing a successful copy would
      // delete a file the reader can see.
      let failed: string | undefined
      for (const entry of clip.entries) {
        const response = await fetch(kbApiPath(clip.cut ? KB_API.move : KB_API.copy), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ from: entry.relPath, to: into }),
          cache: 'no-store',
        })
        const body = await readKnowledgeJson<{ error?: string }>(response)
        if (!response.ok || body.error !== undefined) {
          failed = body.error ?? 'HTTP ' + String(response.status)
          break
        }
      }
      if (failed !== undefined) {
        // The tree changed for whatever did land, so reload before reporting.
        props.onMoved()
        setNotice(failed)
        return
      }
      onClose()
      props.onMoved()
    } catch (error: unknown) {
      setNotice(error instanceof Error ? error.message : t('pasteFailed'))
    } finally {
      setBusy(false)
    }
  }

  // The menu is positioned from the pointer and needs a row; the share dialog is a
  // separate overlay with its own lifetime, so it is rendered even when the menu has
  // already closed (which is exactly what choosing "Share" does). `row` is the
  // non-null view of the target the menu handlers close over.
  const menuOpen = target !== null && at !== null
  const row: ContextTarget | null = menuOpen ? target : null

  const clipboardEmpty = props.clipboard === null || props.pasteInto === null

  /**
   * The rows a batch entry will act on.
   *
   * Empty for a single-row menu, which is how every entry below decides between its
   * one-row and many-row label. `target` stays the row under the pointer regardless.
   */
  // The rows a batch entry covers. Empty means single-row, which is what every entry
  // below tests -- the menu is one component for both cases.
  const batch: readonly ContextTarget[] = row === null
    ? []
    : batchRowsFor(row, props.selection)
  const many = batch.length
  /** Fill `{n}` in a batch label. */
  const count = (key: string): string => batchLabel(t(key), many)

  /**
   * Entries that mean the same thing for one row and for many.
   *
   * Only the label changes: one `favorite` id, one handler, one code path. Splitting
   * them into a separate batch menu is what let the tree and the table disagree before,
   * and the count says what the entry will touch.
   */
  const favoriteAll = many > 0 && batch.every(entry => props.favorite)

  const items: MenuEntry[] = row !== null ? [
    // Opening is the action a file list is expected to lead with; a directory has no
    // preview route here, so the entry is absent rather than a no-op.
    ...(many === 0 && !row.isDir && props.onOpen !== undefined
      ? [{ id: 'open', label: t('actionOpen'), disabled: busy } as MenuEntry]
      : []),
    // A directory has no bytes to save, so the row is absent rather than disabled: a
    // permanently disabled entry teaches the reader nothing.
    ...(many === 0 && !row.isDir ? [{ id: 'download', label: t('actionDownload'), disabled: busy }] : []),
    // Rename and share address ONE row: a batch rename has no meaning (there is no
    // shared new name) and a share dialog taking several principals for several files
    // would be a different feature. Hiding them for a batch is clearer than disabling
    // an entry the reader would have to guess at.
    ...(many === 0 ? [
      { id: 'rename', label: t('actionRename'), disabled: busy } as MenuEntry,
      { id: 'share', label: t('actionShare') } as MenuEntry,
    ] : []),
    {
      id: 'favorite',
      label: many > 0
        ? (favoriteAll ? count('actionUnfavoriteMany') : count('actionFavoriteMany'))
        : (props.favorite ? t('actionUnfavorite') : t('actionFavorite')),
    },
    { type: 'separator', id: 'sep-clip' },
    { id: 'copy', label: many > 0 ? count('actionCopyMany') : t('actionCopy') },
    { id: 'cut', label: many > 0 ? count('actionCutMany') : t('actionCut') },
    {
      id: 'paste',
      // Disabled with an empty clipboard, and when there is no known destination. The
      // label names what will be pasted, so a paste is never a surprise about content
      // or about where it went.
      label: clipboardEmpty
        ? t('actionPaste')
        : (props.clipboard?.cut === true ? t('actionPasteCut') : t('actionPasteCopy'))
          + ' ' + (props.clipboard?.entries.length === 1
            ? props.clipboard.entries[0].name
            : String(props.clipboard?.entries.length ?? 0)),
      disabled: busy || clipboardEmpty,
    },
    { type: 'separator', id: 'sep-2' },
    { id: 'pin', label: props.pinned ? t('actionUnpin') : t('actionPin') },
    { id: 'reference', label: t('actionReference') },
    { type: 'separator', id: 'sep-3' },
    // Moving one row is a prompt, not a submenu of every directory: the tree already
    // offers drag-and-drop for the same job, and a batch move has one shared
    // destination only when the reader names it.
    ...(many === 0 && props.onMove !== undefined
      ? [{ id: 'move', label: t('moveSelected'), disabled: busy } as MenuEntry]
      : []),
    // The permission entry exists only when the Host answered that this caller may
    // manage grants AND the page supplied a surface to open. Hiding it otherwise keeps
    // a refused dialog out of the menu.
    ...(many === 0 && props.canManageGrants === true && props.onGrant !== undefined
      ? [{ id: 'grant', label: t('actionPermissions') } as MenuEntry]
      : []),
    { id: 'delete', label: many > 0 ? count('actionDeleteMany') : t('actionDelete'), danger: true, disabled: busy },
  ] : []

  return (
    <>
      <Menu
        open={menuOpen}
        anchor={<span />}
        items={items}
        onSelect={(id) => {
          // The menu only exists while `row` is set; this keeps the handlers typed
          // against a real target rather than re-checking at each branch.
          if (row === null) return
          if (id === 'open') { props.onOpen?.(row.relPath); onClose(); return }
          if (id === 'download') { void download(row); return }
          if (id === 'rename') { void rename(row); return }
          if (id === 'share') {
            // Capture first: `onClose` clears the parent's target in the same commit.
            setShareTarget(row)
            onClose()
            return
          }
          if (id === 'favorite') {
            if (many > 0) { favoriteMany(!favoriteAll); return }
            props.onFavorite(row.relPath, !props.favorite)
            onClose()
            return
          }
          if (id === 'copy') { clipMany(false); return }
          if (id === 'cut') { clipMany(true); return }
          if (id === 'paste') { void paste(); return }
          if (id === 'pin') { props.onPin(row.relPath, !props.pinned); onClose(); return }
          if (id === 'reference') {
            // One implementation decides which rows a reference covers, shared with the
            // picker's own target resolution: a menu that says "reference 3 items" must
            // hand over exactly those three.
            const targets = referenceTargetsFor(row.relPath, many > 0 ? batch : undefined)
            if (targets.length > 1) {
              props.onReference(row.relPath, row.isDir, batch as readonly ContextTarget[])
            } else {
              props.onReference(row.relPath, row.isDir)
            }
            onClose()
            return
          }
          if (id === 'move') { void move(row); return }
          if (id === 'grant') { props.onGrant?.(row.relPath); onClose() }
          if (id === 'delete') {
            if (many > 0) { void removeMany(); return }
            void remove(row)
          }
        }}
        onClose={onClose}

        getAnchorRect={getAnchorRect}
        // 0.2.2-rc.2 replaced `getAnchorRect` with `anchorPoint` (client viewport
        // coordinates). Supplying both keeps the card at the pointer on either host:
        // each version ignores the prop it does not know, and without `anchorPoint`
        // the newer host falls back to the detached anchor span and places the card
        // somewhere the reader did not click.
        {...(at === null ? {} : { anchorPoint: { x: at.x, y: at.y } })}
        side="bottom"

        autoFocus
      />
      {notice !== undefined && <p role="alert">{notice}</p>}
      <KnowledgeShareDialog
        relPath={shareTarget === null ? null : shareTarget.relPath}
        isDir={shareTarget?.isDir === true}
        copy={props.shareCopy}
        onClose={() => { setShareTarget(null) }}
        onShared={() => {
          setShareTarget(null)
          props.onRenamed()
        }}
      />
    </>
  )
}
