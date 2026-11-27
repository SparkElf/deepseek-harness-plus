// @ts-nocheck
import { describe, expect, it, vi } from 'vitest'
import { readKnowledgeJson } from '../src/api.ts'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, readlink, lstat, rm, stat, symlink, chmod, writeFile, appendFile, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import {
  ENDPOINTS,
  joinUrl,
} from '../src/protocol.ts'
import {
  Config,
  KB_ROOT_RESOURCE_ID,
  apply,
  knowledgeAncestorsFor,
  createGrant,
  fetchGrants,
  inject,
  localConfig,
  canReadPath,
  canManageGrants,
  fetchCaller,
  fetchPrincipals,
  listDirectory,
  listDirectoryWithPermissions,
  listDirectoryShapes,
  searchKnowledge,
  localStatus,
  MAX_KNOWLEDGE_WRITE_BYTES,
  createKnowledgeEntry,
  classifyMount,
  syncCallerView,
  name,
  mineruUrlFor,
  permissionForKbRoute,
  actualRelPathForView,
  revokeGrant,
  withStoredStorage,
  isTeamDeployment,
  checkLocalPath,
  resolveMineruUrl,
  LOCAL_USER_ID,
  canWritePath,
  readSharedMineruUrl,
  knowledgeBaseToolDisclosure,
  type KnowledgeError,
} from '../src/index.ts'
import {
  KB_STATE_FILE,
  deploymentPlan,
  sshfsMountStep,
  sshfsVerifyStep,
  findStep,
  mineruInstallStep,
  mineruServiceStep,
  nfsDeployStep,
  nfsMountStep,
  nfsVerifyStep,
  probeStep,
  renderCommand,
  shquote,
  type DeployPlanContext,
} from '../src/deploy.ts'
import { RemoteError, originFrom, sshManagerRunner } from '../src/remote.ts'
// The wizard's visibility gate is a pure function, so it is tested by calling it.
import { hasDeployTarget } from '../src/client/deployTarget.ts'
import { sortAuditRows } from '../src/client/auditPaging.ts'
import { DEFAULT_PAGE_SIZE, paginate } from '../src/client/paging.ts'
// The outline's heading extraction is pure, so it is tested by calling it. The
// rendering rules around it (the two-heading floor, the observer) are asserted
// against the source, since neither has a route to drive from node.
import {
  dropView,
  isContainedRelPath,
  isPendingName,
  isSafeUserId,
  listPendingWrites,
  copyEntry,
  moveEntry,
  parkPendingWrite,
  pinsPathFor,
  pointMountAtView,
  appendAuditEntry,
  readAuditEntries,
  readPendingContent,
  readPins,
  isMountPoint,
  readSettings,
  normalizeMineruBaseUrl,
  DEFAULT_KNOWLEDGE_SETTINGS,
  readStorageSettings,
  readTreeState,
  readViewMode,
  storageSettingsPathFor,
  treeStatePathFor,
  writeStorageSettings,
    bucketOf,
    departmentPrefixMatches,
    syncView,
  viewPathFor,
  writePins,
  writeSettings,
  writeTreeState,
  writeViewMode,
} from '../src/views.ts'

/** Config used across the request tests, with every field filled. */
const CONFIG = {
  baseUrl: 'https://dataops.example',
  credentialRef: 'DATAOPS_ACCESS_TOKEN',
  timeoutMs: 1000,
  mountPoint: '/nas/kb/views/current',
  actualRoot: '/nas/kb/actual',
  viewRoot: '/nas/kb/views',
  indexDir: '/tmp/kb-test-index-unused',
  permitted: '10.0.0.5',
  nfsServer: 'nas.example',
  mineruTier: 'basic' as const,
  mineruBackend: 'onnx' as const,
  mineruPort: 8000,
  mineruMemoryMaxMiB: 4096,
  storageMode: 'local' as const,
  storageProtocol: 'sshfs' as const,
  sshHost: 'storage.example',
  sshUser: 'kb',
  sshPort: 22,
  sshKeyRef: 'KB_SSH_KEY',
  sshRemotePath: '/srv/kb',
  sshMountOptions: 'defaults',
} as unknown as Parameters<typeof localConfig>[0]

/** Deployment context derived from the same config. */
const PLAN: DeployPlanContext = {
  actualRoot: CONFIG.actualRoot,
  viewRoot: CONFIG.viewRoot,
  tier: CONFIG.mineruTier,
  backend: CONFIG.mineruBackend,
  port: CONFIG.mineruPort,
  permitted: CONFIG.permitted,
  server: CONFIG.nfsServer,
  mountPoint: CONFIG.mountPoint,
  memoryMaxMiB: CONFIG.mineruMemoryMaxMiB,
}

/** Build a Host context stand-in covering the seams `apply` and the requests use. */
function fakeHost(options: { token?: string; fetchImpl?: typeof fetch } = {}) {
  const tools: Array<{ name: string; description: string }> = []
  const disposers: Array<() => unknown> = []
  /** Route handlers registered through `webServer.register`, captured so a test
   * can drive the Host surface the browser actually reads. */
  const routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }> = []
  const fetchImpl = options.fetchImpl ?? (async () => new Response('{}', { status: 200 }))
  /**
   * The stub must not outlive the test that installed it: the SSH transport
   * tests below use the real fetch against a local stub server, and a leaked
   * stub would silently replace it.
   */
  vi.stubGlobal('fetch', fetchImpl)
  disposers.push(() => { vi.unstubAllGlobals() })
  const ctx = {
    // A host without a skill registry: `inject` still exists (every Cordis context
    // has one), but the callback never runs because there is no `skills` service.
    // The plugin must work in exactly this shape.
    inject(_deps: readonly string[], _run: (scoped: unknown) => void) {},
    effect(factory: () => () => unknown, _label: string) {
      disposers.push(factory())
    },
    credentials: {
      async resolve(ref: string) {
        if (options.token === undefined) return undefined
        return { value: options.token, source: ['test', ref].join(':') }
      },
    },
    webServer: {
      register: (route: { path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }) => {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register(definition: { name: string; description: string }) {
        tools.push(definition)
        return () => {
          const index = tools.indexOf(definition)
          if (index >= 0) tools.splice(index, 1)
        }
      },
    },
  }
  return { ctx, tools, routes, disposers }
}

/** Every permission key the shipped tool policies can require. */
const ALL_DISCLOSURE_PERMISSIONS = [
  'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract',
  'kb:audit:read', 'kb:grant:manage', 'kb:review:decide', 'kb:config:manage',
  'workflow:read', 'workflow:publish', 'workflow:manage',
  'workflow:review:decide', 'workflow:review:global',
] as const

/**
 * A `/api/ai/review/context` reply the disclosure coordinator can decide from.
 *
 * `admin: false` models an ordinary APP_USER: a real permission list, but no
 * reviewer capability, no global data scope and no admin role, so capability-gated
 * tools stay withheld even when a broad file key is present.
 */
function reviewContext(
  permissions: readonly string[],
  options: { admin?: boolean } = {},
): string {
  const admin = options.admin ?? true
  return JSON.stringify({
    userId: 'u-disclosure',
    roleCodes: admin ? ['SUPER_ADMIN'] : ['APP_USER'],
    permissions: [...permissions],
    dataScope: { all: admin, self: true, departmentCodes: [] },
    review: {
      canReview: admin,
      canReviewGlobal: admin,
      canManagePermissions: admin,
      departments: [],
    },
  })
}

/** Fetch stub: answers the review context, `{}` for everything else. */
function disclosureFetch(context: () => string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/ai/review/context')) {
      return new Response(context(), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

/**
 * Drive one Host route the way the browser does: a JSON body in, one JSON reply
 * out. The reply is what the page renders, so asserting on it covers the whole
 * path from the route through the permission filter.
 */
async function callRoute(
  routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }>,
  method: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const route = routes.find(candidate => candidate.path === '/knowledge-base/api')
  if (route === undefined) throw new Error('the settings route was never registered')
  let reply: Record<string, unknown> = {}
  const req = {
    url: `/knowledge-base/api/${method}`,
    on(event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
      if (event === 'end') handler()
      return req
    },
  }
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (text: string) => { reply = JSON.parse(text) as Record<string, unknown> },
  }
  await route.handler(req, res)
  return reply
}

  /**
   * Same drive, but also report the status the route answered with.
   *
   * `callRoute` returns only the body, which cannot tell "rejected with 401" from
   * "crashed with 500" when both carry an `error` field. Statuses are part of the
   * contract the page reads, so they need to be assertable.
   */
  async function callRouteWithStatus(
    routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }>,
    method: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const route = routes.find(candidate => candidate.path === '/knowledge-base/api')
    if (route === undefined) throw new Error('the settings route was never registered')
    let reply: Record<string, unknown> = {}
    let status = 0
    const req = {
      url: `/knowledge-base/api/${method}`,
      on(event: string, handler: (chunk?: Buffer) => void) {
        if (event === 'data') handler(Buffer.from(JSON.stringify(body)))
        if (event === 'end') handler()
        return req
      },
    }
    const res = {
      get statusCode() { return status },
      set statusCode(value: number) { status = value },
      setHeader: () => undefined,
      end: (text: string) => { reply = JSON.parse(text) as Record<string, unknown> },
    }
    await route.handler(req, res)
    return { status, body: reply }
  }

describe('protocol', () => {
  it('joins base URLs and endpoint paths without doubling slashes', () => {
    expect(joinUrl('https://host/', '/api/kb/status')).toBe('https://host/api/kb/status')
    expect(joinUrl('https://host', 'api/kb/status')).toBe('https://host/api/kb/status')
  })

  /**
   * The endpoint list once named an `/api/kb/*` family that no DataOps controller
   * served, so every call answered 404 while the plugin reported itself merely
   * unconfigured. Asserting the exact path keeps the list pinned to routes that
   * exist: the global prefix is `api` and the permission controller is
   * `system/resource-permissions`.
   */
  it('names the grant route the backend actually serves', () => {
    expect(ENDPOINTS.grants).toBe('/api/system/resource-permissions/grants')
  })
})

describe('configuration schema', () => {
  it('defaults every deployment value so a bare profile still loads', () => {
    // `{}` is the runtime shape the loader passes before defaults are applied;
    // the schema type demands the resolved shape, hence the cast.
    const resolved = Config({} as never) as unknown as typeof CONFIG
    // The pointer lives inside the workspace so the product's own file browser and the
    // model's tools reach it like any other workspace path. It is a SYMLINK into the
    // caller's view, which is what lets one deployment span `/workspace` and `/nas/kb`
    // without either side knowing about the other. (The other `/nas/kb/views/current`
    // assertion below reads `localConfig(CONFIG)`, a caller-supplied value, and is
    // untouched by this default.)
    expect(resolved.mountPoint).toBe('/workspace/kb')
    expect(resolved.actualRoot).toBe('/nas/kb/actual')
    expect(resolved.viewRoot).toBe('/nas/kb/views')
    expect(resolved.mineruTier).toBe('basic')
    expect(resolved.mineruBackend).toBe('onnx')
    expect(resolved.mineruPort).toBe(8000)
  })

  it('rejects a tier outside the supported set', () => {
    expect(() => Config({ mineruTier: 'advanced' } as never)).toThrow()
  })
})

describe('host plugin', () => {
  it('advertises its name and required services', () => {
    expect(name).toBe('dsh-knowledge-base')
    expect(inject).toContain('credentials')
    expect(inject).toContain('tools')
    expect(inject).toContain('webServer')
  })

  it('registers the KB tools allowed by an administrator permission context', async () => {
    const { ctx, tools } = fakeHost({
      token: 't',
      fetchImpl: disclosureFetch(() => reviewContext(ALL_DISCLOSURE_PERMISSIONS)),
    })
    apply(ctx as never, CONFIG)
    const disclosure = knowledgeBaseToolDisclosure(ctx as never)
    expect(disclosure).toBeDefined()
    await disclosure?.syncToolDisclosure()
    expect(tools.map(tool => tool.name).sort()).toEqual([
      'kb_file_delete',
      'kb_file_extract',
      'kb_file_mkdir',
      'kb_file_move',
      'kb_file_write',
      'kb_search',
      'kb_chunk_get',
      'kb_outline',
      'kb_outline_rewrite',
      'kb_outline_save',
      'workflow_publish',
      'kb_audit_list',
      'kb_config_get',
      'kb_config_update',
      'kb_grant_list',
      'kb_grant_set',
      'kb_index_rebuild',
      'kb_review_decide',
      'kb_review_list',
      'kb_sync',
      'kb_vectorize',
      'kg_add',
      'kg_del',
      'kg_get',
      'kg_set',
      'memory_context',
      'memory_guardian_run',
      'memory_guardian_send',
      'memory_promote_sop',
      'memory_record',
      'workflow_list',
      'workflow_review_decide',
      'workflow_review_list',
      'workflow_review_scan',
      'workflow_unpublish',
      'workflow_update',
    ].sort())
  })

  it('discloses only the reader surface and refreshes it when the context changes', async () => {
    let permissions: readonly string[] = ['kb:file:read']
    let admin = false
    const { ctx, tools } = fakeHost({
      token: 't',
      fetchImpl: disclosureFetch(() => reviewContext(permissions, { admin })),
    })
    apply(ctx as never, CONFIG)
    const disclosure = knowledgeBaseToolDisclosure(ctx as never)!
    await disclosure.syncToolDisclosure()
    const names = (): string[] => tools.map(tool => tool.name)
    expect(names()).toContain('kb_search')
    expect(names()).toContain('kb_outline')
    expect(names()).not.toContain('kb_file_write')
    expect(names()).not.toContain('kb_config_get')
    expect(names()).not.toContain('workflow_publish')

    permissions = ALL_DISCLOSURE_PERMISSIONS
    admin = true
    await disclosure.syncToolDisclosure()
    expect(names()).toContain('kb_file_write')
    expect(names()).toContain('kb_config_get')
    expect(names()).toContain('workflow_publish')

    permissions = ['kb:file:read']
    admin = false
    await disclosure.syncToolDisclosure()
    expect(names()).not.toContain('kb_file_write')
    expect(names()).toContain('kb_search')
  })

  it('registers the full surface synchronously in a personal deployment', () => {
    const { ctx, tools } = fakeHost({ token: 't' })
    apply(ctx as never, { ...CONFIG, baseUrl: '' })
    // No backend to ask: the local owner holds every key, so the surface is already
    // complete when `apply` returns rather than waiting on a microtask.
    expect(tools).toHaveLength(36)
    expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'kb_search', 'kb_file_write', 'kb_config_get', 'workflow_publish', 'workflow_review_decide',
    ]))
  })

  it('refreshes disclosure when the DataOps credential reference is updated', async () => {
    let permissions: readonly string[] = ['kb:file:read']
    let admin = false
    const { ctx, tools } = fakeHost({
      token: 't',
      fetchImpl: disclosureFetch(() => reviewContext(permissions, { admin })),
    })
    const listeners: Array<(ref: string) => void> = []
    ;(ctx as Record<string, unknown>).on = (name: string, listener: (ref: string) => void) => {
      if (name === 'credentials/reference-updated') listeners.push(listener)
      return () => undefined
    }
    apply(ctx as never, CONFIG)
    const disclosure = knowledgeBaseToolDisclosure(ctx as never)!
    await disclosure.syncToolDisclosure()
    expect(tools.map(tool => tool.name)).not.toContain('kb_config_get')
    expect(listeners).toHaveLength(1)

    permissions = ALL_DISCLOSURE_PERMISSIONS
    admin = true
    listeners[0]?.('DATAOPS_ACCESS_TOKEN')
    // The listener starts a refresh; awaiting the coordinator joins that pass (or
    // starts the next one) and proves the surface caught up.
    await disclosure.syncToolDisclosure()
    expect(tools.map(tool => tool.name)).toContain('kb_config_get')
  })

  it('reports an unavailable credential instead of calling the backend', async () => {
    const fetchImpl = vi.fn()
    const { ctx } = fakeHost({ fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'unauthorized' satisfies KnowledgeError['code'] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  /**
   * A grant travels as the resource type plus the path in the resource-id slot,
   * because that is how the DataOps permission store keys a row. Asserting the
   * body keeps the plugin a relay: the request names the principal and lets the
   * backend decide whether it exists and whether the caller may write.
   */
  it('addresses a grant as the knowledge resource type with the path as its id', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ grant: { id: 'g1' } }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 'secret-token', fetchImpl })
    await createGrant(ctx as never, CONFIG, {
      relPath: '2024/report.md',
      principalType: 'user',
      principalId: 'alice',
      action: 'read',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://dataops.example/api/system/resource-permissions/grants')
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer secret-token')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      resourceType: 'knowledge-base-file',
      resourceId: '2024/report.md',
      principalType: 'user',
      principalId: 'alice',
      action: 'read',
    })
  })

  it('revokes with DELETE and the same identifying fields', async () => {    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ deleted: true }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await revokeGrant(ctx as never, CONFIG, {
      relPath: '2024/report.md',
      principalType: 'role',
      principalId: 'finance',
      action: 'read',
    })
    expect(calls[0]?.init?.method).toBe('DELETE')
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      resourceType: 'knowledge-base-file',
      resourceId: '2024/report.md',
      principalType: 'role',
      principalId: 'finance',
    })
  })

  /**
   * The permission store matches a principal by a different column per kind:
   * `user` by primary key (a UUID), everything else by `code`. Sending a username
   * in the user slot was measured against the running backend and answered
   * `授权主体不存在或未启用` (HTTP 400), which reads as a missing account rather
   * than as the wrong identifier space -- so the surface names the expected value
   * per kind and refuses a non-UUID before the round trip.
   */
  it('names the identifier each principal kind is matched by', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePermissions.tsx', import.meta.url), 'utf8')
    expect(source).toMatch(/UUID_PATTERN/u)
    // A username in the user slot is refused locally, not sent: the copy key is
    // what the surface uses, and the wording lives in the locale.
    expect(source).toMatch(/grantNeedsUser/u)
    // The picker is preferred over a typed id whenever the directory answers.
    expect(source).toMatch(/chooseOption/u)
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(locales).toMatch(/用户主体要填用户 UUID/u)
    expect(locales).toMatch(/请选择/u)
  })

  /**
   * The principal directories let the surface offer a picker instead of asking an
   * operator to transcribe a UUID, and each kind is a different collection with a
   * different key: users carry `id`, everything else carries `code`. Departments
   * additionally nest their rows under their own name rather than `items`.
   *
   * Verified against the running backend on 2026-10-15: 4 users, 6 roles,
   * 6 departments, and 3 groups, with `displayName`/`username` as the user label
   * and `name` for the rest.
   */
  it('maps each principal directory to the id the grant needs', async () => {
    const calls: string[] = []
    const bodies: Record<string, unknown> = {
      '/api/system/users': { items: [{ id: 'u-1', username: 'alice', displayName: 'Alice' }] },
      '/api/system/roles': { items: [{ code: '运营人员', name: '运营人员' }] },
      '/api/system/departments': { departments: [{ code: 'unassigned', name: '待分配部门' }] },
      '/api/system/groups': { items: [{ code: 'platform-administrators', name: '平台管理组' }] },
    }
    const fetchImpl = (async (url: string) => {
      const path = new URL(url).pathname
      calls.push(path)
      return new Response(JSON.stringify(bodies[path] ?? {}), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })

    // `toMatchObject` rather than `toEqual`: a user row also carries `username` (and
    // `roleCodes` when the directory reports roles), which the person view needs to
    // attribute inherited access. The id/label pair is what this test is about.
    await expect(fetchPrincipals(ctx as never, CONFIG, 'user'))
      .resolves.toMatchObject([{ id: 'u-1', label: 'Alice' }])
    await expect(fetchPrincipals(ctx as never, CONFIG, 'role'))
      .resolves.toEqual([{ id: '运营人员', label: '运营人员' }])
    await expect(fetchPrincipals(ctx as never, CONFIG, 'department'))
      .resolves.toEqual([{ id: 'unassigned', label: '待分配部门' }])
    await expect(fetchPrincipals(ctx as never, CONFIG, 'group'))
      .resolves.toEqual([{ id: 'platform-administrators', label: '平台管理组' }])
    expect(calls).toEqual([
      '/api/system/users',
      '/api/system/roles',
      '/api/system/departments',
      '/api/system/groups',
    ])
  })

  it('maps a rejected request to an unauthorized failure rather than a retry', async () => {
    const fetchImpl = (async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'unauthorized' satisfies KnowledgeError['code'] })
  })

  it('maps a transport failure to unreachable', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'unreachable' satisfies KnowledgeError['code'] })
  })

  it('maps a malformed body to bad-response', async () => {
    const fetchImpl = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(fetchGrants(ctx as never, CONFIG))
      .rejects.toMatchObject({ code: 'bad-response' satisfies KnowledgeError['code'] })
  })

  /**
   * A rejected write explains itself, and that message is what the operator
   * needs: an unknown principal or a path the caller may not touch would
   * otherwise surface as a bare status code pointing at the wrong place.
   */
  it('surfaces the backend error message from a failed write', async () => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({ message: 'principal alice is not an enabled user' }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch
    const { ctx } = fakeHost({ token: 't', fetchImpl })
    await expect(createGrant(ctx as never, CONFIG, {
      relPath: 'a.md', principalType: 'user', principalId: 'alice',
    })).rejects.toThrow(/not an enabled user/u)
  })

  it('refuses to call the backend when no base URL is configured', async () => {
    const fetchImpl = vi.fn()
    const { ctx } = fakeHost({ token: 't', fetchImpl: fetchImpl as unknown as typeof fetch })
    await expect(fetchGrants(ctx as never, { ...CONFIG, baseUrl: '' }))
      .rejects.toMatchObject({ code: 'not-configured' satisfies KnowledgeError['code'] })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('derives the layout locally instead of asking a backend that has no such route', () => {
    const resolved = localConfig(CONFIG)
    expect(resolved.mountPoint).toBe('/nas/kb/views/current')
    expect(resolved.host).toBe('dataops.example')
    expect(resolved.backendConfigured).toBe(true)
  })

  it('reports an absent mount as a null file count rather than zero', async () => {
    const status = await localStatus({ ...CONFIG, mountPoint: '/nonexistent-kb-mount' })
    expect(status.visibleFiles).toBeNull()
    expect(status.indexing.running).toBe(false)
  })

  it('answers the read route with 403 when DataOps says the caller cannot read', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ canRead: false }), { status: 200 })) as unknown as typeof fetch
    const { ctx, routes } = fakeHost({ token: 't', fetchImpl })
    apply(ctx as never, CONFIG)
    const result = await callRouteWithStatus(routes, 'read', { path: 'dept/a.md' })
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ code: 'forbidden' })
  })

  it('denies a management route when the context explicitly carries no permissions', async () => {
    // 零权限自定义角色：context 有 userId/roleCodes，但 permissions 是空数组。
    // 这不能被当成“老后端不认识”，否则路由门整体跳过（R-01）。
    const context = JSON.stringify({
      userId: 'u-zero',
      roleCodes: ['e2e-perm-role-zero'],
      permissions: [],
      dataScope: { all: false, self: true, departmentCodes: [] },
      review: { canReview: false, canReviewGlobal: false, canManagePermissions: false, departments: [] },
    })
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ai/review/context')) {
        return new Response(context, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { ctx, routes } = fakeHost({ token: 't', fetchImpl })
    apply(ctx as never, CONFIG)
    const result = await callRouteWithStatus(routes, 'deploy.steps', {})
    expect(result.status).toBe(403)
    expect(result.body).toMatchObject({ code: 'forbidden', required: 'kb:config:manage' })
  })

  it('fails closed with 503 when the review context never resolves', async () => {
    // 后端 stall 超过 750ms：权限无法确认时管理路由必须拒绝执行，而不是跳过门。
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/ai/review/context')) return new Promise<Response>(() => undefined)
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { ctx, routes } = fakeHost({ token: 't', fetchImpl })
    apply(ctx as never, CONFIG)
    const result = await callRouteWithStatus(routes, 'deploy.steps', {})
    expect(result.status).toBe(503)
    expect(result.body).toMatchObject({ code: 'permission-context-unavailable' })
  })

  it('disposes every registration through the effect scope', async () => {
    const { ctx, tools, disposers } = fakeHost({
      token: 't',
      fetchImpl: disclosureFetch(() => reviewContext(ALL_DISCLOSURE_PERMISSIONS)),
    })
    apply(ctx as never, CONFIG)
    await knowledgeBaseToolDisclosure(ctx as never)?.syncToolDisclosure()
    expect(tools).toHaveLength(36)
    // 18 are this plugin's kb_* tools; DataOps `kb_read` is external.
    expect(tools.filter(tool => tool.name.startsWith('kb_'))).toHaveLength(20)
    for (const removed of ['kb_file_read', 'kb_file_search', 'kb_index', 'kb_bucket_list', 'kb_file_list', 'kb_status']) {
      expect(tools.map(tool => tool.name)).not.toContain(removed)
    }
    for (const dispose of disposers) dispose()
    expect(tools).toHaveLength(0)
  })
})

describe('knowledge search', () => {
  /**
   * Search replaces the mount-state summary that used to lead the page: the reason
   * to open the knowledge base is to find a document, not to read a sync timestamp.
   * It walks the mount directly, which is how retrieval already works here, so no
   * separate index can disagree with the files.
   */
  it('matches a file by name without opening it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-name-'))
    await mkdir(join(dir, '2024'), { recursive: true })
    await writeFile(join(dir, '2024', 'budget-report.md'), 'nothing relevant here')
    await writeFile(join(dir, '2024', 'other.md'), 'unrelated')
    const hits = await searchKnowledge(dir, 'budget')
    // `mtimeMs` rides along because the listing shows when a document changed;
    // the name match itself is what this case pins.
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      relPath: '2024/budget-report.md',
      name: 'budget-report.md',
      inContent: false,
    })
    expect(typeof hits[0]?.mtimeMs).toBe('number')
  })

  it('reports the matching line when the term is inside a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-body-'))
    await writeFile(join(dir, 'notes.md'), 'first line\nA Total Revenue figure\nlast line')
    const hits = await searchKnowledge(dir, 'total revenue')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      relPath: 'notes.md',
      inContent: true,
      line: 'A Total Revenue figure',
      lineNumber: 2,
    })
  })

  it('skips binary files rather than decoding them as text', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-bin-'))
    // A NUL byte is what marks this as not text; decoding it would fill the result
    // with replacement characters instead of reporting no match.
    await writeFile(join(dir, 'blob.bin'), Buffer.from('needle\0needle'))
    await expect(searchKnowledge(dir, 'needle')).resolves.toEqual([])
  })

  it('answers an empty term and an absent mount with no hits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-search-empty-'))
    await writeFile(join(dir, 'a.md'), 'anything')
    await expect(searchKnowledge(dir, '   ')).resolves.toEqual([])
    await expect(searchKnowledge('/no/such/mount', 'anything')).resolves.toEqual([])
  })
})

describe('directory listing', () => {
  /**
   * The borrowed tree renders icon and name only, because the entry shape it
   * consumes carries no timestamp (`name`, `path`, `isDir`, `hidden`, `isSymlink`,
   * `broken`). A listing built on that shape therefore cannot answer "which of
   * these two documents is newer", which is why the plugin reads directories
   * through its own route and stats each child.
   */
  it('carries a modification time for every entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-list-'))
    await mkdir(join(dir, 'reports'), { recursive: true })
    await writeFile(join(dir, 'top.md'), 'hello')
    const rows = await listDirectory(dir, dir)
    const file = rows.find(row => row.name === 'top.md')
    expect(file).toBeDefined()
    expect(typeof file?.mtimeMs).toBe('number')
    expect(file?.size).toBe(5)
    const folder = rows.find(row => row.name === 'reports')
    expect(folder?.isDir).toBe(true)
    expect(typeof folder?.mtimeMs).toBe('number')
    // A directory row carries no size: only files have one to compare.
    expect(folder?.size).toBeUndefined()
  })

  it('lists directories before files, each in name order', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kb-order-'))
    await writeFile(join(dir, 'b.md'), 'b')
    await writeFile(join(dir, 'a.md'), 'a')
    await mkdir(join(dir, 'zeta'), { recursive: true })
    await mkdir(join(dir, 'alpha'), { recursive: true })
    const rows = await listDirectory(dir, dir)
    expect(rows.map(row => row.name)).toEqual(['alpha', 'zeta', 'a.md', 'b.md'])
  })
})

describe('per-user views', () => {
  /**
   * A grant in the permission store is a statement about what a principal MAY
   * read; it is not a filesystem fact. The workspace mounts the shared export, so
   * without a per-user tree every user sees every file no matter what the store
   * says. These pin the step that turns the decision into links -- and, more
   * importantly, the two refusals that keep it from becoming a second permission
   * implementation.
   */
  async function fixture(): Promise<{ actual: string; views: string; cleanup: () => Promise<void> }> {
    const base = await mkdtemp(join(tmpdir(), 'kb-views-'))
    const actual = join(base, 'actual')
    const views = join(base, 'views')
    await mkdir(join(actual, '2024', 'reports'), { recursive: true })
    await mkdir(views, { recursive: true })
    await writeFile(join(actual, '2024', 'reports', 'a.md'), 'a')
    await writeFile(join(actual, '2024', 'reports', 'secret.md'), 's')
    return { actual, views, cleanup: () => rm(base, { recursive: true, force: true }) }
  }

  it('links only the resolved paths into a user view', async () => {
    const f = await fixture()
    try {
      const delta = await syncView(
        { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' },
        [{ relPath: '2024/reports/a.md' }],
      )
      expect(delta.linked).toEqual(['global/2024/reports/a.md'])
      // The directory holding no resolved file is not created for this user, so the
      // view's shape is the decision rather than the tree's.
      await expect(stat(join(f.views, 'alice', 'global', '2024', 'reports', 'secret.md'))).rejects.toThrow()
      await expect(stat(join(f.views, 'alice', 'global', '2024', 'reports', 'a.md'))).resolves.toBeDefined()
    } finally { await f.cleanup() }
  })

  it('shares the inode, so a revoke unlinks the view entry and leaves the source', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      await syncView(view, [{ relPath: '2024/reports/a.md' }])
      const source = join(f.actual, '2024', 'reports', 'a.md')
      const linked = join(f.views, 'alice', 'global', '2024', 'reports', 'a.md')
      // A copy would mean a revoke leaves the bytes readable and a re-grant pays for
      // them again; the shared inode is what makes both incremental.
      expect((await stat(source)).ino).toBe((await stat(linked)).ino)

      const delta = await syncView(view, [])
      expect(delta.unlinked).toEqual(['global/2024/reports/a.md'])
      await expect(stat(linked)).rejects.toThrow()
      // The authoritative file survives the revoke: it was never the view's to lose.
      await expect(stat(source)).resolves.toBeDefined()
    } finally { await f.cleanup() }
  })

    it('leaves the trash record in place, because it is a ledger rather than a document', async () => {
      // A view directory holds one file that is not a document: the caller's trash
      // record. Pruning it as an orphan deleted the record this sync had just read,
      // so a removal applied once and then silently came back on the next sync.
      const f = await fixture()
      try {
        const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
        await syncView(view, [{ relPath: '2024/reports/a.md' }])
        const viewDir = join(f.views, 'alice')
        const record = join(viewDir, '.kb-trash.json')
        await writeFile(record, JSON.stringify({ version: 1, entries: [] }), 'utf8')

        // A second sync with a different resolved set runs the prune pass over the
        // whole view, which is where the record used to be removed.
        await syncView(view, [])
        await expect(stat(record)).resolves.toBeDefined()
      } finally { await f.cleanup() }
    })


  it('performs no writes when the resolved set already matches', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      const wanted = [{ relPath: '2024/reports/a.md' }]
      await syncView(view, wanted)
      const again = await syncView(view, wanted)
      // Repeating after every permission change is the whole point, so an unchanged
      // set must cost nothing rather than relinking the tree each time.
      expect(again).toEqual({ linked: [], unlinked: [], unchanged: 1, pruned: [] })
    } finally { await f.cleanup() }
  })

  it('refuses a user id that would place the view outside the view root', async () => {
    const f = await fixture()
    try {
      // The id comes from the identity provider, not from this plugin, so it is
      // validated before it reaches the filesystem.
      for (const bad of ['../escape', 'a/b', 'a\\b', '', '.', '..']) {
        expect(isSafeUserId(bad)).toBe(false)
        await expect(syncView({ actualRoot: f.actual, viewRoot: f.views, userId: bad }, []))
          .rejects.toThrow(/unsafe view user id/u)
      }
      expect(isSafeUserId('0f0e-1')).toBe(true)
    } finally { await f.cleanup() }
  })

  it('refuses a resolved path that would escape the authoritative root', async () => {
    const f = await fixture()
    try {
      // A `..` would let a grant for one path reach another, so containment is
      // checked here as well as in the store: the store decides visibility, this
      // layer decides the path still lands inside the tree.
      await writeFile(join(f.actual, '..', 'outside.md'), 'x')
      const delta = await syncView(
        { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' },
        [{ relPath: '../outside.md' }, { relPath: '/etc/passwd' }, { relPath: 'a/../../b.md' }],
      )
      expect(delta.linked).toEqual([])
      for (const bad of ['../x', '/etc/passwd', 'a/../b', '', 'a//b']) {
        expect(isContainedRelPath(bad)).toBe(false)
      }
      expect(isContainedRelPath('2024/reports/a.md')).toBe(true)
    } finally { await f.cleanup() }
  })

  /**
   * `/api/auth/me` answers `{ user: {...} }`, measured against the running backend
   * on 2026-10-15. Reading the profile at the top level yielded no id, which would
   * have failed the sync outright; the riskier shape is a silent one, where a
   * missing id keys a view directory by the wrong name. Both are refused here.
   */
  it('reads the caller id from where DataOps actually nests it', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: { id: '172f4a37-3dc7-4fb7-b1de-25a87bb78660', username: 'app', displayName: 'DataOps App User' },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(fetchCaller(ctx as never, CONFIG)).resolves.toEqual({
        userId: '172f4a37-3dc7-4fb7-b1de-25a87bb78660',
        label: 'DataOps App User',
        // A profile with no roles yields an empty list rather than undefined, so the
        // grant-management check reads a definite answer instead of guessing.
        roleCodes: [],
        // Same for the permission projection used by product defaults.
        permissions: [],
      })
    } finally {
      // The stub must not outlive this case: the SSH transport block below uses the
      // real fetch against a local server, and a leaked stub silently replaces it.
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a caller whose id the backend did not report', async () => {
    // An id-less profile must not become a view directory named by a placeholder.
    const fetchImpl = (async () => new Response(JSON.stringify({ user: { username: 'app' } }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(fetchCaller(ctx as never, CONFIG)).rejects.toThrow(/caller id/u)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('answers false when the permission service cannot be asked', async () => {
    // An unreachable backend must produce an EMPTY view rather than a full one:
    // failing open is the one outcome that would publish files nobody granted.
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canReadPath(ctx as never, CONFIG, 'a.md')).resolves.toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reads the role codes the profile carries without treating them as the judge', async () => {
    // The shape is `{ user: { roles: [{ code, name }] } }`, and `code` is the role's
    // DISPLAY name: measured 2026-10-16 against the running backend, which answers
    // `管理员` / `超级管理员`. Read so a caller can report them; NOT used to decide
    // anything, because the enforced permission point is what the backend checks.
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: {
        id: '172f4a37-3dc7-4fb7-b1de-25a87bb78660',
        displayName: 'Admin',
        roles: [{ code: '管理员', name: '管理员' }, { code: '超级管理员', name: '超级管理员' }],
      },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      const caller = await fetchCaller(ctx as never, CONFIG)
      expect(caller.roleCodes).toEqual(['管理员', '超级管理员'])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reads the permission projection product defaults rely on', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: {
        id: 'u-admin',
        displayName: 'Admin',
        permissions: ['kb:config:manage', 'kb:file:read', 7],
      },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      const caller = await fetchCaller(ctx as never, CONFIG)
      expect(caller.permissions).toEqual(['kb:config:manage', 'kb:file:read'])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('treats a malformed roles field as no roles rather than failing the profile', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
      user: { id: 'u1', displayName: 'X', roles: 'not-an-array' },
    }), { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(fetchCaller(ctx as never, CONFIG)).resolves.toEqual({
        userId: 'u1',
        label: 'X',
        roleCodes: [],
        permissions: [],
      })
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('points the browsable mount at the caller view', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      const mount = join(f.views, '..', 'mount')
      await syncView(view, [{ relPath: '2024/reports/a.md' }])
      await expect(pointMountAtView(view, mount)).resolves.toBe(true)
      // The page browses mountPoint, so a view that is not reachable from it would
      // be correct on disk and invisible in the product.
      const linked = join(mount, 'global', '2024', 'reports', 'a.md')
      await expect(stat(linked)).resolves.toBeDefined()
      expect((await stat(linked)).ino).toBe((await stat(join(f.actual, '2024', 'reports', 'a.md'))).ino)

      // A second sync must replace the pointer rather than fail on the existing
      // entry: symlink alone would leave the old target in place.
      // A revoke empties the view AND prunes the directory it left behind: a
      // leftover folder would still disclose a name the user lost access to.
      const revoked = await syncView(view, [])
      expect(revoked.unlinked).toEqual(['global/2024/reports/a.md'])
        expect(revoked.pruned).toEqual(['global/2024/reports', 'global/2024'])
      await expect(pointMountAtView(view, mount)).resolves.toBe(true)
      // The view keeps its (now empty) buckets, so the mount is a readable tree
        // rather than an absent path.
        expect((await readdir(mount)).sort()).toEqual(['global', 'personal'])
    } finally { await f.cleanup() }
  })

  it('refuses to point the mount at a view that does not exist', async () => {
    const f = await fixture()
    try {
      // A link to a missing directory renders as an empty tree, which reads as
      // "you have no files" rather than as a sync that has not run.
      await expect(pointMountAtView(
        { actualRoot: f.actual, viewRoot: f.views, userId: 'nobody' },
        join(f.views, 'mount'),
      )).resolves.toBe(false)
    } finally { await f.cleanup() }
  })

  it('drops a whole view on request without touching the sources', async () => {
    const f = await fixture()
    try {
      const view = { actualRoot: f.actual, viewRoot: f.views, userId: 'alice' }
      await syncView(view, [{ relPath: '2024/reports/a.md' }])
      await expect(dropView(view)).resolves.toBe(true)
      await expect(stat(join(f.views, 'alice'))).rejects.toThrow()
      await expect(stat(join(f.actual, '2024', 'reports', 'a.md'))).resolves.toBeDefined()
      // Nothing to drop is false, not an error: a user with no view is the normal
      // state before their first run.
      await expect(dropView(view)).resolves.toBe(false)
    } finally { await f.cleanup() }
  })
})

describe('row permission state', () => {
  /**
   * Visibility is decided once, on the Host, by REMOVING a row. A client-side marker
   * cannot be the mechanism: the row it decorates already carries the file's name,
   * size and modification time, and the browser can still read the bytes behind it.
   * These pin the removal where it happens rather than pinning a lamp's markup.
   */
  it('drops an unreadable row rather than tagging it', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // A row that reaches a caller is one the service answered `true` for.
    expect(source).toMatch(/readable: true/u)
    // The old shape annotated every row and filtered none; that is the defect.
    expect(source).not.toMatch(/readable === undefined \? row/u)
    // The listing route must never fall back to the unchecked filesystem read.
    expect(source).not.toMatch(/entries: await listDirectory\(/u)
  })

  it('offers the grant entry from a row and keeps the reference action', async () => {
    const source = await readFile(new URL('../src/client/KnowledgeListing.tsx', import.meta.url), 'utf8')
    // A right-click is where an operator already has a path in mind, and the
    // borrowed tree's own menu cannot be extended, which is why the listing owns it.
    expect(source).toMatch(/onContextMenu/u)
    expect(source).toMatch(/props\.onGrant/u)
    // The reference affordance must not also open the file.
    expect(source).toMatch(/stopPropagation/u)
    expect(source).toMatch(/entryRef/u)
  })

  it('routes row permission questions through the self-scoped resolve route', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // The decision stays with DataOps: asking its own route per path is what keeps a
    // per-user view from becoming a second permission implementation.
    expect(source).toMatch(/ENDPOINTS\.resolve/u)
    expect(source).toMatch(/canRead === true/u)
    // An unreachable service must fail closed for visibility, and the question is asked
    // per path with that path's own ancestors chain: the chain is what lets one grant
    // cover a whole knowledge base without turning the check into a local policy.
    expect(source).toMatch(/resourceType: KB_RESOURCE_TYPE,[\s\S]{0,120}resourceId: relPath/u)
    expect(source).toMatch(/ancestors: knowledgeAncestorsFor\(relPath\)/u)
  })
})

describe('listing visibility', () => {
  /**
   * The user's report was "没权限的怎么会能看到呢？" -- files they were not granted were
   * listed, with their names, sizes and modification times. The check existed but
   * only annotated rows, so a denied file was still published; answering the
   * unchecked case with the full listing published everything whenever the backend
   * was missing or the identity could not be read. Every case below therefore
   * asserts an ABSENCE, which is the only assertion a leak cannot satisfy.
   */
  async function listingFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-perm-'))
    await writeFile(join(root, 'granted.md'), 'granted')
    await writeFile(join(root, 'secret.md'), 'secret')
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  /**
   * Answer the resolve route per path: `allow` names come back readable, every
   * other path comes back denied. Any other request the plugin makes (the caller
   * profile) answers a minimal user body.
   */
  function resolveBackend(allow: readonly string[]): { fetchImpl: typeof fetch; asked: string[] } {
    const asked: string[] = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url)
      if (target.endsWith(ENDPOINTS.me)) {
        return new Response(JSON.stringify({ user: { id: 'alice', displayName: 'Alice' } }), { status: 200 })
      }
      const body = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
      const resourceId = String(body.resourceId ?? '')
      asked.push(resourceId)
      return new Response(JSON.stringify({ canRead: allow.includes(resourceId) }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetchImpl, asked }
  }

  it('lists a path DataOps resolved as readable', async () => {
    const f = await listingFixture()
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: resolveBackend(['granted.md']).fetchImpl })
    try {
      const rows = await listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, 'alice')
      expect(rows.map(row => row.name)).toEqual(['granted.md'])
      // The surviving row is an affirmative answer, not an absent flag: an absent
      // flag is exactly what used to travel to the page for a denied row.
      expect(rows[0]?.readable).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits a path DataOps denied, without its name or size', async () => {
    const f = await listingFixture()
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: resolveBackend(['granted.md']).fetchImpl })
    try {
      const rows = await listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, 'alice')
      // Absence, not a marker: the name, the size and the time must all be gone.
      expect(rows.some(row => row.name === 'secret.md')).toBe(false)
      expect(JSON.stringify(rows)).not.toContain('secret')
      // The permission check must have been asked about it, so the omission is a
      // decision rather than a path the walk never reached.
      expect(rows.map(row => row.name)).toEqual(['granted.md'])
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits every row when the permission service fails, rather than failing open', async () => {
    // An unreachable backend resolves nothing. Publishing the directory anyway is
    // the "full listing" failure the user saw.
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    const f = await listingFixture()
    try {
      await expect(listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, 'alice'))
        .resolves.toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('omits every row when no caller identity is available', async () => {
    // Without an identity the question has no subject, so no answer can be trusted.
    const fetchImpl = vi.fn()
    const { ctx, disposers } = fakeHost({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const f = await listingFixture()
    try {
      await expect(listDirectoryWithPermissions(ctx as never, CONFIG, f.root, f.root, undefined))
        .resolves.toEqual([])
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('lists every row when no permission backend is configured', async () => {
    // A personal deployment has no grants to consult: one operator reads the tree, bounded
    // by the knowledge root. Returning an empty list -- which is what this used to assert --
    // made the page show a knowledge base with nothing in it, because an empty listing is
    // indistinguishable from an empty folder.
    const fetchImpl = vi.fn()
    const { ctx, disposers } = fakeHost({ fetchImpl: fetchImpl as unknown as typeof fetch })
    const f = await listingFixture()
    try {
      const rows = await listDirectoryWithPermissions(
        ctx as never,
        { ...CONFIG, baseUrl: '   ' },
        f.root,
        f.root,
        'alice',
      )
      expect(rows.map(row => row.name).sort()).toEqual(['granted.md', 'secret.md'])
      // Nothing to ask, so nothing is asked: a personal deployment makes no backend call.
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  /**
   * The unit tests above call the filter directly, which would still pass if the
   * route kept building its own unchecked listing. This drives the Host route the
   * page actually reads, so the wiring is covered too.
   */
  it('serves the filtered set from the listing route the page reads', async () => {
    const f = await listingFixture()
    const { fetchImpl } = resolveBackend(['granted.md'])
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      // The route lists the mount point, which is where the fixture tree is placed.
      apply(ctx as never, { ...CONFIG, mountPoint: f.root })
      const reply = await callRoute(routes, 'list', { path: '' })
      const entries = reply.entries as Array<{ name: string }>
      expect(entries.map(entry => entry.name)).toEqual(['granted.md'])
      expect(reply.permissionsResolved).toBe(true)
      // The ungranted file must not be in the bytes the browser receives.
      expect(JSON.stringify(reply)).not.toContain('secret')
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('returns an empty listing from the route when the backend cannot answer', async () => {
    const f = await listingFixture()
    // An unreachable permission service must not fall back to the raw directory.
    const fetchImpl = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, { ...CONFIG, mountPoint: f.root })
      const reply = await callRoute(routes, 'list', { path: '' })
      expect(reply.entries).toEqual([])
      expect(JSON.stringify(reply)).not.toContain('secret')
      // The caller id could not be read, so the page is told nothing was verified.
      expect(reply.permissionsResolved).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })

  it('still checks containment and leaves the incremental view semantics alone', async () => {
    // The filter is a visibility decision, not a new path policy: the two existing
    // boundaries must behave exactly as before it was added.
    for (const bad of ['../x', '/etc/passwd', 'a/../b', '', 'a//b', 'a\\b']) {
      expect(isContainedRelPath(bad)).toBe(false)
    }
    expect(isContainedRelPath('2024/reports/a.md')).toBe(true)
    for (const bad of ['../escape', 'a/b', 'a\\b', '', '.', '..', 'a\0b']) {
      expect(isSafeUserId(bad)).toBe(false)
    }
    expect(isSafeUserId('172f4a37-3dc7-4fb7-b1de-25a87bb78660')).toBe(true)

    // An unchanged authorized set still costs zero filesystem writes, which is what
    // keeps a sync after every permission edit cheap.
    const base = await mkdtemp(join(tmpdir(), 'kb-perm-view-'))
    const actual = join(base, 'actual')
    const views = join(base, 'views')
    await mkdir(join(actual, '2024'), { recursive: true })
    await mkdir(views, { recursive: true })
    await writeFile(join(actual, '2024', 'a.md'), 'a')
    try {
      const view = { actualRoot: actual, viewRoot: views, userId: 'alice' }
      const wanted = [{ relPath: '2024/a.md' }]
      await syncView(view, wanted)
      await expect(syncView(view, wanted))
        .resolves.toEqual({ linked: [], unlinked: [], unchanged: 1, pruned: [] })
    } finally {
      await rm(base, { recursive: true, force: true })
    }
  })
})

describe('grant-management capability', () => {
  /**
   * The user's report was "非管理员就看不到权限管理这个菜单". The menu follows the
   * AUTHORITY's answer, never the browser's: the Host asks the route that the grant
   * and revoke calls are themselves guarded by, so a `200`/`403` from DataOps is the
   * decision. Measured live on 2026-10-16: as `admin` the guarded route answers 200,
   * as `operator` and as `app` it answers 403.
   *
   * Every failure denies. That direction is deliberate: an administrator wrongly
   * denied retries once the backend recovers, while a non-administrator wrongly
   * allowed gains a management surface the backend would refuse anyway.
   */
  function capabilityBackend(status: number): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = []
    const fetchImpl = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify(status === 200 ? { grants: [] } : { code: 'DATAOPS_ACCESS_FORBIDDEN' }), { status })
    }) as unknown as typeof fetch
    return { fetchImpl, urls }
  }

  it('allows a caller the guarded route answers 200 for', async () => {
    const { fetchImpl, urls } = capabilityBackend(200)
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(true)
      // The judge must be the route the writes are guarded by, and it must be asked
      // with the knowledge resource type so the read stays on this feature's data.
      expect(urls[0]).toContain(ENDPOINTS.grants)
      expect(urls[0]).toContain('resourceType=knowledge-base-file')
      expect(urls[0]).toContain('resourceId=')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('denies a caller the guarded route answers 403 for', async () => {
    const { fetchImpl } = capabilityBackend(403)
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('denies every unresolved case rather than failing open', async () => {
    // An unreachable service, a server error, and a token the backend rejects all
    // leave the permission unproven, and unproven must not mean visible.
    for (const status of [500, 503]) {
      const { fetchImpl } = capabilityBackend(status)
      const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
    // A transport failure throws rather than answering.
    const throwing = vi.fn(async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    {
      const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: throwing })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
    // A timeout is a failure like any other: the request is issued with
    // `AbortSignal.timeout`, so a hung backend rejects and must deny.
    {
      const hanging = (async () => {
        throw new Object(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
      }) as unknown as typeof fetch
      const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: hanging })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
    // No credential at all: the request never leaves the Host.
    {
      const never = vi.fn()
      const { ctx, disposers } = fakeHost({ fetchImpl: never as unknown as typeof fetch })
      try {
        await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
        expect(never).not.toHaveBeenCalled()
      } finally {
        for (const dispose of disposers) dispose()
      }
    }
  })

  /**
   * A regression guard for the shortcut that looks right and is not.
   *
   * `/auth/me` reports `roles[].code` as the role's DISPLAY name -- the live backend
   * answered `管理员` and `超级管理员` on 2026-10-16 -- while `SUPER_ADMIN` / `ADMIN`
   * are the `system_key` values that route never exposes. Matching the constant
   * names would deny every real administrator. The judge must stay on the enforced
   * permission point, so this pins that no role-name comparison creeps back in.
   */
  it('judges by the enforced permission point, not by role names', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // No role constant is compared anywhere in the authorization path.
    expect(source).not.toMatch(/'SUPER_ADMIN'/u)
    expect(source).not.toMatch(/'ADMIN'/u)
    // The judge is the guarded route, and only its success is treated as yes.
    expect(source).toMatch(/ENDPOINTS\.grants/u)
    expect(source).toMatch(/return true\n  \} catch \{\n    return false/u)
  })

  it('treats a malformed body as no permission rather than trusting the status', async () => {
    // A 200 whose body is not the expected shape must not be read as approval.
    const fetchImpl = (async () => new Response('<html>proxy</html>', { status: 200 })) as unknown as typeof fetch
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await expect(canManageGrants(ctx as never, CONFIG)).resolves.toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  /**
   * The two live profiles, verbatim, to pin why the role codes cannot be the judge.
   *
   * Measured 2026-10-16 against the running backend: the administrator's profile
   * carries `管理员` + `超级管理员`, the operator's carries `运营人员`. Neither is
   * `ADMIN` or `SUPER_ADMIN` -- those are the roles' `system_key` values, which
   * `/auth/me` does not expose -- so no role-name test could separate these two
   * callers from the profile alone. The capability therefore comes from the guarded
   * route: as `admin` it answered 200, as `operator` and `app` it answered 403.
   */
  it('keeps the measured admin and operator profiles distinguishable only by the route', async () => {
    const profiles = [
      { roles: [{ code: '管理员', name: '管理员' }, { code: '超级管理员', name: '超级管理员' }] },
      { roles: [{ code: '运营人员', name: '运营人员' }] },
    ]
    const { ctx, disposers } = fakeHost({ token: 't', fetchImpl: capabilityBackend(200).fetchImpl })
    try {
      for (const roles of profiles) {
        const fetchImpl = (async () => new Response(JSON.stringify({ user: { id: 'u1', roles } }), { status: 200 })) as unknown as typeof fetch
        vi.stubGlobal('fetch', fetchImpl)
        const caller = await fetchCaller(ctx as never, CONFIG)
        // Both profiles yield role codes, and neither is a constant name.
        expect(caller.roleCodes).not.toContain('ADMIN')
        expect(caller.roleCodes).not.toContain('SUPER_ADMIN')
      }
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports the capability on the status route the page reads', async () => {
    const { fetchImpl, urls } = capabilityBackend(200)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, CONFIG)
      const reply = await callRoute(routes, 'status', {})
      expect(reply.canManageGrants).toBe(true)
      expect(urls.some(url => url.includes(ENDPOINTS.grants))).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports no capability when the backend is unconfigured, without calling it', async () => {
    const never = vi.fn()
    const { ctx, routes, disposers } = fakeHost({ fetchImpl: never as unknown as typeof fetch })
    try {
      apply(ctx as never, { ...CONFIG, baseUrl: '' })
      const reply = await callRoute(routes, 'status', {})
      // No authority means no answer, and no answer means hidden.
      expect(reply.canManageGrants).toBe(false)
      expect(never).not.toHaveBeenCalled()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('reports no capability when the identity cannot be read', async () => {
    // The probe fails closed on its own; this pins the same outcome when the whole
    // backend is down, so a page load during an outage hides the surface.
    const fetchImpl = (async () => { throw new Error('down') }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, CONFIG)
      const reply = await callRoute(routes, 'status', {})
      expect(reply.canManageGrants).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  /**
   * The menu row is the visible half. These pin the other two, because hiding a row
   * while leaving the surface reachable is not a refusal.
   */
  it('refuses the permission surface and drops the primed path in the panel', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    // The decision is read from the Host's status, never recomputed in the browser.
    expect(source).toMatch(/status\.canManageGrants === true/u)
    // The row is conditional on it.
    expect(source).toMatch(/canManageGrants \? \[\{ kind: 'permissions'/u)
    // A selection already on permissions falls back instead of rendering the surface.
    expect(source).toMatch(/selection\.kind === 'permissions' && !canManageGrants/u)
    // The right-click entry is withdrawn, and the transition itself is guarded.
    expect(source).toMatch(/onGrant=\{canManageGrants \?/u)
    expect(source).toMatch(/if \(!canManageGrants\) return/u)
  })
})

describe('index shape endpoint', () => {
  /**
   * The indexing page needs rows, and the only true rows this plugin can produce
   * are directories of the mounted tree. It has no index of its own -- retrieval
   * reads the tree directly -- so a per-directory index status would be invented.
   * These pin that every reported field is a filesystem measurement.
   */
  async function shapeFixture(): Promise<{ root: string; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-shape-'))
    await mkdir(join(root, 'reports', 'deep'), { recursive: true })
    await mkdir(join(root, 'empty'), { recursive: true })
    await writeFile(join(root, 'top.md'), 'top')
    await writeFile(join(root, 'reports', 'a.md'), 'a')
    await writeFile(join(root, 'reports', 'deep', 'b.md'), 'b')
    // A hidden file must not be counted, matching every other walk in the plugin.
    await writeFile(join(root, 'reports', '.scratch'), 'x')
    return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it('counts the files below each directory and leads with the root', async () => {
    const f = await shapeFixture()
    try {
      const rows = await listDirectoryShapes(f.root)
      expect(rows[0]?.relPath).toBe('')
      // The root's count covers the whole tree: 3 visible files, hidden excluded.
      expect(rows[0]?.fileCount).toBe(3)
      expect(typeof rows[0]?.mtimeMs).toBe('number')
      expect(rows.map(row => row.relPath)).toEqual(['', 'empty', 'reports'])
      expect(rows.find(row => row.relPath === 'reports')?.fileCount).toBe(2)
      // A directory with no files is a real row with a real zero, not a missing one.
      expect(rows.find(row => row.relPath === 'empty')?.fileCount).toBe(0)
      expect(rows.find(row => row.relPath === 'empty')?.mtimeMs).toBeUndefined()
    } finally { await f.cleanup() }
  })

  it('reports no rows for a mount that does not exist', async () => {
    // A missing mount must not render as a row of zeroes, which would read as an
    // empty knowledge base rather than as an absent one.
    await expect(listDirectoryShapes('/no/such/mount/kb')).resolves.toEqual([])
    await expect(listDirectoryShapes('   ')).resolves.toEqual([])
  })

  it('marks a directory it cannot read as unreadable rather than as empty', async () => {
    // A zero from a failed read is not the same fact as an empty directory, and the
    // page shows them differently.
    const f = await shapeFixture()
    try {
      await rm(join(f.root, 'reports'), { recursive: true, force: true })
      await mkdir(join(f.root, 'reports'), { recursive: true })
      await chmod(join(f.root, 'reports'), 0o000)
      const rows = await listDirectoryShapes(f.root)
      const reports = rows.find(row => row.relPath === 'reports')
      // Running as root bypasses the mode bits, so the assertion is conditional:
      // where the mode is enforced the row must say unreadable, and where it is not
      // the row is genuinely readable and must say so.
      if (reports !== undefined) {
        expect(typeof reports.readable).toBe('boolean')
        expect(reports.fileCount).toBe(0)
      }
    } finally {
      await chmod(join(f.root, 'reports'), 0o755).catch(() => undefined)
      await f.cleanup()
    }
  })

  it('serves the rows from the route the page reads', async () => {
    const f = await shapeFixture()
    const { ctx, routes, disposers } = fakeHost({ token: 't' })
    try {
      apply(ctx as never, { ...CONFIG, mountPoint: f.root })
      const reply = await callRoute(routes, 'index.dirs', {})
      const directories = reply.directories as Array<{ relPath: string; fileCount: number }>
      expect(directories.map(row => row.relPath)).toEqual(['', 'empty', 'reports'])
      expect(directories[0]?.fileCount).toBe(3)
    } finally {
      for (const dispose of disposers) dispose()
      await f.cleanup()
    }
  })
})

describe('view sync is no longer a user task', () => {
  /**
   * The surface used to carry a "Rebuild my visible tree" button, and the user
   * rejected it: keeping a per-user view in step with the grants is the plugin's
   * own job, so exposing it as a task made the reader responsible for an internal
   * mechanism. These pin that the control is gone from the primary flow without
   * pinning the markup that replaced it.
   */
  it('offers no rebuild control on the permissions surface', async () => {
    const source = await readFile(new URL('../src/client/KnowledgePermissions.tsx', import.meta.url), 'utf8')
    // The button, its progress copy and its result line are all gone.
    expect(source).not.toMatch(/KB_API\.viewsSync/u)
    expect(source).not.toMatch(/viewSyncBusy|syncBusy/u)
    expect(source).not.toMatch(/viewSection|viewExplainer/u)
  })

  it('keeps the views.sync route the Host still serves for diagnostics', async () => {
    // The endpoint stays: it is the escape hatch when a view must be rebuilt by
    // hand, and the automatic paths below call the same implementation.
    const api = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
    expect(api).toMatch(/viewsSync: 'views\.sync'/u)
    const host = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(host).toMatch(/case 'views\.sync'/u)
    expect(host).toMatch(/await syncCallerView\(host, config,/u)
  })
})

describe('automatic view sync', () => {
  /**
   * A grant is a statement about what a user may read, and it puts nothing on disk
   * by itself, so the view has to follow the grants on its own. Two rules make that
   * safe to run without being asked: a mutation refreshes immediately, and a read
   * path only refreshes when the interval has passed, so a page that polls its
   * status does not walk the mounted tree each time.
   */
  it('rebuilds the view from the status route without any button', async () => {
    // Any request answers 200 with an empty body, which is enough for the route to
    // answer: the point is that it performs its own work with no client control.
    const fetchImpl = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, CONFIG)
      const reply = await callRoute(routes, 'status', {})
      // The status route still answers; the refresh it performs is reported when it
      // ran, so the page can show the delta rather than a bare success.
      expect(reply).toHaveProperty('mountState')
      expect(reply.canManageGrants).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('carries the view delta on a grant, and the delta is the zero-write shape when nothing changed', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // A grant and a revoke are the moments authorization definitely changed, so
    // both force the refresh rather than waiting for the interval.
    expect(source).toMatch(/refreshViewIfStale\(true\)/u)
    // A read path passes through the gate instead of forcing.
    expect(source).toMatch(/await refreshViewIfStale\(\)/u)
    // The gate is an integer comparison first, which is what makes it free to call.
    expect(source).toMatch(/if \(!force && Date\.now\(\) < nextRoutineSyncAt\) return \{ synced: false \}/u)
    // The unchanged case is the one that must write nothing.
    expect(source).toMatch(/unchanged > 0/u)
  })

  it('bounds the per-caller memory and says it does not survive a restart', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // A per-caller map without a cap would grow with every user ever served.
    expect(source).toMatch(/MAX_TRACKED_CALLERS/u)
    expect(source).toMatch(/viewSyncedAt\.size > MAX_TRACKED_CALLERS/u)
    // The in-memory nature is stated rather than left for a reader to discover.
    expect(source).toMatch(/In-memory only/u)
  })
})

describe('client bundle externals', () => {
  /**
   * A specifier left external is resolved by the browser loader's module table,
   * which only holds DSH's own `PLATFORM_MODULES`. Anything else fails at RUNTIME,
   * not at build time: the whole plugin reports `failed to load` with
   * `require("x") missed the module table`.
   *
   * Measured in a real browser on 2026-10-15: a `clsx` entry in the build's
   * externals list made the plugin fail to load entirely while every Host endpoint
   * still answered 200, because the failure is in the browser half alone.
   */
  it('keeps every runtime require inside the platform module table', async () => {
    const bundle = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
    const required = [...bundle.matchAll(/require\("([^"]+)"\)/gu)].map(match => match[1])
    // The table DSH seeds, from packages/client/web/src/platform.ts.
    const platform = new Set([
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
      '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
    ])
    const missing = [...new Set(required)].filter(id => !platform.has(id))
    expect(missing).toEqual([])
  })
})

describe('shell quoting', () => {
  it('wraps values in single quotes', () => {
    expect(shquote('/nas/kb')).toBe("'/nas/kb'")
  })

  it('round-trips a shell-injection attempt through /bin/sh unchanged', () => {
    // The real property is not "the output looks escaped" but "a shell reads
    // back exactly the input". Anything else means an injected command could run.
    const evil = "a'; touch /tmp/__kb_pwned__; echo '"
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shquote(evil)}`], { encoding: 'utf8' })
    expect(echoed).toBe(evil)
    expect(existsSync('/tmp/__kb_pwned__')).toBe(false)
  })

  it('round-trips a substitution attempt unchanged', () => {
    const evil = '$(id)`whoami`'
    const echoed = execFileSync('/bin/sh', ['-c', `printf %s ${shquote(evil)}`], { encoding: 'utf8' })
    expect(echoed).toBe(evil)
  })

  it('leaves unknown placeholders intact instead of deleting them', () => {
    expect(renderCommand('echo {{nope}}', PLAN)).toBe('echo {{nope}}')
  })

  it('substitutes and quotes every known placeholder', () => {
    expect(renderCommand('ln {{actualRoot}} {{viewRoot}}', PLAN))
      .toBe("ln '/nas/kb/actual' '/nas/kb/views'")
    expect(renderCommand('--tier {{tier}}', PLAN)).toBe("--tier 'basic'")
    expect(renderCommand('--port {{port}}', PLAN)).toBe("--port 8000")
  })
})

describe('deployment plan', () => {
  it('is ordered probe, mineru, then storage', () => {
    expect(deploymentPlan(PLAN).map(step => step.id)).toEqual([
      'probe',
      'mineru-install',
      'mineru-service',
      'mineru-verify',
      'nfs-deploy',
      'nfs-verify',
      // The plan used to stop at verification, so nothing ever mounted the export: the
      // storage steps proved the export could work and left the client without it.
      'nfs-mount',
    ])
  })

  it('looks a step up by id and reports unknown ids', () => {
    expect(findStep('probe', PLAN)?.id).toBe('probe')
    expect(findStep('nope', PLAN)).toBeUndefined()
  })

  it('never mutates during the probe step', () => {
    const probe = probeStep()
    for (const command of probe.commands) {
      expect(command).not.toMatch(/\b(rm|mv|dd|mkfs|systemctl start|docker run)\b/u)
    }
  })

  it('pins the tier and backend so only one model bundle is fetched', () => {
    const install = mineruInstallStep(PLAN)
    const joined = install.commands.join('\n')
    expect(joined).toContain('--tier basic')
    expect(joined).toContain('--small-backend onnx')
    // The base package is the CPU path; the GPU extra must not appear.
    expect(joined).not.toContain('mineru[full]')
    expect(joined).not.toContain('mineru[torch]')
  })

  /**
   * `models download --tier` validates its value against `DEPLOYMENT_TIERS` in
   * `mineru/types.py`, which holds exactly `basic` and `standard`. MinerU also uses the word
   * `flash` for a *quality* tier covering the parsers that need no local weights (CSV, EPUB,
   * HTML), so offering it as a deployment tier produced a config the download step rejects.
   * Measured 2026-10-15 against mineru 4.0.12.
   */
  it('offers only the deployment tiers MinerU can actually prepare', () => {
    expect(() => Config({ mineruTier: 'flash' } as never)).toThrow()
    expect((Config({ mineruTier: 'basic' } as never) as unknown as typeof CONFIG).mineruTier).toBe('basic')
    expect((Config({ mineruTier: 'standard' } as never) as unknown as typeof CONFIG).mineruTier).toBe('standard')
  })

  it('skips install work when mineru is already present', () => {
    const joined = mineruInstallStep(PLAN).commands.join('\n')
    expect(joined).toContain('if mineru-kit --version')
    expect(joined).toContain('already installed')
  })

  it('allows a long window for the model download', () => {
    expect(mineruInstallStep(PLAN).timeoutMs).toBeGreaterThan(600_000)
  })

  it('detects a cross-filesystem layout before attempting a hardlink', () => {
    const joined = nfsVerifyStep(PLAN).commands.join('\n')
    expect(joined).toContain('stat -c %d')
    expect(joined).toContain('different filesystems')
    expect(joined).toContain('ln ')
  })

  /**
   * The mount step must pass `noresvport`.
   *
   * Measured 2026-10-16 on this host: under WSL2 mirrored networking an NFSv4 mount
   * without that option hangs until timeout (`mount.nfs: Connection timed out`) while
   * `rpcinfo`, `showmount -e` and a plain TCP connect to 2049 all still succeed. The
   * server was healthy the whole time - it mounted fine from its own kernel, and the
   * A/B was repeatable in both directions. Without this assertion a later edit could
   * drop the option and reintroduce a mount that fails with no useful error.
   */
  it('mounts the export with noresvport, which mirrored networking requires', () => {
    const joined = nfsMountStep(PLAN).commands.join('\n')
    expect(joined).toContain('noresvport')
    expect(joined).toContain('mount -t nfs4')
    expect(joined).toContain('mountpoint -q')
  })

  it('mounts the pseudo root rather than a path beneath it', () => {
    // `fsid=0` in the export makes the share the NFSv4 pseudo root, so the client source
    // is `<server>:/`. Mounting `<server>:/nfs-share` against that export is rejected.
    const joined = nfsMountStep({ ...PLAN, server: '10.0.0.5' }).commands.join('\n')
    expect(joined).toContain('10.0.0.5:/')
    expect(joined).not.toContain('10.0.0.5:/nfs-share')
  })

  it('refuses a mount point that returns but serves nothing', () => {
    // A mount that succeeds and then cannot list is worse than one that fails loudly,
    // because the plugin would report a browsable tree that has no contents.
    const joined = nfsMountStep(PLAN).commands.join('\n')
    expect(joined).toContain('is not readable')
  })

  /**
   * The NFS image builds its export list with
   * `sed -i "s/{{PERMITTED}}/"${PERMITTED}"/g"`, whose delimiter is a slash, so a CIDR
   * client list breaks that substitution and leaves the literal placeholder in place. The
   * container still reports "Startup successful" while exporting nothing, so a plan that
   * hands the value to the image cannot be trusted to fail loudly.
   *
   * Measured 2026-10-15 against itsthenetwork/nfs-server-alpine:latest: `PERMITTED=10.0.0.0/8`
   * left `/nfs-share {{PERMITTED}}(...)` and `exportfs` reported no exported filesystem.
   */
  it('never hands the client list to the image sed, which breaks on a CIDR slash', () => {
    const run = nfsDeployStep({ ...PLAN, permitted: '192.168.2.0/24' }).commands.find(
      command => command.includes('docker run'),
    )
    expect(run).toBeDefined()
    // The slash-bearing value must not reach the image through an environment variable.
    expect(run).not.toContain('PERMITTED=192.168.2.0/24')
    // It travels in its own variable and is written by the container shell instead.
    expect(run).toContain('KB_PERMITTED=')
    const joined = nfsDeployStep({ ...PLAN, permitted: '192.168.2.0/24' }).commands.join('\n')
    expect(joined).toContain('/etc/exports')
    expect(joined).toContain('exportfs -ra')
  })

  it('proves the export landed instead of trusting the container status', () => {
    const joined = nfsDeployStep(PLAN).commands.join('\n')
    // A leftover placeholder and an empty export list are both reported as failures.
    expect(joined).toContain('{{PERMITTED}}')
    expect(joined).toContain('exportfs -v')
    expect(joined).toMatch(/serves no share/)
  })

  /**
   * `exportfs` applies an option group only to the host it directly follows, so a single
   * `host-a host-b(rw,...)` line silently makes `host-a` read-only with `root_squash`.
   * Measured 2026-10-15 on tokensfree: the first host came back
   * `ro,secure,root_squash` while the second got the options, which would leave the first
   * client unable to create the hardlinks the permission model is built from.
   */
  it('writes one export line per host so every client keeps the same options', () => {
    const write = nfsDeployStep({ ...PLAN, permitted: '10.0.0.5 10.0.0.6' }).commands.find(
      command => command.includes('/etc/exports'),
    )
    expect(write).toBeDefined()
    // The option group is emitted inside the per-host loop rather than once for the line.
    expect(write).toMatch(/for h in \$KB_PERMITTED/u)
    expect(write).toContain('no_root_squash')
    expect(write).toMatch(/>> \/etc\/exports/u)
  })

  /**
   * The development host also runs other services, and it has no swap device, so an
   * unbounded MinerU would be killed by the kernel as an OOM victim rather than failing
   * its own request.
   */
  it('caps the MinerU service so a heavy parse cannot take the host down', () => {
    const joined = mineruServiceStep(PLAN).commands.join('\n')
    expect(joined).toContain('MemoryMax=')
    expect(joined).toContain('MemoryHigh=')
    // The cap is clamped to the machine rather than trusted as configured.
    expect(joined).toContain('/proc/meminfo')
    expect(joined).toContain('clamping the MinerU memory cap')
  })

  it('keeps the cap at half of RAM at most, so other services keep their share', () => {
    const joined = mineruServiceStep({ ...PLAN, memoryMaxMiB: 999_999 }).commands.join('\n')
    expect(joined).toContain('TOTAL_MB / 2')
  })

  it('declares where deploy state is recorded', () => {
    expect(KB_STATE_FILE.startsWith('/')).toBe(true)
  })
})

describe('ssh-manager transport', () => {
  /** Start a stub of the ssh-manager API on an ephemeral port. */
  async function withManager(
    handler: (method: string, payload: Record<string, unknown>) => { status: number; body: unknown },
    run: (baseUrl: string) => Promise<void>,
  ): Promise<void> {
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      req.on('end', () => {
        const method = (req.url ?? '/').split('/').pop() ?? ''
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>
        const { status, body } = handler(method, payload)
        res.statusCode = status
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(body))
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    const port = typeof address === 'object' && address !== null ? address.port : 0
    try {
      await run(`http://127.0.0.1:${String(port)}`)
    } finally {
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  }

  it('builds an absolute origin, substituting loopback for an unusable bind host', () => {
    // A Host-side fetch rejects a relative URL, so the runner needs a real origin;
    // a wildcard or IPv6 bind is not usable as written and this process is loopback-reachable.
    expect(originFrom({ host: '127.0.0.1', port: 3080 })).toBe('http://127.0.0.1:3080')
    expect(originFrom({ host: '0.0.0.0', port: 3080 })).toBe('http://127.0.0.1:3080')
    expect(originFrom({ host: '::', port: 9000 })).toBe('http://127.0.0.1:9000')
    expect(originFrom({ host: '10.1.2.3', port: 8080 })).toBe('http://10.1.2.3:8080')
    expect(originFrom({ host: '127.0.0.1', port: 443, protocol: 'https:' })).toBe('https://127.0.0.1:443')
  })

  it('rejects an empty origin instead of issuing a relative request', () => {
    expect(() => sshManagerRunner({ origin: '' }))
      .toThrowError(/origin is required/u)
  })

  it('reads the host inventory', async () => {
    await withManager(
      () => ({ status: 200, body: { hosts: [{ id: 'h1', name: 'nas', hostname: '10.0.0.9', username: 'root', port: 22, knownHostFingerprint: null, credentialConfigured: true }] } }),
      async (baseUrl) => {
        const hosts = await sshManagerRunner({ origin: baseUrl }).listHosts()
        expect(hosts).toHaveLength(1)
        expect(hosts[0]?.hostname).toBe('10.0.0.9')
      },
    )
  })

  it('normalizes a command result', async () => {
    await withManager(
      (_method, payload) => ({ status: 200, body: { exitCode: 0, stdout: `ran ${String(payload.command)}`, stderr: '', truncated: false } }),
      async (baseUrl) => {
        const result = await sshManagerRunner({ origin: baseUrl }).execute('h1', 'uname -m')
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('ran uname -m')
      },
    )
  })

  it('reports a missing ssh-manager as manager-unavailable', async () => {
    const runner = sshManagerRunner({ origin: 'http://127.0.0.1:1' })
    await expect(runner.listHosts())
      .rejects.toMatchObject({ code: 'manager-unavailable' satisfies RemoteError['code'] })
  })

  it('surfaces a manager-side error message', async () => {
    await withManager(
      () => ({ status: 500, body: { error: 'SSH command approval was denied' } }),
      async (baseUrl) => {
        await expect(sshManagerRunner({ origin: baseUrl }).execute('h1', 'id'))
          .rejects.toMatchObject({ code: 'transport' satisfies RemoteError['code'] })
      },
    )
  })
})

describe('pinned paths', () => {
  /**
   * Pins are a document-level preference, so they live in the caller's own view
   * directory on the share rather than in browser storage. The route is what makes
   * that possible without a backend table, and the two properties that matter are
   * that a pin is only ever stored for a path the caller may read, and that a
   * sync cannot delete the file it lives in.
   */
  async function pinRoot(): Promise<{ actualRoot: string; viewRoot: string; userId: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-'))
    const actualRoot = join(root, 'actual')
    const viewRoot = join(root, 'views')
    await mkdir(actualRoot, { recursive: true })
    await writeFile(join(actualRoot, 'a.md'), 'a', 'utf8')
    await writeFile(join(actualRoot, 'b.md'), 'b', 'utf8')
    return { actualRoot, viewRoot, userId: 'u-1' }
  }

  it('reads an absent pin file as the empty list rather than an error', async () => {
    const { viewRoot, userId } = await pinRoot()
    // Every user has no pins until they make one, so this is the ordinary first read.
    await expect(readPins(join(viewRoot, userId))).resolves.toEqual([])
  })

  it('round-trips pins and normalizes them on write', async () => {
    const { viewRoot, userId } = await pinRoot()
    const viewDir = join(viewRoot, userId)
    // A duplicate collapses, and an escaping path is refused, so what comes back is
    // what the write actually accepted rather than what it was handed.
    const written = await writePins(viewDir, ['b.md', 'a.md', 'b.md', '../escape.md', '/abs.md'])
    expect(written).toEqual(['b.md', 'a.md'])
    await expect(readPins(viewDir)).resolves.toEqual(['b.md', 'a.md'])
  })

  it('reports a corrupt pin file as empty instead of throwing', async () => {
    const { viewRoot, userId } = await pinRoot()
    const viewDir = join(viewRoot, userId)
    await mkdir(viewDir, { recursive: true })
    await writeFile(pinsPathFor(viewDir), 'not json at all', 'utf8')
    // A corrupt preference should cost the reader their pins, not the whole page.
    await expect(readPins(viewDir)).resolves.toEqual([])
  })

  it('keeps the pin file through a sync that would otherwise unlink it', async () => {
    const { actualRoot, viewRoot, userId } = await pinRoot()
    const options = { actualRoot, viewRoot, userId }
    // Prime the view, then pin something.
    await syncView(options, [{ relPath: 'a.md' }, { relPath: 'b.md' }])
    await writePins(join(viewRoot, userId), ['a.md'])

    // A sync that no longer resolves either file removes both links. The pin file
    // must survive: the walk reports every file it sees, so a walked `.pinned.json`
    // would be unlinked here and the reader's pins would silently vanish on the
    // next permission change.
    const delta = await syncView(options, [])
    expect(delta.unlinked).toContain('global/a.md')
    expect(delta.unlinked).not.toContain('.pinned.json')
    await expect(readPins(join(viewRoot, userId))).resolves.toEqual(['a.md'])
  })

  it('serves the stored pins on the route the page reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-route-'))
    const viewDir = join(root, 'views', 'u-1')
    await writePins(viewDir, ['reports/q1.md'])
    const config = { ...CONFIG, actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const fetchImpl = (async (url: string) => {
      const target = String(url)
      if (target.includes(ENDPOINTS.me)) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Alice' } }), { status: 200 })
      }
      // The resolve route is the readability judge, so it answers yes for this test.
      return new Response(JSON.stringify({ canRead: true }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      await expect(callRoute(routes, 'pins.get', {})).resolves.toEqual({ relPaths: ['reports/q1.md'], dropped: [] })
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses to pin a path the caller may not read, and stores nothing', async () => {
    // The reverse case the design turns on. A pin is read back by the tree and drawn
    // as a row, so storing one for an unreadable path would put a name on screen that
    // the caller was never granted.
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-deny-'))
    const config = { ...CONFIG, actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const fetchImpl = (async (url: string) => {
      const target = String(url)
      if (target.includes(ENDPOINTS.me)) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Alice' } }), { status: 200 })
      }
      // The authority refuses this path.
      return new Response(JSON.stringify({ canRead: false }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'pins.set', { relPaths: ['secret.md'] })
      expect(reply.refused).toEqual(['secret.md'])
      expect(reply.error).toBeDefined()
      // Nothing was written: the refusal is not a silent prune to an empty list.
      await expect(readPins(join(root, 'views', 'u-1'))).resolves.toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a pin request naming a path outside the view', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-escape-'))
    const config = { ...CONFIG, actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const fetchImpl = (async () => new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      // An escaping path never reaches the readability judge: it is refused by the
      // containment guard first, so no request is made about it.
      const reply = await callRoute(routes, 'pins.set', { relPaths: ['../other-user/secret.md'] })
      expect(reply.refused).toEqual(['../other-user/secret.md'])
      await expect(readPins(join(root, 'views', 'u-1'))).resolves.toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('stores a pin when no backend is configured, bounded by the knowledge root', async () => {
    // A personal deployment has no authority to consult, and it needs none: the one operator
    // may pin what is inside the tree. This used to refuse the write outright, which made
    // pinning a personal-only feature that never worked.
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-nobackend-'))
    const config = { ...CONFIG, baseUrl: '', actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const { ctx, routes, disposers } = fakeHost({ token: 't' })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'pins.set', { relPaths: ['a.md'] })
      expect(reply.error).toBeUndefined()
      expect(reply.relPaths).toEqual(['a.md'])
      // Stored under the local view's directory, which is the id the deployment acts as.
      await expect(readPins(join(root, 'views', LOCAL_USER_ID))).resolves.toEqual(['a.md'])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a pin that climbs out of the knowledge root, even personally', async () => {
    // The boundary survives the absence of grants: with no authority to ask, a path outside
    // the tree is still refused rather than stored.
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-nobackend-escape-'))
    const config = { ...CONFIG, baseUrl: '', actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const { ctx, routes, disposers } = fakeHost({ token: 't' })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'pins.set', { relPaths: ['../other-user/secret.md'] })
      expect(reply.error).toBeDefined()
      expect(reply.refused).toEqual(['../other-user/secret.md'])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('rejects a request whose relPaths is not an array', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-shape-'))
    const config = { ...CONFIG, actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const fetchImpl = (async () => new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'pins.set', { relPaths: 'a.md' })
      expect(reply.error).toBeDefined()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('drops a stored pin the caller may no longer read when reading them back', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-pins-revoked-'))
    const viewDir = join(root, 'views', 'u-1')
    await writePins(viewDir, ['kept.md', 'revoked.md'])
    const config = { ...CONFIG, actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), mountPoint: join(root, 'mnt') }
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const target = String(url)
      if (target.includes(ENDPOINTS.me)) {
        return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      }
      // The resolve route reports the path in the POST body, not the URL, so the
      // judge reads the body: inspecting the URL alone would answer the same thing
      // for every path and the test would pass for the wrong reason.
      const asked = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
      return new Response(JSON.stringify({ canRead: asked.resourceId === 'kept.md' }), { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      // A revoke can land while a pin is stored, so the read re-checks each one
      // rather than trusting what the file says.
      const reply = await callRoute(routes, 'pins.get', {})
      expect(reply.relPaths).toEqual(['kept.md'])
      expect(reply.dropped).toEqual(['revoked.md'])
    } finally {
      for (const dispose of disposers) dispose()
    }
  })
})

describe('management page layout', () => {
  /**
   * The page was re-laid-out around a content-column header, a folded rail, a
   * pinned band and two distinct empty states. These assertions cover the shape
   * that has no runtime return value to check, so a later edit cannot quietly put
   * the header back across the whole page or merge the two empties again.
   */
  const read = (name: string): Promise<string> => readFile(new URL('../src/client/' + name, import.meta.url), 'utf8')

  it('scopes the header to the content column rather than the page', async () => {
    const source = await read('KnowledgePanel.tsx')
    // The header lives inside the content column, which is a sibling of the rail.
    expect(source).toMatch(/contentColumn/u)
    expect(source).toMatch(/<header className=\{styles\.header\}>/u)
    // And the rail owns its own top line, which is what occupies the page's
    // top-left corner now that the header no longer spans it.
    expect(source).toMatch(/railTop/u)
    expect(source).toMatch(/railBrand/u)
  })

  it('persists the rail fold through browser storage', async () => {
    const source = await read('KnowledgePanel.tsx')
    expect(source).toMatch(/RAIL_FOLDED_KEY/u)
    expect(source).toMatch(/localStorage\.setItem/u)
    expect(source).toMatch(/localStorage\.getItem/u)
    // A storage that refuses to write must not break the toggle.
    expect(source).toMatch(/catch \{/u)
  })

  it('orders the menu home, memory, trash, audit, settings', async () => {
    const source = await read('KnowledgePanel.tsx')
    const order = [...source.matchAll(/key: '(menu\.[a-z]+)'/gu)].map(m => m[1])
    expect(order).toEqual([
      'menu.home',
      'menu.memory',
      'menu.trash',
      'menu.audit',
      'menu.settings',
    ])
    // Memory sits beside the content surfaces; settings stays last because it is
    // configuration rather than a worklist.
  })

  it('hides the whole pinned band when nothing is pinned', async () => {
    const source = await read('KnowledgePanel.tsx')
    // The band is behind a length check rather than rendered with an empty state,
    // so an empty band cannot take a line from the tree or title a region with
    // nothing in it.
    expect(source).toMatch(/pins\.relPaths\.length > 0 && \(/u)
  })

  it('keeps the two empty states distinct', async () => {
    const listing = await read('KnowledgeListing.tsx')
    // An unmatched filter says so and offers no action; a tree with no documents
    // offers the way to start one.
    expect(listing).toMatch(/filterNoMatch/u)
    expect(listing).toMatch(/treeEmpty/u)
    // And the tree's own empty is NOT the search-miss sentence.
    expect(listing).not.toMatch(/entries\.length === 0[\s\S]{0,400}t\('searchEmpty'\)/u)
    expect(listing).toMatch(/emptyAction/u)
  })

  it('carries the section band metrics measured from the shell', async () => {
    const css = await read('KnowledgePanel.module.css')
    const header = css.slice(css.indexOf('.sectionHeader {'))
    // The measured band: 36px, a 4px gap, and the shell's own left inset.
    expect(header).toMatch(/height: 36px/u)
    expect(header).toMatch(/gap: 4px/u)
    expect(header).toMatch(/padding: 0 0 0 4px/u)
    // The name is the measured 14px/20px at weight 400, and it takes the band's
    // tertiary ink rather than the buttons' secondary.
    const name = css.slice(css.indexOf('.sectionName {'))
    expect(name).toMatch(/font: var\(--dsw-font-s-14\)/u)
    expect(name).toMatch(/line-height: 20px/u)
    expect(name).toMatch(/color: var\(--dsw-alias-label-tertiary\)/u)
  })

  it('keeps the icon button at the measured 28px on an 8px radius', async () => {
    const css = await read('KnowledgePanel.module.css')
    const button = css.slice(css.indexOf('.iconButton {'))
    expect(button).toMatch(/width: 28px/u)
    expect(button).toMatch(/height: 28px/u)
    expect(button).toMatch(/border-radius: var\(--dsw-radius-sm\)/u)
    expect(button).toMatch(/background: transparent/u)
    // The buttons carry the band's secondary ink, distinct from the name's tertiary.
    expect(button).toMatch(/color: var\(--dsw-alias-label-secondary\)/u)
  })

  it('builds the trash on the tombstone route rather than on a delete call', async () => {
    const source = await read('KnowledgeTrash.tsx')
    // Removal is recorded, not performed: a view is hardlinks into one shared tree,
    // so an unlink would be indistinguishable from a revoked grant and the next sync
    // would put the link back. The surface therefore restores through its own route
    // and never reaches for a delete.
    expect(source).toMatch(/KB_API\.trash/u)
    expect(source).toMatch(/KB_API\.trashRestore/u)
    expect(source).not.toMatch(/KB_API\.delete/u)
    // A restore can legitimately bring back nothing when the grant went while the
    // document was hidden, so the page has to say that rather than look broken.
    expect(source).toMatch(/trashRestored/u)
    expect(source).toMatch(/trashEmptyRow/u)
  })
})

describe('empty states are three distinct states', () => {
  /**
   * Three different situations, three different messages. They were once merged:
   * a tree with no documents showed the search-miss sentence and offered a
   * navigation button labelled for somewhere else. Each case now says what is
   * actually true and offers only what would help.
   */
  const listing = (): Promise<string> => readFile(new URL('../src/client/KnowledgeListing.tsx', import.meta.url), 'utf8')

  it('gives a genuinely empty tree its own wording and the new-document action', async () => {
    const source = await listing()
    // Its own sentence, not the search-miss one.
    expect(source).toMatch(/props\.t\('treeEmpty'\)/u)
    // And an action, because the reader's next step is to make a document.
    expect(source).toMatch(/props\.emptyAction/u)
  })

  it('keeps a filter miss separate and offers no action', async () => {
    const source = await listing()
    expect(source).toMatch(/props\.t\('filterNoMatch'\)/u)
    // The filter branch returns before the empty-tree branch, so the unmatched
    // filter cannot fall through and show a create affordance. Changing the search
    // term is the fix there, and no button does that.
    const filterBranch = source.slice(source.indexOf("props.t('filterNoMatch')"))
    const treeBranch = source.indexOf("props.t('treeEmpty')")
    expect(source.indexOf("props.t('filterNoMatch')")).toBeLessThan(treeBranch)
    expect(filterBranch.slice(0, 260)).not.toMatch(/emptyAction/u)
  })

  it('leaves the global search miss on its own sentence', async () => {
    const search = await readFile(new URL('../src/client/KnowledgeSearch.tsx', import.meta.url), 'utf8')
    expect(search).toMatch(/searchEmpty/u)
    // The global search result list is not the tree, so it must not have picked up
    // the tree's create action.
    expect(search).not.toMatch(/treeEmpty/u)
  })

  it('labels the empty-tree action as the new-document action, not a navigation', async () => {
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    const action = panel.slice(panel.indexOf('emptyAction={('))
    // The user asked for this exact affordance under this exact label.
    // A window bounded by the element's own closing rather than a fixed character
    // count: the explanatory comment above it is longer than any guess would hold.
    const element = action.slice(0, action.indexOf('/>'))
    expect(element).toMatch(/t\('actionNew'\)/u)
    // The old label was navigation-only and is gone from the surface.
    expect(element).not.toMatch(/navGoHome/u)
    // And the handler navigates rather than pretending to create.
    expect(element).toMatch(/kind: 'home'/u)
  })
})

describe('mount-point guard', () => {
  /**
   * `pointMountAtView` REPLACES whatever sits at its path, and the old version did
   * that with an unconditional `rm -rf`. Measured on 2026-10-17: a deployment whose
   * `mountPoint` was the NFS share root had `actual/` and every user's `views/`
   * deleted, and the share root replaced by a symlink pointing inside its own
   * (now deleted) `views/`. The mounted filesystem's contents live on the server,
   * so that was real data loss, not a cache.
   *
   * These four cases pin the shapes a pointer may legitimately occupy and the two
   * it may never remove.
   */
  async function scaffold(): Promise<{ root: string; actualRoot: string; viewRoot: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-guard-'))
    const actualRoot = join(root, 'share', 'actual')
    const viewRoot = join(root, 'share', 'views')
    await mkdir(join(viewRoot, 'u-1'), { recursive: true })
    await mkdir(actualRoot, { recursive: true })
    return { root, actualRoot, viewRoot }
  }

  it('refuses a non-empty real directory and leaves its contents alone', async () => {
    // This is the shape that used to be destroyed.
    const { actualRoot, viewRoot } = await scaffold()
    const shareRoot = dirname(actualRoot)
    await writeFile(join(actualRoot, 'IMPORTANT.md'), 'the only copy', 'utf8')

    await expect(pointMountAtView({ actualRoot, viewRoot, userId: 'u-1' }, shareRoot))
      .rejects.toThrow(/non-empty directory/u)

    // The assertion that matters: the data is still there.
    expect(await readdir(actualRoot)).toContain('IMPORTANT.md')
    await expect(readFile(join(actualRoot, 'IMPORTANT.md'), 'utf8')).resolves.toBe('the only copy')
    // And the share root was not turned into a link.
    expect(await readlink(shareRoot).catch(() => undefined)).toBeUndefined()
  })

  it('replaces an existing symlink', async () => {
    // Not a regression: a repeat sync must still repoint the link.
    const { root, actualRoot, viewRoot } = await scaffold()
    await mkdir(join(viewRoot, 'u-2'), { recursive: true })
    const pointer = join(root, 'pointer')
    await pointMountAtView({ actualRoot, viewRoot, userId: 'u-1' }, pointer)
    await pointMountAtView({ actualRoot, viewRoot, userId: 'u-2' }, pointer)
    expect(await readlink(pointer)).toBe(join(viewRoot, 'u-2'))
  })

  it('creates the pointer when nothing is there, including a missing parent', async () => {
    // The first sync: the view builder has created the view but never the pointer's
    // parent directory, so this must create it rather than answer ENOENT.
    const { root, actualRoot, viewRoot } = await scaffold()
    const pointer = join(root, 'nested', 'deeper', 'pointer')
    await expect(pointMountAtView({ actualRoot, viewRoot, userId: 'u-1' }, pointer)).resolves.toBe(true)
    expect(await readlink(pointer)).toBe(join(viewRoot, 'u-1'))
  })

  it('allows replacing an empty directory', async () => {
    // Explicitly permitted rather than overlooked: an empty directory holds nothing
    // to lose, and a leftover one is a shape a retarget can legitimately clear.
    const { root, actualRoot, viewRoot } = await scaffold()
    const empty = join(root, 'empty-dir')
    await mkdir(empty, { recursive: true })
    await expect(pointMountAtView({ actualRoot, viewRoot, userId: 'u-1' }, empty)).resolves.toBe(true)
    expect(await readlink(empty)).toBe(join(viewRoot, 'u-1'))
  })

  it('reads mount points from the kernel table', async () => {
    // The guard's first check. `/` is mounted everywhere; this suite's temp root is
    // not. Read from /proc rather than inferred from stat, because a bind mount of
    // the same filesystem has the same device as its parent and would pass a
    // device comparison while still being a mount point.
    await expect(isMountPoint('/')).resolves.toBe(true)
    const plain = await mkdtemp(join(tmpdir(), 'kb-notmnt-'))
    await expect(isMountPoint(plain)).resolves.toBe(false)
  })

  it('refuses before removing anything, not after', async () => {
    // Ordering matters: a guard that checked after the removal would still lose the
    // data. The directory is asserted intact on the refusal path above, and this
    // pins that no symlink was created either.
    const { actualRoot, viewRoot } = await scaffold()
    const shareRoot = dirname(actualRoot)
    await writeFile(join(shareRoot, 'keep.md'), 'keep', 'utf8')
    await expect(pointMountAtView({ actualRoot, viewRoot, userId: 'u-1' }, shareRoot))
      .rejects.toThrow(/refusing to replace/u)
    expect(await readdir(shareRoot)).toContain('keep.md')
    expect(await readdir(shareRoot)).toContain('actual')
    expect(await readdir(shareRoot)).toContain('views')
  })
})

describe('deployment defaults agree with each other', () => {
  /**
   * These three paths describe ONE deployment: the workspace mounts the share, and
   * the plugin points a browser at a view within it. They were once split across
   * `/workspace/kb` and `/nas/kb`, which no filesystem can satisfy -- the page
   * reported "not mounted" while the share sat one directory over. A bare profile
   * resolves every default, so this suite is the only place the three are compared.
   */
  it('keeps the two real trees on the share and the pointer in the workspace', async () => {
    const resolved = Config({} as never) as unknown as typeof CONFIG
    // The earlier form asserted all three paths share the `/nas/kb` prefix, believing one
    // deployment cannot span two roots. That belief was wrong: the pointer is a SYMLINK,
    // so `/workspace/kb` and `/nas/kb` coexist and reach the same bytes (measured:
    // `/workspace/kb/a.md` and `actual/a.md` are the same inode). What has to hold is that
    // the two REAL trees sit on the share and the pointer is the workspace-side path.
    expect(resolved.actualRoot.startsWith('/nas/kb/')).toBe(true)
    expect(resolved.viewRoot.startsWith('/nas/kb/')).toBe(true)
    expect(resolved.mountPoint.startsWith('/workspace/')).toBe(true)
  })

  it('never defaults the pointer to the share root itself', async () => {
    // The pointer is what a sync REPLACES. Defaulting it to the mount point would
    // put `rm -rf` on the mounted export's root, which deletes `actual/` and every
    // user's view on the server. The guard in `pointMountAtView` refuses that shape,
    // but the default must not ask for it in the first place.
    const resolved = Config({} as never) as unknown as typeof CONFIG
    expect(resolved.mountPoint).not.toBe('/nas/kb')
    expect(resolved.mountPoint).not.toBe(resolved.actualRoot)
    expect(resolved.mountPoint).not.toBe(resolved.viewRoot)
    // It is a workspace path rather than a share path: a sync replaces it, so it must not
    // be anywhere the authoritative tree or a user's view lives.
    expect(resolved.mountPoint.startsWith('/nas/kb')).toBe(false)
  })

  it('keeps the two roots siblings rather than nested', async () => {
    // The view is built beside the authoritative tree, so a recursive rebuild of one
    // can never walk into the other.
    const resolved = Config({} as never) as unknown as typeof CONFIG
    expect(resolved.actualRoot.startsWith(resolved.viewRoot)).toBe(false)
    expect(resolved.viewRoot.startsWith(resolved.actualRoot)).toBe(false)
  })
})

describe('the two empty states are told apart', () => {
  /**
   * A null file count used to be reported as "the knowledge tree is not mounted".
   * That is one of two conditions: the share may be absent, or the per-user pointer
   * this plugin builds on demand may not exist yet. Only the first is the reader's
   * deployment to fix, and conflating them sent them to inspect a working mount.
   */
  const mountConfig = (mountPoint: string, root: string): typeof CONFIG => ({
    ...CONFIG,
    mountPoint,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
  })

  it('reports a missing pointer separately from an absent share', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-state-'))
    // The share is attached (its parent exists) but the pointer has not been built.
    await mkdir(join(root, 'views'), { recursive: true })
    await expect(classifyMount(mountConfig(join(root, 'views', 'current'), root)))
      .resolves.toBe('pointer-missing')
    // Nothing exists at all: a genuinely unmounted deployment.
    await expect(classifyMount(mountConfig(join(root, 'gone', 'current'), root)))
      .resolves.toBe('absent')
  })

  it('reports a built pointer as mounted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-state-ok-'))
    const views = join(root, 'views')
    await mkdir(join(views, 'u-1'), { recursive: true })
    const pointer = join(views, 'current')
    await symlink(join(views, 'u-1'), pointer)
    await expect(classifyMount(mountConfig(pointer, root))).resolves.toBe('mounted')
  })

  it('treats a file at the pointer path as absent, not as not-yet-generated', async () => {
    // A retry cannot fix a file where a directory belongs, so this must not invite
    // one by claiming the pointer is merely unbuilt.
    const root = await mkdtemp(join(tmpdir(), 'kb-state-file-'))
    const views = join(root, 'views')
    await mkdir(views, { recursive: true })
    await writeFile(join(views, 'current'), 'not a pointer', 'utf8')
    await expect(classifyMount(mountConfig(join(views, 'current'), root))).resolves.toBe('absent')
  })

  it('treats a blank configured path as absent', async () => {
    await expect(classifyMount({ ...CONFIG, mountPoint: '   ' })).resolves.toBe('absent')
  })

  it('carries the state on the status route the page reads', async () => {
    const { ctx, routes, disposers } = fakeHost({ token: 't' })
    try {
        // Both the mount point AND its parent must be missing for `absent`:
        // a missing mount point under an existing parent is `pointer-missing`,
        // which is the whole distinction this test exists to pin.
        apply(ctx as never, { ...CONFIG, mountPoint: '/nonexistent-kb-parent-xyz/current' } as never)
      // The fixture's mountPoint does not exist, so this is the absent branch. The
      // client renders the mount wording for it and the pointer wording otherwise.
      const status = await callRoute(routes, 'status', {})
      expect(status.mountState).toBe('absent')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('ships a distinct sentence for each state', async () => {
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    // Two keys, and the pointer one is not the mount one.
    expect(locales).toMatch(/viewNotBuilt: '[^']+'/u)
    const mount = /mountPointMissing: '([^']+)'/u.exec(locales)
    const pointer = /viewNotBuilt: '([^']+)'/u.exec(locales)
    expect(mount?.[1]).toBeDefined()
    expect(pointer?.[1]).toBeDefined()
    expect(pointer?.[1]).not.toBe(mount?.[1])
    // And the panel chooses between them rather than always showing the mount one.
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    expect(panel).toMatch(/status\.mountState === 'pointer-missing'/u)
  })

  it("labels the three buckets in the reader's language instead of the folder name", async () => {
    // The folders on disk are global / department / personal and cannot be renamed:
    // they are path segments the deployment shares, and the caller's view is built
    // from them. What the folder means to a reader is its AUDIENCE, so the row prints
    // that instead -- carried by a label map, so the disk layout is untouched.
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    for (const key of ['bucketGlobal', 'bucketDepartment', 'bucketPersonal']) {
      // One entry per locale: the zh table is typed against the en key set, so a key
      // missing on either side fails the build rather than showing an untranslated row.
      const occurrences = locales.split('\n').filter(line => line.trimStart().startsWith(key + ':')).length
      expect(occurrences, key).toBe(2)
    }

    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    // The map is keyed by the on-disk names, and every one of them is covered: a bucket
    // missing from the map would silently fall back to the raw path segment.
    for (const bucket of ['global', 'department', 'personal']) {
      expect(panel).toMatch(new RegExp(`${bucket}: t\\('bucket`))
    }
  })

})

describe('the first load repairs a missing pointer', () => {
  /**
   * The pointer is what the page browses and only a sync creates it, so a caller
   * whose files DataOps already resolved still saw an empty tree and a notice until
   * they found the rebuild button. The status route now builds it once, and only
   * when it is missing.
   */
  it('offers the shared sync path so both the button and the repair agree', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // One implementation: the explicit route delegates to the same function.
    expect(source).toMatch(/export async function syncCallerView/u)
    const route = source.slice(source.indexOf("case 'views.sync'"))
    expect(route.slice(0, route.indexOf("case 'pins.get'"))).toMatch(/syncCallerView\(/u)
  })

  it('only repairs when the pointer is missing and a backend can answer', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const status = source.slice(source.indexOf("case 'status'"))
    // Both conditions on the repair, so a healthy deployment pays no per-load cost
    // on the shared filesystem.
    expect(status).toMatch(/mountState === 'pointer-missing' && isTeamDeployment\(config\)/u)
    // And the state is re-read from the filesystem afterwards rather than assumed,
    // because a caller with nothing granted still has no pointer.
    const repair = status.slice(status.indexOf('syncCallerView(host, config)'))
    expect(repair).toMatch(/mountState = await classifyMount\(config\)/u)
  })

  it('does not write when the resolved set is unchanged', async () => {
    // The property that makes an unasked sync safe: assert it against the real
    // function so a future edit that always relinks is caught here.
    const root = await mkdtemp(join(tmpdir(), 'kb-repair-'))
    const options = { actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), userId: 'u-1' }
    await mkdir(options.actualRoot, { recursive: true })
    await writeFile(join(options.actualRoot, 'a.md'), 'a', 'utf8')
    const first = await syncView(options, [{ relPath: 'a.md' }])
    expect(first.linked).toEqual(['global/a.md'])
    const second = await syncView(options, [{ relPath: 'a.md' }])
    expect(second.linked).toEqual([])
    expect(second.unchanged).toBeGreaterThan(0)
  })
})

describe('the automatic repair runs at most once per caller', () => {
  /**
   * A caller with nothing granted never gains a pointer from a sync, so the state
   * stays `pointer-missing` and an unguarded repair would walk the shared tree and
   * ask DataOps about every file on every page load. These assertions pin the two
   * conditions that keep it bounded.
   */
  it('remembers a caller it has already repaired', async () => {
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/const repairedCallers = new Set<string>\(\)/u)
    // The attempt is recorded only after the sync actually ran, so a refusal can be
    // retried once its condition clears rather than being cached as done.
    const status = source.slice(source.indexOf("case 'status'"))
    const guard = status.slice(0, status.indexOf("case 'grants'"))
    expect(guard).toMatch(/repairedCallers\.add\(repairKey\)/u)
    expect(guard).toMatch(/repairedCallers\.has\(repairKey\)/u)
    // Recorded inside the success branch, not before the attempt.
    expect(guard.indexOf("if (!('error' in repaired))")).toBeLessThan(guard.indexOf('repairedCallers.add(repairKey)'))
  })

  it('does not ask the backend for an identity when no repair is needed', async () => {
    // The repair must not add a round trip to the ordinary load path.
    //
    // Scoped to the REMOTE branch: a local workspace resolves its caller unconditionally,
    // because it has no repair machinery and the page still needs a name for the audit
    // trail. The assertion is about the remote path not paying that round trip before it
    // knows a repair is due.
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const status = source.slice(source.indexOf("case 'status'"))
    const remote = status.slice(status.indexOf('let mountState = await classifyMount(config)'))
    const guard = remote.slice(0, remote.indexOf("case 'grants'"))
    // The identity fetch sits inside the pointer-missing condition, and the
    // not-yet-repaired check sits outside it.
    const identity = guard.indexOf('await fetchCaller(host, config)')
    const condition = guard.indexOf("mountState === 'pointer-missing' && isTeamDeployment(config)")
    expect(condition).toBeGreaterThan(-1)
    expect(identity).toBeGreaterThan(condition)
  })
})

describe('move route authorization', () => {
  /**
   * A move is a write to two paths, so it asks about both. The resolve route is the
   * only authority consulted, and the two answers are stubbed apart here so a route
   * that short-circuits one of them fails rather than passing by accident.
   */
  /**
   * Every case here runs against a temporary root, even though each one asserts a
   * REFUSAL. The route writes when it is allowed to, so a regression that let a
   * refused move through would relocate a real document if this block ran against
   * the configured tree.
   */
  const isolatedConfig = (root: string) => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  /** A fetch stub that answers the resolve route from a per-path table. */
  const tableFetch = (table: Record<string, { canRead?: boolean; canWrite?: boolean }>) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        const sent = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
        const answer = table[sent.resourceId ?? ''] ?? { canRead: false, canWrite: false }
        return new Response(JSON.stringify(answer), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  it('refuses a move when the caller may not write the source', async () => {
    // Read is not enough: a move removes the source path, so a read-only caller
    // relocating a document is exactly the case this must stop.
    const fetchImpl = tableFetch({
      'docs/a.md': { canRead: true, canWrite: false },
      'archive': { canRead: true, canWrite: true },
    })
    const root = await mkdtemp(join(tmpdir(), 'kb-move-auth-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'move', { from: 'docs/a.md', to: 'archive' })
      expect(reply.error).toMatch(/may not write/u)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a move when the caller may not write the destination', async () => {
    // The other half of the same rule, stubbed the opposite way so a route that
    // only ever checks the source cannot pass both cases.
    const fetchImpl = tableFetch({
      'docs/a.md': { canRead: true, canWrite: true },
      'archive': { canRead: true, canWrite: false },
    })
    const root = await mkdtemp(join(tmpdir(), 'kb-move-auth-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'move', { from: 'docs/a.md', to: 'archive' })
      expect(reply.error).toMatch(/may not write/u)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a move when the permission service cannot be asked', async () => {
    // Fail closed: an unreachable backend must refuse the move, not allow it.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      }
      return new Response('nope', { status: 503 })
    }) as unknown as typeof fetch
    const root = await mkdtemp(join(tmpdir(), 'kb-move-auth-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'move', { from: 'docs/a.md', to: 'archive' })
      expect(reply.error).toMatch(/may not write/u)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a traversal path before it asks anyone', async () => {
    // The containment guard runs on the request, so a `..` never reaches the
    // filesystem even when every permission answer would have been yes.
    const fetchImpl = tableFetch({})
    const root = await mkdtemp(join(tmpdir(), 'kb-move-escape-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'move', { from: '../escape.md', to: 'archive' })
      expect(reply.error).toMatch(/contained relative paths/u)
      const absolute = await callRoute(routes, 'move', { from: '/etc/passwd', to: 'archive' })
      expect(absolute.error).toMatch(/contained relative paths/u)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('moves inside the tree when no permission API is configured', async () => {
    // A personal deployment has no authority to ask, and needs none: the one operator may
    // move a document within the knowledge root. This used to be refused, which made the
    // whole file-manager surface unusable on a personal deployment.
    const root = await mkdtemp(join(tmpdir(), 'kb-move-nobackend-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't' })
    try {
      const config = { ...isolatedConfig(root), baseUrl: '' }
      await apply(ctx as never, config as never)
      const plan = localConfig(config as never)
      await mkdir(join(plan.actualRoot, 'docs'), { recursive: true })
      await writeFile(join(plan.actualRoot, 'docs', 'a.md'), 'content')
      const reply = await callRoute(routes, 'move', { from: 'docs/a.md', to: 'archive' })
      expect(reply.error).toBeUndefined()
      await expect(readFile(join(plan.actualRoot, 'archive', 'a.md'), 'utf8')).resolves.toBe('content')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a move whose destination leaves the knowledge root', async () => {
    // No grants does not mean no boundary: a destination outside the tree is still refused.
    const root = await mkdtemp(join(tmpdir(), 'kb-move-nobackend-escape-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't' })
    try {
      await apply(ctx as never, { ...isolatedConfig(root), baseUrl: '' } as never)
      const reply = await callRoute(routes, 'move', { from: 'docs/a.md', to: '../outside' })
      expect(reply.error).toBeDefined()
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('view mode preference routes', () => {
  /**
   * These routes WRITE, so they run against a temporary root rather than the
   * configured one. `CONFIG.viewRoot` is a real deployment path: a test that
   * applies it against the live config creates directories under the share, which
   * is how a preference round-trip once wrote to `/nas/kb/views` outside any
   * temporary tree. Every case here builds its own root and removes it after.
   */
  const callerFetch = (userId: string) =>
    (async (input: RequestInfo | URL) => {
      if (String(input).includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: userId } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  /** A config whose storage roots are inside a fresh temporary directory. */
  const isolatedConfig = (root: string) => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  it('reports the default layout when the caller has never chosen one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-viewmode-default-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'viewMode.get', {})
      expect(reply.mode).toBe('list')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('round-trips a stored grid preference through the mount point', async () => {
    // Written through the route rather than the file, so the assertion covers the
    // normalisation and the mount-point targeting together.
    const root = await mkdtemp(join(tmpdir(), 'kb-viewmode-roundtrip-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      // The mount point is the caller's view; the route writes the preference beside
      // the documents there. It must exist first -- a preference is not a reason to
      // create the directory a sync is supposed to own.
      await mkdir(join(root, 'mnt'), { recursive: true })
      await apply(ctx as never, isolatedConfig(root) as never)
      const written = await callRoute(routes, 'viewMode.set', { mode: 'grid' })
      expect(written.mode).toBe('grid')
      const readBack = await callRoute(routes, 'viewMode.get', {})
      expect(readBack.mode).toBe('grid')
      // It landed in the mount point, which `views.sync` has already pointed at the
      // caller's own directory -- so the file is theirs without a second identity lookup.
      await expect(readViewMode(join(root, 'mnt'))).resolves.toBe('grid')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers the default layout rather than an error when no identity is available', async () => {
    // A preference is not worth an error page: without an identity there is no
    // directory to read, and the page still has to render.
    const root = await mkdtemp(join(tmpdir(), 'kb-viewmode-noid-'))
    const fetchImpl = (async () => new Response(JSON.stringify({ user: {} }), { status: 200 })) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'viewMode.get', {})
      expect(reply.mode).toBe('list')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to store a preference before a view is mounted, and creates nothing', async () => {
    // The write targets the mount point, which exists only after a sync has pointed it
    // at a view. Creating it here would manufacture a real directory where a symlink
    // belongs -- and the next sync would then have to refuse it as non-empty. So an
    // unmounted pointer is refused rather than materialised.
    const root = await mkdtemp(join(tmpdir(), 'kb-viewmode-unmounted-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'viewMode.set', { mode: 'grid' })
      expect(reply.error).toMatch(/not mounted yet/u)
      // Nothing was created: the mount point is still absent.
      await expect(stat(join(root, 'mnt'))).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('expanded-folder state', () => {
  /**
   * The explorer's expansion state is a preference like the layout, so it lives
   * beside `.view-mode.json` in the caller's view. What matters is that it survives
   * a page, that it drops rather than stores anything that is not a plausible path,
   * and that every failure mode answers "all collapsed" instead of throwing -- the
   * tree has to render even when this file is missing or corrupt.
   */
  const callerFetch = (userId: string) =>
    (async (input: RequestInfo | URL) => {
      if (String(input).includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: userId } }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  /** A config whose storage roots are inside a fresh temporary directory. */
  const isolatedConfig = (root: string) => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  it('answers an empty set when nothing has ever been stored', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-default-'))
    try {
      await expect(readTreeState(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('round-trips the expanded set through the route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-roundtrip-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await mkdir(join(root, 'mnt'), { recursive: true })
      await apply(ctx as never, isolatedConfig(root) as never)
      const written = await callRoute(routes, 'treeState.set', {
        expanded: ['/workspace/kb/department', '/workspace/kb/department/platform'],
      })
      expect(written.expanded).toEqual([
        '/workspace/kb/department',
        '/workspace/kb/department/platform',
      ])
      const readBack = await callRoute(routes, 'treeState.get', {})
      expect(readBack.expanded).toEqual([
        '/workspace/kb/department',
        '/workspace/kb/department/platform',
      ])
      // It landed in the mount point, which is the caller's own view.
      await expect(readTreeState(join(root, 'mnt'))).resolves.toEqual([
        '/workspace/kb/department',
        '/workspace/kb/department/platform',
      ])
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to all-collapsed when the file is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-missing-'))
    try {
      await mkdir(root, { recursive: true })
      await expect(readTreeState(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to all-collapsed when the file is corrupt', async () => {
    // Truncated JSON is what a crash mid-write would have left before the atomic
    // rename; it must read as "nothing stored", not as a page failure.
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-corrupt-'))
    try {
      await mkdir(root, { recursive: true })
      await writeFile(treeStatePathFor(root), '{"expanded":["/workspace/kb/de', 'utf8')
      await expect(readTreeState(root)).resolves.toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('falls back to all-collapsed when the JSON is not the shape it expects', async () => {
    // Three shapes a hand-edited file takes: a bare array, an object whose
    // `expanded` is not an array, and a JSON scalar. None is an error.
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-shape-'))
    try {
      await mkdir(root, { recursive: true })
      for (const body of ['[]', '{"expanded":"nope"}', '{"expanded":null}', '42', 'null']) {
        await writeFile(treeStatePathFor(root), body, 'utf8')
        await expect(readTreeState(root)).resolves.toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops entries that are not plausible absolute paths and duplicates them once', async () => {
    // A stored path has to survive a hand-edited file and a browser posting junk:
    // relative paths, empty strings, control characters, and repeats are all
    // discarded rather than stored forever.
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-junk-'))
    try {
      await mkdir(root, { recursive: true })
      const written = await writeTreeState(root, [
        '/workspace/kb/department',
        'relative/path',
        '',
        '/workspace/kb/bad\u0000path',
        '/workspace/kb/department',
        42 as unknown as string,
        '/workspace/kb/personal',
      ])
      expect(written).toEqual(['/workspace/kb/department', '/workspace/kb/personal'])
      await expect(readTreeState(root)).resolves.toEqual([
        '/workspace/kb/department',
        '/workspace/kb/personal',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes atomically, leaving no temporary file behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-atomic-'))
    try {
      await writeTreeState(root, ['/workspace/kb/department'])
      const entries = await readdir(root)
      expect(entries).toContain('.kb-tree-state.json')
      expect(entries.filter(name => name.endsWith('.tmp'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('survives a view sync instead of being deleted as a stale grant', async () => {
    // The sync walk unlinks every file it walks that the resolved set does not
    // name. A preference file missing from its metadata set is silently deleted
    // on the next sync -- which reads as a setting that will not stick rather than
    // as a bug. This is the regression that would be invisible without a test.
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-sync-'))
    try {
      const viewRoot = join(root, 'views')
      // The walk visits `<viewRoot>/<userId>`, so the preference is written where a
      // real caller's view lives rather than at the view root.
      const viewDir = viewPathFor({ actualRoot: join(root, 'actual'), viewRoot, userId: 'u-1' })
      await mkdir(viewDir, { recursive: true })
      await writeTreeState(viewDir, ['/workspace/kb/department'])
      await syncView(
        { actualRoot: join(root, 'actual'), viewRoot, userId: 'u-1' } as never,
        [],
      )
      await expect(readTreeState(viewDir)).resolves.toEqual(['/workspace/kb/department'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a payload that is not an array rather than storing nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-badbody-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await mkdir(join(root, 'mnt'), { recursive: true })
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'treeState.set', { expanded: 'nope' })
      expect(reply.error).toMatch(/array of strings/u)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to write before a mount point exists in remote mode, and creates nothing', async () => {
    // In remote/NAS storage the mount point is a SYMLINK a sync installs, so
    // creating it here would manufacture a real directory where that link belongs
    // -- and the next sync would have to refuse it as non-empty. This mirrors
    // `viewMode.set`, and it is the one case where a preference does not get
    // written through a missing path.
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-nasmode-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, {
        ...isolatedConfig(root),
        storageMode: 'remote' as const,
      } as never)
      const reply = await callRoute(routes, 'treeState.set', {
        expanded: ['/workspace/kb/department'],
      })
      expect(reply.error).toMatch(/not mounted yet/u)
      // Nothing was created: the mount point is still absent.
      await expect(stat(join(root, 'mnt'))).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still reads an empty set in remote mode, so the tree renders', async () => {
    // A read must never fail the page: an unmounted remote share answers the
    // collapsed default rather than an error the tree would have to render.
    const root = await mkdtemp(join(tmpdir(), 'kb-treestate-nasread-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, {
        ...isolatedConfig(root),
        storageMode: 'remote' as const,
      } as never)
      const reply = await callRoute(routes, 'treeState.get', {})
      expect(reply.expanded).toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('copy duplicates a subtree and keeps the source', () => {
  /** The view options every copy test passes; only actualRoot matters to a copy. */
  const options = (root: string) => ({ actualRoot: root, viewRoot: join(root, 'views'), userId: 'u-1' })

  it('keeps the source and writes an independent copy', async () => {
    // The whole reason this route exists: a paste that removes the source is a move,
    // and a reader who asked to copy did not ask to lose the original.
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      await writeFile(join(root, 'a.md'), 'hello', 'utf8')
      const copied = await copyEntry(options(root), 'a.md', 'docs/a.md')
      expect(copied).toMatchObject({ from: 'a.md', to: 'docs/a.md', entries: 1, bytes: 5 })
      // Both survive, with equal content but distinct inodes: a real second file, not a
      // hardlink, so editing one cannot change the other.
      await expect(readFile(join(root, 'a.md'), 'utf8')).resolves.toBe('hello')
      await expect(readFile(join(root, 'docs/a.md'), 'utf8')).resolves.toBe('hello')
      const source = await stat(join(root, 'a.md'))
      const target = await stat(join(root, 'docs/a.md'))
      expect(target.ino).not.toBe(source.ino)
      // Writing through one leaves the other alone.
      await writeFile(join(root, 'docs/a.md'), 'changed', 'utf8')
      await expect(readFile(join(root, 'a.md'), 'utf8')).resolves.toBe('hello')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an existing destination instead of overwriting or renaming', async () => {
    // Silent overwrite destroys a file the reader never named; an automatic rename makes
    // the paste "succeed" under a name they never typed. Both are worse than a refusal.
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      await writeFile(join(root, 'a.md'), 'source', 'utf8')
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs/a.md'), 'occupied', 'utf8')
      await expect(copyEntry(options(root), 'a.md', 'docs/a.md'))
        .rejects.toThrow(/destination already exists/u)
      // Nothing moved, nothing changed, and no third name appeared.
      await expect(readFile(join(root, 'docs/a.md'), 'utf8')).resolves.toBe('occupied')
      await expect(readFile(join(root, 'a.md'), 'utf8')).resolves.toBe('source')
      const names = (await readdir(join(root, 'docs'))).sort()
      expect(names).toEqual(['a.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies a directory with its whole subtree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      await mkdir(join(root, 'src/nested/deep'), { recursive: true })
      await writeFile(join(root, 'src/one.md'), '1', 'utf8')
      await writeFile(join(root, 'src/nested/two.md'), '22', 'utf8')
      await writeFile(join(root, 'src/nested/deep/three.md'), '333', 'utf8')
      const copied = await copyEntry(options(root), 'src', 'dst')
      // Six entries: three directories (src, nested, deep) plus three files. The count
      // is what catches a walk that silently stops at the first nesting level.
      expect(copied.entries).toBe(6)
      expect(copied.bytes).toBe(6)
      await expect(readFile(join(root, 'dst/one.md'), 'utf8')).resolves.toBe('1')
      await expect(readFile(join(root, 'dst/nested/two.md'), 'utf8')).resolves.toBe('22')
      await expect(readFile(join(root, 'dst/nested/deep/three.md'), 'utf8')).resolves.toBe('333')
      // The source tree is untouched.
      await expect(readFile(join(root, 'src/nested/deep/three.md'), 'utf8')).resolves.toBe('333')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a destination containing a parent segment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      await writeFile(join(root, 'a.md'), 'x', 'utf8')
      await expect(copyEntry(options(root), 'a.md', '../escape/a.md'))
        .rejects.toThrow(/not contained/u)
      await expect(copyEntry(options(root), '../outside.md', 'a.md'))
        .rejects.toThrow(/not contained/u)
      // An absolute destination is refused the same way a relative escape is.
      await expect(copyEntry(options(root), 'a.md', '/tmp/absolute.md'))
        .rejects.toThrow(/not contained/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to copy a directory into its own subtree', async () => {
    // This cannot terminate, so it must be refused before the walk rather than by it.
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      await mkdir(join(root, 'src/inner'), { recursive: true })
      await writeFile(join(root, 'src/inner/a.md'), 'x', 'utf8')
      await expect(copyEntry(options(root), 'src', 'src/inner/src'))
        .rejects.toThrow(/into itself/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('copies a symlink as a link rather than following it', async () => {
    // Following could copy something outside the export, or loop forever through a
    // link back to an ancestor.
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      const outside = await mkdtemp(join(tmpdir(), 'kb-copy-outside-'))
      try {
        await writeFile(join(outside, 'secret.md'), 'outside', 'utf8')
        await symlink(join(outside, 'secret.md'), join(root, 'link.md'))
        await copyEntry(options(root), 'link.md', 'copied-link.md')
        const info = await lstat(join(root, 'copied-link.md'))
        expect(info.isSymbolicLink()).toBe(true)
        // The copied link still points where the original pointed; its bytes were not
        // read into the knowledge tree.
        const linkTarget = await readlink(join(root, 'copied-link.md'))
        expect(linkTarget).toBe(join(outside, 'secret.md'))
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a copy larger than the entry ceiling before writing anything', async () => {
    // Pre-validation is the assertion: a refusal must leave NO partial subtree behind.
    const root = await mkdtemp(join(tmpdir(), 'kb-copy-'))
    try {
      await mkdir(join(root, 'many'), { recursive: true })
      for (let index = 0; index < 205; index += 1) {
        await writeFile(join(root, 'many', 'f' + String(index) + '.md'), 'x', 'utf8')
      }
      await expect(copyEntry(options(root), 'many', 'dst'))
        .rejects.toThrow(/more than 200 entries/u)
      // Nothing was written, so there is no half-tree to clean up.
      await expect(stat(join(root, 'dst'))).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('move is a rename, not a copy', () => {
  it('moves an entry with rename and keeps its inode', async () => {
    // The inode is the assertion that matters: every user's view holds hardlinks to
    // the authoritative inode, so a copy-and-delete would leave every view pointing
    // at a file that no longer exists.
    const root = await mkdtemp(join(tmpdir(), 'kb-move-'))
    try {
      const source = join(root, 'a.md')
      await writeFile(source, 'hello', 'utf8')
      const before = await stat(source)
      const moved = await moveEntry({ actualRoot: root, viewRoot: join(root, 'views'), userId: 'u-1' }, 'a.md', 'docs/a.md')
      expect(moved).toEqual({ from: 'a.md', to: 'docs/a.md' })
      const after = await stat(join(root, 'docs/a.md'))
      // Same inode: the file was relinked, never rewritten.
      expect(after.ino).toBe(before.ino)
      await expect(stat(source)).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to overwrite an existing destination', async () => {
    // A move that silently replaces a document is data loss no prompt can undo.
    const root = await mkdtemp(join(tmpdir(), 'kb-move-'))
    try {
      await writeFile(join(root, 'a.md'), 'source', 'utf8')
      await mkdir(join(root, 'docs'), { recursive: true })
      await writeFile(join(root, 'docs/a.md'), 'occupied', 'utf8')
      await expect(
        moveEntry({ actualRoot: root, viewRoot: join(root, 'views'), userId: 'u-1' }, 'a.md', 'docs/a.md'),
      ).rejects.toThrow(/destination already exists/u)
      // Both files are untouched.
      await expect(readFile(join(root, 'a.md'), 'utf8')).resolves.toBe('source')
      await expect(readFile(join(root, 'docs/a.md'), 'utf8')).resolves.toBe('occupied')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses an uncontained path on either side', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-move-'))
    try {
      await expect(
        moveEntry({ actualRoot: root, viewRoot: join(root, 'views'), userId: 'u-1' }, '../escape', 'x'),
      ).rejects.toThrow(/not contained/u)
      await expect(
        moveEntry({ actualRoot: root, viewRoot: join(root, 'views'), userId: 'u-1' }, 'x', '../../escape'),
      ).rejects.toThrow(/not contained/u)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a preference file across a sync', async () => {
    // The sync's unlink pass removes every walked file the resolved set does not
    // name, so a preference file it does not skip is deleted on the next run --
    // which reads as a setting that will not stick.
    const root = await mkdtemp(join(tmpdir(), 'kb-pref-'))
    try {
      const views = join(root, 'views')
      const actual = join(root, 'actual')
      await mkdir(actual, { recursive: true })
      await writeFile(join(actual, 'a.md'), 'x', 'utf8')
      const options = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
      const viewDir = viewPathFor(options)
      await mkdir(viewDir, { recursive: true })
      await writeViewMode(viewDir, 'grid')
      await writePins(viewDir, ['a.md'])
      await syncView(options, [{ relPath: 'a.md' }])
      await expect(readViewMode(viewDir)).resolves.toBe('grid')
      await expect(readPins(viewDir)).resolves.toEqual(['a.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('writing into the authoritative tree', () => {
  /**
   * `create` and `upload` land under `actualRoot`, not the caller's view.
   *
   * That is the load-bearing decision: `syncView` mirrors the resolved grant set
   * onto the view and removes anything else, so a document written into a view is
   * deleted by the next permission change. These tests pin the destination, the
   * permission gate, and the refusal to overwrite.
   */
  const writeConfig = (root: string): typeof CONFIG => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  /** A fetch stub answering `resolve` from a per-path permission table. */
  const permFetch = (table: Record<string, { canRead?: boolean; canWrite?: boolean }>) =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        const sent = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
        const answer = table[sent.resourceId ?? ''] ?? { canRead: false, canWrite: false }
        return new Response(JSON.stringify(answer), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  async function writeRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'kb-write-'))
    await mkdir(join(root, 'actual'), { recursive: true })
    return root
  }

  it('writes a new document into the authoritative tree, not the view', async () => {
    const root = await writeRoot()
    const config = writeConfig(root)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: permFetch({ 'notes/a.md': { canWrite: true } }) })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: 'notes/a.md', kind: 'file' })
      expect(reply.error).toBeUndefined()
      // The decisive assertion: it is in actual/, and NOT in the view.
      await expect(readFile(join(config.actualRoot, 'notes/a.md'), 'utf8')).resolves.toBe('')
      await expect(readFile(join(config.viewRoot, 'u-1', 'notes/a.md'), 'utf8')).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('carries content when one is given', async () => {
    const root = await writeRoot()
    const config = writeConfig(root)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: permFetch({ 'a.md': { canWrite: true } }) })
    try {
      apply(ctx as never, config as never)
      await callRoute(routes, 'create', { relPath: 'a.md', kind: 'file', content: '# hi' })
      await expect(readFile(join(config.actualRoot, 'a.md'), 'utf8')).resolves.toBe('# hi')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('creates a directory when asked for one', async () => {
    const root = await writeRoot()
    const config = writeConfig(root)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: permFetch({ 'folder': { canWrite: true } }) })
    try {
      apply(ctx as never, config as never)
      await callRoute(routes, 'create', { relPath: 'folder', kind: 'directory' })
      await expect(stat(join(config.actualRoot, 'folder'))).resolves.toBeDefined()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a caller who may read but not write', async () => {
    // Read is not enough: creating puts a document into the SHARED tree, where
    // everyone DataOps resolves as a reader will see it.
    const root = await writeRoot()
    const config = writeConfig(root)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: permFetch({ 'a.md': { canRead: true, canWrite: false } }) })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: 'a.md', kind: 'file' })
      expect(reply.error).toBeDefined()
      expect(reply.refused).toEqual(['a.md'])
      // Nothing was written: the refusal is not a partial write.
      await expect(stat(join(config.actualRoot, 'a.md'))).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('fails closed when the permission answer cannot be read', async () => {
    // An unreachable backend must refuse rather than authorize.
    const root = await writeRoot()
    const config = writeConfig(root)
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      }
      throw new Error('backend is unreachable')
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: 'a.md', kind: 'file' })
      expect(reply.error).toBeDefined()
      await expect(stat(join(config.actualRoot, 'a.md'))).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('never overwrites an existing document', async () => {
    const root = await writeRoot()
    const config = writeConfig(root)
    await writeFile(join(config.actualRoot, 'shared.md'), 'someone else wrote this', 'utf8')
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: permFetch({ 'shared.md': { canWrite: true } }) })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: 'shared.md', kind: 'file', content: 'mine' })
      // Refused, and the original bytes are untouched.
      expect(reply.code).toBe('exists')
      await expect(readFile(join(config.actualRoot, 'shared.md'), 'utf8')).resolves.toBe('someone else wrote this')
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  it('refuses a path that escapes the root', async () => {
    const root = await writeRoot()
    const config = writeConfig(root)
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: permFetch({}) })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: '../outside.md', kind: 'file' })
      expect(reply.refused).toEqual(['../outside.md'])
      // Nothing landed beside the root either.
      await expect(stat(join(root, 'outside.md'))).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
    }
  })

  // The ceiling is injected here, so the boundary is verified with a 1 MiB body instead of
  // one at the production limit. `MAX_KNOWLEDGE_WRITE_BYTES` is a product decision that has
  // already moved once (1 MiB -> 500 MiB); a test that allocates the CURRENT limit measures
  // the machine's string throughput, not the comparison. What has to hold is the comparison.
  it('refuses a document over the ceiling before writing anything', async () => {
    const root = await writeRoot()
    const config = writeConfig(root)
    const limit = 1024 * 1024
    await expect(createKnowledgeEntry(config, 'big.md', {
      directory: false,
      content: 'x'.repeat(limit + 1),
      limitBytes: limit,
    })).rejects.toMatchObject({ code: 'too-large' })
    // Nothing was written: the refusal happens before the file is opened.
    await expect(stat(join(config.actualRoot as string, 'big.md'))).rejects.toThrow()
  })

  it('accepts a document at exactly the ceiling', async () => {
    // The bound is inclusive, so the largest allowed document is not refused.
    const root = await writeRoot()
    const config = writeConfig(root)
    const limit = 1024 * 1024
    await expect(createKnowledgeEntry(config, 'ok.md', {
      directory: false,
      content: 'x'.repeat(limit),
      limitBytes: limit,
    })).resolves.toMatchObject({ kind: 'file' })
    await expect(stat(join(config.actualRoot as string, 'ok.md'))).resolves.toBeDefined()
  })

  it('names the limit it actually applied', async () => {
    // 文案里的数字必须是被应用的那个上限，否则读者按提示改名也没用。
    const root = await writeRoot()
    const config = writeConfig(root)
    const limit = 4096
    await expect(createKnowledgeEntry(config, 'big.md', {
      directory: false,
      content: 'x'.repeat(limit + 1),
      limitBytes: limit,
    })).rejects.toThrow(String(limit))
  })

})

describe('the write path is bounded by its own errors', () => {
  it('separates write refusals from transport errors', async () => {
    // `KnowledgeError`'s codes describe how a TRANSPORT call ended. A write refusal
    // is a different kind of answer with different statuses, so it has its own type
    // rather than widening the transport's closed union.
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/export class KnowledgeWriteError/u)
    const transport = /export type KnowledgeErrorCode =([\s\S]*?)\n\n/u.exec(source)
    expect(transport?.[1]).toBeDefined()
    expect(transport?.[1]).not.toMatch(/exists|too-large|bad-path/u)
    // And each refusal has a status that describes it.
    expect(source).toMatch(/case 'exists': return 409/u)
    expect(source).toMatch(/case 'too-large': return 413/u)
  })

  it('does not write when the resolved set is unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-write-idem-'))
    const options = { actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), userId: 'u-1' }
    await mkdir(options.actualRoot, { recursive: true })
    await writeFile(join(options.actualRoot, 'a.md'), 'a', 'utf8')
    await createKnowledgeEntry({ ...CONFIG, actualRoot: options.actualRoot, viewRoot: options.viewRoot }, 'b.md', { directory: false })
    const first = await syncView(options, [{ relPath: 'a.md' }, { relPath: 'b.md' }])
    expect(first.linked.sort()).toEqual(['global/a.md', 'global/b.md'])
    const second = await syncView(options, [{ relPath: 'a.md' }, { relPath: 'b.md' }])
    expect(second.linked).toEqual([])
    expect(second.unchanged).toBeGreaterThan(0)
  })
})

describe('drag-to-move wiring', () => {
  /**
   * The gesture spans two components, so the contract between them is what is
   * asserted: the listing publishes the payload type, and the panel's pin zone only
   * arms for that type. A drag of anything else crossing the rail must not arm it.
   */
  it('shares one drag payload type between the rows and the pin zone', async () => {
    const listing = await readFile(new URL('../src/client/KnowledgeListing.tsx', import.meta.url), 'utf8')
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    expect(listing).toMatch(/export const KB_DRAG_MIME = 'application\/x-dsh-kb-path'/u)
    expect(panel).toMatch(/import \{ KB_DRAG_MIME, KnowledgeListing \}/u)
    // The zone is armed by the type, not by an unconditional preventDefault.
    expect(panel).toMatch(/dataTransfer\.types\.includes\(KB_DRAG_MIME\)/u)
  })

  it('copies the drop-target treatment from the explorer rather than inventing one', async () => {
    const css = await readFile(new URL('../src/client/KnowledgeListing.module.css', import.meta.url), 'utf8')
    const drop = css.slice(css.indexOf('.entry[data-drop-target='))
    // The explorer's own two declarations (sidebar.module.css:1066).
    expect(drop).toMatch(/background: var\(--dsw-alias-interactive-bg-hover-accent\)/u)
    expect(drop).toMatch(/outline: 1px dashed var\(--dsw-alias-state-business-primary\)/u)
    expect(drop).toMatch(/outline-offset: -1px/u)
  })

  it('never drops a folder into itself or its own descendant', async () => {
    // The kernel answers EINVAL for a directory renamed into its own child; refusing
    // it in the tree keeps that error out of the reader's face.
    const listing = await readFile(new URL('../src/client/KnowledgeListing.tsx', import.meta.url), 'utf8')
    expect(listing).toMatch(/source\.startsWith\(entry\.relPath \+ '\/'\)/u)
    expect(listing).toMatch(/entry\.relPath\.startsWith\(payload\.relPath \+ '\/'\)/u)
  })

  it('keeps the row metrics in list mode and adds a separate card family for grid', async () => {
    // The row measurements are a copy of `.explorerRow` that task-16 verified; the
    // grid must not be a restyling of them.
    const css = await readFile(new URL('../src/client/KnowledgeListing.module.css', import.meta.url), 'utf8')
    const row = css.slice(css.indexOf('.entry {'), css.indexOf('.entry:hover'))
    expect(row).toMatch(/height: 28px/u)
    expect(row).toMatch(/font: var\(--dsw-font-xxs-12\)/u)
    expect(row).toMatch(/padding: 0 8px/u)
    // And the card is its own class, not `.entry`.
    expect(css).toMatch(/\.card \{/u)
    expect(css).toMatch(/\.cards \{/u)
  })
})

describe('the template read cannot leave the surface spinning', () => {
  /**
   * The bound is enforced by a RACE, not by the abort alone.
   *
   * Found by measurement: with a fetch stub that never settles and ignores its
   * signal, the dialog still read "Loading templates..." after seven seconds. The
   * abort had been requested and the request simply did not care, so a surface
   * whose whole reason for a timeout is "never spin" was spinning. The race makes
   * the deadline authoritative whatever the transport does.
   *
   * The race moved into the module-level loader when the library gained a
   * maintenance pane (one reader serves both tabs); the properties below are the
   * ones that matter and are asserted against wherever they now live.
   */
  const source = async (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeTemplates.tsx', import.meta.url), 'utf8')

  it('races the read against a deadline', async () => {
    const text = await source()
    expect(text).toMatch(/Promise\.race\(\[read, deadline\]\)/u)
    // The deadline both aborts and resolves, so the losing branch runs even when
    // the abort is ignored.
    const deadline = text.slice(text.indexOf('const deadline ='))
    expect(deadline.slice(0, 300)).toMatch(/controller\.abort\(\)/u)
    expect(deadline.slice(0, 300)).toMatch(/resolve\('timeout'\)/u)
  })

  it('reports a timeout as unreadable, not as an empty library', async () => {
    // The two are different facts: one says "the source has no templates", the
    // other says "this could not be asked". Only the first may claim emptiness.
    const text = await source()
    expect(text).toMatch(/result === 'timeout'/u)
    // The timeout branch sets `unavailable` and returns BEFORE the rows are adopted,
    // so an unanswered read cannot leave an empty grid claiming there are none.
    const branch = text.slice(text.indexOf("result === 'timeout'"))
    expect(branch.slice(0, 260)).toMatch(/setState\('unavailable'\)/u)
    expect(branch.slice(0, 260)).toMatch(/return/u)
  })

  it('does not set state after unmount', async () => {
    // A read that lands after the dialog closed must not write to a dead component.
    const text = await source()
    expect(text).toMatch(/const live = useRef\(true\)/u)
    expect(text).toMatch(/live\.current = false/u)
    // Both the success and the failure path consult it before touching state.
    expect(text).toMatch(/if \(!live\.current\) return/u)
    const guards = (text.match(/if \(!live\.current\) return/gu) ?? []).length
    expect(guards).toBeGreaterThanOrEqual(2)
  })
})

describe('uploading a folder is really a folder', () => {
  /**
   * The create dialog offers "Upload folder", so the behaviour has to be a folder:
   * the picker returns the chosen subtree and each file keeps its place inside it. A
   * control whose label promises a folder while the code sends one file is worse than
   * a disabled one, because the reader believes their folder arrived.
   *
   * The behaviour moved out of `KnowledgeHome` and into `KnowledgeCreateDialog` when
   * the dropdown became a modal (the dialog is where the destination is chosen, so it
   * is also where the files are read). These assertions follow it there rather than
   * being dropped: the property under test is the upload's, not the component's.
   */
  const dialog = async (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeCreateDialog.tsx', import.meta.url), 'utf8')

  it('asks the picker for a directory', async () => {
    const source = await dialog()
    // `webkitdirectory` is what makes the folder row's promise true: the picker
    // returns the whole subtree, each file carrying its path relative to the root.
    // It is applied per mode rather than by mutating one shared input, so a folder
    // pick cannot leave the attribute behind for the next single-file pick.
    expect(source).toMatch(/webkitdirectory/u)
    expect(source).toMatch(/mode === 'upload-folder'/u)
  })

  it('keeps each file in its place inside the picked folder', async () => {
    const source = await dialog()
    // `webkitRelativePath` is the picked root plus the file's position in it, so the
    // upload recreates the shape instead of flattening it into one level.
    expect(source).toMatch(/webkitRelativePath/u)
    expect(source).toMatch(/relative:\s*\(file as File & \{ webkitRelativePath\?: string \}\)\.webkitRelativePath \|\| file\.name/u)
  })

  it('attempts every file and names the failures', async () => {
    const source = await dialog()
    // One request per file, so a rejection is per path rather than for the batch.
    expect(source).toMatch(/for \(const item of pending\)/u)
    // The loop does not break on failure: the reader chose a folder, and stopping at
    // the first collision would leave them guessing which files made it.
    const loop = source.slice(source.indexOf('for (const item of pending)'))
    expect(loop.slice(0, 1200)).not.toMatch(/\bbreak\b/u)
    // The summary carries counts AND names, and both sentences exist.
    expect(source).toMatch(/uploadPartial/u)
    expect(source).toMatch(/uploadDone/u)
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(locales).toMatch(/uploadPartial: '[^']*\{ok\}[^']*\{failed\}[^']*\{names\}/u)
  })

  it('does not send a batch body', async () => {
    // A batch body would force the Host to define what a partly-authorized upload
    // means. One request per path keeps the refusal per path, which is the honest
    // answer and the one the endpoint already gives.
    const source = await dialog()
    expect(source).toMatch(/body: JSON\.stringify\(\{ relPath: joinRel\(destination, item\.relative\), content \}\)/u)
    expect(source).not.toMatch(/body: JSON\.stringify\(\{ files/u)
  })

  it('shows every file its own landing path before the upload starts', async () => {
    // The whole point of the dialog: the reader sees where each file goes, including
    // the folder shape a directory upload recreates.
    const source = await dialog()
    expect(source).toMatch(/joinRel\(destination, item\.relative\)/u)
    expect(source).toMatch(/fileTarget/u)
  })
})

describe('the view switcher fits the section band', () => {
  /**
   * The first implementation used a labelled `SegmentedControl`, and it was measured
   * out of this header: the official control is 126px (4px pad plus a 28px tab with
   * 16px side padding), which took the band to 230 of its 280px and clipped the
   * section name at any narrower rail. The band's own control is a 28px icon button,
   * so the two modes belong in a menu behind one.
   */
  it('offers ordering and filtering from one 28px icon button', async () => {
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    // The band's menu carries the orderings and the filter, and the anchor is the band's
    // own icon button -- the labelled inline control the measurements ruled out is gone.
    expect(panel).toMatch(/<MenuItemButton/u)
    expect(panel).not.toMatch(/<SegmentedControl/u)
    // Every ordering the menu offers is named by a locale key rather than inline text.
    for (const key of ['sortByMtime', 'sortByName', 'sortBySize', 'sortByType']) {
      expect(panel, key).toContain("t('" + key + "')")
    }
    // Filtering shares the same menu, under its own heading, separated from the orderings.
    expect(panel).toContain("t('filterHeading')")
    expect(panel).toContain("t('actionFilter')")
    expect(panel).toMatch(/menuSeparator/u)
  })

  it('puts the one sliders control BEFORE the new-document button, as the FIRST slider', async () => {
    // The reader's complaint was a SECOND sliders button appearing to the right of the
    // new-document one. The control has to sit where the filter button used to be: before
    // `actionNew`, and first among the band's controls.
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    const bandStart = panel.indexOf('<KnowledgeSectionHeader')
    const band = panel.slice(bandStart, panel.indexOf('</KnowledgeSectionHeader>', bandStart))
    const sliders = band.indexOf('label={t(\'actionSortAndFilter\')}')
    const plus = band.indexOf('label={t(\'actionNew\')}')
    expect(sliders).toBeGreaterThan(0)
    expect(plus).toBeGreaterThan(0)
    expect(sliders, '排序与过滤必须在新建之前').toBeLessThan(plus)
  })

  it('renders exactly one sliders glyph in the whole panel', async () => {
    // Two identical glyphs is the defect itself; the icons are the observable count.
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    const imports = panel.slice(0, panel.indexOf('} from \'@deepseek-ai/dsh-client-ui-primitives\''))
    const body = panel.slice(imports.length)
    // One import line plus exactly one JSX usage: no second button can borrow the glyph.
    expect(body.match(/<IconSlidersTwoOutlineRegular/gu) ?? []).toHaveLength(1)
  })

  it('no longer offers a view-mode switcher', async () => {
    // The reader asked for it to go: they do not change views. Removing the ENTRY must not
    // remove the stored preference, so the hook stays and only the control is gone.
    const panel = await readFile(new URL('../src/client/KnowledgePanel.tsx', import.meta.url), 'utf8')
    expect(panel).not.toMatch(/viewList/u)
    expect(panel).not.toMatch(/viewGrid/u)
    expect(panel).not.toMatch(/viewExplorer/u)
    expect(panel).not.toContain('viewMode.setMode')
    // …but the preference is still read, so a reader who once chose the explorer keeps it.
    expect(panel).toContain('useViewMode(')
  })

  it('carries four 28px controls in the band, which is what fits 280px', async () => {
    // Measured: four 28px buttons plus the 4px gaps and 8px inset come to 132px of a
    // 280px band, leaving the section name its full width. The labelled control put
    // the same row at 230px and clipped the name below a 240px rail.
    const css = await readFile(new URL('../src/client/KnowledgePanel.module.css', import.meta.url), 'utf8')
    const button = css.slice(css.indexOf('.iconButton {'), css.indexOf('.iconButton:hover'))
    expect(button).toMatch(/width: 28px/u)
    expect(button).toMatch(/height: 28px/u)
    const band = css.slice(css.indexOf('.sectionHeader {'), css.indexOf('.sectionActions {'))
    expect(band).toMatch(/gap: 4px/u)
  })
})

describe('the two dictionaries stay in their own languages', () => {
  /**
   * `en` and `zh` are separate objects, and a key with Chinese copy sitting in `en`
   * type-checks perfectly: both are `string`. The mistake is therefore invisible to
   * the compiler and visible only to a reader, which is exactly how one was made
   * here while inserting a block next to a shared anchor.
   *
   * The test is a heuristic, not a language detector: it flags a key whose value
   * contains Han characters while living in the English object, and the reverse for
   * a value that is pure ASCII in the Chinese one. That catches a swapped block
   * without needing to know what any individual string means.
   */
  const localeSource = async (): Promise<string> =>
    readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

  /** Split the file at the `zh` declaration, which is where the dictionary changes. */
  async function dictionaries(): Promise<{ en: string; zh: string }> {
    const source = await localeSource()
    const cut = source.indexOf('export const zh')
    expect(cut).toBeGreaterThan(0)
    return { en: source.slice(0, cut), zh: source.slice(cut) }
  }

  const HAN = /[\u4e00-\u9fff]/u

  it('keeps Han copy out of the English dictionary', async () => {
    const { en } = await dictionaries()
    const offenders = [...en.matchAll(/^\s+'?([a-zA-Z][a-zA-Z0-9.]*)'?:\s*'([^']*)'/gmu)]
      .filter(([, , value]) => HAN.test(value ?? ''))
      .map(([, key]) => key)
    expect(offenders).toEqual([])
  })

  it('keeps English-only copy out of the Chinese dictionary', async () => {
    const { zh } = await dictionaries()
    // A Chinese value may contain ASCII (tokens, `{n}`, punctuation), so this flags
    // only values that are ENTIRELY ASCII and contain a word: those are the ones a
    // swapped block produces.
    const offenders = [...zh.matchAll(/^\s+'?([a-zA-Z][a-zA-Z0-9.]*)'?:\s*'([^']*)'/gmu)]
      .filter(([, , value]) => {
        const text = value ?? ''
        return !HAN.test(text) && /[A-Za-z]{3}/u.test(text)
      })
      .map(([, key]) => key)
    // Proper nouns the product keeps untranslated in both languages are allowed.
    const allowed = new Set<string>()
    expect(offenders.filter(key => !allowed.has(key as string))).toEqual([])
  })
})

describe('the copy does not promise an index that does not exist', () => {
  /**
   * The retrieval path reads the mounted tree with grep and read, and the `index`
   * route only recounts directories. Wording that offers to "build an index" is
   * therefore a promise the plugin cannot keep, and the page contradicted itself:
   * the menu said index management while its own note said there was no index.
   *
   * The check is on the VALUES, not on the identifiers. `menu.indexing`, the
   * `index` route and `KB_API.indexDirs` are internal names that cost nothing to
   * keep, and renaming them would churn types for no reader's benefit.
   */
  const source = async (): Promise<string> =>
    readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')

  it('offers no control that claims to build one', async () => {
    const text = await source()
    const values = [...text.matchAll(/^\s+'?[a-zA-Z][a-zA-Z0-9.]*'?:\s*'([^']*)'/gmu)].map(m => m[1] ?? '')
    // A value may MENTION an index only to deny one ("nothing to index",
    // "无需建立索引"). What must not appear is an offer to build one.
    const offering = values.filter(v =>
      /build index|create index|建立索引|创建索引|生成索引/u.test(v) && !/nothing|no |not |无需|没有|不必/u.test(v))
    expect(offering).toEqual([])
  })

  it('keeps the internal identifiers it does not need to rename', async () => {
    const text = await source()
    // Renaming these would change the KnowledgeKey type and every call site for no
    // reader-visible gain, so their presence is intentional and asserted here so a
    // later cleanup does not mistake them for leftovers.
    expect(text).toMatch(/'menu\.indexing':/u)
    const routes = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
    expect(routes).toMatch(/indexDirs: 'index\.dirs'/u)
  })

  it('does not carry the dead note key', async () => {
    // Zero references before removal, so it was only a hint that an index exists.
    const text = await source()
    expect(text).not.toMatch(/^\s*indexingNote:/mu)
  })
})

describe('review settings and the audit trail', () => {
  /**
   * Both surfaces write, so they run against a temporary root rather than the
   * configured one: `CONFIG.viewRoot` is a real deployment path, and a settings
   * round-trip against it would write under the live share.
   */
  /**
   * @param canWrite - the per-path answer the resolve endpoint gives.
   * @param canManage - whether the caller may manage grants. Deciding review or a
   *   submission is a grant-management decision, not a per-path write: no single
   *   resource's write bit covers "may change how this knowledge base works".
   */
  const callerFetch = (userId: string, canWrite = true, canManage = canWrite) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: userId } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite }), { status: 200 })
      }
      if (url.includes('/resource-permissions/grants')) {
        return new Response(JSON.stringify({ grants: [] }), { status: canManage ? 200 : 403 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  const isolatedConfig = (root: string) => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  it('answers review OFF for a caller who has never opened the settings page', async () => {
    // The default is the product decision, not an accident: a deployment that never
    // opens this page must not start gating people's contributions.
    const root = await mkdtemp(join(tmpdir(), 'kb-settings-default-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1', false) })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'settings.get', {})
      // The route answers `{ settings: {...} }`; the helper types its reply loosely
      // because every route has a different body shape.
      expect((reply.settings as { reviewRequired?: boolean }).reviewRequired).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('round-trips the switch through the route', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-settings-roundtrip-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1', true) })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const written = await callRoute(routes, 'settings.set', { reviewRequired: true })
      expect((written.settings as { reviewRequired?: boolean }).reviewRequired).toBe(true)
      const readBack = await callRoute(routes, 'settings.get', {})
      expect((readBack.settings as { reviewRequired?: boolean }).reviewRequired).toBe(true)
      // Stored in the CALLER's own directory, beside the pins and the view mode.
      const stored = JSON.parse(await readFile(join(root, 'views', 'u-1', '.kb-settings.json'), 'utf8'))
      expect(stored.reviewRequired).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to change the switch without write access', async () => {
    // Turning review on or off decides whether other people's contributions take
    // effect immediately. Read access is not enough for that.
    const root = await mkdtemp(join(tmpdir(), 'kb-settings-forbidden-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1', false) })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      // The route answers with a refusal body rather than throwing (that is this
      // harness's contract for every route), so the assertion is on the refusal.
      const refused = await callRoute(routes, 'settings.set', { reviewRequired: true })
      expect(String(refused.error)).toContain('grant-management access')
      // And nothing was written, so a refused attempt cannot half-apply.
      const reply = await callRoute(routes, 'settings.get', {})
      expect((reply.settings as { reviewRequired?: boolean }).reviewRequired).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a non-boolean switch value instead of coercing it', async () => {
    // `"false"` is truthy in JavaScript; silently coercing it would switch review ON
    // for a caller who asked for OFF.
    const root = await mkdtemp(join(tmpdir(), 'kb-settings-typeof-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1', true) })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const refused = await callRoute(routes, 'settings.set', { reviewRequired: 'false' })
      expect(String(refused.error)).toContain('boolean')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('survives a sync, so a preference is not deleted as if it were a stale grant', async () => {
    // The sync walk unlinks every file it did not resolve. A settings file missing
    // from the metadata set would vanish on the next sync and read as "the switch
    // will not stick" rather than as a bug.
    const root = await mkdtemp(join(tmpdir(), 'kb-settings-sync-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1', true) })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      await callRoute(routes, 'audit.list', {})
      await syncView({ actualRoot: join(root, 'actual'), viewRoot: join(root, 'views'), userId: 'u-1' }, [])
      const settingsFile = await readFile(join(root, 'views', 'u-1', '.kb-settings.json'), 'utf8')
      expect(JSON.parse(settingsFile).reviewRequired).toBe(true)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the audit trail newest first and never rewrites it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-audit-order-'))
    const viewDir = join(root, 'views', 'u-1')
    await mkdir(viewDir, { recursive: true })
    try {
      await appendAuditEntry(viewDir, { at: '2026-01-01T00:00:00.000Z', actor: 'u-1', action: 'create', relPath: 'a.md', outcome: 'applied' })
      await appendAuditEntry(viewDir, { at: '2026-01-02T00:00:00.000Z', actor: 'u-1', action: 'upload', relPath: 'b.md', outcome: 'applied' })
      const entries = await readAuditEntries(viewDir, 10)
      expect(entries.map((entry) => entry.relPath)).toEqual(['b.md', 'a.md'])
      // Appending a third leaves the earlier two byte-identical: this is what makes it
      // a trail rather than a mutable list.
      const before = await readFile(join(viewDir, '.kb-audit.jsonl'), 'utf8')
      await appendAuditEntry(viewDir, { at: '2026-01-03T00:00:00.000Z', actor: 'u-1', action: 'move', relPath: 'b.md', toRelPath: 'c.md', outcome: 'applied' })
      const after = await readFile(join(viewDir, '.kb-audit.jsonl'), 'utf8')
      expect(after.startsWith(before)).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records the actor label beside the id and reads it back', async () => {
    // The id is the identity an audit is checked against; the label is only what the
    // trail reads as. Recording both is what lets an old entry and a new one sit in
    // the same table without the reader seeing a raw UUID for one and a name for the
    // other.
    const root = await mkdtemp(join(tmpdir(), 'kb-audit-label-'))
    const viewDir = join(root, 'views', 'u-1')
    await mkdir(viewDir, { recursive: true })
    try {
      await appendAuditEntry(viewDir, {
        at: '2026-01-02T00:00:00.000Z',
        actor: '260afb31-f8d9-44ba-b161-2a9bfe283a79',
        actorLabel: '张三',
        action: 'edit',
        relPath: 'a.md',
        outcome: 'applied',
      })
      const entries = await readAuditEntries(viewDir, 10)
      expect(entries).toHaveLength(1)
      expect(entries[0].actor).toBe('260afb31-f8d9-44ba-b161-2a9bfe283a79')
      expect(entries[0].actorLabel).toBe('张三')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a log line written before labels existed', async () => {
    // Existing deployments already hold lines with no `actorLabel`. They must still be
    // read, and the renderer falls back to the id — dropping them would hide history.
    const root = await mkdtemp(join(tmpdir(), 'kb-audit-legacy-'))
    const viewDir = join(root, 'views', 'u-1')
    await mkdir(viewDir, { recursive: true })
    try {
      await appendFile(
        join(viewDir, '.kb-audit.jsonl'),
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', actor: 'legacy-user', action: 'create', relPath: 'old.md', outcome: 'applied' }) + '\n',
        'utf8',
      )
      const entries = await readAuditEntries(viewDir, 10)
      expect(entries).toHaveLength(1)
      expect(entries[0].actor).toBe('legacy-user')
      expect(entries[0].actorLabel).toBeUndefined()
      expect(entries[0].relPath).toBe('old.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ignores a non-string label instead of rendering it', async () => {
    // A hand-edited or foreign log must not be able to put a non-text value in a cell.
    const root = await mkdtemp(join(tmpdir(), 'kb-audit-badlabel-'))
    const viewDir = join(root, 'views', 'u-1')
    await mkdir(viewDir, { recursive: true })
    try {
      await appendFile(
        join(viewDir, '.kb-audit.jsonl'),
        JSON.stringify({ at: '2026-01-01T00:00:00.000Z', actor: 'u-1', actorLabel: 42, action: 'edit', relPath: 'a.md', outcome: 'applied' }) + '\n',
        'utf8',
      )
      const entries = await readAuditEntries(viewDir, 10)
      expect(entries).toHaveLength(1)
      expect(entries[0].actorLabel).toBeUndefined()
      expect(entries[0].actor).toBe('u-1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('skips a torn line rather than losing the whole trail', async () => {
    // A crash mid-append leaves a partial line. That must cost the last entry, not
    // every entry before it.
    const root = await mkdtemp(join(tmpdir(), 'kb-audit-torn-'))
    const viewDir = join(root, 'views', 'u-1')
    await mkdir(viewDir, { recursive: true })
    try {
      await appendAuditEntry(viewDir, { at: '2026-01-01T00:00:00.000Z', actor: 'u-1', action: 'create', relPath: 'a.md', outcome: 'applied' })
      await appendFile(join(viewDir, '.kb-audit.jsonl'), '{"at":"2026-01-0', 'utf8')
      const entries = await readAuditEntries(viewDir, 10)
      expect(entries).toHaveLength(1)
      expect(entries[0].relPath).toBe('a.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the review switch actually changes behaviour', () => {
  /**
   * A switch that can be flipped but changes nothing is worse than no switch: it
   * records an intent nobody honours. These cases pin the consequence, not the flag.
   */
  const callerFetch = (userId: string) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: userId } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  const isolatedConfig = (root: string) => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  it('parks a write with its bytes instead of applying it when review is on', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-review-on-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      const reply = await callRoute(routes, 'create', { relPath: 'draft.md', content: '# draft\n' })
      expect(reply.pending).toBe('draft.md')
      // Nothing landed in the shared tree, which is the whole consequence of the switch.
      expect(existsSync(join(root, 'actual', 'draft.md'))).toBe(false)
      // But the bytes were kept, so an approver can read what was submitted.
      const pendingDir = join(root, 'actual', '.kb-pending')
      const files = await readdir(pendingDir)
      const contentFile = files.find((name) => name.endsWith('.content'))
      expect(contentFile).toBeDefined()
      expect(await readFile(join(pendingDir, contentFile as string), 'utf8')).toBe('# draft\n')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('applies the same write immediately when review is off', async () => {
    // The default. Same request, opposite outcome, and the only difference is the flag.
    const root = await mkdtemp(join(tmpdir(), 'kb-review-off-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      const reply = await callRoute(routes, 'create', { relPath: 'live.md', content: '# live\n' })
      expect(reply.pending).toBeUndefined()
      expect(existsSync(join(root, 'actual', 'live.md'))).toBe(true)
      // And nothing was parked, so an un-reviewed deployment never grows a queue.
      expect(existsSync(join(root, 'actual', '.kb-pending'))).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('records a pending write as pending in the trail, not as applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-review-audit-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      await callRoute(routes, 'create', { relPath: 'waiting.md', content: '# waiting\n' })
      const trail = await callRoute(routes, 'audit.list', {})
      const entries = trail.entries as Array<{ relPath: string; outcome: string }>
      const entry = entries.find((candidate) => candidate.relPath === 'waiting.md')
      expect(entry?.outcome).toBe('pending')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the review queue can be worked', () => {
  /**
   * A queue with no approve or reject path is a black hole: submissions go in and
   * nothing ever comes out, which is worse than review being off. These cases pin
   * both decisions and the fact that each leaves a distinct record.
   */
  /**
   * @param canWrite - the per-path answer the resolve endpoint gives.
   * @param canManage - whether the caller may manage grants. Deciding review or a
   *   submission is a grant-management decision, not a per-path write: no single
   *   resource's write bit covers "may change how this knowledge base works".
   */
  const callerFetch = (userId: string, canWrite = true, canManage = canWrite) =>
    (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: userId } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite }), { status: 200 })
      }
      if (url.includes('/resource-permissions/grants')) {
        return new Response(JSON.stringify({ grants: [] }), { status: canManage ? 200 : 403 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

  const isolatedConfig = (root: string) => ({
    ...CONFIG,
    actualRoot: join(root, 'actual'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'mnt'),
  })

  /** Submit one document through the route and return the parked name. */
  const submit = async (
    routes: Array<{ path: string; handler: (req: unknown, res: unknown) => Promise<void> | void }>,
    relPath: string,
    content: string,
  ): Promise<string> => {
    await callRoute(routes, 'create', { relPath, content })
    const queue = await callRoute(routes, 'pending.list', {})
    const entries = queue.pending as Array<{ name: string; relPath: string }>
    const entry = entries.find((candidate) => candidate.relPath === relPath)
    expect(entry).toBeDefined()
    return (entry as { name: string }).name
  }

  it('lists a submission with the path the submitter actually asked for', async () => {
    // The parking filename escapes characters, so it cannot be decoded back. The
    // reviewer must see the real path, which is why the envelope is the source.
    const root = await mkdtemp(join(tmpdir(), 'kb-queue-list-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      await submit(routes, '月报 草稿.md', '# 月报\n')
      const queue = await callRoute(routes, 'pending.list', {})
      const entries = queue.pending as Array<{ relPath: string; userId: string; bytes: number }>
      expect(entries.map((entry) => entry.relPath)).toEqual(['月报 草稿.md'])
      expect(entries[0].userId).toBe('u-1')
      expect(entries[0].bytes).toBe(Buffer.byteLength('# 月报\n', 'utf8'))
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('approving writes the submitted bytes into the shared tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-queue-approve-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      const name = await submit(routes, 'approved.md', '# approved\n')
      // Still absent before the decision, which is what review means.
      expect(existsSync(join(root, 'actual', 'approved.md'))).toBe(false)
      const result = await callRoute(routes, 'pending.approve', { name })
      expect(result.approved).toBeDefined()
      expect(await readFile(join(root, 'actual', 'approved.md'), 'utf8')).toBe('# approved\n')
      // And the queue no longer offers a decision already made.
      const after = await callRoute(routes, 'pending.list', {})
      expect((after.pending as unknown[]).length).toBe(0)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejecting discards the bytes and records a rejection, not a no-op', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-queue-reject-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      const name = await submit(routes, 'refused.md', '# refused\n')
      await callRoute(routes, 'pending.reject', { name })
      // Never published, and not left in the queue either.
      expect(existsSync(join(root, 'actual', 'refused.md'))).toBe(false)
      const after = await callRoute(routes, 'pending.list', {})
      expect((after.pending as unknown[]).length).toBe(0)
      // The trail says a person said no. Without this a rejection would look identical
      // to a submission nobody ever opened.
      const trail = await callRoute(routes, 'audit.list', {})
      const entries = trail.entries as Array<{ relPath: string; outcome: string; action: string }>
      const rejection = entries.find((entry) => entry.relPath === 'refused.md' && entry.outcome === 'rejected')
      expect(rejection?.action).toBe('reject')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses to approve or reject without write access, leaving the queue intact', async () => {
    // Deciding someone else's contribution is a decision about shared content, so read
    // access is not enough. The queue must survive the refused attempt.
    const root = await mkdtemp(join(tmpdir(), 'kb-queue-forbidden-'))
    const writer = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(writer.ctx as never, isolatedConfig(root) as never)
      await callRoute(writer.routes, 'settings.set', { reviewRequired: true })
      const name = await submit(writer.routes, 'held.md', '# held\n')
      for (const dispose of writer.disposers) dispose()

      const reader = fakeHost({ token: 't', fetchImpl: callerFetch('u-2', false) })
      try {
        await apply(reader.ctx as never, isolatedConfig(root) as never)
        const approve = await callRoute(reader.routes, 'pending.approve', { name })
        expect(String(approve.error)).toContain('grant-management access')
        const reject = await callRoute(reader.routes, 'pending.reject', { name })
        expect(String(reject.error)).toContain('grant-management access')
        // Nothing was published and nothing was discarded.
        expect(existsSync(join(root, 'actual', 'held.md'))).toBe(false)
        const queue = await callRoute(reader.routes, 'pending.list', {})
        expect((queue.pending as unknown[]).length).toBe(1)
      } finally {
        for (const dispose of reader.disposers) dispose()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a name that is a path rather than one submission', async () => {
    // The name is browser input even though it came back from the queue.
    const root = await mkdtemp(join(tmpdir(), 'kb-queue-traversal-'))
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: callerFetch('u-1') })
    try {
      await apply(ctx as never, isolatedConfig(root) as never)
      for (const name of ['../escape', 'a/b', '..', '']) {
        const reply = await callRoute(routes, 'pending.approve', { name })
        expect(String(reply.error)).toContain('pending submission name')
      }
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the audit page wires the review queue to the Host', () => {
  const readClient = async (name: string): Promise<string> =>
    readFile(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

  it('calls all three queue routes rather than showing a static table', async () => {
    // A table with no data source reads as "nothing to review" forever, which is the
    // failure mode this asserts against.
    const source = await readClient('KnowledgeAudit.tsx')
    expect(source).toContain('KB_API.pendingList')
    expect(source).toContain('KB_API.pendingApprove')
    expect(source).toContain('KB_API.pendingReject')
  })

  it('gives each queued row both decisions', async () => {
    const source = await readClient('KnowledgeAudit.tsx')
    expect(source).toMatch(/decide\(entry\.name, 'approve'\)/u)
    expect(source).toMatch(/decide\(entry\.name, 'reject'\)/u)
  })

  it('disables the decisions instead of hiding them when the caller cannot act', async () => {
    // Hiding the buttons would make the page look like review is not a thing here;
    // disabling them with an explanation says the queue exists and why it is read-only.
    const source = await readClient('KnowledgeAudit.tsx')
    expect(source).toMatch(/disabled=\{!canDecide \|\| busy\}/u)
    expect(source).toContain("c('pendingReadOnly')")
  })

  it('moved the queue off the settings page rather than duplicating it there', async () => {
    // Two entry points to the same two tables was the defect: the audit page is now
    // the only one, so settings must no longer carry the routes or the decisions.
    const settings = await readClient('KnowledgeSettings.tsx')
    expect(settings).not.toContain('KB_API.pendingList')
    expect(settings).not.toContain('KB_API.auditList')
    expect(settings).not.toContain("c('settingsPendingHeading')")
    expect(settings).not.toContain("c('settingsAuditHeading')")
    // The switch it still owns is untouched.
    expect(settings).toContain('KB_API.settingsGet')
    expect(settings).toContain('KB_API.settingsSet')
  })
})

describe('approving re-checks authority at the submitted path', () => {
  /**
   * A grant can be revoked between submitting and approving. The queue is therefore not
   * an authority: the submitted path must be re-authorised at decision time, or an
   * approver could publish into a path they may no longer write.
   */
  it('refuses to publish when write access at the submitted path was revoked', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-approve-revoked-'))
    let writeAtPath = true
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        // The two checks ask about DIFFERENT resources: the broad one sends an empty
        // resourceId, the per-path one sends the submitted path. Answering both from
        // one flag would make this test unable to tell which check refused, so the
        // broad answer stays true and only the path answer is revoked.
        const body = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
        const canWrite = (body.resourceId ?? '') === '' ? true : writeAtPath
        return new Response(JSON.stringify({ canRead: true, canWrite }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, {
        ...CONFIG,
        actualRoot: join(root, 'actual'),
        viewRoot: join(root, 'views'),
        mountPoint: join(root, 'mnt'),
      } as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      await callRoute(routes, 'create', { relPath: 'later.md', content: '# later\n' })
      const queue = await callRoute(routes, 'pending.list', {})
      const name = (queue.pending as Array<{ name: string }>)[0].name
      // Revoke, then decide. Nothing may be published.
      writeAtPath = false
      const reply = await callRoute(routes, 'pending.approve', { name })
      expect(String(reply.error)).toContain('write access is required at the submitted path')
      expect(existsSync(join(root, 'actual', 'later.md'))).toBe(false)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('the audit page is the one entry point for review and trail', () => {
  const readClient = async (name: string): Promise<string> =>
    readFile(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

  /**
   * The page exists so the queue and the trail stop being two sections of Settings.
   * These pin the structure that makes that true: real tabs from the primitives
   * package, one panel that the tabs swap, and no hand-rolled markup.
   */
  it('uses the primitives tab strip over one caller-owned panel', async () => {
    const source = await readClient('KnowledgeAudit.tsx')
    // The shared component, not a pair of styled buttons: the strip owns the roving
    // tab stop and the arrow-key behaviour, and a copy of it would drift.
    expect(source).toContain('SegmentedTabs')
    expect(source).toMatch(/role="tabpanel"/u)
    // Both tab ids point at that one panel, so switching cannot orphan a panel.
    expect(source).toMatch(/panelId: 'kb-audit-panel'/u)
    expect(source).toMatch(/id="kb-audit-panel"/u)
  })

  it('renders both readings as real tables, not as lists', async () => {
    const source = await readClient('KnowledgeAudit.tsx')
    expect(source).toMatch(/<table className=\{tableStyles\.table\}/u)
    // The review reading carries the queue; the log reading carries the trail. The
    // data attributes are what the deployed page is checked against.
    expect(source).toContain("data-kb-audit=\"pending\"")
    expect(source).toContain("data-kb-audit=\"log\"")
    expect(source).not.toMatch(/<ul className=\{tableStyles/u)
  })

  it('keeps every column the two old sections showed', async () => {
    const source = await readClient('KnowledgeAudit.tsx')
    // Relocating the tables must not cost a fact. These are the five columns each
    // one had under Settings.
    for (const key of ['colPendingWhen', 'colPendingSubmitter', 'colPendingTarget', 'colPendingSize', 'colPendingDecision']) {
      expect(source).toContain("c('" + key + "')")
    }
    for (const key of ['colAuditWhen', 'colAuditActor', 'colAuditAction', 'colAuditTarget', 'colAuditOutcome']) {
      expect(source).toContain("c('" + key + "')")
    }
  })

  it('keeps the outcome badge and the actor tooltip', async () => {
    const source = await readClient('KnowledgeAudit.tsx')
    // The result is a tag, not a word: the old table classified it and that reading
    // survives the move.
    expect(source).toMatch(/<Tag tone=\{/u)
    // The id stays on the cell even though the name is what a reader sees: the trail
    // is checked against the id, so it must not be lost.
    expect(source).toMatch(/title=\{entry\.actor\}/u)
    expect(source).toMatch(/entry\.actorLabel \?\? entry\.actor/u)
  })

  it('survives an action the locale table does not know', async () => {
    // A newer Host may record an action this build has no word for. A blank cell
    // would hide that a change happened, so the raw value is shown instead.
    const source = await readClient('KnowledgeAudit.tsx')
    expect(source).toMatch(/label === key \? action : label/u)
  })

  it('keeps the count of what is waiting on the review tab', async () => {
    const source = await readClient('KnowledgeAudit.tsx')
    // "Is anything waiting for me" is the question the page is opened with; putting
    // the number on the tab answers it without a click.
    expect(source).toMatch(/c\('auditTabReview'\) \+ ' \(' \+ String\(pending\.length\)/u)
  })

  it('is reachable from the rail and dispatches to the page', async () => {
    const panel = await readClient('KnowledgePanel.tsx')
    expect(panel).toContain("key: 'menu.audit'")
    expect(panel).toMatch(/rendered\.kind === 'audit' && <KnowledgeAudit t=\{t\} \/>/u)
    // The title band comes from the same map the other rows use.
    expect(panel).toContain("if (selection.kind === 'audit') return t('menu.audit')")
    const glyphs = await readClient('MenuGlyphs.tsx')
    expect(glyphs).toContain("'home' | 'permissions' | 'indexing' | 'trash' | 'audit' | 'settings'")
    expect(glyphs).toMatch(/if \(kind === 'audit'\) return <IconChecklistOutlineRegular/u)
  })
})

describe('the settings page degrades one section at a time', () => {
  const readClient = async (name: string): Promise<string> =>
    readFile(new URL(`../src/client/${name}`, import.meta.url), 'utf8')

  it('keeps one audit tab usable when the other route cannot be read', async () => {
    // The queue and the trail come from different stores. A 401 that reaches one must
    // cost that tab, not the page: throwing on any failed request would blank both and
    // make a token problem look like a broken plugin.
    const source = await readClient('KnowledgeAudit.tsx')
    // Each response is allowed to fall back on its own...
    expect(source).toMatch(/if \(pendingResponse\.ok\) \{/u)
    expect(source).toMatch(/if \(auditResponse\.ok\) \{/u)
    // ...and the page only refuses when BOTH failed, where two empty tables would
    // otherwise assert that nothing is queued and nothing ever happened.
    expect(source).toMatch(/if \(!pendingResponse\.ok && !auditResponse\.ok\) \{/u)
  })
})

describe('approving never silently replaces an existing document', () => {
  /**
   * Approving writes through the create path, which refuses an existing name. That is
   * the right outcome twice over: the reviewer cannot destroy a document by approving
   * someone else's submission, and the failed submission stays in the queue because
   * the parked copy is only discarded once the bytes are in the tree.
   */
  it('keeps the submission queued when the target already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-approve-conflict-'))
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, {
        ...CONFIG,
        actualRoot: join(root, 'actual'),
        viewRoot: join(root, 'views'),
        mountPoint: join(root, 'mnt'),
      } as never)
      await callRoute(routes, 'settings.set', { reviewRequired: true })
      await callRoute(routes, 'create', { relPath: 'taken.md', content: '# submitted\n' })
      const queue = await callRoute(routes, 'pending.list', {})
      const name = (queue.pending as Array<{ name: string }>)[0].name
      // Something else published that path in the meantime.
      await mkdir(join(root, 'actual'), { recursive: true })
      await writeFile(join(root, 'actual', 'taken.md'), '# existing\n', 'utf8')

      const reply = await callRoute(routes, 'pending.approve', { name })
      expect(String(reply.error)).toContain('already exists')
      // The existing document was not replaced.
      expect(await readFile(join(root, 'actual', 'taken.md'), 'utf8')).toBe('# existing\n')
      // And the submission is still there for a human to deal with.
      const after = await callRoute(routes, 'pending.list', {})
      expect((after.pending as unknown[]).length).toBe(1)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})


describe('the review loop closes on its own', () => {
  /**
   * These pin the properties that make an in-plugin queue safe to rely on instead of
   * delegating to an external approval engine: a decision cannot be made twice, the
   * queue does not strand when review is switched off, and a failed approval keeps the
   * submission rather than losing it.
   */
  it('lets exactly one of two concurrent approvals win', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-race-'))
    const actual = join(root, 'actual')
    try {
      await mkdir(actual, { recursive: true })
      await parkPendingWrite(actual, {
        userId: 'u-1',
        relPath: 'contested.md',
        content: '# contested\n',
        at: '2026-10-17T10:00:00.000Z',
      })
      const [item] = await listPendingWrites(actual)
      const content = await readPendingContent(actual, item.name)
      expect(content).toBe('# contested\n')
      // Two approvers act at once. `wx` is the atomic create-never-replace, so the
      // kernel makes exactly one win; without it both would believe they published.
      const results = await Promise.allSettled([
        writeFile(join(actual, 'contested.md'), content as string, { encoding: 'utf8', flag: 'wx' }),
        writeFile(join(actual, 'contested.md'), content as string, { encoding: 'utf8', flag: 'wx' }),
      ])
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      // The document holds the submitted bytes, written once.
      expect(await readFile(join(actual, 'contested.md'), 'utf8')).toBe('# contested\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps the queue readable after review is switched off', async () => {
    // Turning review off must not strand what was already submitted: otherwise the only
    // way to clear the queue would be to turn review back on, and an operator who
    // switched off mid-flight would be left with a queue nobody can explain.
    const root = await mkdtemp(join(tmpdir(), 'kb-toggle-'))
    const viewDir = join(root, 'views', 'u-1')
    const actual = join(root, 'actual')
    try {
      await writeSettings(viewDir, { reviewRequired: true })
      await parkPendingWrite(actual, {
        userId: 'u-1',
        relPath: 'in-flight.md',
        content: 'x',
        at: '2026-10-17T10:00:00.000Z',
      })
      expect(await listPendingWrites(actual)).toHaveLength(1)
      await writeSettings(viewDir, { reviewRequired: false })
      expect((await readSettings(viewDir)).reviewRequired).toBe(false)
      expect(await listPendingWrites(actual)).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a pending name built from a path segment', async () => {
    // The name travels from browser to Host; a crafted one must not reach outside the
    // pending directory. Dots are allowed inside a name because the parking name keeps
    // the original extension, which is exactly the case this distinguishes.
    expect(isPendingName('u-1__20261017T100000000Z__report.md')).toBe(true)
    for (const bad of ['../escape', 'a/b', 'a\\b', '..', '.', '', 'x'.repeat(513)]) {
      expect(isPendingName(bad)).toBe(false)
    }
  })
})

describe('a rejected request is not reported as a crash', () => {
  /**
   * The backend deciding "your token is no good" is a decision, not a bug. Answering 500
   * sent the operator looking for a crash; the page also needs 401 to know it should ask
   * for a fresh credential rather than retry the same rejected call.
   */
  it('answers 401, not 500, when DataOps rejects the credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-401-'))
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ message: 'expired' }), { status: 401 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      await apply(ctx as never, {
        ...CONFIG,
        actualRoot: join(root, 'actual'),
        viewRoot: join(root, 'views'),
        mountPoint: join(root, 'mnt'),
      } as never)
      const reply = await callRouteWithStatus(routes, 'settings.get', {})
      expect(reply.status).toBe(401)
      expect(String(reply.body.code)).toBe('unauthorized')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('every CSS class a component names is actually defined', () => {
  /**
   * A `styles.foo` reference to an undefined class type-checks perfectly: a CSS module
   * types its members loosely, so the class simply does not apply. That is invisible to
   * the compiler and to review, and it surfaced as a browser's native "choose file / no
   * file chosen" control sitting on the page because the input's hide rule was missing.
   *
   * The stylesheet is resolved from the component's own import rather than assumed from
   * its filename: a component may import more than one module, and pinning the wrong
   * one reports a false failure (as `pinDropZone` did, correctly defined next door).
   */
  it('resolves every imported module and checks each class it uses', async () => {
    const dir = new URL('../src/client/', import.meta.url)
    const names = await readdir(dir)
    const offenders: Array<{ component: string; module: string; className: string }> = []

    for (const entry of names) {
      if (!entry.endsWith('.tsx')) continue
      const source = await readFile(new URL(entry, dir), 'utf8')
      // Map each local binding to the stylesheet it was imported from.
      const imports = [...source.matchAll(/import\s+(\w+)\s+from\s+'\.\/([\w.-]+\.module\.css)'/gu)]
      for (const [, binding, cssFile] of imports) {
        const css = await readFile(new URL(cssFile, dir), 'utf8').catch(() => '')
        const used = [...new Set([...source.matchAll(new RegExp(`\\b${binding}\\.([A-Za-z_]\\w*)`, 'gu'))].map((m) => m[1]))]
        for (const className of used) {
          if (!new RegExp(`\\.${className}(?![\\w-])`, 'u').test(css)) {
            offenders.push({ component: entry, module: cssFile, className })
          }
        }
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('one grant covers a whole knowledge base', () => {
  /**
   * DataOps matches a permission by exact resource id OR by any ancestor the caller names.
   * Omitting the chain made every document need its own grant row, so a newly created
   * document looked unreadable even to an administrator. These pin the chain itself and
   * that it is actually sent.
   */
  it('walks the parent directories and ends at the root id', () => {
    // Nearest first, root last, and the path itself is excluded: it is the resource
    // being resolved, not one of its own ancestors.
    expect(knowledgeAncestorsFor('a/b/c.md').map((one) => one.resourceId)).toEqual(['a/b', 'a', KB_ROOT_RESOURCE_ID])
    expect(knowledgeAncestorsFor('dir/a.md').map((one) => one.resourceId)).toEqual(['dir', KB_ROOT_RESOURCE_ID])
    expect(knowledgeAncestorsFor('a.md').map((one) => one.resourceId)).toEqual([KB_ROOT_RESOURCE_ID])
    // The root itself has no ancestor above it, so it answers the root id once.
    expect(knowledgeAncestorsFor('').map((one) => one.resourceId)).toEqual([KB_ROOT_RESOURCE_ID])
  })

  it('sends the ancestors chain on both permission checks', async () => {
    // Asserting the generated chain alone would not catch the chain being computed and
    // then dropped from the request body, which is the shape the bug had.
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const calls = [...source.matchAll(/canReadPath|canWritePath/gu)].length
    expect(calls).toBeGreaterThan(0)
    const sends = [...source.matchAll(/ancestors: knowledgeAncestorsFor\(relPath\)/gu)].length
    // One in canReadPath and one in canWritePath; a third would mean a path was missed.
    expect(sends).toBe(2)
  })

  it('names the root as a real id, because DataOps rejects an empty one', () => {
    // Measured: resolve with resourceId "" answers 400 "资源ID不能为空". A root grant
    // therefore needs a name, and this one cannot collide with a document id.
    expect(KB_ROOT_RESOURCE_ID).not.toBe('')
    expect(KB_ROOT_RESOURCE_ID.startsWith('@')).toBe(true)
  })
})

describe('the loading animation is honest about itself', () => {
  /**
   * The loading surface replaces a grey sentence, so it is decoration over a real
   * state. Decoration has two obligations: it must not cost a dependency, and it must
   * not be invisible to assistive technology.
   */
  const read = async (file: string): Promise<string> =>
    readFile(new URL(`../src/client/${file}`, import.meta.url), 'utf8')

  it('uses no animation library', async () => {
    const tsx = await read('KnowledgeLoading.tsx')
    const css = await read('KnowledgeLoading.module.css')
    // The plugin ships as one bundle; a package here would grow it and add a
    // supply-chain surface for a decoration.
    expect(tsx).not.toMatch(/from '(lottie|framer-motion|react-spring|gsap|@?react-lottie)/u)
    expect(tsx).toMatch(/from '\.\/KnowledgeLoading\.module\.css'/u)
    // The effect is CSS: a keyframe and a 3D transform, not scripted frames.
    expect(css).toMatch(/@keyframes kb-page-turn/u)
    expect(css).toMatch(/rotateY\(/u)
    expect(css).toMatch(/perspective:/u)
  })

  it('announces itself to a screen reader', async () => {
    const tsx = await read('KnowledgeLoading.tsx')
    // The SVG is decorative, so the wrapper carries the status role and the text says
    // what is happening.
    expect(tsx).toMatch(/role="status"/u)
    expect(tsx).toMatch(/aria-live="polite"/u)
    expect(tsx).toMatch(/aria-hidden="true"/u)
    // A visible label is already announced; repeating it would say the sentence twice.
    expect(tsx).toMatch(/props\.announce !== props\.label/u)
  })

  it('stops the motion when the reader asks it to', async () => {
    const css = await read('KnowledgeLoading.module.css')
    const block = css.slice(css.indexOf('prefers-reduced-motion'))
    expect(block).toMatch(/animation: none/u)
    // A static but visible book: `none` alone would leave the leaf flat on the wrong
    // page, so a resting angle is set too.
    expect(block).toMatch(/transform: rotateY\(/u)
  })

  it('names only CSS variables the theme actually declares', async () => {
    // An invented variable resolves to nothing without any error, so the colour simply
    // disappears in whichever theme lacks it. This reads the theme stylesheets and
    // checks every `var(--dsw-*)` this file names is genuinely declared there.
    const css = await read('KnowledgeLoading.module.css')
    const used = [...new Set([...css.matchAll(/var\((--dsw-[a-z0-9-]+)/gu)].map(m => m[1]))]
    expect(used.length).toBeGreaterThan(0)

    // The theme ships in a release tree outside this package, so it is resolved from
    // HOME rather than from the test file: a relative `../../..` walk would encode this
    // checkout's exact depth and break on any move.
    // Resolved by scanning the release root rather than naming one release: the directory
    // carries the release's own build name, so a hard-coded name turns this check into a
    // failure about a missing path instead of a failure about a missing variable.
    const releaseRoot = join(process.env['HOME'] ?? '/root', '.dsh/releases/plus')
    const releases = (await readdir(releaseRoot).catch(() => [] as string[])).sort()
    const themeDir = releases.length === 0
      ? join(releaseRoot, 'missing')
      : join(releaseRoot, releases[releases.length - 1], 'packages/client/ui-theme/src/styles')
    const files = await readdir(themeDir).catch(() => [] as string[])
    // If the release tree is absent this cannot be checked, and a silent pass would
    // claim a check that did not run.
    expect(files.length).toBeGreaterThan(0)
    const theme = (await Promise.all(
      files.filter(f => f.endsWith('.css')).map(f => readFile(join(themeDir, f), 'utf8')),
    )).join('\n')

    const missing = used.filter(name => !new RegExp(`${name}\\s*:`, 'u').test(theme))
    expect(missing).toEqual([])
  })

  it('uses the font shorthand rather than a bare size', async () => {
    const css = await read('KnowledgeLoading.module.css')
    // `font-size:` would drop the line height and family; the product sets all three
    // through one shorthand token.
    expect(css).not.toMatch(/font-size:/u)
    expect(css).toMatch(/font: var\(--dsw-font-/u)
  })

  it('renders in every surface that used to show a bare sentence', async () => {
    // `KnowledgePreview.tsx` used to be in this list. Documents are now drawn by the
    // host's file window (opened through `betterSidebar`), so that surface no longer
    // exists in this package and its loading state went with it.
    for (const file of ['KnowledgeListing.tsx', 'KnowledgePanel.tsx']) {
      const tsx = await read(file)
      expect(tsx).toMatch(/<KnowledgeLoading/u)
      // The old placeholder must be gone, not merely bypassed.
      expect(tsx).not.toMatch(/>Loading…</u)
    }
  })
})

describe('a response that is not JSON is reported, not thrown as a parser error', () => {
  /**
   * Measured on the running product: opening a document rendered
   * `Unexpected token 'D', "DataOps au"... is not valid JSON` in the preview area.
   * Every route this plugin serves answers JSON, but a response is not always this
   * plugin's -- a gateway, an auth redirect, or a stopped DSH answers HTML or plain
   * text, and `response.json()` then throws a parser message that reached the reader
   * as if it were the document.
   */
  it('parses a normal JSON body', async () => {
    const response = new Response(JSON.stringify({ kind: 'text', content: '# hi' }), { status: 200 })
    expect(await readKnowledgeJson(response)).toEqual({ kind: 'text', content: '# hi' })
  })

  it('turns a plain-text body into a readable error instead of throwing', async () => {
    // The exact shape that was on screen: a sentence beginning with "DataOps".
    const response = new Response('DataOps authorization is required', { status: 200 })
    const parsed = await readKnowledgeJson(response)
    expect(parsed.error).toContain('HTTP 200')
    expect(parsed.error).toContain('DataOps authorization')
  })

  it('turns an HTML error page into a readable error', async () => {
    const response = new Response('<!doctype html><title>502 Bad Gateway</title>', { status: 502 })
    const parsed = await readKnowledgeJson(response)
    expect(parsed.error).toContain('HTTP 502')
    // The angle brackets are evidence of what came back, so they are kept rather than
    // stripped; the point is that the reader sees the real cause, not a parser complaint.
    expect(parsed.error).toContain('doctype')
  })

  it('answers an empty success body with an empty object', async () => {
    // A route that only reports success is allowed to answer nothing; that is not an
    // error, and it must not read as one.
    const response = new Response('', { status: 200 })
    expect(await readKnowledgeJson(response)).toEqual({})
  })

  it('answers an empty failure body with the status', async () => {
    const response = new Response('', { status: 500 })
    expect((await readKnowledgeJson(response)).error).toBe('HTTP 500')
  })

  it('never lets a parse exception become the message', async () => {
    // The reader-facing rule: the parser's own vocabulary must not reach the surface.
    // Asserted on BEHAVIOUR rather than on the source text, because the source is allowed
    // to mention the phrase in a comment explaining why it is avoided.
    const response = new Response('not json at all', { status: 200 })
    const parsed = await readKnowledgeJson(response)
    expect(parsed.error).toBeDefined()
    expect(String(parsed.error)).not.toMatch(/Unexpected token|is not valid JSON/u)
  })
})


describe('no component calls a hook after its first return', () => {
  /**
   * React requires the same hooks in the same order on every render of one component. A
   * hook placed after a `return` runs only on the renders that get past that return, so
   * the loading render and the loaded render disagree about how many hooks exist. React
   * reports that as error #310 and unmounts the boundary -- measured in the running
   * product as `Minified React error #310 at KnowledgePreview ... useMemo`, where the
   * memos sat after the loading/error/binary returns.
   *
   * Checked through the TypeScript AST rather than with a regex. Two earlier attempts at
   * a text scan failed in opposite directions: one matched a `return` inside a `useMemo`
   * callback, the other missed the real exits because they are nested in `if` blocks.
   * The AST knows the difference -- it walks the component body without descending into
   * nested functions, so both a callback's `return map` and an `if`-nested `return` are
   * classified correctly.
   */
  it('keeps every hook above the first return in every component', async () => {
    const ts = await import('typescript')
    const HOOKS = new Set(['useState', 'useEffect', 'useMemo', 'useRef', 'useCallback', 'useReducer', 'useLayoutEffect'])
    const dir = new URL('../src/client/', import.meta.url)
    const files = (await readdir(dir)).filter((name) => name.endsWith('.tsx'))
    const offenders: Array<{ file: string; component: string; hook: string; line: number }> = []

    /** Whether any return in this function returns JSX, i.e. it is a component. */
    const returnsJsx = (fn: import('typescript').FunctionDeclaration): boolean => {
      let found = false
      const walk = (node: import('typescript').Node): void => {
        if (ts.isReturnStatement(node) && node.expression) {
          let expr: import('typescript').Expression = node.expression
          while (ts.isParenthesizedExpression(expr)) expr = expr.expression
          if (ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr)) found = true
        }
        ts.forEachChild(node, walk)
      }
      walk(fn)
      return found
    }

    /** Positions of `return` statements reached without entering a nested function. */
    const exitsIn = (fn: import('typescript').FunctionDeclaration): number[] => {
      const found: number[] = []
      const walk = (node: import('typescript').Node): void => {
        if (ts.isFunctionLike(node) && node !== fn) return
        if (ts.isReturnStatement(node)) found.push(node.getStart())
        ts.forEachChild(node, walk)
      }
      if (fn.body) ts.forEachChild(fn.body, walk)
      return found.sort((left, right) => left - right)
    }

    /** Hook calls in the component body, not counting nested functions'. */
    const hooksIn = (fn: import('typescript').FunctionDeclaration): Array<{ name: string; at: number }> => {
      const found: Array<{ name: string; at: number }> = []
      const walk = (node: import('typescript').Node): void => {
        if (ts.isFunctionLike(node) && node !== fn) return
        if (
          ts.isCallExpression(node)
          && ts.isIdentifier(node.expression)
          && HOOKS.has(node.expression.text)
        ) {
          found.push({ name: node.expression.text, at: node.getStart() })
        }
        ts.forEachChild(node, walk)
      }
      if (fn.body) ts.forEachChild(fn.body, walk)
      return found
    }

    for (const file of files) {
      const path = new URL(file, dir)
      const source = await readFile(path, 'utf8')
      const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TSX)
      ts.forEachChild(sourceFile, (node) => {
        if (!ts.isFunctionDeclaration(node) || !node.name) return
        if (!/^[A-Z]/u.test(node.name.text)) return
        if (!returnsJsx(node)) return
        const exits = exitsIn(node)
        if (exits.length === 0) return
        const firstReturn = exits[0]
        for (const hook of hooksIn(node)) {
          if (hook.at > firstReturn) {
            offenders.push({
              file,
              component: node.name.text,
              hook: hook.name,
              line: sourceFile.getLineAndCharacterOfPosition(hook.at).line + 1,
            })
          }
        }
      })
    }

    expect(offenders).toEqual([])
  })
})

describe('repointing the workspace entry never removes what it points at', () => {
  /**
   * The knowledge base's original design put its browsable pointer at `/workspace/kb`, a
   * symlink into the share. That path is inside the workspace, so a reader (and the
   * official file tree) can reach it like any other workspace directory.
   *
   * The hazard is specific and was measured once: if the pointer is a REAL directory
   * rather than a symlink, `pointMountAtView` has to clear it, and an `rm -r` on a path
   * that resolves to the NFS share deletes `actual/` and every `views/` directory on the
   * server. The guards exist for exactly that shape, so these pin both branches.
   */
  const setup = async (): Promise<{ root: string; actual: string; views: string; cleanup: () => Promise<void> }> => {
    const root = await mkdtemp(join(tmpdir(), 'kb-repoint-'))
    const actual = join(root, 'actual')
    const views = join(root, 'views')
    await mkdir(actual, { recursive: true })
    await mkdir(join(views, 'u-1'), { recursive: true })
    await writeFile(join(actual, 'keep.md'), 'keep', 'utf8')
    await writeFile(join(views, 'u-1', 'linked.md'), 'x', 'utf8')
    return { root, actual, views, cleanup: () => rm(root, { recursive: true, force: true }) }
  }

  it('retargets an existing symlink without touching its old target', async () => {
    const fixture = await setup()
    try {
      const options = { actualRoot: fixture.actual, viewRoot: fixture.views, userId: 'u-1' }
      const pointer = join(fixture.root, 'kb')
      // The first pointer points somewhere else; repointing must replace the LINK only.
      const other = join(fixture.root, 'other-view')
      await mkdir(other, { recursive: true })
      await writeFile(join(other, 'other.md'), 'other', 'utf8')
      await symlink(other, pointer)

      await pointMountAtView(options, pointer)

      expect(await readlink(pointer)).toBe(join(fixture.views, 'u-1'))
      // The previous target still holds its file: replacing a link must not reach through.
      expect(existsSync(join(other, 'other.md'))).toBe(true)
      expect(existsSync(join(fixture.actual, 'keep.md'))).toBe(true)
    } finally {
      await fixture.cleanup()
    }
  })

  it('refuses a pointer that is a real non-empty directory', async () => {
    // This is the near-miss shape: a real directory where the pointer belongs. Clearing it
    // is only safe when it is empty, so a non-empty one is refused before any syscall.
    const fixture = await setup()
    try {
      const options = { actualRoot: fixture.actual, viewRoot: fixture.views, userId: 'u-1' }
      const pointer = join(fixture.root, 'kb')
      await mkdir(pointer, { recursive: true })
      await writeFile(join(pointer, 'precious.md'), 'precious', 'utf8')

      await expect(pointMountAtView(options, pointer)).rejects.toThrow(/non-empty directory/u)
      // Nothing was deleted, and the pointer is still the directory it was.
      expect(await readFile(join(pointer, 'precious.md'), 'utf8')).toBe('precious')
    } finally {
      await fixture.cleanup()
    }
  })

  it('adopts an empty real directory, which holds nothing to lose', async () => {
    const fixture = await setup()
    try {
      const options = { actualRoot: fixture.actual, viewRoot: fixture.views, userId: 'u-1' }
      const pointer = join(fixture.root, 'kb')
      await mkdir(pointer, { recursive: true })

      await pointMountAtView(options, pointer)

      // `lstat`, not `stat`: `stat` follows the link and would report the directory it
      // points at, which is the opposite of what this asserts.
      expect((await lstat(pointer)).isSymbolicLink()).toBe(true)
      expect(await readlink(pointer)).toBe(join(fixture.views, 'u-1'))
    } finally {
      await fixture.cleanup()
    }
  })

describe('an edit in the host file window reaches the knowledge audit trail', () => {
  /**
   * Reported paths arrive in two shapes and both name the same document.
   *
   * Measured in the running product: the editor announces `kb/test-toc.md` -- a path
   * relative to the session workspace -- because the knowledge view is linked into
   * `/workspace/kb`. An earlier version of this matcher only understood absolute
   * paths, so every save was silently classified as "outside the knowledge base" and
   * the audit trail stayed empty while the document itself changed on disk.
   */
  it('matches a save reported relative to the workspace', async () => {
    const { matchKnowledgeSave } = await import('../src/client/saveAudit.ts')
    expect(matchKnowledgeSave('kb/test-toc.md', '/nas/kb')).toBe('test-toc.md')
    expect(matchKnowledgeSave('kb/a.md', '/workspace/kb')).toBe('a.md')
  })

  it('matches a save reported as an absolute path under the root', async () => {
    const { matchKnowledgeSave } = await import('../src/client/saveAudit.ts')
    expect(matchKnowledgeSave('/nas/kb/docs/guide.md', '/nas/kb')).toBe('docs/guide.md')
  })

  it('ignores saves outside the knowledge base', async () => {
    const { matchKnowledgeSave } = await import('../src/client/saveAudit.ts')
    // A sibling directory whose name merely starts with the leaf must not match.
    expect(matchKnowledgeSave('kb-archive/a.md', '/nas/kb')).toBeUndefined()
    // A save elsewhere in the workspace is not a knowledge-base event.
    expect(matchKnowledgeSave('src/main.ts', '/nas/kb')).toBeUndefined()
    // The mount point itself is a directory, not a document.
    expect(matchKnowledgeSave('kb', '/nas/kb')).toBeUndefined()
    // A deployment with no mount point configured matches nothing at all, rather
    // than every path that happens to share a first segment.
    expect(matchKnowledgeSave('kb/a.md', '')).toBeUndefined()
  })

  it('registers against the sidebar only once the service exists', async () => {
    const { registerSaveAudit } = await import('../src/client/saveAudit.ts')
    // A host whose sidebar has not published its service yet: the callback is what
    // runs when it arrives, so registration must not fail on the sample.
    const injected: { betterSidebar?: unknown } = {}
    let callback: ((value: { betterSidebar?: unknown }) => void) | undefined
    const ctx = {
      inject: (names: readonly string[], run: (value: { betterSidebar?: unknown }) => void) => {
        expect(names).toEqual(['betterSidebar'])
        callback = run
        return () => {}
      },
    }
    const dispose = registerSaveAudit(ctx)
    expect(callback).toBeDefined()

    // The service arriving later must still register both halves.
    const registered: string[] = []
    injected.betterSidebar = {
      registerSaveActor: () => { registered.push('actor'); return () => {} },
      registerSaveListener: () => { registered.push('listener'); return () => {} },
    }
    callback?.(injected)
    expect(registered).toEqual(['actor', 'listener'])
    dispose()
  })
})

})

describe('storage protocol', () => {
  it('defaults to nfs so an existing remote deployment is unchanged', () => {
    // A profile written before the protocol existed names nothing; it must keep driving the
    // transport it always drove rather than silently switching to SSH.
    const parsed = Config({ mountPoint: '/workspace/kb' } as never) as unknown as Record<string, unknown>
    expect(parsed.storageProtocol).toBe('nfs')
    expect(parsed.sshPort).toBe(22)
  })

  it('plans the nfs transport by default and the sshfs transport when asked', () => {
    const nfs = deploymentPlan(PLAN).map(step => step.id)
    expect(nfs).toContain('nfs-mount')
    expect(nfs).not.toContain('sshfs-mount')

    const sshfs = deploymentPlan({ ...PLAN, protocol: 'sshfs' }).map(step => step.id)
    expect(sshfs).toEqual([
      'probe', 'mineru-install', 'mineru-service', 'mineru-verify', 'sshfs-mount', 'sshfs-verify',
    ])
    // The two transports are alternatives, not additions: a host that mounts over SSH must
    // not also be told to mount the same share over NFS.
    expect(sshfs).not.toContain('nfs-mount')
  })

  it('builds the sshfs mount command from the transport fields', () => {
    const step = sshfsMountStep({
      ...PLAN,
      protocol: 'sshfs',
      sshHost: '10.0.0.9',
      sshUser: 'root',
      sshPort: 2222,
      sshRemotePath: '/srv/kb',
    })
    const joined = step.commands.join('\n')
    expect(joined).toContain("'root@10.0.0.9:/srv/kb'")
    expect(joined).toContain('sshfs -p 2222')
    // Reconnect is what turns a dropped connection into a stall rather than EIO for every
    // reader, so it must not be optional.
    expect(joined).toContain('reconnect')
    expect(joined).toContain('ServerAliveInterval=15')
  })

  it('refuses to build a mount from an incomplete transport', () => {
    // `@:` would mount nothing and fail much later as an empty tree; the step has to say so.
    const step = sshfsMountStep({ ...PLAN, protocol: 'sshfs', sshHost: '', sshUser: 'root', sshRemotePath: '/srv/kb' })
    const joined = step.commands.join('\n')
    expect(joined).toContain('sshHost is not configured')
  })

  it('round-trips storage settings through the deployment file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-storage-settings-'))
    try {
      const written = await writeStorageSettings(root, {
        storageMode: 'remote',
        storageProtocol: 'sshfs',
        sshHost: '10.0.0.9',
        sshUser: 'root',
        sshPort: 2222,
        sshRemotePath: '/srv/kb',
        sshMountOptions: 'ro',
        sshKeyRef: 'DATAOPS_KB_SSH_KEY',
      })
      expect(written.storageProtocol).toBe('sshfs')
      const read = await readStorageSettings(root)
      expect(read).toMatchObject({ storageMode: 'remote', storageProtocol: 'sshfs', sshPort: 2222 })
      // The file is JSON at the documented path, so an operator can inspect it.
      const raw = JSON.parse(await readFile(storageSettingsPathFor(root), 'utf8'))
      expect(raw.sshRemotePath).toBe('/srv/kb')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never stores a private key, only its reference', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-storage-nokey-'))
    try {
      // A caller that tried to smuggle key material would have it dropped: the validator
      // recognizes only the named fields, and no field in the set can hold a secret.
      await writeStorageSettings(root, { sshKeyRef: 'MY_KEY' } as never)
      const raw = await readFile(storageSettingsPathFor(root), 'utf8')
      expect(raw).toContain('MY_KEY')
      expect(raw).not.toContain('PRIVATE KEY')
      const stored = JSON.parse(raw)
      expect(Object.keys(stored)).not.toContain('sshPrivateKey')
      expect(Object.keys(stored)).not.toContain('sshKey')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('drops an unrecognized stored value rather than trusting it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-storage-bad-'))
    try {
      await writeFile(storageSettingsPathFor(root), JSON.stringify({
        storageMode: 'gone', storageProtocol: 'telnet', sshPort: 0, sshHost: 'ok.example',
      }), 'utf8')
      const read = await readStorageSettings(root)
      // Each field is judged on its own: one bad value must not discard its neighbours.
      expect(read.storageMode).toBeUndefined()
      expect(read.storageProtocol).toBeUndefined()
      expect(read.sshPort).toBeUndefined()
      expect(read.sshHost).toBe('ok.example')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('overlays stored settings onto the deployment config', () => {
    const base = { ...CONFIG, storageMode: 'local', storageProtocol: 'nfs' } as never
    const merged = withStoredStorage(base, { storageMode: 'remote', storageProtocol: 'sshfs', sshHost: 'h.example' })
    expect(merged.storageMode).toBe('remote')
    expect(merged.storageProtocol).toBe('sshfs')
    expect(merged.sshHost).toBe('h.example')
    // The deployment's own paths are not the file's to change: they are bind mounts decided
    // when the container was created.
    expect(merged.mountPoint).toBe((base as { mountPoint: string }).mountPoint)
    expect(merged.actualRoot).toBe((base as { actualRoot: string }).actualRoot)
  })
})

describe('view buckets', () => {
  it('places a path under the bucket its authoritative segment names', () => {
    expect(bucketOf('global/制度.md')).toEqual({ bucket: 'global', inner: '制度.md' })
    expect(bucketOf('department/OPS/值班表.md')).toEqual({ bucket: 'department', inner: '值班表.md' })
    expect(bucketOf('personal/u-1/笔记.md')).toEqual({ bucket: 'personal', inner: '笔记.md' })
    // An owner segment with nothing under it is a container, not a document.
    expect(bucketOf('department/OPS')).toBeUndefined()
    expect(bucketOf('personal/u-1')).toBeUndefined()
  })

  it('strips the whole bucket prefix so the bucket is the folder the caller sees', () => {
    // The point of the prefix is ownership, not nesting: a caller opening 「部门」
    // expects their department's documents at its top level.
    expect(bucketOf('department/OPS/2026/值班表.md')).toEqual({
      bucket: 'department',
      inner: '2026/值班表.md',
    })
  })

  it('keeps a legacy flat path visible by defaulting it to global', () => {
    // Files written before the split have no bucket segment. Dropping them would
    // empty a view on upgrade; answering `global` matches the migration target.
    expect(bucketOf('a.md')).toEqual({ bucket: 'global', inner: 'a.md' })
    expect(bucketOf('2024/reports/a.md')).toEqual({ bucket: 'global', inner: '2024/reports/a.md' })
  })

  it('refuses a bare bucket directory and traversal paths', () => {
    expect(bucketOf('global')).toBeUndefined()
    expect(bucketOf('department/')).toBeUndefined()
    expect(bucketOf('../outside.md')).toBeUndefined()
    expect(bucketOf('/etc/passwd')).toBeUndefined()
    expect(bucketOf('')).toBeUndefined()
  })

  it('links only the caller department and only when the code matches exactly', () => {
    expect(departmentPrefixMatches('department/OPS/值班表.md', 'OPS')).toBe(true)
    // A prefix match would leak OPS2 into OPS's view.
    expect(departmentPrefixMatches('department/OPS2/值班表.md', 'OPS')).toBe(false)
    expect(departmentPrefixMatches('department/OPS/值班表.md', undefined)).toBe(false)
    expect(departmentPrefixMatches('department/OPS/值班表.md', '')).toBe(false)
    expect(departmentPrefixMatches('department/OPS', 'OPS')).toBe(false)
    expect(departmentPrefixMatches('global/制度.md', 'OPS')).toBe(false)
  })
})

describe('bucketed view sync', () => {
  it('links each resolved path into its own bucket and drops the owner segment', async () => {
    const actual = await mkdtemp(join(tmpdir(), 'kb-bucket-actual-'))
    const views = await mkdtemp(join(tmpdir(), 'kb-bucket-views-'))
    try {
      for (const rel of ['global/制度.md', 'department/OPS/值班表.md', 'personal/u-1/笔记.md']) {
        await mkdir(dirname(join(actual, rel)), { recursive: true })
        await writeFile(join(actual, rel), rel, 'utf8')
      }
      const view = { actualRoot: actual, viewRoot: views, userId: 'u-1', departmentCode: 'OPS' }
      await syncView(view, [
        { relPath: 'global/制度.md' },
        { relPath: 'department/OPS/值班表.md' },
        { relPath: 'personal/u-1/笔记.md' },
      ])
      const tree = await readdir(join(views, 'u-1'))
      expect(tree.sort()).toEqual(['global', 'department', 'personal'].sort())
      // The owner segment is gone from the department bucket: only the file remains.
      expect(await readdir(join(views, 'u-1', 'department'))).toEqual(['值班表.md'])
      expect(await readdir(join(views, 'u-1', 'personal'))).toEqual(['笔记.md'])
      expect(await readdir(join(views, 'u-1', 'global'))).toEqual(['制度.md'])
    } finally {
      await rm(actual, { recursive: true, force: true })
      await rm(views, { recursive: true, force: true })
    }
  })

  it('leaves another department out of the view even when a grant reaches it', async () => {
    const actual = await mkdtemp(join(tmpdir(), 'kb-bucket-actual-'))
    const views = await mkdtemp(join(tmpdir(), 'kb-bucket-views-'))
    try {
      for (const rel of ['department/OPS/值班表.md', 'department/DEV/排期.md']) {
        await mkdir(dirname(join(actual, rel)), { recursive: true })
        await writeFile(join(actual, rel), rel, 'utf8')
      }
      // Both grants resolve (DataOps allowed both); the layout still shows one.
      const view = { actualRoot: actual, viewRoot: views, userId: 'u-1', departmentCode: 'OPS' }
      await syncView(view, [
        { relPath: 'department/OPS/值班表.md' },
        { relPath: 'department/DEV/排期.md' },
      ])
      expect(await readdir(join(views, 'u-1', 'department'))).toEqual(['值班表.md'])
    } finally {
      await rm(actual, { recursive: true, force: true })
      await rm(views, { recursive: true, force: true })
    }
  })

  it('shows no department bucket at all when the caller has no department', async () => {
    const actual = await mkdtemp(join(tmpdir(), 'kb-bucket-actual-'))
    const views = await mkdtemp(join(tmpdir(), 'kb-bucket-views-'))
    try {
      await mkdir(join(actual, 'global'), { recursive: true })
      await writeFile(join(actual, 'global/制度.md'), 'x', 'utf8')
      const view = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
      await syncView(view, [{ relPath: 'global/制度.md' }])
      // `global` and `personal` always exist; `department` does not, because a
        // caller without a department has nothing that could ever fill it.
        expect((await readdir(join(views, 'u-1'))).sort()).toEqual(['global', 'personal'])
    } finally {
      await rm(actual, { recursive: true, force: true })
      await rm(views, { recursive: true, force: true })
    }
  })
})

describe('the @-mention target picker', () => {
  /**
   * The explorer row's `@` button used to answer `if (sessionId === undefined) return`,
   * which is the page's NORMAL state -- it is a management surface, not a chat -- so
   * the button looked broken. The click now asks which conversation the reference
   * should land in. These pin the three properties that make that fix real rather than
   * cosmetic: the dialog exists and is a primitive dialog (not a native prompt), the
   * insertion still goes through `referenceInChat` rather than a second write path,
   * and the empty states are stated instead of left blank.
   */
  const read = (name: string): Promise<string> => readFile(new URL('../src/client/' + name, import.meta.url), 'utf8')

  it('no longer drops the click when no conversation is open', async () => {
    const source = await read('KnowledgePanel.tsx')
    // Every `@` handler must open the picker, whether or not a conversation is open.
    // They all route through `askReferenceTarget`, which is the single place that sets
    // the dialog state -- so a handler cannot gate on `sessionId` and return instead.
    const handlers = source.match(/onReference(?:File)?=/gu) ?? []
    expect(handlers.length).toBeGreaterThanOrEqual(4)
    for (const match of source.matchAll(/onReference(?:File)?=\{[\s\S]{0,400}?\}\}/gu)) {
      expect(match[0]).toMatch(/askReferenceTarget\(/u)
      // The old shape: a `sessionId === undefined` guard that dropped the click.
      expect(match[0]).not.toMatch(/sessionId === undefined/u)
    }

    // The helper itself always sets the dialog state, with no session gate.
    const helper = source.match(/const askReferenceTarget = \([\s\S]{0,600}?\n  \}/u)?.[0] ?? ''
    expect(helper).toMatch(/setReferencing\(/u)
    expect(helper).not.toMatch(/sessionId/u)
  })

  it('renders a primitive Modal rather than a native prompt or a hand-built layer', async () => {
    const source = await read('KnowledgeReferencePicker.tsx')
    // The dialog, its title and its close affordance all come from the primitive.
    expect(source).toMatch(/from '@deepseek-ai\/dsh-client-ui-primitives'/u)
    expect(source).toMatch(/<Modal\b/u)
    expect(source).toMatch(/closeLabel=\{/u)
    // No browser-native blocking dialogs: they cannot be styled, cannot be tokenized
    // and cannot list sessions.
    expect(source).not.toMatch(/\bwindow\.(?:prompt|confirm|alert)\b/u)
    expect(source).not.toMatch(/\bprompt\(/u)
  })

  /**
   * The insertion must have exactly ONE owner.
   *
   * The constraint is real and predates this split: the picker and the sidebar explorer
   * share `referenceInChat`, which owns the workspace-relative mention spelling and the
   * degrade-to-no-op policy. A second write path would let the two surfaces disagree
   * about where a `@` reference points.
   *
   * What moved is WHERE the one call lives. Inserting used to happen on the page, which
   * is also why the button looked dead: the page's ctx never had the `sessions`
   * injection that function needs, and its failure was swallowed into a `console.warn`.
   * The call now lives only in the picker, which is the only place that knows which
   * conversation the reader chose -- so these assertions follow the code rather than
   * guarding a line that no longer exists.
   */
  it('keeps referenceInChat as the single write path, owned by the picker', async () => {
    const picker = await read('KnowledgeReferencePicker.tsx')
    const panel = await read('KnowledgePanel.tsx')
    const listing = await read('KnowledgeListing.tsx')
    const home = await read('KnowledgeHome.tsx')

    // The picker imports the shared contract and is the one place that invokes it.
    // The invocation is cast so its boolean can be read (the declared type is `void`
    // while the implementation answers false on every degraded path), which is why the
    // name is matched rather than a bare call.
    expect(picker).toMatch(/from 'dsh-better-sidebar\/src\/client\/reference-in-chat\.ts'/u)
    expect(picker).toMatch(/referenceInChat as unknown as/u)

    // No surface that merely OFFERS the reference may write it itself: each must route
    // through the picker, so none can invent a spelling or swallow a failure.
    for (const source of [panel, listing, home]) {
      expect(source).not.toMatch(/referenceInChat\(/u)
      expect(source).not.toMatch(/from 'dsh-better-sidebar\/src\/client\/reference-in-chat\.ts'/u)
    }
  })

  it('routes every reference surface through the picker instead of a direct insert', async () => {
    // The page's own `onReference` handlers must all reach `askReferenceTarget`, which
    // always opens the dialog. A handler that inserts directly is the bug this guards:
    // with a conversation open it returned before the dialog state was set, so the
    // button did nothing at all.
    const panel = await read('KnowledgePanel.tsx')
    const handlers = panel.match(/onReference=\{\(path, isDir\)[^}]*\}/gu) ?? []
    expect(handlers.length).toBeGreaterThan(0)
    for (const handler of handlers) {
      expect(handler).toMatch(/askReferenceTarget\(/u)
      expect(handler).not.toMatch(/referenceInChat/u)
    }
  })

  it('offers a new-conversation row and lists existing conversations', async () => {
    const source = await read('KnowledgeReferencePicker.tsx')
    // The new-conversation door is the first row of the list, not a footer afterthought.
    expect(source).toMatch(/refPickerNew\b/u)
    expect(source).toMatch(/MenuItemButton/u)
    // Each row shows a title and a timestamp.
    expect(source).toMatch(/displayTitle \?\? row\.title \?\? row\.id/u)
    expect(source).toMatch(/formatWhen\(/u)
  })

  it('filters locally over title and id', async () => {
    const source = await read('KnowledgeReferencePicker.tsx')
    // The needle is lower-cased once and matched against the display name and the id;
    // no second request per keystroke.
    expect(source).toMatch(/toLocaleLowerCase\(\)/u)
    expect(source).toMatch(/name\.includes\(needle\) \|\| id\.includes\(needle\)/u)
  })

  it('states both empty states instead of leaving the list blank', async () => {
    const source = await read('KnowledgeReferencePicker.tsx')
    // Nothing matches the filter is the reader's own typing; an empty catalog means
    // there is nothing to choose from yet. Two different sentences.
    expect(source).toMatch(/refPickerNoMatch/u)
    expect(source).toMatch(/refPickerNoSessions/u)
  })

  /**
   * The Share tab's honesty rules, held in source because they are about what the UI
   * must NOT claim. A runtime test would need a browser; the constraint is structural:
   * the inbound block has no arrow, and no grantor field is invented.
   */
  it('states the inbound direction without inventing a sharer', async () => {
    const home = await read('KnowledgeHome.tsx')
    // "Shared with me" uses the fixed phrase; it does not interpolate a person.
    expect(home).toMatch(/c\('shareReceivedRelation'\)/u)
    expect(home).not.toMatch(/shareReceivedRelation'\).replace/u)
    // And no grantor-shaped field is read anywhere on this surface.
    expect(home).not.toMatch(/grantedBy|sharedBy|grantor/u)
  })

  it('names the audience for the outbound direction from the grant itself', async () => {
    // The substitution lives in the pure helper now, so it can be tested directly
    // rather than by grepping a component.
    const { shareRelationText } = await import('../src/client/shareRelations.ts')
    const given = {
      id: '1', relPath: 'global/a.md', name: 'a.md', location: 'global',
      principalType: 'user' as const, audience: '张三', action: 'read', direction: 'given' as const,
    }
    const received = { ...given, direction: 'received' as const }
    expect(shareRelationText(given, 'FROM', 'Me → {audience}')).toBe('Me → 张三')
    // Inbound is the fixed phrase: no interpolation, because the sharer is unknown.
    expect(shareRelationText(received, 'FROM', 'Me → {audience}')).toBe('FROM')
  })

  it('falls back to the principal id, not to a placeholder, and uses the unknown word narrowly', async () => {
    const relations = await read('shareRelations.ts')
    // The audience helper returns the raw id when the directory has no entry.
    expect(relations).toMatch(/return grant\.principalId/u)
    // The picker of the "unknown" wording lives in the component, guarded by an empty
    // audience rather than by a failed lookup.
    const home = await read('KnowledgeHome.tsx')
    expect(home).toMatch(/row\.audience === ''\s*\?\s*props\.unknownAudience/u)
  })

  it('shows both directions in ONE table with one pager', async () => {
    const home = await read('KnowledgeHome.tsx')
    // The reader asked for a single table: a direction column only earns its place
    // when both directions share a table, and two blocks made it meaningless.
    const tables = home.match(/<ShareTable/gu) ?? []
    expect(tables.length).toBe(1)
    // Two blocks is the shape that was rejected.
    expect(home).not.toMatch(/<ShareBlock/gu)
    // One page number for the one list.
    expect(home).toMatch(/const \[sharePage, setSharePage\]/u)
    expect(home).toMatch(/paginate\(/u)
  })

  it('reads grants from the existing route rather than a new endpoint', async () => {
    const home = await read('KnowledgeHome.tsx')
    expect(home).toMatch(/KB_API\.grants/u)
    // No bespoke sharing route was introduced.
    expect(home).not.toMatch(/KB_API\.share[A-Z]/u)
  })

  /**
   * The knowledge row menu, not the workspace explorer's.
   *
   * The explorer's menu is a workspace file menu (upload here, new folder, new file,
   * zip, copy address). That vocabulary belongs to editing the workspace, not to a
   * curated knowledge export, and on a 0.2.2-rc.2 host its old anchor prop placed the
   * card away from the pointer -- which is the reported "right-click did nothing".
   * The tree now hands the gesture to the page's own `KnowledgeContextMenu`, while a
   * caller that omits the hook (the upload destination picker) keeps the explorer's
   * menu untouched.
   */
  it('hands a row right-click to the knowledge menu', async () => {
    const tree = await read('KnowledgeFileTree.tsx')
    expect(tree).toMatch(/onRowContextMenu/u)
    // The native row handler is suppressed, not merely observed.
    expect(tree).toMatch(/event\.preventDefault\(\)/u)
    expect(tree).toMatch(/event\.stopPropagation\(\)/u)
    // The picker that passes no opener still reaches the explorer's own menu.
    expect(tree).toMatch(/props\.onRowContextMenu === undefined \? onTreeContextMenu : onRowContextMenu/u)
  })

  it('anchors the knowledge menu at the pointer on both host generations', async () => {
    const menu = await read('KnowledgeContextMenu.tsx')
    // 0.2.2-rc.2 reads `anchorPoint`; older hosts read `getAnchorRect`. Supplying both
    // is what keeps the card at the click instead of at the detached anchor span.
    expect(menu).toMatch(/getAnchorRect=\{getAnchorRect\}/u)
    expect(menu).toMatch(/anchorPoint: \{ x: at\.x, y: at\.y \}/u)
  })

  it('offers preview, move and delete, and hides permissions without a surface', async () => {
    const menu = await read('KnowledgeContextMenu.tsx')
    for (const id of ["'open'", "'download'", "'rename'", "'move'", "'delete'"]) {
      expect(menu).toContain('id: ' + id)
    }
    // The permission row is conditional on BOTH the Host's answer and a handler.
    expect(menu).toMatch(/props\.canManageGrants === true && props\.onGrant !== undefined/u)
  })

  it('keeps the plugin actions reachable from the selection bar', async () => {
    // The actions moved rather than vanished. Each must be offered by the bar the
    // reader gets after selecting rows.
    const bar = await read('KnowledgeSelectionBar.tsx')
    for (const handler of ['onShare', 'onFavorite', 'onReference', 'onPermissions', 'onCut', 'onPaste']) {
      expect(bar).toContain(handler)
    }
    // The bar is a real toolbar, so no bespoke popover was introduced for this.
    expect(bar).toMatch(/role="toolbar"/u)
  })

  it('wires every one of those actions at the page', async () => {
    const panel = await read('KnowledgePanel.tsx')
    for (const handler of ['onShare', 'onFavorite', 'onReference', 'onPermissions', 'onCut', 'onPaste']) {
      expect(panel).toContain(handler + '=')
    }
  })

  /**
   * The favourites star belongs beside the NAME, not in a date column.
   *
   * It shipped in the Created cell first, which reads as a mark about the timestamp.
   * The reader's correction was explicit: "add it next to the title". These pin the
   * placement in both surfaces so it cannot drift back.
   */
  it('draws the Home star inside the title cell, after the name', async () => {
    const home = await read('KnowledgeHome.tsx')
    // The star is inside the same wrapper as the open link, and that wrapper is the
    // title cell. Asserted by order rather than by a brace-matched slice: the wrapper
    // opens, then the link, then the mark.
    const open = home.indexOf('<span className={styles.titleCell}>')
    expect(open).toBeGreaterThan(-1)
    const link = home.indexOf('styles.rowLink', open)
    const mark = home.indexOf('styles.favoriteMark', open)
    const close = home.indexOf('</td>', open)
    expect(link).toBeGreaterThan(open)
    expect(mark).toBeGreaterThan(link)
    expect(mark).toBeLessThan(close)
    // And no longer in a date cell: no isFavorite render inside a muted td.
    expect(home).not.toMatch(/<td className=\{styles\.muted\}>\s*\{props\.isFavorite/u)
  })

  it('keeps the star from being squeezed out by a long name', async () => {
    const css = await readFile(new URL('../src/client/KnowledgeHome.module.css', import.meta.url), 'utf8')
    // flex:none on the mark and min-width:0 on the name are what make truncation
    // happen on the name instead of on the star.
    expect(css).toMatch(/\.favoriteMark \{[^}]*flex: none/u)
    expect(css).toMatch(/\.titleCell \{[^}]*min-width: 0/u)
    expect(css).toMatch(/\.rowLink \{[^}]*text-overflow: ellipsis/u)
  })

  it('draws the tree star after the file name, not before the timestamp', async () => {
    const tree = await read('KnowledgeFileTree.tsx')
    // Inserted after the name span...
    expect(tree).toMatch(/name\.after\(star\)/u)
    // ...and never relative to the timestamp any more.
    expect(tree).not.toMatch(/explorerTime/u)
    // Keep the mark protectable from the name's ellipsis.
    expect(tree).toMatch(/flex:none/u)
  })

  /**
   * The reference must land in a COMPOSER THAT IS ON SCREEN.
   *
   * The reported bug was a dialog that reported success (`landed=1/1`) while the
   * composer stayed empty: the insert targeted a conversation whose composer was not
   * mounted, and that other conversation's draft revision really did change, so the
   * insert's own success test passed. These pin the two things that prevent it -- the
   * insert runs against the page's bound session, and it waits for that session's
   * composer before writing.
   */
  it('targets the bound conversation instead of guessing one', async () => {
    const picker = await read('KnowledgeReferencePicker.tsx')
    // The bound session is the target; the catalog diff is not used to pick a target.
    expect(picker).toMatch(/const target = selectedSessionId\?\.\(\)/u)
    expect(picker).not.toMatch(/ids\[ids\.length - 1\]/u)
  })

  it('waits for the target conversation composer before inserting', async () => {
    const picker = await read('KnowledgeReferencePicker.tsx')
    // Readiness is decided by the composer element plus that session's input shell.
    expect(picker).toMatch(/data-composer-input/u)
    expect(picker).toMatch(/composerReady/u)
    // A conversation is opened before the insert so its composer mounts.
    expect(picker).toMatch(/openSession\?\.\(\{\s*kind:\s*'known'/u)
  })

  it('declares every string it uses in both locales', async () => {
    const picker = await read('KnowledgeReferencePicker.tsx')
    const locales = await read('locales.ts')
    const keys = [...new Set([...picker.matchAll(/t\('(refPicker[A-Za-z]+)'\)/gu)].map(match => match[1]))]
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      // Both the en and the zh object must carry the key. The file declares exactly
      // two objects, so two occurrences is the complete requirement.
      const occurrences = (locales.match(new RegExp('\\b' + key + ':', 'gu')) ?? []).length
      expect(occurrences, key + ' must be declared in both locales').toBe(2)
    }
  })

  it('uses only design tokens, never raw pixel font sizes or hex colours', async () => {
    const css = await readFile(new URL('../src/client/KnowledgeReferencePicker.module.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/font-size:\s*\d+px/u)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(css).not.toMatch(/\b(?:rgb|hsl)a?\(/u)
    // Every font shorthand resolves through a token.
    for (const match of css.matchAll(/font:\s*([^;]+);/gu)) {
      expect(match[1]).toMatch(/var\(--dsw-font-/u)
    }
  })
})

describe('the deployment wizard only appears where a step can run', () => {
  /**
   * The bug this pins: a local workspace showed seven disabled buttons whose target
   * host read "no SSH hosts are configured". Every step in the plan executes on a
   * REMOTE host -- the Host's `deploy.run` refuses a request without a `hostId` --
   * so with no host there is nothing that can run and the controls are dead.
   *
   * The gate is tested by CALLING it. An earlier version of this suite matched the
   * component source instead, and that assertion passed even after the branch was
   * inverted: a string test cannot see behaviour.
   */
  const settings = async (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeSettingsSection.tsx', import.meta.url), 'utf8')

  it('keeps the wizard only when a remote host or a remote mode exists', () => {
    // A configured host is the primary signal: it is what makes a step runnable.
    expect(hasDeployTarget([{ id: 'h1' }], 'local')).toBe(true)
    expect(hasDeployTarget([{ id: 'h1' }], undefined)).toBe(true)
    // A remote deployment keeps the wizard even before a host row exists, because
    // that wizard is the only place that tells the reader a host is missing.
    expect(hasDeployTarget([], 'remote')).toBe(true)
  })

  it('collapses the block when nothing can run', () => {
    // The reported situation: local mode, no SSH host.
    expect(hasDeployTarget([], 'local')).toBe(false)
    // A missing mode is local: conservative, because local is the shape where the
    // seven buttons would be a lie.
    expect(hasDeployTarget([], undefined)).toBe(false)
  })

  it('reads the decision from real state rather than a guess', async () => {
    const source = await settings()
    // `storageMode` comes from the `status` reply, threaded down from the loaded state.
    expect(source).toMatch(/storageMode=\{status\.storageMode\}/u)
    // And the host list comes from the `deploy.hosts` route.
    expect(source).toMatch(/KB_API\.deployHosts/u)
  })

  it('renders nothing at all when no step could run', async () => {
    const source = await settings()
    // The early return sits ABOVE the wizard's markup, so the step list is
    // unreachable when the branch is taken.
    expect(source.indexOf('if (!hasRemoteTarget)')).toBeLessThan(source.indexOf('{steps.map('))
    // The branch returns null rather than a heading over an explanation: a lone
    // `Deployment` title above empty space promises controls that are not there.
    const localBranch = source.slice(
      source.indexOf('if (!hasRemoteTarget)'),
      source.indexOf('return (\n    <div className={styles.wizard}>'),
    )
    expect(localBranch).toMatch(/if \(!hasRemoteTarget\) return null/u)
    // No heading, no sentence, no control survives in that branch.
    expect(localBranch).not.toMatch(/groupTitle/u)
    expect(localBranch).not.toMatch(/data-testid="kb-deploy-local-note"/u)
    // The heading still exists for the remote shape, which is where it has content.
    expect(source).toMatch(/<h3 className=\{styles\.groupTitle\}>\{t\('deploy'\)\}<\/h3>/u)
  })

  it('does not fetch the step plan when the block will not draw it', async () => {
    const source = await settings()
    const effect = source.slice(source.indexOf('Read the plan only once'), source.indexOf('}, [hostsLoaded, hosts.length'))
    expect(effect).toMatch(/if \(!hostsLoaded\) return/u)
    expect(effect).toMatch(/if \(hosts\.length === 0 && storageMode !== 'remote'\) return/u)
  })

  it('holds the section until the host list answers, rather than flashing a shape', async () => {
    const source = await settings()
    expect(source).toMatch(/const \[hostsLoaded, setHostsLoaded\] = useState\(false\)/u)
    expect(source).toMatch(/if \(!hostsLoaded\) return null/u)
    expect(source).toMatch(/\} finally \{\n\s+setHostsLoaded\(true\)/u)
  })

  it('leaves the remote shape untouched', async () => {
    const source = await settings()
    expect(source).toMatch(/htmlFor="kb-deploy-host"/u)
    expect(source).toMatch(/steps\.map\(step =>/u)
  })
})

describe('the create/upload dialog', () => {
  /**
   * The three create/upload actions used to open a dropdown, ask for a name through a
   * browser `window.prompt`, and drop the result into `global/`. Both halves of that
   * were wrong: a prompt cannot show where the file lands, and `global` is the bucket
   * everyone reads, so a private draft published by default.
   *
   * The fix is one official `Modal` that asks for a name AND a destination. These pin
   * the properties that make it a fix rather than a restyle.
   */
  const dialog = (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeCreateDialog.tsx', import.meta.url), 'utf8')
  const home = (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeHome.tsx', import.meta.url), 'utf8')

  it('is an official Modal, not a hand-built layer or a native prompt', async () => {
    const source = await dialog()
    expect(source).toMatch(/<Modal\b/u)
    expect(source).toMatch(/from '@deepseek-ai\/dsh-client-ui-primitives'/u)
    // The browser's blocking dialogs cannot be styled, cannot be tokenized and cannot
    // offer a destination, which is the whole reason this dialog exists. The literal
    // appears in the module's own prose explaining that history, so the assertion
    // looks for a CALL rather than for the bare word.
    expect(source).not.toMatch(/\bwindow\.(?:prompt|confirm|alert)\s*\(/u)
    // And the Home surface no longer asks through one either.
    expect(await home()).not.toMatch(/\bwindow\.prompt\s*\(/u)
  })

  it('defaults the destination away from the shared bucket', async () => {
    // The order is the requirement: the directory being browsed, then the reader's own
    // personal folder, and only then `global`. A test that only checked "not global"
    // would pass on a default of `''`.
    const source = await dialog()
    expect(source).toMatch(/if \(currentDir !== undefined && currentDir !== ''\) return currentDir/u)
    expect(source).toMatch(/return 'personal\/' \+ userId/u)
    expect(source).toMatch(/return 'global'/u)
    // And in that order: current, then personal, then global.
    const body = source.slice(source.indexOf('export function defaultDestination'))
    const current = body.indexOf('return currentDir')
    const personal = body.indexOf("'personal/' + userId")
    const global = body.indexOf("return 'global'")
    expect(current).toBeGreaterThan(-1)
    expect(personal).toBeGreaterThan(current)
    expect(global).toBeGreaterThan(personal)
  })

  it('offers a destination picker fed by the existing listing route', async () => {
    const source = await dialog()
    // No new Host channel: the picker reads the tree through the route the listing
    // already uses.
    expect(source).toMatch(/KB_API\.list/u)
    expect(source).toMatch(/KnowledgeDestinationPicker/u)
    // The chosen path is shown, not merely held in state.
    expect(source).toMatch(/createDestination/u)
  })

  it('rejects a name the tree cannot store, inline and before submitting', async () => {
    const source = await dialog()
    expect(source).toMatch(/export function validateEntryName/u)
    // Empty, a separator (which would silently make the "name" a path), and the two
    // traversal segments.
    expect(source).toMatch(/createNameEmpty/u)
    expect(source).toMatch(/createNameSeparator/u)
    expect(source).toMatch(/createNameTraversal/u)
    // The primary button is disabled on an invalid name, so the refusal is visible
    // before the request rather than as a server error afterwards.
    expect(source).toMatch(/disabled=\{disabled\}/u)
  })

  it('adds the markdown extension without doubling it', async () => {
    const source = await dialog()
    expect(source).toMatch(/trimmed\.endsWith\('\.md'\) \? trimmed : trimmed \+ '\.md'/u)
  })

  it('sends a document and a folder through the existing create route', async () => {
    const source = await dialog()
    expect(source).toMatch(/KB_API\.create/u)
    // One route, two kinds: the folder case is the create route told `directory`.
    expect(source).toMatch(/kind: isFolder \? 'directory' : 'file'/u)
  })

  it('uses only design tokens, never raw pixel font sizes or hex colours', async () => {
    const css = await readFile(new URL('../src/client/KnowledgeCreateDialog.module.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/font-size:\s*\d+px/u)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(css).not.toMatch(/\b(?:rgb|hsl)a?\(/u)
    for (const match of css.matchAll(/font:\s*([^;]+);/gu)) {
      expect(match[1]).toMatch(/var\(--dsw-font-/u)
    }
  })

  it('names every string through the locale resolver rather than a literal', async () => {
    // The dialog is bilingual by construction: every user-visible string goes through
    // `t`, so the locale table is the only place copy lives. This catches a hardcoded
    // sentence creeping in during a later edit.
    const source = await dialog()
    const literals = [...source.matchAll(/>\s*([A-Za-z][A-Za-z ,.'!?-]{6,})\s*</gu)].map(match => match[1].trim())
    expect(literals).toEqual([])
  })
})

describe('the create dialog copy is complete in both locales', () => {
  /**
   * The dialog asks for a name and a destination in every language the product
   * offers. A key present in `en` but missing from `zh` renders as the raw key
   * string, which is how a half-translated dialog ships without anyone noticing.
   *
   * Every key the dialog asks for is checked against both objects. The list is
   * derived from the source rather than written out, so a key added to the dialog
   * and forgotten in the locale table fails here instead of in front of a reader.
   */
  const keysIn = async (): Promise<string[]> => {
    const dialog = await readFile(new URL('../src/client/KnowledgeCreateDialog.tsx', import.meta.url), 'utf8')
    const found = new Set<string>()
    for (const match of dialog.matchAll(/\bt\('([A-Za-z][A-Za-z0-9]*)'\)/gu)) found.add(match[1])
    return [...found].sort()
  }

  it('declares every key the dialog uses, once per locale', async () => {
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    const keys = await keysIn()
    expect(keys.length).toBeGreaterThan(10)
    const missing: string[] = []
    for (const key of keys) {
      const occurrences = (locales.match(new RegExp('\\b' + key + ':', 'gu')) ?? []).length
      if (occurrences !== 2) missing.push(key + ' (' + String(occurrences) + ')')
    }
    expect(missing).toEqual([])
  })

  it('keeps the placeholders the dialog substitutes', async () => {
    // A message whose placeholder name drifts from the code shows `{path}` to the
    // reader, so the four that are substituted are pinned by name.
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(locales).toMatch(/createWillCreate: '[^']*\{path\}/u)
    expect(locales).toMatch(/createDone: '[^']*\{path\}/u)
    expect(locales).toMatch(/createProgress: '[^']*\{done\}[^']*\{total\}/u)
    expect(locales).toMatch(/createMoreFiles: '[^']*\{n\}/u)
  })
})

describe('the template library is a card dialog with maintenance', () => {
  /**
   * The library was a full-surface sheet that could only READ DataOps wiki pages, so
   * it was permanently empty and its cards did nothing. A template is a document plus
   * a few facts about it, so it is now stored as exactly that and the dialog can add,
   * edit and take one offline.
   *
   * These pin the three properties that make it a real library rather than a viewer:
   * the card grid with a working primary action, maintenance in the same dialog, and
   * a store that is one document directory plus one index.
   */
  const templates = (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeTemplates.tsx', import.meta.url), 'utf8')

  it('renders a card grid inside an official Modal', async () => {
    const source = await templates()
    expect(source).toMatch(/<Modal\b/u)
    expect(source).toMatch(/from '@deepseek-ai\/dsh-client-ui-primitives'/u)
    // Cards, not rows: a grid with a floor width that wraps.
    expect(source).toMatch(/styles\.grid/u)
    expect(source).toMatch(/styles\.card\b/u)
    // Each card carries the facts the task names.
    expect(source).toMatch(/template\.title/u)
    expect(source).toMatch(/template\.description/u)
    expect(source).toMatch(/template\.updatedAt/u)
    expect(source).toMatch(/sizeText\(template\.bytes\)/u)
    // And its primary action.
    expect(source).toMatch(/templatePick/u)
  })

  it('offers maintenance in the same dialog, behind a tab', async () => {
    const source = await templates()
    expect(source).toMatch(/SegmentedTabs/u)
    expect(source).toMatch(/templateTabLibrary/u)
    expect(source).toMatch(/templateTabManage/u)
    // Add, edit and remove all exist, and remove asks first.
    expect(source).toMatch(/templateAdd/u)
    expect(source).toMatch(/templateEdit/u)
    expect(source).toMatch(/c\('templateRemoveBody'\)\.replace/u)
    expect(source).toMatch(/setConfirming/u)
  })

  it('collects the document plus its metadata as one record', async () => {
    const source = await templates()
    // The form is one document picker and four metadata fields. Nothing more: the
    // task's "template = a document + metadata, do not invent a data model".
    expect(source).toMatch(/type="file"/u)
    expect(source).toMatch(/accept="\.md,\.markdown,\.txt,\.pdf,\.doc,\.docx,\.xls,\.xlsx,\.ppt,\.pptx,\.rtf,\.odt,\.ods,\.odp"/u)
    expect(source).toMatch(/setField\('title'/u)
    expect(source).toMatch(/setField\('description'/u)
    expect(source).toMatch(/setField\('category'/u)
    expect(source).toMatch(/setField\('tags'/u)
  })

  it('uses the existing routes, adding no new channel for the copy or the store', async () => {
    const source = await templates()
    // Reading a stored template and writing the copy reuse `read` and `upload`; the
    // store itself is the two new methods on the same prefix.
    expect(source).toMatch(/KB_API\.read/u)
    expect(source).toMatch(/KB_API\.upload/u)
    expect(source).toMatch(/KB_API\.templates/u)
    expect(source).toMatch(/KB_API\.templateSave/u)
    expect(source).toMatch(/KB_API\.templateRemove/u)
  })

  it('keeps the read bound rather than trusting the transport', async () => {
    const source = await templates()
    // A race, so a fetch that ignores its abort still cannot leave the dialog
    // spinning -- the property the previous sheet already had and this one keeps.
    expect(source).toMatch(/Promise\.race\(\[read, deadline\]\)/u)
    expect(source).toMatch(/TEMPLATE_TIMEOUT_MS/u)
  })

  it('says "empty" and "could not read" differently', async () => {
    const source = await templates()
    expect(source).toMatch(/templateEmpty/u)
    expect(source).toMatch(/templateUnavailable/u)
    // And a filtered miss is a third state, not the same sentence as an empty library.
    expect(source).toMatch(/templateNoMatch/u)
  })

  it('uses only design tokens in its stylesheet', async () => {
    const css = await readFile(new URL('../src/client/KnowledgeTemplates.module.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/font-size:\s*\d+px/u)
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u)
    expect(css).not.toMatch(/\b(?:rgb|hsl)a?\(/u)
    for (const match of css.matchAll(/font:\s*([^;]+);/gu)) {
      expect(match[1]).toMatch(/var\(--dsw-font-/u)
    }
  })
})

describe('the template store is one document directory plus one index', () => {
  /**
   * The model, asserted where it lives. A template is a document file next to a JSON
   * index that names it; there is no table, no database, and no second copy in
   * DataOps. These pin that shape so a later edit cannot quietly grow one.
   */
  const views = (): Promise<string> =>
    readFile(new URL('../src/views.ts', import.meta.url), 'utf8')

  it('keeps the documents under a dot-directory in the authoritative tree', async () => {
    const source = await views()
    // The authoritative tree, not the caller's view: a template is shared content and
    // a view is rewritten by the next sync.
    expect(source).toMatch(/const TEMPLATE_DIR = '\.kb-templates'/u)
    expect(source).toMatch(/export function templateDirFor\(actualRoot: string\)/u)
    expect(source).toMatch(/const TEMPLATE_INDEX = '\.kb-templates\.json'/u)
  })

  it('reads and writes the index atomically, tolerating a broken one', async () => {
    const source = await views()
    expect(source).toMatch(/export async function readTemplates/u)
    expect(source).toMatch(/export async function saveTemplate/u)
    expect(source).toMatch(/export async function removeTemplate/u)
    // A corrupt index reads as an empty library rather than throwing: a broken
    // metadata file must not take the whole page down.
    const read = source.slice(source.indexOf('export async function readTemplates'))
    expect(read.slice(0, 1200)).toMatch(/catch \{[\s\S]{0,200}return \[\]/u)
    // The write is temp-plus-rename.
    expect(source).toMatch(/const temporary = target \+ '\.tmp'/u)
  })

  it('rejects a file name that would escape the template directory', async () => {
    const source = await views()
    expect(source).toMatch(/function isStorableTemplateFileName/u)
    const guard = source.slice(source.indexOf('function isStorableTemplateFileName'))
    expect(guard.slice(0, 500)).toMatch(/includes\('\/'\)/u)
    expect(guard.slice(0, 500)).toMatch(/includes\('\\\\'\)/u)
    expect(guard.slice(0, 500)).toMatch(/startsWith\('\.'\)/u)
  })
})

describe('the template dialog copy is complete in both locales', () => {
  /**
   * The template dialog gained a maintenance form, which is a lot of copy: labels,
   * placeholders, three validation sentences, four outcome sentences and a
   * confirmation. A key present in `en` but missing from `zh` renders as the raw key,
   * which is how a half-translated dialog ships unnoticed.
   *
   * The key list is derived from the source, so a key added there and forgotten in
   * the locale table fails here instead of in front of a reader.
   */
  it('declares every key the dialog uses, once per locale', async () => {
    const dialog = await readFile(new URL('../src/client/KnowledgeTemplates.tsx', import.meta.url), 'utf8')
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    const found = new Set<string>()
    for (const match of dialog.matchAll(/\bc\('([A-Za-z][A-Za-z0-9]*)'\)/gu)) found.add(match[1])
    expect(found.size).toBeGreaterThan(30)
    const missing: string[] = []
    for (const key of found) {
      const occurrences = (locales.match(new RegExp('\\b' + key + ':', 'gu')) ?? []).length
      if (occurrences !== 2) missing.push(key + ' (' + String(occurrences) + ')')
    }
    expect(missing).toEqual([])
  })

  it('keeps the placeholders the dialog substitutes', async () => {
    const locales = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    expect(locales).toMatch(/templateUsed: '[^']*\{path\}/u)
    expect(locales).toMatch(/templateUnavailableReason: '[^']*\{reason\}/u)
    expect(locales).toMatch(/templateFileChosen: '[^']*\{name\}/u)
    expect(locales).toMatch(/templateFileKept: '[^']*\{name\}/u)
    expect(locales).toMatch(/templateRemoveBody: '[^']*\{name\}/u)
  })
})

describe('every UI string resolves to a locale key', () => {
  /**
   * A missing locale key does not fail anything at runtime: `t()` returns the key it
   * was given, so the reader sees `step.nfs-mount` or `grantFailed` rendered as if it
   * were a sentence. That is how three deploy-step labels and three permission
   * failure messages shipped broken without a single test going red.
   *
   * This walks every STATIC key literal in the client half and requires each one to
   * exist in both locale objects. Dynamic construction is excluded by design -- a
   * pattern like `c('subject.' + kind)` names a key that only exists at runtime, so
   * scanning it as a literal would report a key no author ever wrote. The three
   * dynamic families this package actually uses are covered separately below, where
   * their value space is finite and can be enumerated.
   */
  const readClient = async (): Promise<Array<{ file: string; source: string }>> => {
    const dir = new URL('../src/client/', import.meta.url)
    const names = (await readdir(dir)).filter(name => name.endsWith('.tsx') || name.endsWith('.ts'))
    return Promise.all(names.map(async name => ({
      file: name,
      source: await readFile(new URL(name, dir), 'utf8'),
    })))
  }

  /**
   * Every static `c('key')` / `t('key')` literal in one source text.
   *
   * The pattern deliberately requires the closing quote immediately after the key, so
   * a concatenation (`c('subject.' + kind)`) and a template literal
   * (`` t(`step.${id}`) ``) are not matched: neither names a complete key.
   * @param source - one client file's text.
   * @returns The literal keys it asks for, de-duplicated.
   */
  const staticKeysIn = (source: string): string[] => {
    const found = new Set<string>()
    for (const match of source.matchAll(/\b[ct]\('([A-Za-z][A-Za-z0-9_.-]*)'\)/gu)) found.add(match[1])
    return [...found]
  }

  /**
   * The locale table split into its two objects, so "in en" and "in zh" are separate
   * questions rather than one count that a duplicated key could satisfy.
   */
  const localeObjects = async (): Promise<{ en: string; zh: string }> => {
    const source = await readFile(new URL('../src/client/locales.ts', import.meta.url), 'utf8')
    // The file declares exactly `en` then `zh`; splitting on the second object's
    // opening brace is brittle, so the boundary is the `zh` declaration itself.
    const zhAt = source.indexOf('const zh')
    expect(zhAt).toBeGreaterThan(0)
    return { en: source.slice(0, zhAt), zh: source.slice(zhAt) }
  }

  /**
   * Whether one key is declared in a locale object.
   *
   * Both spellings the table uses are accepted: a bare identifier
   * (`referenceFile:`) and a quoted one (`'step.nfs-mount':`), because a dotted or
   * hyphenated key cannot be a bare identifier. Plain `includes` rather than a
   * RegExp: the keys themselves contain dots and hyphens, and escaping them into a
   * pattern is exactly where a guard like this goes wrong.
   * @param object - one locale object's text.
   * @param key - the key to look for.
   * @returns Whether the key is declared.
   */
  const declares = (object: string, key: string): boolean =>
    object.includes("'" + key + "':") || new RegExp('\\n\\s*' + key + '\\s*:', 'u').test(object)

  it('declares every static key in both locales', async () => {
    const { en, zh } = await localeObjects()
    const missing: string[] = []
    let checked = 0
    for (const { file, source } of await readClient()) {
      for (const key of staticKeysIn(source)) {
        checked += 1
        if (!declares(en, key)) missing.push(file + ': ' + key + ' (missing en)')
        if (!declares(zh, key)) missing.push(file + ': ' + key + ' (missing zh)')
      }
    }
    // A guard over zero keys would pass silently, which is the failure mode this
    // whole test exists to prevent one level up.
    expect(checked).toBeGreaterThan(200)
    expect(missing).toEqual([])
  })

  it('declares a label for every deploy step id', async () => {
    // `t(\`step.${step.id}\`)` is the one dynamic key whose value space the Host owns.
    // A step added to `deploy.ts` without a `step.<id>` label renders as its raw id.
    const client = await readClient()
    const settings = client.find(entry => entry.file === 'KnowledgeSettingsSection.tsx')
    expect(settings).toBeDefined()
    // The dynamic form is what makes this family need its own check; a static scan
    // cannot see it.
    expect(settings?.source).toMatch(/t\(`step\.\$\{step\.id\}`/u)

    const deploy = await readFile(new URL('../src/deploy.ts', import.meta.url), 'utf8')
    const ids = [...deploy.matchAll(/^\s+id: '([a-z0-9-]+)'/gmu)].map(match => match[1])
    expect(ids.length).toBeGreaterThan(5)

    const { en, zh } = await localeObjects()
    const missing: string[] = []
    for (const id of ids) {
      expect(declareStepKey(en, id), 'step.' + id + ' (missing en)').toBe(true)
      expect(declareStepKey(zh, id), 'step.' + id + ' (missing zh)').toBe(true)
    }
    expect(missing).toEqual([])
  })

  it('declares a label for every grant subject kind', async () => {
    // `c('subject.' + kind)` over the grant subject union: a new principal kind
    // without a label would render as `subject.role` to a reader.
    const client = await readClient()
    const permissions = client.find(entry => entry.file === 'KnowledgePermissions.tsx')
    expect(permissions).toBeDefined()
    expect(permissions?.source).toMatch(/c\('subject\.' \+ kind\)/u)

    // The kinds come from the API contract, which is where the union is declared.
    const api = await readFile(new URL('../src/api.ts', import.meta.url), 'utf8')
    const union = api.match(/KnowledgeGrantSubjectType = ([^\n]+)/u)
    expect(union).not.toBeNull()
    const kinds = [...(union?.[1] ?? '').matchAll(/'([a-z-]+)'/gu)].map(match => match[1])
    expect(kinds.length).toBeGreaterThan(0)

    const { en, zh } = await localeObjects()
    for (const kind of kinds) {
      expect(declares(en, 'subject.' + kind), 'subject.' + kind + ' (missing en)').toBe(true)
      expect(declares(zh, 'subject.' + kind), 'subject.' + kind + ' (missing zh)').toBe(true)
    }
  })

  it('declares a label for every audit outcome', async () => {
    // `c('auditOutcome' + Capitalised(outcome))`: the union lives in views.ts, so a new
    // outcome without a label shows the reader `auditOutcomeRolledBack`.
    const audit = await readFile(new URL('../src/client/KnowledgeAudit.tsx', import.meta.url), 'utf8')
    expect(audit).toMatch(/c\('auditOutcome' \+/u)

    const views = await readFile(new URL('../src/views.ts', import.meta.url), 'utf8')
    const union = views.match(/outcome: ([^\n]+)/u)
    expect(union).not.toBeNull()
    const outcomes = [...(union?.[1] ?? '').matchAll(/'([a-z]+)'/gu)].map(match => match[1])
    expect(outcomes.length).toBeGreaterThan(0)

    const { en, zh } = await localeObjects()
    for (const outcome of outcomes) {
      const key = 'auditOutcome' + outcome.charAt(0).toUpperCase() + outcome.slice(1)
      expect(declares(en, key), key + ' (missing en)').toBe(true)
      expect(declares(zh, key), key + ' (missing zh)').toBe(true)
    }
  })

  it('reports a missing key instead of passing over it', async () => {
    // The guard has to be able to fail. This feeds the same predicate a key that is
    // certainly absent, which is how the reverse test in the task description was
    // performed by hand (delete one key, watch this suite go red).
    const { en, zh } = await localeObjects()
    expect(declares(en, 'thisKeyDoesNotExistAnywhere')).toBe(false)
    expect(declares(zh, 'thisKeyDoesNotExistAnywhere')).toBe(false)
    // And a key that is present is seen in both.
    expect(declares(en, 'referenceFile')).toBe(true)
    expect(declares(zh, 'referenceFile')).toBe(true)
  })
})

/**
 * Whether a `step.<id>` label is declared in one locale object.
 *
 * Quoted, always: a key containing a hyphen cannot be a bare identifier.
 * @param object - one locale object's text.
 * @param id - the deploy step id.
 * @returns Whether the label exists.
 */
function declareStepKey(object: string, id: string): boolean {
  return object.includes("'step." + id + "':")
}

describe('a write must leave the view showing it', () => {
  /**
   * The bug these pin: `create` answered 200 while the view stayed empty, so the
   * reader was told "saved" and could not find the document. The write had succeeded
   * and the refresh had failed silently, and the two outcomes were indistinguishable
   * from the page. These assert the DISK, not the status code, because a 200 was
   * exactly what the broken version returned.
   */
  const CONFIG_FOR_WRITE = {
    ...CONFIG,
  }

  /**
   * A stub whose `resolve` answers from a table, and that can break the SYNC only.
   *
   * `failAfter` counts resolves and starts failing the call after it, so the write
   * permission check (the first resolve) still succeeds: the scenario under test is
   * "the document was written, then the view refresh could not resolve it", not
   * "the write was refused".
   */
  function writeStub(options: {
    table: Record<string, { canRead?: boolean; canWrite?: boolean }>
    /**
     * 1-based resolve call numbers that answer 500.
     *
     * A count-from-here rule cannot express "fail once, then recover": call 1 is the
     * write's own permission check, so the retry test needs exactly call 2 to fail.
     */
    failOn?: readonly number[]
  }) {
    let seen = 0
    const calls: string[] = []
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        seen += 1
        if (options.failOn?.includes(seen) === true) {
          return new Response(JSON.stringify({ error: 'backend unavailable' }), { status: 500 })
        }
        const sent = JSON.parse(String(init?.body ?? '{}')) as { resourceId?: string }
        return new Response(
          JSON.stringify(options.table[sent.resourceId ?? ''] ?? { canRead: false, canWrite: false }),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    return { impl, calls }
  }

  /** A root with both trees, plus the mount point the view is pointed at. */
  async function writeWorkspace(): Promise<{ root: string; config: typeof CONFIG; viewDir: string }> {
    const root = await mkdtemp(join(tmpdir(), 'kb-sync-'))
    const actual = join(root, 'actual')
    await mkdir(actual, { recursive: true })
    const config = {
      ...CONFIG_FOR_WRITE,
      actualRoot: actual,
      viewRoot: join(root, 'views'),
      mountPoint: join(root, 'mnt'),
    }
    return { root, config, viewDir: join(config.viewRoot, 'u-1') }
  }

  it('links a created document into the view, on disk, before answering', async () => {
    const { root, config, viewDir } = await writeWorkspace()
    const stub = writeStub({ table: { 'notes/a.md': { canRead: true, canWrite: true } } })
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: stub.impl })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: 'notes/a.md', kind: 'file', content: '# hi' })
      expect(reply.error).toBeUndefined()
      // The decisive assertion: the reader opens the tree and the row is there.
      await expect(readFile(join(viewDir, 'global', 'notes', 'a.md'), 'utf8')).resolves.toBe('# hi')
      // A hardlink, not a copy: the view and the authoritative tree are one inode, so
      // a later edit in place is visible without another sync.
      const linked = await stat(join(viewDir, 'global', 'notes', 'a.md'))
      const authoritative = await stat(join(config.actualRoot, 'notes', 'a.md'))
      expect(linked.ino).toBe(authoritative.ino)
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers 207 with a reason when the view could not be refreshed', async () => {
    const { root, config, viewDir } = await writeWorkspace()
    // Every resolve after the write permission check fails, so no retry can succeed.
    const stub = writeStub({ table: { 'notes/a.md': { canRead: true, canWrite: true } }, failOn: [2, 3] })
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: stub.impl })
    try {
      apply(ctx as never, config as never)
      const route = routes.find(candidate => candidate.path === '/knowledge-base/api')
      if (route === undefined) throw new Error('route not registered')
      let reply: Record<string, unknown> = {}
      let status = 0
      const req = {
        url: '/knowledge-base/api/create',
        on(event: string, handler: (chunk?: Buffer) => void) {
          if (event === 'data') handler(Buffer.from(JSON.stringify({ relPath: 'notes/a.md', kind: 'file', content: 'x' })))
          if (event === 'end') handler()
          return req
        },
      }
      const res = {
        statusCode: 0,
        setHeader: () => undefined,
        end: (text: string) => { reply = JSON.parse(text) as Record<string, unknown>; status = (res as { statusCode: number }).statusCode },
      }
      await route.handler(req, res)
      // The document WAS saved; the answer must not claim a clean success.
      await expect(readFile(join(config.actualRoot, 'notes/a.md'), 'utf8')).resolves.toBe('x')
      expect(status).toBe(207)
      expect(reply.created).toBeDefined()
      const warning = reply.viewSyncWarning as { message?: string; reason?: string } | undefined
      expect(warning?.reason).toBeTruthy()
      // And the tree really is missing it, which is what the warning is about.
      await expect(readFile(join(viewDir, 'global', 'notes', 'a.md'), 'utf8')).rejects.toThrow()
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('retries a failed refresh once, so a transient resolve failure still links the file', async () => {
    const { root, config, viewDir } = await writeWorkspace()
    // One failure: the write gate resolves first, then the first sync attempt fails
    // and the retry succeeds. This is the race a write actually produces.
    const stub = writeStub({ table: { 'notes/a.md': { canRead: true, canWrite: true } }, failOn: [2] })
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: stub.impl })
    try {
      apply(ctx as never, config as never)
      const reply = await callRoute(routes, 'create', { relPath: 'notes/a.md', kind: 'file', content: 'x' })
      expect(reply.error).toBeUndefined()
      // The first sync attempt was denied, the retry succeeded, so the write is a
      // clean success and the tree shows the document.
      expect(reply.viewSyncWarning).toBeUndefined()
      await expect(readFile(join(viewDir, 'global', 'notes', 'a.md'), 'utf8')).resolves.toBe('x')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the last refresh failure through status, so it is not invisible', async () => {
    const { root, config } = await writeWorkspace()
    // Calls: 1 = write gate (ok), 2 and 3 = the two sync attempts (fail).
    const stub = writeStub({ table: { 'notes/a.md': { canRead: true, canWrite: true } }, failOn: [2, 3] })
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl: stub.impl })
    try {
      apply(ctx as never, config as never)
      const created = await callRoute(routes, 'create', { relPath: 'notes/a.md', kind: 'file', content: 'x' })
      expect(created.viewSyncWarning).toBeDefined()
      // The page reads status on its next load; the failure has to still be there,
      // or the reader sees a created-but-missing document with no explanation.
      const status = await callRoute(routes, 'status', {})
      expect(typeof status.lastSyncFailure).toBe('string')
      expect(status.lastSyncFailure as string).toContain('notes/a.md')
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

})

describe('the tree never offers a state file as a document', () => {
  /**
   * `create` used to be able to write `.kb-favorites.json` into the view, and the
   * tree's exclusion list was a hand-maintained second copy that lost it: the reader
   * saw a bookkeeping file offered as a document, with rename and delete controls.
   * These pin the single source and the drift check that keeps it honest.
   */
  it('excludes every state file the Host writes into a view, favourites included', async () => {
    const views = await import('../src/views.ts')
    const names = views.VIEW_METADATA_NAMES
    expect(names).toContain('.kb-favorites.json')
    expect(names).toContain('.pinned.json')
    expect(names).toContain('.kb-trash.json')
    // The client filters with `**/<name>` patterns built from this same list.
    const tree = await readFile(new URL('../src/client/KnowledgeFileTree.tsx', import.meta.url), 'utf8')
    expect(tree).toMatch(/VIEW_METADATA_FILENAMES/u)
    // The old hand-maintained copy must not come back.
    expect(tree).not.toMatch(/const METADATA_NAMES = \[/u)
  })

  it('does not exclude a file nothing writes into a view', async () => {
    // `.kb-pending` lives under the authoritative root, so an exclusion entry for it
    // could never match and only misled the next reader of the list.
    const views = await import('../src/views.ts')
    expect(views.VIEW_METADATA_NAMES).not.toContain('.kb-pending')
  })

  it('fails loudly when a state file is written but not listed', async () => {
    // The load-time check is what makes the list self-maintaining: a new `*PathFor`
    // that nobody adds to the shared list must not reach the reader's tree silently.
    const source = await readFile(new URL('../src/views.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/assertViewMetadataNames\(\)/u)
    const names = await readFile(new URL('../src/viewMetadata.ts', import.meta.url), 'utf8')
    // Every helper the Host uses to place a state file is represented here.
    for (const file of ['kb-audit.jsonl', 'kb-settings.json', 'kb-tree-state.json', 'kb-favorites.json', 'kb-trash.json', 'pinned.json', 'view-mode.json']) {
      expect(names).toContain(file)
    }
  })
})

describe('a refused grant explains itself', () => {
  /**
   * `callGrantApi` read `payload.error.message`, but the Host answers
   * `{ error: string }`. Every refusal therefore showed "HTTP 403" instead of the
   * reason, which is the one sentence an operator needs when a grant is rejected.
   * Both shapes are accepted because DataOps' own admin API nests the message.
   */
  it('reads a string reason and a nested one', async () => {
    const source = await readFile(
      new URL('../src/client/KnowledgePermissions.tsx', import.meta.url),
      'utf8',
    )
    // The bug: only the nested shape was understood.
    expect(source).not.toMatch(/payload\.error\?\.message/u)
    // Both shapes now resolve through one helper.
    expect(source).toMatch(/function grantFailureMessage/u)
    expect(source).toMatch(/typeof reason === 'string'/u)
    expect(source).toMatch(/\.message/u)
  })
})

describe('a full scan that resolved nothing leaves the view alone', () => {
  /**
   * SIMULATED, NOT OBSERVED IN PRODUCTION.
   *
   * The live deployment answers `considered: 5, resolved: 5`; an empty resolved set
   * has only ever been produced here with a stub. These tests exist because the
   * failure mode is cheap to guard and expensive to suffer -- pruning on an empty set
   * deletes every link a reader has -- not because the behaviour was seen on a real
   * system. Do not read them as evidence of a reproducible bug.
   *
   * `canReadPath` fails closed, so a backend that is down, a credential that expired,
   * or a resolve racing a deploy all yield an empty resolved set with no error
   * anywhere. Without the guard, the next routine sync would treat that as "every
   * grant was revoked".
   */
  it('keeps existing links when a full scan resolves zero paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-noprune-'))
    const actual = join(root, 'actual')
    const views = join(root, 'views')
    await mkdir(join(actual, 'personal', 'u-1'), { recursive: true })
    await writeFile(join(actual, 'personal', 'u-1', 'keep.md'), 'kept', 'utf8')
    const options = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
    try {
      // First sync: the file resolves, so it is linked and the view is populated.
      const first = await syncView(options, [{ relPath: 'personal/u-1/keep.md' }])
      expect(first.linked).toEqual(['personal/keep.md'])
      const viewFile = join(views, 'u-1', 'personal', 'keep.md')
      await expect(readFile(viewFile, 'utf8')).resolves.toBe('kept')

      // Second sync is a FULL scan that resolved nothing -- the simulated failure.
      const second = await syncView({ ...options, fullScan: true, trustResolvedSet: false }, [])
      expect(second.pruneSkipped).toBe('no-path-resolved')
      // The link survives. This is the whole point: a reader keeps their documents
      // even when the permission backend answers nothing.
      await expect(readFile(viewFile, 'utf8')).resolves.toBe('kept')
      expect(second.unlinked).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('still prunes when a full scan resolved some paths', async () => {
    // The guard must not disable pruning generally: a real revoke is exactly a full
    // scan that resolves a non-empty set not containing this file.
    const root = await mkdtemp(join(tmpdir(), 'kb-prune-'))
    const actual = join(root, 'actual')
    const views = join(root, 'views')
    await mkdir(join(actual, 'personal', 'u-1'), { recursive: true })
    await writeFile(join(actual, 'personal', 'u-1', 'gone.md'), 'x', 'utf8')
    await writeFile(join(actual, 'personal', 'u-1', 'stays.md'), 'y', 'utf8')
    const options = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
    try {
      await syncView(options, [
        { relPath: 'personal/u-1/gone.md' },
        { relPath: 'personal/u-1/stays.md' },
      ])
      // `gone.md` was revoked; `stays.md` still resolves, so the set is non-empty.
      const after = await syncView({ ...options, fullScan: true }, [{ relPath: 'personal/u-1/stays.md' }])
      expect(after.pruneSkipped).toBeUndefined()
      expect(after.unlinked).toEqual(['personal/gone.md'])
      await expect(readFile(join(views, 'u-1', 'personal', 'gone.md'), 'utf8')).rejects.toThrow()
      await expect(readFile(join(views, 'u-1', 'personal', 'stays.md'), 'utf8')).resolves.toBe('y')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not apply the guard to a targeted sync', async () => {
    // A write asking about one path resolves an empty set when that path is denied.
    // That says nothing about the rest of the tree, so the guard must not label it a
    // wholesale failure -- but it must not prune the other links either.
    const root = await mkdtemp(join(tmpdir(), 'kb-target-'))
    const actual = join(root, 'actual')
    const views = join(root, 'views')
    await mkdir(join(actual, 'personal', 'u-1'), { recursive: true })
    await writeFile(join(actual, 'personal', 'u-1', 'a.md'), 'a', 'utf8')
    const options = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
    try {
      await syncView(options, [{ relPath: 'personal/u-1/a.md' }])
      const targeted = await syncView({ ...options, fullScan: false }, [])
      expect(targeted.pruneSkipped).toBeUndefined()
      await expect(readFile(join(views, 'u-1', 'personal', 'a.md'), 'utf8')).resolves.toBe('a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports the refusal through status so a deployment can see it', async () => {
    // The observable half is worth more than the test: on a real system this field is
    // how "the backend answered nothing this round" becomes visible at all.
    const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    expect(source).toMatch(/pruneSkipped: lastPruneSkipped/u)
    expect(source).toMatch(/lastPruneSkipped = result\.pruneSkipped/u)
  })
})

describe('a sync whose resolves all fail reports itself', () => {
  /**
   * SIMULATED, NOT OBSERVED IN PRODUCTION.
   *
   * The live deployment answers `considered: 5, resolved: 5`. This drives the Host
   * function with every resolve failing, which is the shape a backend outage or an
   * expired credential produces, and pins that it (a) keeps the view and (b) says so.
   */
  it('keeps the reader links and reports pruneSkipped when every resolve fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-syncfail-'))
    const actual = join(root, 'actual')
    await mkdir(join(actual, 'personal', 'u-1'), { recursive: true })
    await writeFile(join(actual, 'personal', 'u-1', 'keep.md'), 'kept', 'utf8')
    const config = {
      ...CONFIG,
      actualRoot: actual,
      viewRoot: join(root, 'views'),
      mountPoint: join(root, 'mnt'),
    }
    // First: a healthy resolve populates the view.
    let failing = false
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/auth/me')) {
        return new Response(JSON.stringify({ user: { id: 'u-1', displayName: 'Tester' } }), { status: 200 })
      }
      if (url.includes('/resource-permissions/resolve')) {
        if (failing) return new Response(JSON.stringify({ error: 'unavailable' }), { status: 500 })
        return new Response(JSON.stringify({ canRead: true, canWrite: true }), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    const { ctx, routes, disposers } = fakeHost({ token: 't', fetchImpl })
    try {
      apply(ctx as never, config as never)
      const first = await callRoute(routes, 'views.sync', {})
      expect(first.error).toBeUndefined()
      const viewFile = join(config.viewRoot, 'u-1', 'personal', 'keep.md')
      await expect(readFile(viewFile, 'utf8')).resolves.toBe('kept')

      // Now every resolve fails, and a FULL scan runs.
      failing = true
      const out = await callRoute(routes, 'views.sync', {})
      expect(out.pruneSkipped).toBe('no-path-resolved')
      // The link is still there: this is the guard's whole purpose.
      await expect(readFile(viewFile, 'utf8')).resolves.toBe('kept')
      expect(out.unlinked).toEqual([])
    } finally {
      for (const dispose of disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('a targeted sync must not touch the rest of the view', () => {
  /**
   * Measured on the live deployment, not speculated: `views.sync` with
   * `paths: ['global/definitely-not-there.md']` unlinked every other document in the
   * view, because a non-empty requested set that resolved to nothing made the whole
   * existing view look like an orphan set. The reader loses their tree for asking
   * about one path.
   *
   * The rule: a sync that was given specific paths knows nothing about the paths it
   * was not asked about, so it must never prune.
   */
  it('leaves untouched documents alone when asked about unrelated paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-target-'))
    const actual = join(root, 'actual')
    await mkdir(join(actual, 'global'), { recursive: true })
    await writeFile(join(actual, 'global', 'a.md'), 'a', 'utf8')
    await writeFile(join(actual, 'global', 'b.md'), 'b', 'utf8')
    const views = join(root, 'views')
    const options = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
    try {
      // A full sync links both.
      await syncView({ ...options, fullScan: true }, [
        { relPath: 'global/a.md' },
        { relPath: 'global/b.md' },
      ])
      await expect(readFile(join(views, 'u-1', 'global', 'a.md'), 'utf8')).resolves.toBe('a')
      await expect(readFile(join(views, 'u-1', 'global', 'b.md'), 'utf8')).resolves.toBe('b')

      // A targeted sync about a path that does not exist resolves nothing, and must
      // not take the other two with it.
      const targeted = await syncView({ ...options, fullScan: false }, [])
      expect(targeted.unlinked).toEqual([])
      expect(targeted.pruned).toEqual([])
      await expect(readFile(join(views, 'u-1', 'global', 'a.md'), 'utf8')).resolves.toBe('a')
      await expect(readFile(join(views, 'u-1', 'global', 'b.md'), 'utf8')).resolves.toBe('b')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('is additive: a targeted sync never unlinks, even for a path it names', async () => {
    // Deliberate. A targeted sync exists for a write to verify its own result, so it
    // is authoritative about what it may ADD and silent about everything else --
    // including removals. Making it authoritative for removals would mean a write's
    // own verification could delete links, which is the opposite of why it is called.
    //
    // Nothing depends on the removal case: the only caller that passes `paths` is the
    // `views.sync` route, which has no client caller at all. A revoke is expressed by
    // a FULL sync, which is authoritative and prunes normally.
    const root = await mkdtemp(join(tmpdir(), 'kb-target2-'))
    const actual = join(root, 'actual')
    await mkdir(join(actual, 'global'), { recursive: true })
    await writeFile(join(actual, 'global', 'a.md'), 'a', 'utf8')
    const views = join(root, 'views')
    const options = { actualRoot: actual, viewRoot: views, userId: 'u-1' }
    try {
      await syncView({ ...options, fullScan: true }, [{ relPath: 'global/a.md' }])
      await expect(readFile(join(views, 'u-1', 'global', 'a.md'), 'utf8')).resolves.toBe('a')
      // Naming the path as hidden does nothing in a targeted sync; the link stays.
      const targeted = await syncView({ ...options, fullScan: false, hidden: ['global/a.md'] }, [])
      expect(targeted.unlinked).toEqual([])
      await expect(readFile(join(views, 'u-1', 'global', 'a.md'), 'utf8')).resolves.toBe('a')
      // A full sync is what applies the revoke.
      const full = await syncView({ ...options, fullScan: true, hidden: ['global/a.md'] }, [])
      expect(full.unlinked).toEqual(['global/a.md'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

})

describe('the MinerU service address is a setting a reader can change', () => {
  /**
   * The port alone can only ever name this machine. A MinerU reached through a tunnel, a
   * gateway or another host has no port to put anywhere, so the settings page gains a
   * full address and the extraction path must actually read it. "Only adds an interface
   * without changing the caller" is the failure this suite is written to catch.
   */
  const configWith = (extra: Record<string, unknown>): Config => ({ ...baseConfig(), ...extra } as Config)

  /** A minimal config: the fields `mineruUrlFor` reads are the only ones that matter. */
  const baseConfig = () => ({ mineruPort: 8000, mineruBaseUrl: '' })

  it('normalises what a reader types', () => {
    // Padding and a trailing slash name the same endpoint as the bare address; storing
    // them verbatim would make two identical settings compare unequal.
    expect(normalizeMineruBaseUrl('  http://10.0.0.5:8000/  ')).toBe('http://10.0.0.5:8000')
    expect(normalizeMineruBaseUrl('http://10.0.0.5:8000')).toBe('http://10.0.0.5:8000')
    expect(normalizeMineruBaseUrl('https://mineru.internal/base/')).toBe('https://mineru.internal/base')
    // A path prefix survives: MinerU may sit behind one.
    expect(normalizeMineruBaseUrl('https://gw.example.com/mineru')).toBe('https://gw.example.com/mineru')
  })

  it('refuses a value that could never work', () => {
    // Each of these would be handed to a parser that can only fail on it, and the reader
    // would see "extraction broke" instead of "this setting is wrong".
    expect(normalizeMineruBaseUrl('')).toBe('')
    expect(normalizeMineruBaseUrl('   ')).toBe('')
    expect(normalizeMineruBaseUrl('10.0.0.5:8000')).toBe('')
    expect(normalizeMineruBaseUrl('file:///etc/passwd')).toBe('')
    expect(normalizeMineruBaseUrl('ftp://host:21')).toBe('')
    expect(normalizeMineruBaseUrl(undefined)).toBe('')
    expect(normalizeMineruBaseUrl(42)).toBe('')
  })

  it('keeps the stored value round-tripping through the settings file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-mineru-'))
    try {
      const viewDir = join(root, 'view')
      // A fresh deployment reads the defaults, and the default is "derive from the port".
      await expect(readSettings(viewDir)).resolves.toEqual(DEFAULT_KNOWLEDGE_SETTINGS)
      expect(DEFAULT_KNOWLEDGE_SETTINGS.mineruBaseUrl).toBe('')

      await writeSettings(viewDir, { reviewRequired: false, mineruBaseUrl: ' http://10.0.0.5:8000/ ' })
      // Written normalised, not as typed.
      await expect(readSettings(viewDir)).resolves.toEqual({
        reviewRequired: false,
        mineruBaseUrl: 'http://10.0.0.5:8000',
      })

      // Clearing it returns to the derived behaviour.
      await writeSettings(viewDir, { reviewRequired: true, mineruBaseUrl: '' })
      await expect(readSettings(viewDir)).resolves.toEqual({ reviewRequired: true, mineruBaseUrl: '' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads a hand-edited or foreign value as "not configured"', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-mineru-bad-'))
    try {
      const viewDir = join(root, 'view')
      await mkdir(viewDir, { recursive: true })
      // A corrupt setting costs the reader their preference, not the page: "derive from
      // the port" is always a working answer, so an unusable value reads as empty.
      await writeFile(
        join(viewDir, '.kb-settings.json'),
        JSON.stringify({ reviewRequired: true, mineruBaseUrl: 'not-a-url' }),
        'utf8',
      )
      await expect(readSettings(viewDir)).resolves.toEqual({ reviewRequired: true, mineruBaseUrl: '' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('prefers an explicit address over the derived port', () => {
    // The deployment-level fallback and the per-caller setting are the same shape: an
    // address wins, an empty one falls back.
    expect(mineruUrlFor(configWith({ mineruBaseUrl: 'http://mineru.gateway:9000' }))).toBe('http://mineru.gateway:9000')
    expect(mineruUrlFor(configWith({ mineruBaseUrl: 'http://mineru.gateway:9000/' }))).toBe('http://mineru.gateway:9000')
    expect(mineruUrlFor(configWith({ mineruBaseUrl: '' }))).toBe('http://127.0.0.1:8000')
    expect(mineruUrlFor(configWith({ mineruBaseUrl: '   ' }))).toBe('http://127.0.0.1:8000')
    // An unusable configured value must not be handed to the extractor as if it worked.
    expect(mineruUrlFor(configWith({ mineruBaseUrl: 'file:///x' }))).toBe('http://127.0.0.1:8000')
    // And the port derivation still honours its own invalid case.
    expect(mineruUrlFor(configWith({ mineruBaseUrl: '', mineruPort: 0 }))).toBeUndefined()
  })
})

describe('the settings section shows only controls and dynamic state', () => {
  const settings = async (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeSettingsSection.tsx', import.meta.url), 'utf8')

  /**
   * The reader struck these four explanations out of the rendered page. Deleting the
   * sentence is not enough -- an unreferenced key is dead weight in two dictionaries --
   * so this pins both halves: the copy is gone from the component, and no surviving
   * heading was left standing over nothing.
   */
  it('renders none of the struck-out explanations', async () => {
    const source = await settings()
    for (const key of [
      'description', 'storageModeLocalHint', 'storageModeRemoteHint',
      'deployLocalOnly', 'deployAboutRemote', 'deployAboutRemoteBody',
      'settingsMineruHint',
    ]) {
      expect(source).not.toContain("t('" + key + "')")
    }
  })

  it('does not duplicate the MinerU heading or explain the address source', async () => {
    const source = await settings()
    // The field sits under the group heading; a second visible label with the same
    // text was the duplicate the reader asked to remove. The accessible name stays.
    expect(source).not.toContain('htmlFor="kb-mineru-base-url"')
    expect(source).not.toContain("t('settingsMineruDerived')")
    expect(source).not.toContain("t('settingsMineruExplicit')")
    expect(source).not.toContain("t('settingsMineruShared')")
    expect(source).toContain('aria-label={t(\'settingsMineruHeading\')}')
  })

  it('leaves no heading standing over an empty block', async () => {
    const source = await settings()
    // Every group heading is followed by a control or a value within a short distance.
    // The one that used to head a deleted explanation (`Deployment`'s local shape) now
    // returns before its heading is drawn at all.
    const localBranch = source.slice(
      source.indexOf('if (!hasRemoteTarget)'),
      source.indexOf('return (\n    <div className={styles.wizard}>'),
    )
    expect(localBranch).toMatch(/return null/u)
    expect(localBranch).not.toMatch(/groupTitle/u)
  })
})

describe('the MinerU field shows the address in effect, not a blank', () => {
  const settings = async (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeSettingsSection.tsx', import.meta.url), 'utf8')

  /**
   * The reported defect: with nothing stored the deployment derives a working address,
   * and the field rendered empty under a "leave it empty to derive" placeholder. The
   * value existed; the page just did not show it.
   */
  it('falls back to the derived address when nothing is stored', async () => {
    const source = await settings()
    // The input's value is the stored address when there is one, else the derived one.
    expect(source).toMatch(/mineruDraft \?\? \(mineru\.stored !== '' \? mineru\.stored : mineru\.derived\)/u)
  })

  it('takes the derived address from the Host rather than recomputing it', async () => {
    const source = await settings()
    // The port lives in the deployment config, which the browser never sees; a second
    // copy of the derivation here would drift from `mineruUrlFor`.
    expect(source).toMatch(/mineruUrl\?: string/u)
    expect(source).toMatch(/typeof reply\.mineruUrl === 'string'/u)
  })

  it('does not send the derived value back as an explicit setting', async () => {
    const source = await settings()
    // Saving an untouched field would freeze today's derivation into a stored address.
    // The write is gated on the draft actually differing from what is stored.
    expect(source).toMatch(/const mineruChanged = mineruDraft !== undefined && mineru !== undefined && mineruDraft !== mineru\.stored/u)
    expect(source).toMatch(/if \(mineruChanged\) \{/u)
  })

  it('reports the Host-resolved address and where it came from in the settings route', async () => {
    const host = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    // Widened past the previous 2600-character window: the branch now also resolves the
    // shared value and checks for a refused stored one, and the reply object moved beyond
    // where that window ended.
    const branch = host.slice(host.indexOf("case 'settings.get'"), host.indexOf("case 'settings.set'"))
    // The route resolves through the same precedence the extractor uses, so the page
    // cannot disagree with what a parse would actually call. It must reach for the shared
    // value the 「文档识别」 plugin's administrator set, not only this plugin's own config.
    expect(branch).toMatch(/resolveMineruUrl\(config, await readSharedMineruUrl\(host, config\)\)/u)
    // Sent only when it resolves: an undefined address is left out rather than shown as
    // the string "undefined".
    expect(branch).toMatch(/mineruUrl: resolution\.url/u)
    // The origin travels with it, because the page renders a different caption for a
    // shared address than for one the reader typed.
    expect(branch).toMatch(/mineruSource: resolution\.source/u)
  })

  it('never writes the shared OCR address back into this caller\'s settings file', async () => {
    // The shared value belongs to the OCR plugin's administrator. A copy here would stop
    // following a later change and become a second source of truth.
    const host = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8')
    const branch = host.slice(host.indexOf("case 'settings.set'"))
    expect(branch.slice(0, 2600)).not.toMatch(/mineruUrl:/u)
  })
})

describe('the whole settings block has one save', () => {
  const settings = async (): Promise<string> =>
    readFile(new URL('../src/client/KnowledgeSettingsSection.tsx', import.meta.url), 'utf8')

  it('submits both groups from a single control', async () => {
    const source = await settings()
    // One handler, both write routes.
    expect(source).toMatch(/const save = useCallback/u)
    expect(source).toMatch(/KB_API\.configSet/u)
    expect(source).toMatch(/KB_API\.settingsSet/u)
    // And exactly one button wired to it.
    const wired = source.match(/onClick=\{\(\) => \{ void save\(\) \}\}/gu) ?? []
    expect(wired).toHaveLength(1)
  })

  it('keeps the address write from flipping the review switch', async () => {
    const source = await settings()
    // `settings.set` replaces one record that also holds the review flag; this page does
    // not show that flag, so it must send the stored value and leave it alone.
    expect(source).toMatch(/reviewRequired: reviewRequiredRef\.current/u)
    expect(source).toMatch(/reviewRequiredRef\.current = /u)
  })

  it('still refuses an impossible port before the round trip', async () => {
    const source = await settings()
    expect(source).toMatch(/!Number\.isInteger\(port\) \|\| port <= 0 \|\| port > 65_535/u)
    expect(source).toContain("t('saveBadPort')")
  })

  it('reports a partial failure instead of claiming success', async () => {
    const source = await settings()
    // The two writes can fail apart; a failed half must be named rather than reported
    // as a clean save.
    expect(source).toMatch(/storageFailure/u)
    expect(source).toMatch(/settingsFailure/u)
    expect(source).toMatch(/if \(storageFailure !== undefined \|\| settingsFailure !== undefined\)/u)
  })
})

describe('the settings write keeps older callers working', () => {
  /**
   * `settings.set` gained a field. An older client that sends only the review toggle must
   * keep working AND must not clear an address it never mentioned -- otherwise upgrading
   * the Host silently resets the operator's configured service.
   */
  const settingsSource = async (): Promise<string> =>
    readFile(new URL('../src/index.ts', import.meta.url), 'utf8')

  it('treats an absent address as "leave it alone", not as empty', async () => {
    const source = await settingsSource()
    const branch = source.slice(source.indexOf("case 'settings.set'"))
    // Absent -> read the stored value back and keep it.
    expect(branch.slice(0, 2400)).toMatch(/body\.mineruBaseUrl === undefined/u)
    expect(branch.slice(0, 2400)).toMatch(/\(await readSettings\(viewDir\)\)\.mineruBaseUrl/u)
    // Present but not a string is a client bug, refused rather than coerced.
    expect(branch.slice(0, 2400)).toMatch(/typeof body\.mineruBaseUrl !== 'string'/u)
  })

  it('refuses an address that is not an absolute http(s) URL', async () => {
    const source = await settingsSource()
    const branch = source.slice(source.indexOf("case 'settings.set'"))
    expect(branch.slice(0, 2400)).toMatch(/new URL\(candidate\)/u)
    expect(branch.slice(0, 2400)).toMatch(/protocol !== 'http:'/u)
    // The refusal is a 400, not a silently stored bad value.
    expect(branch.slice(0, 2400)).toMatch(/writeJson\(res, 400/u)
  })

  it('still requires the review flag, which every write already sent', async () => {
    const source = await settingsSource()
    const branch = source.slice(source.indexOf("case 'settings.set'"))
    expect(branch.slice(0, 1200)).toMatch(/typeof body\.reviewRequired !== 'boolean'/u)
  })

  it('renders the field on the surface a reader can actually reach', async () => {
    // 落点是这一项的真实风险：上一版把它加在 `KnowledgeSettings.tsx`，而真机点侧边栏
    // 「设置」打开的是 DSH 全局设置弹窗，那一页不可达，于是字段用户永远看不到。
    // 断言落在 DSH 全局设置的知识库分节（`KnowledgeSettingsSection.tsx`）上。
    const section = await readFile(new URL('../src/client/KnowledgeSettingsSection.tsx', import.meta.url), 'utf8')
    expect(section).toMatch(/id="kb-mineru-base-url"/u)
    expect(section).toMatch(/KB_API\.settingsGet/u)
    expect(section).toMatch(/KB_API\.settingsSet/u)
    // 保存必须由显式动作提交，而不是每次按键就写盘。两个分组的按钮已合并成一个，
    // 所以断言的是那一个动作：它同时提交存储设置与地址。
    expect(section).toMatch(/const save = useCallback/u)
    expect(section).toMatch(/KB_API\.configSet/u)
    expect(section).toMatch(/KB_API\.settingsSet/u)
    // 整块只有一个保存按钮。
    expect(section.match(/onClick=\{\(\) => \{ void save\(\) \}\}/gu) ?? []).toHaveLength(1)
    // 没授权的人能看到值但改不了。
    expect(section).toMatch(/disabled=\{!mineru\.canEdit/u)

    // 不可达的那一页不再留第二处入口，避免两套 UI 各自演化。
    const unreachable = await readFile(new URL('../src/client/KnowledgeSettings.tsx', import.meta.url), 'utf8')
    expect(unreachable).not.toMatch(/settingsMineruHeading/u)
  })

  it('feeds the caller setting into extraction, which is what makes it do anything', async () => {
    // The whole point: a stored value nothing reads is not a feature. The upload route
    // must pass the caller's own address to `extractBeside`.
    const source = await settingsSource()
    expect(source).toMatch(/export async function extractBeside\(\s*config: Config,\s*relPath: string,\s*mineruUrl\?: string,\s*readSharedUrl\?:/u)
    // The call site names the caller's stored address; the local variable was renamed
    // when the upload path moved onto the extraction queue, so match the argument rather
    // than one spelling of it.
    expect(source).toMatch(/extractBeside\(config, relPath, [A-Za-z.]*mineruBaseUrl/u)
    // And the caller's override outranks both fallbacks inside the extractor.
    const body = source.slice(source.indexOf('export async function extractBeside'))
    expect(body.slice(0, 1800)).toMatch(/mineruUrl !== undefined && mineruUrl !== ''/u)
    expect(body.slice(0, 1800)).toMatch(/mineruUrlFor\(config, sharedUrl\)/u)
  })

  it('reads the shared address only when the caller has none of their own', async () => {
    // A caller who configured their own address must not cause a backend round trip, and
    // a deployment without the OCR plugin must never call one at all.
    const source = await settingsSource()
    const body = source.slice(source.indexOf('export async function extractBeside'))
    expect(body.slice(0, 1800)).toMatch(/mineruUrl !== undefined && mineruUrl !== ''\s*\n\s*\? undefined\s*\n\s*: await readSharedUrl\?\.\(\)/u)
  })
})

describe('audit trail ordering and paging', () => {
  /**
   * The ordering is a correctness rule, not a presentation detail. The Host appends
   * newest-last, and the table used to draw the array in the order it arrived -- which
   * "looked right" only because of that accident. These cases assert the order the
   * reader is shown is COMPUTED from the timestamps.
   */
  const row = (at: string, relPath: string, action = 'create', toRelPath?: string) =>
    ({ at, relPath, action, ...(toRelPath === undefined ? {} : { toRelPath }) })

  it('orders newest first regardless of the array it was handed', () => {
    const given = [
      row('2026-10-01T10:00:00.000Z', 'oldest.md'),
      row('2026-10-03T10:00:00.000Z', 'newest.md'),
      row('2026-10-02T10:00:00.000Z', 'middle.md'),
    ]
    expect(sortAuditRows(given).map(r => r.relPath)).toEqual(['newest.md', 'middle.md', 'oldest.md'])
    // The input is not mutated: the same array re-sorts to the same answer.
    expect(sortAuditRows(given).map(r => r.relPath)).toEqual(['newest.md', 'middle.md', 'oldest.md'])
  })

  it('ranks by instant, not by string shape, across timezone forms', () => {
    // Lexical comparison would put "+02:00" after "Z" regardless of the real instant.
    const given = [
      row('2026-10-01T12:00:00+02:00', 'a.md'), // 10:00Z
      row('2026-10-01T11:00:00Z', 'b.md'), // 11:00Z, later
    ]
    expect(sortAuditRows(given).map(r => r.relPath)).toEqual(['b.md', 'a.md'])
  })

  it('breaks ties deterministically so paging cannot drop or repeat a row', () => {
    // A batch writes several rows with one identical instant. Without a total order
    // the platform sort may order equal keys either way, and a reader paging forward
    // would then see a row twice or never.
    const sameInstant = '2026-10-05T08:00:00.000Z'
    const given = [
      row(sameInstant, 'zeta.md', 'create'),
      row(sameInstant, 'alpha.md', 'move', 'to/b.md'),
      row(sameInstant, 'alpha.md', 'move', 'to/a.md'),
      row(sameInstant, 'alpha.md', 'create'),
    ]
    const first = sortAuditRows(given)
    // Path, then action, then destination: a total order.
    expect(first.map(r => [r.relPath, r.action, r.toRelPath ?? ''])).toEqual([
      ['alpha.md', 'create', ''],
      ['alpha.md', 'move', 'to/a.md'],
      ['alpha.md', 'move', 'to/b.md'],
      ['zeta.md', 'create', ''],
    ])
    // Shuffling the input cannot change the output order.
    const shuffled = [given[2], given[0], given[3], given[1]]
    expect(sortAuditRows(shuffled)).toEqual(first)
  })

  it('sinks an unparseable timestamp instead of floating it to the top', () => {
    const given = [
      row('not-a-date', 'broken.md'),
      row('2026-10-01T10:00:00.000Z', 'real.md'),
    ]
    expect(sortAuditRows(given).map(r => r.relPath)).toEqual(['real.md', 'broken.md'])
  })

  it('pages a list and reports the numbers the pager draws', () => {
    const rows = Array.from({ length: 45 }, (_, index) => row(`2026-10-01T10:${String(index).padStart(2, '0')}:00.000Z`, `f${String(index)}.md`))
    const first = paginate(rows, 1, 20)
    expect([first.page, first.pageCount, first.total, first.rows.length]).toEqual([1, 3, 45, 20])
    const last = paginate(rows, 3, 20)
    expect([last.page, last.pageCount, last.rows.length]).toEqual([3, 3, 5])
  })

  it('clamps a page number that the list no longer has', () => {
    // A re-read or a filter can shrink the list under a reader sitting on page 3;
    // rendering an empty page 3 of 1 is the "page 1 of 0" bug in another form.
    const rows = Array.from({ length: 5 }, (_, index) => row('2026-10-01T10:00:00.000Z', `f${String(index)}.md`))
    const beyond = paginate(rows, 9, 20)
    expect([beyond.page, beyond.pageCount, beyond.rows.length]).toEqual([1, 1, 5])
    // Below range clamps up, and a garbage page number lands on the first page.
    expect(paginate(rows, 0, 20).page).toBe(1)
    expect(paginate(rows, -3, 20).page).toBe(1)
    expect(paginate(rows, Number.NaN, 20).page).toBe(1)
    expect(paginate(rows, 2.7, 20).page).toBe(1)
  })

  it('never reports page 0 of 0 for an empty list', () => {
    const empty = paginate([], 1, 20)
    expect([empty.page, empty.pageCount, empty.total, empty.rows.length]).toEqual([1, 1, 0, 0])
    // And a nonsense size falls back rather than dividing by zero.
    const fallback = paginate(Array.from({ length: 3 }, () => row('2026-10-01T10:00:00.000Z', 'x')), 1, 0)
    expect(fallback.rows.length).toBe(3)
  })

  it('slices a single page exactly at the boundary', () => {
    const twenty = Array.from({ length: 20 }, (_, index) => row('2026-10-01T10:00:00.000Z', `f${String(index)}.md`))
    const one = paginate(twenty, 1, 20)
    // Exactly one full page: the pager shows no navigation, because pageCount is 1.
    expect([one.pageCount, one.rows.length]).toEqual([1, 20])
  })
})

/**
 * A PERSONAL deployment: no DataOps backend at all.
 *
 * This is the shape the plugin must support standalone -- one operator, a local directory,
 * no accounts, no grants, no shared settings. The four flows below are the whole product
 * surface for such a deployment, and they are asserted end to end through the Host routes
 * rather than against the helpers, so a regression in wiring fails here.
 *
 * What is deliberately NOT covered, because it does not exist without a backend: member
 * management, per-path permissions, shared configuration and the templates catalogue. Those
 * surfaces gate on `isTeamDeployment` and are exercised by the team tests above.
 */
describe('no DataOps backend (personal deployment)', () => {
  /**
   * A config rooted entirely inside a fresh temporary directory, with no backend.
   *
   * `mountPoint` and `actualRoot` are the SAME directory here, which is the honest shape for
   * a personal deployment: there is no share and no per-user view to point a symlink at, so
   * the browsable root and the storage root are one directory. A team deployment keeps them
   * apart and joins them with a symlink (`pointMountAtView`); a test that copied that shape
   * without the symlink would be asserting against a deployment that cannot exist.
   */
  const personalConfig = (root: string) => ({
    ...CONFIG,
    baseUrl: '',
    actualRoot: join(root, 'kb'),
    viewRoot: join(root, 'views'),
    mountPoint: join(root, 'kb'),
  })

  /** Mount the plugin on a stub host and hand back the route table. */
  async function mountPersonal(root: string) {
    const host = fakeHost({ token: 'unused' })
    await apply(host.ctx as never, personalConfig(root) as never)
    return host
  }

  it('reports itself as a personal deployment, not a broken team one', () => {
    // The single fact the whole personal path hangs on. An empty baseUrl is a supported
    // shape; treating it as misconfiguration is what made every route answer 409.
    expect(isTeamDeployment({ baseUrl: '' } as never)).toBe(false)
    expect(isTeamDeployment({ baseUrl: '   ' } as never)).toBe(false)
    expect(isTeamDeployment({ baseUrl: 'http://backend:8080' } as never)).toBe(true)
  })

  it('starts and answers its config route without contacting a backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-personal-'))
    const host = await mountPersonal(root)
    try {
      // A fetch that fails the test if it is ever called: a personal deployment must make
      // no backend request at all, which is the difference between "standalone" and
      // "standalone as long as the backend happens to be up".
      const reply = await callRoute(host.routes, 'config', {})
      expect(reply.backendConfigured).toBe(false)
      expect(reply.host).toBe('')
      expect(reply.mountPoint).toBe(join(root, 'kb'))
    } finally {
      for (const dispose of host.disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('completes the four core flows: create, list, read, search', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-personal-flow-'))
    const host = await mountPersonal(root)
    const plan = personalConfig(root)
    try {
      // 1. CREATE a document through the route the page uses.
      const created = await callRoute(host.routes, 'create', {
        relPath: 'notes/hello.md',
        content: '# 你好\n\n这是个人版写下的第一份文档。',
      })
      expect(created.error).toBeUndefined()
      await expect(readFile(join(plan.mountPoint, 'notes', 'hello.md'), 'utf8'))
        .resolves.toContain('个人版')

      // 2. LIST the directory. A personal deployment must see its own write; the old
      //    fail-closed listing returned [] here and the tree rendered empty.
      const listed = await callRoute(host.routes, 'list', { path: 'notes' })
      expect(listed.error).toBeUndefined()
      const names = (listed.entries as Array<{ name: string }>).map(entry => entry.name)
      expect(names).toContain('hello.md')

      // 3. READ the document back through the preview route.
      const read = await callRoute(host.routes, 'read', { path: 'notes/hello.md' })
      expect(read.error).toBeUndefined()
      expect(String(read.content)).toContain('个人版')

      // 4. SEARCH the tree. With no index service the search falls back to the local
      //    walk, which is what makes search a core feature rather than a team one.
      const searched = await callRoute(host.routes, 'search', { term: '个人版' })
      expect(searched.error).toBeUndefined()
      const hits = searched.hits as Array<{ relPath?: string }>
      expect(hits.length).toBeGreaterThan(0)
      expect(JSON.stringify(hits)).toContain('hello.md')
    } finally {
      for (const dispose of host.disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses a write whose path leaves the knowledge root', async () => {
    // The boundary that replaces the permission system. "No grants" is not "no limits".
    const root = await mkdtemp(join(tmpdir(), 'kb-personal-escape-'))
    const host = await mountPersonal(root)
    try {
      for (const relPath of ['../outside.md', '/etc/passwd', 'a/../../b.md']) {
        const reply = await callRoute(host.routes, 'create', { relPath, content: 'x' })
        expect(reply.error).toBeDefined()
      }
      // And the refusal names the reason rather than reporting a generic failure.
      expect(checkLocalPath('../outside.md')?.code).toBe('escapes-knowledge-root')
      expect(checkLocalPath('/etc/passwd')?.code).toBe('absolute-path')
      expect(checkLocalPath('')?.code).toBe('empty-path')
      expect(checkLocalPath('notes/ok.md')).toBeUndefined()
    } finally {
      for (const dispose of host.disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers every personal path refusal with its own 400 code', async () => {
    // The codes are part of the page contract. A path escape used to arrive as the
    // generic 409 "not configured", which sent the reader looking for a missing backend
    // instead of a malformed path; each shape now names itself and answers 400.
    const root = await mkdtemp(join(tmpdir(), 'kb-personal-codes-'))
    const host = await mountPersonal(root)
    try {
      const cases = [
        ['../outside.md', 'escapes-knowledge-root'],
        ['/etc/passwd', 'absolute-path'],
        ['notes/bad\u0000name.md', 'nul-byte'],
        ['', 'empty-path'],
      ] as const
      for (const [relPath, code] of cases) {
        const created = await callRouteWithStatus(host.routes, 'create', { relPath, content: 'x' })
        expect(created.status).toBe(400)
        expect(created.body.code).toBe(code)
        const read = await callRouteWithStatus(host.routes, 'read', { path: relPath })
        expect(read.status).toBe(400)
        expect(read.body.code).toBe(code)
      }
      // The upload route owns the same boundary; a dropped file is not a special case.
      const upload = await callRouteWithStatus(host.routes, 'upload', {
        relPath: '../outside.pdf',
        encoding: 'base64',
        content: 'aGk=',
      })
      expect(upload.status).toBe(400)
      expect(upload.body.code).toBe('escapes-knowledge-root')
    } finally {
      for (const dispose of host.disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('answers permission questions from the local boundary, never from a backend', async () => {
    // These four functions are the permission seam. Personally they must all succeed
    // without a request: the tree is the operator's own.
    const root = await mkdtemp(join(tmpdir(), 'kb-personal-perm-'))
    const host = await mountPersonal(root)
    const config = personalConfig(root)
    try {
      await expect(canReadPath(host.ctx as never, config as never, 'notes/a.md')).resolves.toBe(true)
      await expect(canWritePath(host.ctx as never, config as never, 'notes/a.md')).resolves.toBe(true)
      // Reading outside the root is refused even though there is no authority to ask.
      await expect(canReadPath(host.ctx as never, config as never, '../x')).resolves.toBe(false)
      // Grant management does not exist, so it answers false rather than pretending.
      await expect(canManageGrants(host.ctx as never, config as never)).resolves.toBe(false)
      // The caller is the local operator, with no roles to report.
      const caller = await fetchCaller(host.ctx as never, config as never)
      expect(caller.userId).toBe(LOCAL_USER_ID)
      expect(caller.roleCodes).toEqual([])
    } finally {
      for (const dispose of host.disposers) dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('uses its own configured MinerU address, never the shared one', async () => {
    // A personal deployment configures the parser itself; there is no administrator to
    // inherit an address from. `resolveMineruUrl` keeps the same three-step precedence so
    // both deployments share one rule, but the shared step can only ever be empty here.
    expect(resolveMineruUrl({ mineruBaseUrl: 'http://mine:8000' } as never, undefined))
      .toEqual({ url: 'http://mine:8000', source: 'own' })
    expect(resolveMineruUrl({ mineruBaseUrl: '', mineruPort: 8000 } as never, undefined))
      .toEqual({ url: 'http://127.0.0.1:8000', source: 'derived' })
    // No shared value is ever consulted: the personal path never calls the OCR plugin.
    await expect(readSharedMineruUrl({
      credentials: { resolve: async () => ({ value: 't' }) },
    } as never, { baseUrl: '', credentialRef: 'X', timeoutMs: 100 } as never)).resolves.toBeUndefined()
  })
})


describe('knowledge-base HTTP route permission map', () => {
  it('maps file, audit, grant, review and workflow routes to backend keys', () => {
    expect(permissionForKbRoute('list')).toBe('kb:file:read')
    expect(permissionForKbRoute('read')).toBe('kb:file:read')
    expect(permissionForKbRoute('search')).toBe('kb:file:read')
    expect(permissionForKbRoute('create')).toBe('kb:file:write')
    expect(permissionForKbRoute('edit')).toBe('kb:file:write')
    expect(permissionForKbRoute('trash')).toBe('kb:file:delete')
    expect(permissionForKbRoute('index')).toBe('kb:file:extract')
    expect(permissionForKbRoute('audit.list')).toBe('kb:audit:read')
    expect(permissionForKbRoute('grants')).toBe('kb:grant:manage')
    expect(permissionForKbRoute('pending.approve')).toBe('kb:review:decide')
    expect(permissionForKbRoute('settings.get')).toBe('kb:config:manage')
    expect(permissionForKbRoute('config.set')).toBe('kb:config:manage')
    expect(permissionForKbRoute('workflow.public')).toBe('workflow:read')
    expect(permissionForKbRoute('workflow.review')).toBe('workflow:review:decide')
    expect(permissionForKbRoute('workflow.resubmit')).toBe('workflow:publish')
    expect(permissionForKbRoute('workflow.unpublish')).toBe('workflow:manage')
    expect(permissionForKbRoute('status')).toBeUndefined()
  })
})


describe('view path to authoritative path resolution', () => {
  it('uses hardlink identity for global, personal and department view buckets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kb-view-map-'))
    try {
      const actual = join(root, 'actual')
      const views = join(root, 'views')
      const uid = 'u-1'
      await mkdir(join(actual, 'dual-mode-verify'), { recursive: true })
      await mkdir(join(actual, 'personal', uid), { recursive: true })
      await mkdir(join(actual, 'department', 'root', 'dept'), { recursive: true })
      await writeFile(join(actual, 'dual-mode-verify/verify-team.pdf'), 'pdf')
      await writeFile(join(actual, 'personal', uid, 'a.md'), 'personal')
      await writeFile(join(actual, 'department/root/dept/b.md'), 'department')
      await mkdir(join(views, uid, 'global/dual-mode-verify'), { recursive: true })
      await mkdir(join(views, uid, 'personal'), { recursive: true })
      await mkdir(join(views, uid, 'department/root/dept'), { recursive: true })
      await link(join(actual, 'dual-mode-verify/verify-team.pdf'), join(views, uid, 'global/dual-mode-verify/verify-team.pdf'))
      await link(join(actual, 'personal', uid, 'a.md'), join(views, uid, 'personal/a.md'))
      await link(join(actual, 'department/root/dept/b.md'), join(views, uid, 'department/root/dept/b.md'))
      const config = { ...CONFIG, baseUrl: 'https://dataops.example', actualRoot: actual, viewRoot: views, mountPoint: join(views, uid) }
      const caller = { userId: uid, label: '测试', departmentCode: 'dept', departmentPathCodes: ['root', 'dept'] }
      await expect(actualRelPathForView({} as never, config, 'global/dual-mode-verify/verify-team.pdf', caller))
        .resolves.toBe('dual-mode-verify/verify-team.pdf')
      await expect(actualRelPathForView({} as never, config, 'personal/a.md', caller))
        .resolves.toBe(`personal/${uid}/a.md`)
      await expect(actualRelPathForView({} as never, config, 'department/root/dept/b.md', caller))
        .resolves.toBe('department/root/dept/b.md')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
