/**
 * Skill center — host half. Serves the skill-center data source over the
 * `/api/dsh-skill-center` route family: list grouped by source, enable or disable
 * model invocation, create, delete into a recoverable trash, and health.
 *
 * Reading goes through the official `ctx.skills` registry, so the catalog, its
 * provider precedence, and its hot reload are the harness's rather than a second
 * scanner's. The three writes have no official equivalent — the registry is
 * read-only — so they are implemented here against the skill file's YAML
 * frontmatter.
 *
 * @module @sparkelf/dsh-client-ui-skill-center
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pull in the `ctx.skills` and `ctx.sessions` service merges the
// `inject` list names, so the plugin body reads them with their declarations.
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-session'

/** Stable cordis plugin name. */
export const name = 'ui-skill-center'

/** Services required before the routes can mount. */
export const inject = ['webServer', 'skills', 'sessions']

/** Route paths, mirrored by the browser half. */
export const ROUTES = {
  list: '/api/dsh-skill-center/list',
  setEnabled: '/api/dsh-skill-center/set-enabled',
  create: '/api/dsh-skill-center/create',
  delete: '/api/dsh-skill-center/delete',
  health: '/api/dsh-skill-center/health',
} as const

/** Plugin configuration. */
export interface Config {
  /** Extra custom skill root directories. */
  customSkillDirs?: string[]
  /** User dsh config root; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** User agents config root; defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
}

/** One source group, in display order. */
interface SourceGroup {
  readonly key: string
  readonly title: string
  readonly hint: string
}

/**
 * Groups the panel renders, in order. The level a skill resolves to selects its
 * group; anything matching no convention lands in the custom group.
 */
const SOURCE_GROUPS: readonly SourceGroup[] = [
  { key: 'bundled', title: '系统内置', hint: '随 Harness 一同安装，不能删除' },
  { key: 'runtime', title: '运行时注册', hint: '由已安装的插件在运行时注册' },
  { key: 'user-agents', title: '用户 ~/.agents/skills', hint: '在用户 agents 目录下，对所有项目生效' },
  { key: 'user-dsh', title: '用户 ~/.dsh/skills', hint: '在用户 dsh 目录下，对所有项目生效' },
  { key: 'project-agents', title: '项目 .agents/skills', hint: '随项目提交，对协作者共享' },
  { key: 'project-dsh', title: '项目 .dsh/skills', hint: '项目本地技能，通常不提交' },
  { key: 'custom', title: '自定义目录', hint: '由本插件的 customSkillDirs 配置' },
]

/** A skill row as the panel receives it. */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  provider?: string
  level: string
  path?: string
  /** True when the skill resolves through a symlink; deletion is refused. */
  linked?: boolean
  modelInvocable: boolean
  userInvocable: boolean
  workspaceRoot?: string
  workspaceName?: string
  isActiveWorkspace?: boolean
}

/** One rendered group. */
export interface GroupPayload {
  key: string
  title: string
  hint: string
  skills: SkillEntry[]
}

/** One selectable workspace. */
export interface WorkspaceItem {
  root: string
  name: string
  active: boolean
}

/** The list route's payload. */
export interface ListPayload {
  cwd: string
  projectRoots: string[]
  complete: boolean
  groups: GroupPayload[]
  workspaces?: WorkspaceItem[]
}

/**
 * The user skill root convention.
 * @param dshHome - the user's dsh config root, usually `~/.dsh`.
 * @returns the directory holding user-level skills.
 */
export function userSkillRoot(dshHome: string): string {
  return join(dshHome, 'skills')
}

/**
 * The project skill root convention.
 * @param projectRoot - the project's root directory.
 * @returns the directory holding that project's skills.
 */
export function projectSkillRoot(projectRoot: string): string {
  return join(projectRoot, '.dsh', 'skills')
}

/**
 * The nearest ancestor holding a `.git` entry.
 * @param cwd - the directory to search upward from.
 * @returns the project root, or `cwd` itself when no ancestor holds `.git`.
 */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  for (;;) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * The display group a skill belongs to.
 *
 * The registry summary reports a discovery source rather than a file path, so
 * grouping follows the source name the filesystem provider assigns to each root
 * it scans. An unrecognized source falls through to the custom group.
 * @param source - the registry's discovery source label.
 * @param provider - the provider that owns the skill body.
 * @returns the group key.
 */
export function levelOfSource(source: string, provider: string): string {
  if (provider === 'runtime') return 'runtime'
  const s = source.toLowerCase()
  if (s.includes('bundled')) return 'bundled'
  if (s.includes('.agents')) return 'project-agents'
  if (s.includes('.dsh')) return 'project-dsh'
  if (s.includes('agents')) return 'user-agents'
  if (s.includes('dsh')) return 'user-dsh'
  if (s.includes('runtime')) return 'runtime'
  return 'custom'
}

/**
 * Read `disable-model-invocation` from a skill file.
 * @param source - the skill file's content.
 * @returns the flag when the frontmatter declares it, otherwise undefined.
 */
export function readDisabledFlag(source: string): boolean | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (match === null) return undefined
  const line = /^\s*disable-model-invocation\s*:\s*(true|false)\s*$/m.exec(match[1] ?? '')
  return line === null ? undefined : line[1] === 'true'
}

/**
 * Rewrite `disable-model-invocation`, adding it when absent.
 *
 * The field is one YAML scalar in the leading frontmatter block, so this edits
 * that line rather than re-serializing the document: comments, key order, and
 * the body all survive unchanged.
 * @param source - the skill file's current content.
 * @param disabled - the value to write.
 * @returns the new content.
 */
export function withDisabledFlag(source: string, disabled: boolean): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(source)
  if (match === null) {
    return '---\ndisable-model-invocation: ' + String(disabled) + '\n---\n' + source
  }
  const body = match[2] ?? ''
  const field = /^\s*disable-model-invocation\s*:.*$/m
  const next = field.test(body)
    ? body.replace(field, 'disable-model-invocation: ' + String(disabled))
    : body + '\ndisable-model-invocation: ' + String(disabled)
  return (match[1] ?? '---\n') + next + (match[3] ?? '\n---') + source.slice(match[0].length)
}

/**
 * Build the SKILL.md a create writes.
 * @param name - the skill's kebab-case name.
 * @param description - the routing description.
 * @param whenToUse - extra routing guidance, omitted when undefined.
 * @param content - the instruction body; an empty value yields a heading.
 * @returns the complete file content.
 */
export function buildSkillContent(
  name: string,
  description: string,
  whenToUse: string | undefined,
  content: string,
): string {
  const lines = ['---', 'name: ' + name, 'description: ' + description]
  if (whenToUse !== undefined && whenToUse.trim() !== '') lines.push('when-to-use: ' + whenToUse)
  lines.push('---', '')
  lines.push(content.trim() === '' ? '# ' + name : content.trim())
  return lines.join('\n') + '\n'
}

/** The routes' dependencies, injectable for tests. */
export interface SkillRoutesDeps {
  dshHome: string
  agentsHome: string
  customSkillDirs: string[]
  /** The official registry's summaries for a workspace, already bound to the viewing context. */
  snapshotProject(cwd: string): Promise<{ skills: SkillSummary[]; complete: boolean }>
  /**
   * One skill's absolute file path, or undefined when it has none.
   *
   * The registry's summaries deliberately omit the path — they are
   * invocation-neutral metadata — so the write routes resolve it through
   * `get()` when an action actually needs to touch a file. `collect()` caches
   * the catalog these calls share, so the resolve is not a second scan.
   */
  pathOf(name: string, cwd: string): Promise<string | undefined>
  activeSessionCwds(): string[]
  logger: { warn(error: unknown): void }
}

/** The registry summary this route family reads, re-exported for its callers. */
export type { SkillSummary }

/** Write a JSON response. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(text)) })
  res.end(text)
}

/** Read a bounded JSON request body. */
async function readJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buf.length
    if (total > maxBytes) throw new Error('request body too large')
    chunks.push(buf)
  }
  if (total === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

/** The list handler: group the registry snapshot by source. */
async function handleList(deps: SkillRoutesDeps, cwd: string): Promise<ListPayload> {
  const projectRoots = [...new Set(deps.activeSessionCwds().map(findProjectRoot).concat(findProjectRoot(cwd)))]
  const snapshot = await deps.snapshotProject(cwd)
  const byGroup = new Map<string, SkillEntry[]>(SOURCE_GROUPS.map(g => [g.key, []]))
  for (const skill of snapshot.skills) {
    // The summary carries the discovery source but not the file path, so the
    // group is derived from the source the registry already resolved.
    const level = levelOfSource(skill.source, skill.provider)
    const entry: SkillEntry = {
      name: skill.name,
      description: skill.description,
      level,
      provider: skill.provider,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
      ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    }
    ;(byGroup.get(level) ?? byGroup.get('custom'))?.push(entry)
  }
  const groups: GroupPayload[] = []
  for (const g of SOURCE_GROUPS) {
    const skills = (byGroup.get(g.key) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    if (skills.length > 0) groups.push({ key: g.key, title: g.title, hint: g.hint, skills })
  }
  return { cwd, projectRoots, complete: snapshot.complete, groups }
}

/** The set-enabled handler: rewrite the skill's frontmatter flag. */
async function handleSetEnabled(deps: SkillRoutesDeps, body: Record<string, unknown>, cwd: string): Promise<unknown> {
  const name = requireString(body.name, 'name')
  const path = await resolveSkillPath(deps, name, body, cwd)
  const enabled = body.enabled === true
  const source = await readFile(path, 'utf8')
  const before = readDisabledFlag(source)
  const next = withDisabledFlag(source, !enabled)
  if (next !== source) await writeFile(path, next, 'utf8')
  return { name: requireString(body.name, 'name'), enabled, modelInvocable: enabled, changed: before !== !enabled }
}

/** The create handler: write a new SKILL.md under the chosen root. */
async function handleCreate(deps: SkillRoutesDeps, body: Record<string, unknown>): Promise<unknown> {
  const root = body.root === 'project' ? 'project' : 'user'
  const skillName = requireString(body.name, 'name')
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) throw new Error('skill name must be kebab-case')
  const base = root === 'project'
    ? projectSkillRoot(deps.activeSessionCwds()[0] ?? process.cwd())
    : userSkillRoot(deps.dshHome)
  const dir = join(base, skillName)
  const target = join(dir, 'SKILL.md')
  await mkdir(dir, { recursive: true })
  await writeFile(target, buildSkillContent(
    skillName,
    requireString(body.description, 'description'),
    typeof body.whenToUse === 'string' ? body.whenToUse : undefined,
    typeof body.content === 'string' ? body.content : '',
  ), 'utf8')
  return { ok: true, name: skillName, path: target }
}

/** The delete handler: move the skill directory into a recoverable trash. */
async function handleDelete(deps: SkillRoutesDeps, body: Record<string, unknown>, cwd: string): Promise<unknown> {
  const path = await resolveSkillPath(deps, requireString(body.name, 'name'), body, cwd)
  if (!existsSync(path)) throw new Error('skill file not found')
  const dir = dirname(path)
  const trash = join(dirname(dir), '.trash', String(Date.now()) + '-' + (body.name === undefined ? 'skill' : String(body.name)))
  await mkdir(dirname(trash), { recursive: true })
  await rename(dir, trash)
  return { ok: true, moved: trash }
}

/** The workspace a request is about: its own `cwd` query, else the first active session's. */
function currentCwd(deps: SkillRoutesDeps, req: IncomingMessage): string {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const asked = url.searchParams.get('cwd')
    if (asked !== null && asked !== '') return asked
  } catch {
    // A malformed URL falls back to the active session's workspace.
  }
  return deps.activeSessionCwds()[0] ?? process.cwd()
}

/** One required string field. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new Error('missing ' + field)
  return value
}

/**
 * The absolute file path a write should touch.
 *
 * A caller-supplied path is honoured so the panel can act on the exact file it
 * listed; otherwise the registry resolves it, which is also what rejects a
 * skill the registry does not know.
 * @param deps - the route dependencies.
 * @param name - the skill name.
 * @param body - the request body, which may carry an explicit path.
 * @param cwd - the workspace the caller is viewing.
 * @returns the resolved path.
 * @throws when the skill has no file (a virtual or runtime-registered skill).
 */
async function resolveSkillPath(
  deps: SkillRoutesDeps,
  name: string,
  body: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  if (typeof body.path === 'string' && body.path !== '') return body.path
  const path = await deps.pathOf(name, cwd)
  if (path === undefined) throw new Error('skill "' + name + '" has no file on disk')
  return path
}

/**
 * Build the skill-center routes.
 * @param deps - resolved roots, the registry snapshot, and the session list.
 * @returns the routes for `ctx.webServer.register`.
 */
export function makeRoutes(deps: SkillRoutesDeps): WebRoute[] {
  return [
    { kind: 'exact', path: ROUTES.health, handler: (_req, res) => writeJson(res, 200, { ok: true }) },
    {
      kind: 'exact',
      path: ROUTES.list,
      handler: async (req, res) => {
        try {
          writeJson(res, 200, await handleList(deps, currentCwd(deps, req)))
        } catch (error) {
          deps.logger.warn(error)
          writeJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.setEnabled,
      handler: async (req, res) => {
        const cwd = currentCwd(deps, req)
        try { writeJson(res, 200, await handleSetEnabled(deps, await readJson(req, 1 << 20), cwd)) } catch (error) {
          deps.logger.warn(error)
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.create,
      handler: async (req, res) => {
        try { writeJson(res, 200, await handleCreate(deps, await readJson(req, 1 << 20))) } catch (error) {
          deps.logger.warn(error)
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
    {
      kind: 'exact',
      path: ROUTES.delete,
      handler: async (req, res) => {
        const cwd = currentCwd(deps, req)
        try { writeJson(res, 200, await handleDelete(deps, await readJson(req, 1 << 20), cwd)) } catch (error) {
          deps.logger.warn(error)
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]
}

/**
 * Mount the skill-center routes.
 * @param ctx - host context carrying `webServer`, `skills`, and `sessions`.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const dshHome = config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const agentsHome = config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents')
  const deps: SkillRoutesDeps = {
    dshHome,
    agentsHome,
    customSkillDirs: config.customSkillDirs ?? [],
    snapshotProject: cwd => ctx.skills.snapshot({ cwd }).then(s => ({ skills: s.skills, complete: s.complete })),
    pathOf: async (name, cwd) => (await ctx.skills.get(name, { cwd }))?.path,
    activeSessionCwds: () => ctx.sessions.list()
      .map(s => s.header.cwd)
      .filter((c): c is string => typeof c === 'string' && c !== ''),
    logger: { warn: (error: unknown) => { ctx.logger.warn(error) } },
  }
  for (const route of makeRoutes(deps)) ctx.effect(() => ctx.webServer.register(route), 'ui-skill-center: route ' + route.path)
}
