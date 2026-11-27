/**
 * Wire the knowledge base into the sidebar editor's save events.
 *
 * The knowledge base does not own the editor. Documents are shown in the host's own
 * file window, and that window saves through its own route -- so a save never passes
 * through a knowledge-base code path, and an audit trail written only from this
 * plugin's routes would miss every edit made in the editor.
 *
 * The sidebar therefore accepts two registrations, both optional to it:
 *
 * - A **save actor** answers "who is acting right now". The knowledge base registers
 *   one that reports the DataOps identity the Host resolved.
 * - A **save listener** receives every successful save after the bytes landed.
 *
 * The knowledge base registers both. What it does with an event is deliberately
 * duller than it could be: it posts the save to its own append-only audit route and
 * forgets about it. Delivery is fire-and-forget, so a knowledge base that is down,
 * slow, or misconfigured cannot turn a completed save into a failed one -- which is
 * the whole reason the sidebar calls listeners without awaiting them.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { KB_API, kbApiPath } from '../api.ts'

/** The slice of the host sidebar service this module uses. */
interface SaveActorLike {
  system: string
  id: string
  displayName?: string
}

interface SaveEventLike {
  path: string
  sessionId: string
  actors: readonly SaveActorLike[]
  length: number
}

interface SaveActorProviderLike {
  id: string
  current: () => SaveActorLike | undefined
}

interface SaveListenerLike {
  id: string
  onSaved: (event: SaveEventLike) => void
}

interface SidebarService {
  registerSaveActor: (provider: SaveActorProviderLike) => () => void
  registerSaveListener: (listener: SaveListenerLike) => () => void
}

/**
 * The sidebar service as it arrives from the host.
 *
 * The extension methods are optional here because a host running an older sidebar
 * simply does not have them; the guard in {@link registerSaveAudit} narrows to
 * {@link SidebarService} before anything is called.
 */
type SidebarServiceLike = Partial<SidebarService>

/** The context shape the lookup needs. */
interface ContextLike {
  get?: (name: string) => unknown
}

/** The host's service-availability hook: the callback runs once the service exists. */
interface InjectLike {
  inject?: (names: readonly string[], callback: (injected: { betterSidebar?: SidebarServiceLike }) => void) => unknown
}

/** Registration ids, prefixed so they cannot collide with another plugin's. */
const ACTOR_ID = 'knowledge-base:actor'
const LISTENER_ID = 'knowledge-base:audit'

/**
 * Turn an absolute path back into a knowledge-base relative path.
 *
 * The sidebar reports absolute paths because that is what it edits. The audit route
 * speaks the relative paths every other knowledge-base surface uses, so the mount
 * point is stripped here rather than sending an absolute path the route would have
 * to guess a root for.
 * @param absolutePath - the path the sidebar saved.
 * @param mountPoint - the knowledge root, absolute.
 * @returns The relative path, or undefined when the save was outside the root.
 */
export function toKnowledgePath(absolutePath: string, mountPoint: string): string | undefined {
  const normalized = absolutePath.replace(/\\/g, '/')
  const root = mountPoint.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root === '' || normalized === root) return undefined
  if (!normalized.startsWith(root + '/')) return undefined
  const relative = normalized.slice(root.length + 1)
  return relative === '' ? undefined : relative
}

/**
 * Decide whether a save belongs to the knowledge base, and under which path.
 *
 * Two shapes show up in practice and both mean the same document:
 *
 * - The editor reports an absolute path when it edits outside a session workspace.
 * - It reports a path relative to the session workspace (`kb/test-toc.md`) when the
 *   document was reached through the workspace, which is the ordinary case here: the
 *   knowledge view is linked into `/workspace/kb`.
 *
 * The knowledge root is reported by the page as its configured mount point, and the
 * view is what the editor actually opens, so the mount point's last segment (`kb`)
 * is the prefix that identifies knowledge-base saves in the relative shape. Matching
 * on that segment rather than on the full absolute path is what makes the workspace
 * route work at all.
 * @param savedPath - the path the editor reported.
 * @param mountPoint - the knowledge root as the page configured it.
 * @returns The knowledge-base relative path, or undefined when the save is elsewhere.
 */
export function matchKnowledgeSave(savedPath: string, mountPoint: string): string | undefined {
  const normalized = savedPath.replace(/\\/g, '/').replace(/^\/+/, '')
  // Absolute shape: strip the root.
  const byRoot = toKnowledgePath(savedPath, mountPoint)
  if (byRoot !== undefined) return byRoot
  // Relative shape: `kb/<relPath>`, where `kb` is the mount point's last segment.
  const root = mountPoint.replace(/\\/g, '/').replace(/\/+$/, '')
  const leaf = root.slice(root.lastIndexOf('/') + 1)
  if (leaf === '') return undefined
  if (normalized === leaf) return undefined
  if (!normalized.startsWith(leaf + '/')) return undefined
  const relative = normalized.slice(leaf.length + 1)
  return relative === '' ? undefined : relative
}

/**
 * Report one save to the knowledge base's audit trail.
 *
 * Deliberately never rejects: the caller is a fire-and-forget listener inside the
 * sidebar's save path, and an unhandled rejection there would surface as an error
 * about a save that actually succeeded.
 * @param relPath - path relative to the knowledge root.
 * @param actor - the identity the sidebar resolved, when one was registered.
 */
async function reportSave(relPath: string, actor: SaveActorLike | undefined): Promise<void> {
  try {
    await fetch(kbApiPath(KB_API.auditAppend), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        relPath,
        action: 'edit',
        // The actor travels so the trail records who, not merely what. The route
        // trusts its own caller resolution over this field (it is a browser-supplied
        // claim), so this is a cross-check rather than the authority.
        ...(actor === undefined ? {} : { actor: actor.id }),
      }),
      cache: 'no-store',
    })
  } catch {
    // A save that already landed is not made worse by a failed audit write. The
    // sidebar's own log carries the failure; the reader does not need to see it.
  }
}

/**
 * Register the knowledge base as a save actor and a save listener.
 *
 * Safe to call on a host without the extension: every access is optional and an
 * absent service simply means nothing is registered. The returned disposer removes
 * both registrations, so a plugin unload cannot leave a listener pointing at a
 * closed page.
 *
 * @param ctx - the client context the page runs in.
 * @param mountPoint - the knowledge root, used to keep saves outside it out of the trail.
 * @returns A disposer, or a no-op when the sidebar service is absent.
 */
export function registerSaveAudit(ctx: unknown): () => void {
  const context = ctx as (ContextLike & InjectLike) | undefined
  if (context === undefined) return () => {}

  // Wait for the sidebar service rather than sampling it once.
  //
  // Plugin load order is not ours to choose: the knowledge base may apply before the
  // sidebar has published `betterSidebar`, and a one-shot `get` in that window would
  // return undefined and -- silently -- never register anything. `inject` is the
  // host's own answer to that: the callback runs when the service is available,
  // whether that is now or later.
  const disposers: (() => void)[] = []
  let disposeAudit: (() => void) | undefined
  context.inject?.(['betterSidebar'], (injected: { betterSidebar?: SidebarServiceLike }) => {
    const service = injected.betterSidebar
    if (service?.registerSaveActor === undefined || service.registerSaveListener === undefined) {
      return
    }
    disposeAudit = registerAgainst({
      registerSaveActor: service.registerSaveActor,
      registerSaveListener: service.registerSaveListener,
    })
  })
  disposers.push(() => { disposeAudit?.() })

  return () => { for (const dispose of disposers) dispose() }
}

/**
 * Register the actor and the listener against a live service.
 * @param service - the sidebar service, once the host has published it.
 * @returns a disposer that removes both registrations.
 */
function registerAgainst(service: SidebarService): () => void {

  const disposeActor = service.registerSaveActor({
    id: ACTOR_ID,
    current: () => {
      // The Host resolved this identity for the page; the sidebar only needs a name
      // to hand to listeners. A page with no identity (an anonymous profile) reports
      // nobody rather than a placeholder.
      const id = currentActorId()
      if (id === undefined) return undefined
      return { system: 'knowledge-base', id }
    },
  })

  const disposeListener = service.registerSaveListener({
    id: LISTENER_ID,
    onSaved: (event) => {
      const relative = matchKnowledgeSave(event.path, currentMountPoint())
      // A save elsewhere in the workspace is not a knowledge-base event.
      if (relative === undefined) return
      void reportSave(relative, event.actors.find(actor => actor.system === 'knowledge-base'))
    },
  })

  return () => {
    disposeActor()
    disposeListener()
  }
}

/**
 * The DataOps user id this page was loaded for, when it published one.
 *
 * Read from the document rather than from a React tree: the registration happens in
 * `apply`, before any knowledge surface mounts, so there is no component to read a
 * prop from. A deployment that publishes no identity reports none.
 */
let actorResolver: (() => string | undefined) | undefined
/** The knowledge root, published by the page once its status answers. */
let mountPointResolver: (() => string) | undefined

/**
 * Install the resolver that reports the knowledge root.
 *
 * The page is what knows the mount point (it comes from the Host's config), and the
 * save listener needs it to tell a knowledge-base save from any other file's save.
 * Passing a getter rather than a string keeps the registration alive across a mount
 * point that arrives after the listener is installed.
 * @param resolver - returns the current knowledge root, absolute.
 */
export function setMountPointResolver(resolver: () => string): void {
  mountPointResolver = resolver
}

function currentMountPoint(): string {
  try {
    return mountPointResolver?.() ?? ''
  } catch {
    return ''
  }
}

/** Install the resolver the plugin's apply step owns. */
export function setActorResolver(resolver: () => string | undefined): void {
  actorResolver = resolver
}

function currentActorId(): string | undefined {
  if (resolvedActorId !== undefined) return resolvedActorId
  try {
    return actorResolver?.()
  } catch {
    return undefined
  }
}

/**
 * Publish the DataOps identity to the save-actor registration.
 *
 * The page resolves it through its own status call; the registration lives at plugin
 * scope, so the value travels through here rather than being fetched twice.
 * @param id - the caller id DataOps reported, or undefined when none is known.
 */
export function publishActor(id: string | undefined): void {
  resolvedActorId = id
}

let resolvedActorId: string | undefined
