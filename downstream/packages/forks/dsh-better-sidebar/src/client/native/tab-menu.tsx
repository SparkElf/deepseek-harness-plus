/**
 * Native right-Sidebar tab menu entries owned by better-sidebar.
 *
 * DSH's dock kit draws the outer tab strip and owns its context menu: the
 * kit's own row is just "关闭", and any extra actions must be contributed
 * through the `sidebar.right.tab.menu.item` list slot. This module adds the
 * file-tab actions (copy relative/absolute path) and the pane batch actions
 * (close others / close all).
 *
 * Visibility: the copy rows exist only for a tab whose `contentId` is a
 * `dsh-resource://file/…` address (a real file), and the close rows only for
 * a tab kind this plugin registered. Another plugin's tab therefore keeps its
 * own menu untouched. Relative paths are projected against the session's live
 * workspace root (`useSessionRoot`, the same host-confirmed root the explorer
 * uses); absolute paths are the real filesystem spelling. The host's own
 * close path (`closeIn`) is reused, so a dirty editor's close handler and the
 * rule that keeps the sole docked guide alive are unchanged.
 */
import { createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { Toast, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '../../context-types.ts'
import type { BetterSidebarService } from '../service.ts'
import { downloadUrl } from '../api.ts'
import { createOpenInApp } from '../open-in-app.ts'
import { t } from '../locales.ts'
import { isAbsolutePath, workspaceRelativePath } from '../paths.ts'
import { parseFileAddress } from '../resource-address.ts'
import { useSessionRoot } from '../use-session-root.ts'
import css from '../sidebar.module.css'

/** Must mirror `EDITOR_KIND` in ./index.ts (the file resource tab kind). */
const EDITOR_KIND = 'editor'
/** Must mirror `FILES_KIND` in ./index.ts (the explorer guide takeover). */
const FILES_KIND = 'files'

/**
 * The controller slice these entries use. `tabsIn`/`closeIn` are concrete
 * `SidebarRightController` methods rather than `ISidebarRight` members, so
 * they are probed at call time like the rest of the plugin's native surface.
 */
interface NativeTabMenuController {
  tabsIn?(sessionId: string): readonly { readonly id: string }[]
  closeIn?(sessionId: string, tabId: string): void
  close?(tabId: string): void
  mounted?: { getSnapshot(): string | undefined }
}

/** Props the slot owner passes to one menu entry. */
interface TabMenuOwnerProps {
  readonly tab: { readonly id: string; readonly kind: string; readonly contentId: string }
  readonly dismiss: () => void
  /** Standard session-scope prop supplied by the slot runtime. */
  readonly sessionId?: string
}

/** The path pair a file tab exposes to the two copy rows. */
export interface CopiedPaths {
  /** Relative to the session's workspace root; absent outside it / unknown. */
  readonly relative?: string
  /** The real filesystem path; absent while the root is still unknown. */
  readonly absolute?: string
}

/** Read the native controller, tolerating a late/absent service. */
function controllerOf(ctx: Context): NativeTabMenuController | undefined {
  try {
    return ctx.get('sidebarRight') as unknown as NativeTabMenuController | undefined
  } catch {
    return undefined
  }
}

/** The session whose menu is open: the slot prop, else the mounted seat. */
function sessionOf(ctx: Context, props: TabMenuOwnerProps): string | undefined {
  if (typeof props.sessionId === 'string' && props.sessionId !== '') return props.sessionId
  try {
    return controllerOf(ctx)?.mounted?.getSnapshot()
  } catch {
    return undefined
  }
}

/** Every tab the host has committed for one session (empty when unadopted). */
function tabsOf(ctx: Context, sessionId: string | undefined): readonly { readonly id: string }[] {
  if (sessionId === undefined) return []
  const controller = controllerOf(ctx)
  if (controller === undefined || typeof controller.tabsIn !== 'function') return []
  try {
    return controller.tabsIn(sessionId)
  } catch {
    return []
  }
}

/** Close one tab through the host's own close path (per-kind cleanup runs). */
function closeTab(ctx: Context, sessionId: string | undefined, tabId: string): void {
  const controller = controllerOf(ctx)
  if (controller === undefined) return
  try {
    if (sessionId !== undefined && typeof controller.closeIn === 'function') controller.closeIn(sessionId, tabId)
    else controller.close?.(tabId)
  } catch {
    // The tab can disappear between the menu render and the click; the next
    // open recomputes from the controller, so there is nothing to recover.
  }
}

/** Join one workspace-relative path onto a root, both `/`-spelled. */
function joinRoot(root: string, path: string): string {
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (path === '') return base
  return `${base}/${path}`
}

/**
 * Project one tab's content address into the copy rows' two spellings.
 * @param contentId - the tab's content address.
 * @param cwd - the session's live workspace root, when resolved.
 * @returns the pair, or `undefined` when the content is not a file resource.
 */
export function copiedPaths(contentId: string, cwd: string | undefined): CopiedPaths | undefined {
  const address = parseFileAddress(contentId)
  if (address === undefined) return undefined
  const raw = address.path.replace(/\\/g, '/')
  if (isAbsolutePath(raw)) {
    return {
      absolute: raw,
      ...(cwd === undefined ? {} : { relative: workspaceRelativePath(cwd, raw) }),
    }
  }
  const relative = raw.replace(/^(?:\.\/)+/, '')
  return {
    relative,
    ...(cwd === undefined ? {} : { absolute: joinRoot(cwd, relative) }),
  }
}

/** Success toast: its own body-level root so closing the menu cannot unmount it. */
function showCopiedToast(): void {
  if (typeof document === 'undefined') return
  const host = document.createElement('div')
  host.dataset.dshBetterSidebarCopied = '1'
  document.body.appendChild(host)
  const root = createRoot(host)
  let done = false
  const cleanup = (): void => {
    if (done) return
    done = true
    queueMicrotask(() => {
      root.unmount()
      host.remove()
    })
  }
  root.render(createElement(Toast, { text: t('copied'), tone: 'success', onDone: cleanup }))
}

/** Copy one text and give success feedback; the menu closes immediately. */
function copyText(text: string, dismiss: () => void): void {
  dismiss()
  void writeClipboard(text).then((written) => {
    if (written) showCopiedToast()
  })
}

/** Whether one native tab kind belongs to this plugin. */
function ownsKind(service: BetterSidebarService, kind: string): boolean {
  if (kind === FILES_KIND) return true
  if (kind === EDITOR_KIND) return service.isTabEnabled(EDITOR_KIND)
  return service.getTabs().some(tab => tab.id === kind && service.isTabEnabled(tab.id))
}

/**
 * Whether the tab addresses a real file. The host may draw a file through its
 * own built-in type (for example `text`) instead of this plugin's `editor`
 * kind, so batching actions must use the content address as well as the kind
 * ownership check; otherwise a host-owned file tab gets the copy rows but
 * loses close-others/close-all.
 */
function isFileTab(tab: TabMenuOwnerProps['tab']): boolean {
  return parseFileAddress(tab.contentId) !== undefined
}

/** Whether the batch close rows belong on this tab. */
function canBatchClose(service: BetterSidebarService, tab: TabMenuOwnerProps['tab']): boolean {
  return isFileTab(tab) || ownsKind(service, tab.kind)
}

/** One row, styled like the dock kit's own menu item. */
function MenuRow(props: {
  readonly label: string
  readonly disabled?: boolean
  readonly onSelect: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      className={css.nativeTabMenuItem}
      disabled={props.disabled === true}
      onClick={props.onSelect}
    >
      {props.label}
    </button>
  )
}

/** The hairline between the path actions and the close actions. */
function MenuSeparator(): ReactNode {
  return <div role="separator" className={css.nativeTabMenuSeparator} />
}

/** "Copy relative path" (workspace-root-relative), file tabs only. */
function CopyRelativeItem(props: TabMenuOwnerProps & { readonly ctx: Context }): ReactNode {
  const address = parseFileAddress(props.tab.contentId)
  const sessionId = address?.scope === 'session' ? address.sessionId : sessionOf(props.ctx, props)
  const cwd = useSessionRoot(props.ctx, sessionId)
  if (address === undefined) return null
  const paths = copiedPaths(props.tab.contentId, cwd)
  const text = paths?.relative
  return (
    <MenuRow
      label={t('copyRelative')}
      disabled={text === undefined}
      onSelect={() => {
        if (text !== undefined) copyText(text, props.dismiss)
      }}
    />
  )
}

/** "Copy absolute path" (real filesystem spelling), file tabs only. */
function CopyAbsoluteItem(props: TabMenuOwnerProps & { readonly ctx: Context }): ReactNode {
  const address = parseFileAddress(props.tab.contentId)
  const sessionId = address?.scope === 'session' ? address.sessionId : sessionOf(props.ctx, props)
  const cwd = useSessionRoot(props.ctx, sessionId)
  if (address === undefined) return null
  const paths = copiedPaths(props.tab.contentId, cwd)
  const text = paths?.absolute
  return (
    <MenuRow
      label={t('copyAbsolute')}
      disabled={text === undefined}
      onSelect={() => {
        if (text !== undefined) copyText(text, props.dismiss)
      }}
    />
  )
}

/** "Download": hand the real file path to the host's attachment route. */
function DownloadItem(props: TabMenuOwnerProps & { readonly ctx: Context }): ReactNode {
  const address = parseFileAddress(props.tab.contentId)
  const sessionId = address?.scope === 'session' ? address.sessionId : sessionOf(props.ctx, props)
  const cwd = useSessionRoot(props.ctx, sessionId)
  if (address === undefined) return null
  const absolute = copiedPaths(props.tab.contentId, cwd)?.absolute
  return (
    <>
      <MenuRow
        label={t('download')}
        disabled={absolute === undefined}
        onSelect={() => {
          if (absolute === undefined || sessionId === undefined) return
          const anchor = document.createElement('a')
          anchor.href = downloadUrl({ sessionId, cwd }, absolute)
          anchor.style.display = 'none'
          document.body.appendChild(anchor)
          anchor.click()
          anchor.remove()
          props.dismiss()
        }}
      />
      <MenuSeparator />
    </>
  )
}

/** "Close other tabs": every sibling in the session except the target. */
function CloseOthersItem(props: TabMenuOwnerProps & { readonly ctx: Context; readonly service: BetterSidebarService }): ReactNode {
  const { ctx, service, tab, dismiss } = props
  if (!canBatchClose(service, tab)) return null
  const sessionId = sessionOf(ctx, props)
  const others = tabsOf(ctx, sessionId).filter(entry => entry.id !== tab.id)
  return (
    <MenuRow
      label={t('closeOtherTabs')}
      disabled={others.length === 0}
      onSelect={() => {
        for (const entry of others) closeTab(ctx, sessionId, entry.id)
        dismiss()
      }}
    />
  )
}

/** "Close all tabs": every committed tab of the session, the target included. */
function CloseAllItem(props: TabMenuOwnerProps & { readonly ctx: Context; readonly service: BetterSidebarService }): ReactNode {
  const { ctx, service, tab, dismiss } = props
  if (!canBatchClose(service, tab)) return null
  const sessionId = sessionOf(ctx, props)
  const tabs = tabsOf(ctx, sessionId)
  const targets = tabs.length > 0 ? tabs : [{ id: tab.id }]
  return (
    <MenuRow
      label={t('closeAllTabs')}
      onSelect={() => {
        for (const entry of targets) closeTab(ctx, sessionId, entry.id)
        dismiss()
      }}
    />
  )
}


/** "Open containing folder": file tabs only; switches to Files and reveals the row. */
function OpenFolderItem(props: TabMenuOwnerProps & { readonly ctx: Context; readonly service: BetterSidebarService }): ReactNode {
  const address = parseFileAddress(props.tab.contentId)
  const sessionId = address?.scope === 'session' ? address.sessionId : sessionOf(props.ctx, props)
  const cwd = useSessionRoot(props.ctx, sessionId)
  if (address === undefined) return null
  const absolute = copiedPaths(props.tab.contentId, cwd)?.absolute
  const disabled = absolute === undefined || sessionId === undefined || !props.service.isTabEnabled(EDITOR_KIND)
  return (
    <>
      <MenuSeparator />
      <MenuRow
        label={t('openContainingFolder')}
        disabled={disabled}
        onSelect={() => {
          if (disabled || absolute === undefined || sessionId === undefined) return
          props.dismiss()
          props.service.revealInExplorer({ sessionId, cwd }, absolute)
        }}
      />
    </>
  )
}

/** "Open location": reveals the file in the system file manager. */
function RevealInFileManagerItem(props: TabMenuOwnerProps & { readonly ctx: Context; readonly service: BetterSidebarService }): ReactNode {
  const address = parseFileAddress(props.tab.contentId)
  const sessionId = address?.scope === 'session' ? address.sessionId : sessionOf(props.ctx, props)
  const cwd = useSessionRoot(props.ctx, sessionId)
  if (address === undefined) return null
  const absolute = copiedPaths(props.tab.contentId, cwd)?.absolute
  const disabled = absolute === undefined || sessionId === undefined
  return (
    <>
      <MenuSeparator />
      <MenuRow
        label={t('openInFileManager')}
        disabled={disabled}
        onSelect={() => {
          if (disabled || absolute === undefined || sessionId === undefined) return
          props.dismiss()
          // In-app reveal: select the row, expand its ancestors and scroll it
          // into sight inside the Files tree.
          props.service.revealInExplorer({ sessionId, cwd }, absolute)
        }}
      />
    </>
  )
}

/**
 * Register the entries into the host's tab-menu list slot.
 *
 * The kit's own "关闭" row always leads; the extras follow in registration
 * order: copy relative, copy absolute, download (+ separator), close others,
 * close all, open containing folder (+ separator).
 * `slots.inject` rather than a bare `register`: the rightbar seat declares the
 * slot, and it may arrive after this activation. Each declaration lifetime
 * gets its own registrations, all released by the returned disposer.
 * @param ctx - the client context (slots + `sidebarRight`).
 * @param service - the plugin service, for the owned kind set.
 * @returns a disposer unregistering every entry.
 */
export function registerNativeTabMenuItems(ctx: Context, service: BetterSidebarService): () => void {
  const disposers: Array<() => void> = []
  const register = (id: string, order: number, component: (props: TabMenuOwnerProps) => ReactNode): void => {
    disposers.push(ctx.slots.inject('sidebar.right.tab.menu.item', () => ctx.slots.register({
      name: 'sidebar.right.tab.menu.item',
      id,
      order,
      registrant: 'dsh-better-sidebar',
    }, component)))
  }
  try {
    register('dsh-better-sidebar:tab-copy-relative', 10, props => <CopyRelativeItem {...props} ctx={ctx} />)
    register('dsh-better-sidebar:tab-copy-absolute', 20, props => <CopyAbsoluteItem {...props} ctx={ctx} />)
    register('dsh-better-sidebar:tab-download', 30, props => <DownloadItem {...props} ctx={ctx} />)
    register('dsh-better-sidebar:tab-close-others', 40, props => <CloseOthersItem {...props} ctx={ctx} service={service} />)
    register('dsh-better-sidebar:tab-close-all', 50, props => <CloseAllItem {...props} ctx={ctx} service={service} />)
    register('dsh-better-sidebar:tab-open-folder', 60, props => <OpenFolderItem {...props} ctx={ctx} service={service} />)
    register('dsh-better-sidebar:tab-open-in-file-manager', 65, props => <RevealInFileManagerItem {...props} ctx={ctx} service={service} />)
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  return () => {
    for (const dispose of disposers.reverse()) dispose()
    disposers.length = 0
  }
}
