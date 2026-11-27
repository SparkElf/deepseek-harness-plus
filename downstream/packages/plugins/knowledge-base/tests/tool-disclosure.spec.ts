// @ts-nocheck
import { describe, expect, it, vi } from 'vitest'
import {
  KB_TOOL_ACCESS,
  KNOWLEDGE_TOOL_NAMES,
  TOOL_GROUPS,
  TOOL_GROUPS_OF,
  createToolDisclosure,
  decideToolAccess,
  type ToolRegistryLike,
} from '../src/toolDisclosure.ts'
import { createKnowledgeFileTools } from '../src/knowledgeTools.ts'
import { createKnowledgeGraphTools } from '../src/graphTools.ts'
import { createMemoryTools } from '../src/memoryTools.ts'
import { createMemoryGuardianTools } from '../src/memoryGuardianTool.ts'
import { createMemoryRecordTools } from '../src/memoryRecordTool.ts'
import {
  DEFAULT_DSH_PERMISSIONS,
  createManagementTools,
  defaultPermissionsForRoles,
  type ManagementContext,
} from '../src/managementTools.ts'

const ALL_PERMISSIONS = [...new Set(Object.values(DEFAULT_DSH_PERMISSIONS).flat())]

/** The real tool set, built through the same factories `apply` uses. */
const toolDefinitions = () => [
  // `workflow_publish` is defined inline in index.ts; the policy map is keyed by
  // name, so the definition itself only needs the name for this test.
  { name: 'workflow_publish' } as never,
  ...createKnowledgeFileTools({} as never),
  ...createManagementTools({} as never),
  // The graph tools are registered through the same coordinator `apply` builds.
  ...createKnowledgeGraphTools({} as never),
  // Runtime memory tools share the disclosure map; their host is only touched at execute time.
  ...createMemoryTools({} as never),
  ...createMemoryGuardianTools({} as never),
  ...createMemoryRecordTools({} as never),
]

/** An ordinary caller with an explicit permission list and no role capability. */
const caller = (
  permissions: readonly string[],
  overrides: Partial<ManagementContext> = {},
): ManagementContext => ({
  userId: 'u1',
  roleCodes: ['APP_USER'],
  permissions: [...permissions],
  dataScope: { all: false, self: true, departmentCodes: [] },
  review: { canReview: false, canReviewGlobal: false, canManagePermissions: false, departments: [] },
  ...overrides,
})

/** A caller holding the given keys plus the global-admin capability flags. */
const admin = (permissions: readonly string[] = ALL_PERMISSIONS): ManagementContext => caller(permissions, {
  roleCodes: ['SUPER_ADMIN'],
  dataScope: { all: true, self: true, departmentCodes: [] },
  review: { canReview: true, canReviewGlobal: true, canManagePermissions: true, departments: [] },
})

/** A department reviewer: reviewer capability without global data scope or config keys. */
const deptAdmin = (permissions: readonly string[] = defaultPermissionsForRoles(['DEPT_ADMIN'])): ManagementContext => caller(permissions, {
  roleCodes: ['DEPT_ADMIN'],
  departmentCode: 'data-platform',
  dataScope: { all: false, self: true, departmentCodes: ['data-platform'] },
  review: { canReview: true, canReviewGlobal: false, canManagePermissions: false, departments: ['data-platform'] },
})

/** A registry stub recording exactly what the coordinator registered. */
function makeRegistry(): {
  registry: ToolRegistryLike
  names: () => string[]
  registrations: string[]
  disposed: string[]
} {
  const live = new Map<string, () => void>()
  const registrations: string[] = []
  const disposed: string[] = []
  const registry: ToolRegistryLike = {
    register(definition) {
      registrations.push(definition.name)
      const dispose = (): void => {
        disposed.push(definition.name)
        live.delete(definition.name)
      }
      live.set(definition.name, dispose)
      return dispose
    },
  }
  return {
    registry,
    names: () => [...live.keys()].sort(),
    registrations,
    disposed,
  }
}

function makeCoordinator(
  context: () => Promise<ManagementContext>,
  tools = toolDefinitions(),
): { coordinator: ReturnType<typeof createToolDisclosure>; registry: ReturnType<typeof makeRegistry> } {
  const registry = makeRegistry()
  const coordinator = createToolDisclosure({
    tools,
    registry: registry.registry,
    resolveContext: context,
  })
  return { coordinator, registry }
}

describe('tool disclosure policy map', () => {
  it('covers every model-facing tool and names it exactly once', () => {
    const names = toolDefinitions().map(definition => definition.name).sort()
    expect(names).toHaveLength(36)
    expect(Object.keys(KB_TOOL_ACCESS).sort()).toEqual(names)
    expect([...KNOWLEDGE_TOOL_NAMES].sort()).toEqual(names)
    // No group may silently lose a tool.
    const grouped = TOOL_GROUPS.flatMap(group => TOOL_GROUPS_OF[group]).sort()
    expect(grouped).toEqual(names)
  })

  it('groups tools by the permission surface they belong to', () => {
    expect([...TOOL_GROUPS_OF.read].sort()).toEqual([
      'kb_chunk_get', 'kb_outline', 'kb_outline_rewrite', 'kb_search', 'kb_vectorize', 'kg_get', 'memory_context',
      'memory_guardian_send', 'workflow_list',
    ])
    expect([...TOOL_GROUPS_OF.write].sort()).toEqual([
      'kb_file_delete', 'kb_file_extract', 'kb_file_mkdir', 'kb_file_move', 'kb_file_write', 'kb_outline_save',
      'kg_add', 'kg_del', 'kg_set', 'memory_promote_sop', 'memory_record',
    ])
    expect([...TOOL_GROUPS_OF.manage].sort()).toEqual([
      'kb_audit_list', 'kb_config_get', 'kb_config_update', 'kb_grant_list', 'kb_grant_set',
      'kb_index_rebuild', 'kb_review_decide', 'kb_review_list', 'kb_sync', 'memory_guardian_run',
      'workflow_review_decide', 'workflow_review_list', 'workflow_review_scan', 'workflow_unpublish',
    ])
    expect([...TOOL_GROUPS_OF.publish].sort()).toEqual(['workflow_publish', 'workflow_update'])
  })

  it('refuses to construct from a tool set the policy does not describe', () => {
    expect(() => createToolDisclosure({
      tools: [{ name: 'kb_unknown' } as never],
      registry: makeRegistry().registry,
      resolveContext: async () => admin(),
    })).toThrow(/no policy for kb_unknown/)
    expect(() => createToolDisclosure({
      tools: toolDefinitions().filter(definition => definition.name !== 'kb_search'),
      registry: makeRegistry().registry,
      resolveContext: async () => admin(),
    })).toThrow(/policy without a tool for kb_search/)
  })
})

describe('decideToolAccess', () => {
  it('fails closed when there is no permission context', () => {
    expect(decideToolAccess('kb_search', undefined)).toEqual({
      allowed: false,
      group: 'read',
      missing: ['permission-context'],
    })
    expect(decideToolAccess('not-a-tool', admin())).toEqual({
      allowed: false,
      missing: ['disclosure-policy'],
    })
  })

  it('shows read tools to any caller holding the read key', () => {
    const reader = caller(['kb:file:read'])
    expect(decideToolAccess('kb_search', reader).allowed).toBe(true)
    expect(decideToolAccess('kb_outline', reader).allowed).toBe(true)
    expect(decideToolAccess('kb_file_write', reader)).toEqual({
      allowed: false,
      group: 'write',
      missing: ['kb:file:write'],
    })
    expect(decideToolAccess('kb_config_get', reader).missing).toEqual(['kb:config:manage'])
  })

  it('does not let a knowledge read key open the workflow read surface', () => {
    expect(decideToolAccess('workflow_list', caller(['kb:file:read'])).allowed).toBe(false)
    expect(decideToolAccess('workflow_list', caller(['workflow:read'])).allowed).toBe(true)
  })

  it('requires the exact editing key per write tool', () => {
    const writer = caller(['kb:file:read', 'kb:file:write'])
    expect(decideToolAccess('kb_file_write', writer).allowed).toBe(true)
    expect(decideToolAccess('kb_outline_save', writer).allowed).toBe(true)
    expect(decideToolAccess('kb_file_delete', writer).missing).toEqual(['kb:file:delete'])
    expect(decideToolAccess('kb_file_extract', writer).missing).toEqual(['kb:file:extract'])
    const extractor = caller(['kb:file:read', 'kb:file:extract'])
    expect(decideToolAccess('kb_file_extract', extractor).allowed).toBe(true)
    expect(decideToolAccess('kb_file_write', extractor).allowed).toBe(false)
  })

  it('withholds index upkeep from a department reviewer without config:manage', () => {
    const dept = deptAdmin()
    expect(decideToolAccess('kb_sync', dept).allowed).toBe(true)
    expect(decideToolAccess('kb_index_rebuild', dept)).toEqual({
      allowed: false,
      group: 'manage',
      missing: ['kb:config:manage'],
    })
  })

  it('withholds reviewer tools from a user holding every file key', () => {
    const powerUser = caller(['kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract'])
    expect(decideToolAccess('kb_sync', powerUser)).toEqual({
      allowed: false,
      group: 'manage',
      missing: ['reviewer'],
    })
    expect(decideToolAccess('workflow_review_list', powerUser).missing).toEqual(['workflow:review:decide'])
  })

  it('allows every tool for a global administrator with the full key set', () => {
    const root = admin()
    for (const name of KNOWLEDGE_TOOL_NAMES) {
      expect(decideToolAccess(name, root)).toMatchObject({ allowed: true })
    }
  })
})

describe('ToolDisclosureCoordinator', () => {
  it('registers nothing for a caller with no permissions', async () => {
    const { coordinator, registry } = makeCoordinator(async () => caller([]))
    const snapshot = await coordinator.syncToolDisclosure()
    expect(registry.names()).toEqual([])
    expect(snapshot.registered).toEqual([])
    expect(snapshot.denied).toHaveLength(KNOWLEDGE_TOOL_NAMES.length)
    expect(snapshot.activeGroups).toEqual([])
  })

  it('registers exactly the read group for a reader and adds write for an editor', async () => {
    const reader = caller(['kb:file:read', 'workflow:read'])
    const { coordinator, registry } = makeCoordinator(async () => reader)
    const readSnapshot = await coordinator.syncToolDisclosure()
    expect(registry.names()).toEqual([...TOOL_GROUPS_OF.read].sort())
    expect(readSnapshot.activeGroups).toEqual(['read'])

    const editor = caller([
      'kb:file:read', 'kb:file:write', 'kb:file:delete', 'kb:file:extract', 'workflow:read',
    ])
    const { coordinator: editorCoordinator, registry: editorRegistry } = makeCoordinator(async () => editor)
    const editorSnapshot = await editorCoordinator.syncToolDisclosure()
    expect(editorRegistry.names()).toEqual([...TOOL_GROUPS_OF.read, ...TOOL_GROUPS_OF.write].sort())
    expect(editorSnapshot.activeGroups).toEqual(['read', 'write'])
    expect(editorRegistry.names()).not.toContain('kb_config_get')
  })

  it('registers every group for the administrator context', async () => {
    const { coordinator, registry } = makeCoordinator(async () => admin())
    const snapshot = await coordinator.syncToolDisclosure()
    expect(registry.names()).toEqual([...KNOWLEDGE_TOOL_NAMES].sort())
    expect(snapshot.activeGroups).toEqual([...TOOL_GROUPS])
  })

  it('follows the shipped role defaults for APP_USER and DEPT_ADMIN', async () => {
    const appUser = caller(defaultPermissionsForRoles(['APP_USER']))
    const { coordinator: appCoordinator, registry: appRegistry } = makeCoordinator(async () => appUser)
    const appSnapshot = await appCoordinator.syncToolDisclosure()
    expect(appRegistry.names()).toEqual(expect.arrayContaining([
      'kb_search', 'kb_file_write', 'kb_file_extract', 'workflow_publish', 'workflow_list',
    ]))
    expect(appSnapshot.activeGroups).toEqual(['read', 'write', 'publish'])
    expect(appRegistry.names()).not.toContain('kb_config_get')
    expect(appRegistry.names()).not.toContain('kb_review_decide')
    expect(appRegistry.names()).not.toContain('workflow_unpublish')

    const dept = deptAdmin()
    const { coordinator: deptCoordinator, registry: deptRegistry } = makeCoordinator(async () => dept)
    const deptSnapshot = await deptCoordinator.syncToolDisclosure()
    expect(deptRegistry.names()).toEqual(expect.arrayContaining([
      'kb_sync', 'kb_review_decide', 'kb_grant_list', 'workflow_review_decide', 'workflow_unpublish',
    ]))
    expect(deptSnapshot.activeGroups).toEqual([...TOOL_GROUPS])
    expect(deptRegistry.names()).not.toContain('kb_config_get')
    expect(deptRegistry.names()).not.toContain('kb_index_rebuild')
  })

  it('disposes tools that a changed context no longer allows and re-registers on the way back', async () => {
    let current = caller(['kb:file:read'])
    const { coordinator, registry } = makeCoordinator(async () => current)
    await coordinator.syncToolDisclosure()
    expect(registry.names()).toEqual([...TOOL_GROUPS_OF.read].filter(name => name !== 'workflow_list').sort())

    current = admin()
    await coordinator.syncToolDisclosure()
    expect(registry.names()).toEqual([...KNOWLEDGE_TOOL_NAMES].sort())
    expect(registry.disposed).toEqual([])

    current = caller(['kb:file:read'])
    await coordinator.syncToolDisclosure()
    expect(registry.disposed).toEqual(expect.arrayContaining(['kb_file_write', 'kb_config_get', 'workflow_publish']))
    expect(registry.names()).toEqual([...TOOL_GROUPS_OF.read].filter(name => name !== 'workflow_list').sort())
    expect([...coordinator.registeredTools].sort()).toEqual(registry.names())
  })

  it('does not re-register unchanged tools when the same context is synced twice', async () => {
    const { coordinator, registry } = makeCoordinator(async () => admin())
    await coordinator.syncToolDisclosure()
    const afterFirst = registry.registrations.length
    await coordinator.syncToolDisclosure()
    expect(registry.registrations).toHaveLength(afterFirst)
    expect(registry.disposed).toEqual([])
  })

  it('applies a context supplied by a route without a second resolver round trip', async () => {
    const resolveContext = vi.fn(async () => admin())
    const registry = makeRegistry()
    const coordinator = createToolDisclosure({
      tools: toolDefinitions(),
      registry: registry.registry,
      resolveContext,
    })
    await coordinator.syncToolDisclosure(caller(['kb:file:read']))
    expect(resolveContext).not.toHaveBeenCalled()
    expect(registry.names()).toEqual([...TOOL_GROUPS_OF.read].filter(name => name !== 'workflow_list').sort())
  })

  it('disposes every tool when the permission context cannot be resolved', async () => {
    let fail = false
    const { coordinator, registry } = makeCoordinator(async () => {
      if (fail) throw new Error('DataOps review context unavailable')
      return admin()
    })
    await coordinator.syncToolDisclosure()
    expect(registry.names()).toHaveLength(36)

    fail = true
    const snapshot = await coordinator.syncToolDisclosure()
    expect(snapshot.error).toBe('DataOps review context unavailable')
    expect(snapshot.registered).toEqual([])
    expect(registry.names()).toEqual([])
    expect(registry.disposed).toHaveLength(36)
  })

  it('reports every registration failure as a denial instead of claiming it is live', async () => {
    const coordinator = createToolDisclosure({
      tools: toolDefinitions(),
      registry: { register() { throw new Error('duplicate tool name') } },
      resolveContext: async () => admin(),
    })
    const snapshot = await coordinator.syncToolDisclosure()
    expect(snapshot.registered).toEqual([])
    expect(snapshot.denied).toHaveLength(36)
    expect(snapshot.denied[0]?.missing).toEqual(['register-failed'])
    expect(coordinator.registeredTools).toEqual([])
  })

  it('disposes every registration and makes later refreshes no-ops', async () => {
    const { coordinator, registry } = makeCoordinator(async () => admin())
    await coordinator.syncToolDisclosure()
    expect(registry.names()).toHaveLength(36)
    coordinator.dispose()
    expect(registry.names()).toEqual([])
    const snapshot = await coordinator.syncToolDisclosure(admin())
    expect(snapshot.registered).toEqual([])
    expect(snapshot.error).toMatch(/disposed/)
  })
})
