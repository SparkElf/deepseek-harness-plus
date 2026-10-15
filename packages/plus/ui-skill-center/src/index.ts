/**
 * Skill center — host half. Serves the skill-center data source over the
 * `/api/dsh-skill-center` route family: list grouped by source, read one skill's
 * body, enable or disable model invocation, create, delete into a recoverable
 * trash, and health.
 *
 * Reading goes through the official `ctx.skills` registry, so the catalog, its
 * provider precedence, and its hot reload are the harness's rather than a second
 * scanner's. The three writes have no official equivalent — the registry is
 * read-only — so they are implemented here against the skill file's YAML
 * frontmatter.
 *
 * @module @sparkelf/dsh-client-ui-skill-center
 */
import { existsSync, lstatSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
// Type-only: pull in the `ctx.skills` and `ctx.sessions` service merges the
// `inject` list names, so the plugin body reads them with their declarations.
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-session'
import { readSkillTranslation, readTranslationProgress } from './translations.ts'
import type { SkillTranslation } from './translations.ts'

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
  content: '/api/dsh-skill-center/content',
  health: '/api/dsh-skill-center/health',
  translationProgress: '/api/dsh-skill-center/translation-progress',
} as const

/** Plugin configuration. */
export interface Config {
  /** Extra custom skill root directories. */
  customSkillDirs?: string[]
  /** User dsh config root; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** User agents config root; defaults to `$DSH_AGENTS_HOME` or `~/.agents`. */
  agentsHome?: string
  /**
   * Skill set whose `<skill>/i18n/zh.json` files supply the panel's Chinese copy.
   *
   * A skill that resolves through a symlink into another repository keeps its
   * translation in that repository, not in the deployment, so this names the
   * checkout that holds the translated set. Unset means English only.
   */
  translationRoot?: string
}

/** One source group, in display order. */
interface SourceGroup {
  readonly key: string
  readonly title: string
}

/**
 * Groups the panel renders, in order. The level a skill resolves to selects its
 * group; anything matching no convention lands in the custom group.
 */
const SOURCE_GROUPS: readonly SourceGroup[] = [
  { key: 'bundled', title: '系统内置' },
  { key: 'project-dsh', title: '项目 .dsh/skills' },
  { key: 'project-agents', title: '项目 .agents/skills' },
  { key: 'custom', title: '自定义目录' },
  { key: 'user-dsh', title: '用户 ~/.dsh/skills' },
  { key: 'user-agents', title: '用户 ~/.agents/skills' },
  { key: 'runtime', title: '运行时注册' },
]

/** Chinese copy for one skill, rendered in place of the English values. */
export interface SkillEntryTranslation {
  title: string
  description: string
  summary: string
}

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
  /**
   * Chinese copy, when a translation file exists beside the skill.
   *
   * Kept apart from `description` rather than replacing it: the registry value is
   * what the model routes on, and the panel must stay able to show it.
   */
  i18n?: SkillEntryTranslation
}

/** One rendered group. */
export interface GroupPayload {
  key: string
  title: string
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

/** One skill found by reading a root directory. */
export interface ScannedSkill {
  name: string
  description: string
  whenToUse?: string
  level: string
  path: string
  linked: boolean
  modelInvocable: boolean
  userInvocable: boolean
  /** The project a project-scoped skill came from; absent for user and bundled roots. */
  workspaceRoot?: string
  workspaceName?: string
  isActiveWorkspace?: boolean
}

/** The Markdown a skill directory may declare its bundle with. */
const SKILL_FILE = 'SKILL.md'

/**
 * Read one root directory for skills.
 *
 * The web-app bundle disables the host `skill-filesystem` row and lets each preset
 * own local discovery, so the host registry carries only the bundled catalog: a
 * panel reading the registry alone shows the shipped skills and none of the
 * project or user ones the agent is actually running with. Reading the root
 * conventions here closes that gap without a second catalog authority — the
 * registry still owns discovery for anything it does serve, and this scan is
 * merged under it by name.
 *
 * Both layouts the harness accepts are read: a directory holding SKILL.md, and a
 * flat Markdown file.
 *
 * @param root - absolute root directory to scan.
 * @param level - the group key every skill under this root belongs to.
 * @param workspace - the project a project-scoped root belongs to, so a row can name
 * its origin and mark itself when it is not the workspace being viewed.
 * @returns the skills found, sorted by name; missing roots yield none.
 */
export async function scanSkillRoot(
  root: string,
  level: string,
  workspace?: { root: string; name: string; active: boolean },
): Promise<ScannedSkill[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // A root that does not exist is the normal case for a deployment that never
    // created one, not a failure to report.
    return []
  }
  const found: ScannedSkill[] = []
  for (const entry of entries) {
    const path = entry.isDirectory() || entry.isSymbolicLink()
      ? join(root, entry.name, SKILL_FILE)
      : entry.name.endsWith('.md') ? join(root, entry.name) : undefined
    if (path === undefined || !existsSync(path)) continue
    const name = entry.name.replace(/\.md$/u, '')
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) continue
    let source: string
    try {
      source = await readFile(path, 'utf8')
    } catch {
      continue
    }
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)?.[1] ?? ''
    const field = (key: string): string | undefined => {
      const line = new RegExp('^\\s*' + key + '\\s*:\\s*(.+?)\\s*$', 'mu').exec(front)
      return line?.[1]?.replace(/^['"]|['"]$/gu, '')
    }
    const disabled = readDisabledFlag(source)
    const invocation = field('invocation')
    found.push({
      name,
      description: field('description') ?? '',
      level,
      path,
      linked: lstatSyncSafe(path),
      // A skill is model-invocable unless the file disables it; user invocation
      // follows the frontmatter's own policy when it declares one.
      modelInvocable: disabled !== true && invocation !== 'user',
      userInvocable: invocation !== 'model',
      ...field('when-to-use') === undefined ? {} : { whenToUse: field('when-to-use') as string },
      ...workspace === undefined ? {} : {
        workspaceRoot: workspace.root,
        workspaceName: workspace.name,
        isActiveWorkspace: workspace.active,
      },
    })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether a skill file is reached through a symlink, which makes deletion unsafe. */
function lstatSyncSafe(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink() || lstatSync(dirname(path)).isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * Every local skill root this deployment uses, with the group each belongs to.
 *
 * @param deps - the resolved configuration.
 * @param projectRoots - project roots whose skill directories are in scope.
 * @param activeRoot - the project root the view is about, marked active so the panel
 * can distinguish a row from another workspace.
 * @returns the roots to scan, in group order.
 */
export function localSkillRoots(
  deps: Pick<SkillRoutesDeps, 'dshHome' | 'agentsHome'> & { customSkillDirs: readonly string[] },
  projectRoots: readonly string[],
  activeRoot?: string,
): { path: string; level: string; workspace?: { root: string; name: string; active: boolean } }[] {
  const roots: { path: string; level: string; workspace?: { root: string; name: string; active: boolean } }[] = []
  for (const projectRoot of projectRoots) {
    // Every project root in scope is scanned, not only the active one: a session in
    // another workspace still resolves skills from its own project, and the panel
    // marks a row that came from somewhere other than the workspace being viewed.
    const workspace = { root: projectRoot, name: basename(projectRoot) || projectRoot, active: projectRoot === activeRoot }
    roots.push({ path: join(projectRoot, '.dsh', 'skills'), level: 'project-dsh', workspace })
    roots.push({ path: join(projectRoot, '.agents', 'skills'), level: 'project-agents', workspace })
  }
  for (const dir of deps.customSkillDirs) roots.push({ path: dir, level: 'custom' })
  roots.push({ path: join(deps.dshHome, 'skills'), level: 'user-dsh' })
  roots.push({ path: join(deps.agentsHome, 'skills'), level: 'user-agents' })
  return roots
}

/**
 * Strip the leading YAML frontmatter from a skill file.
 *
 * @param source - the skill file's complete content.
 * @returns the body below the closing delimiter, or the whole file when it declares none.
 */
export function stripFrontmatter(source: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/.exec(source)
  return match === null ? source : source.slice(match[0].length)
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
  /** Skill set holding the `<skill>/i18n/zh.json` files; unset disables translation. */
  translationRoot?: string
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

/**
 * Chinese copy for every skill the list will render, keyed by skill name.
 *
 * The registry omits the skill file path from its summaries, so each one is resolved
 * through `pathOf`, which consults the catalog `collect()` already cached. A skill
 * whose path or translation is missing simply has no entry here and renders in English.
 *
 * @param deps - the routes' dependencies.
 * @param skills - skill names to look up.
 * @param cwd - the viewing context the registry resolves against.
 * @returns the translations found, keyed by name.
 */
async function translationsFor(
  deps: SkillRoutesDeps,
  skills: readonly { name: string; path?: string }[],
  cwd: string,
): Promise<Map<string, SkillTranslation>> {
  const found = new Map<string, SkillTranslation>()
  const root = deps.translationRoot
  await Promise.all(skills.map(async ({ name, path: known }) => {
    let path = known
    if (path === undefined) {
      try {
        path = await deps.pathOf(name, cwd)
      } catch {
        // A provider that raises still leaves the configured fallback available, so this
        // does not return: the fallback below resolves by name and needs no path.
        path = undefined
      }
    }
    // The file beside the skill needs no configuration, so it is read first; an unconfigured
    // `translationRoot` only removes the fallback, not the lookup. A bundled skill resolves
    // inside an installed package, where the translation repository is not, so an unresolved
    // path must still reach the fallback rather than skip the skill.
    const beside = await readSkillTranslation(path)
    const translation = beside ?? (root === undefined
      ? undefined
      : await readSkillTranslation(join(root, name, 'SKILL.md')))
    if (translation !== undefined) found.set(name, translation)
  }))
  return found
}

/** The list handler: group the registry snapshot and the local roots together. */
async function handleList(deps: SkillRoutesDeps, cwd: string): Promise<ListPayload> {
  const projectRoots = [...new Set(deps.activeSessionCwds().map(findProjectRoot).concat(findProjectRoot(cwd)))]
  const snapshot = await deps.snapshotProject(cwd)
  const byGroup = new Map<string, SkillEntry[]>(SOURCE_GROUPS.map(g => [g.key, []]))
  const seen = new Set<string>()
  const translations = await translationsFor(deps, snapshot.skills.map(s => ({ name: s.name })), cwd)
  for (const skill of snapshot.skills) {
    // The summary carries the discovery source but not the file path, so the
    // group is derived from the source the registry already resolved.
    const level = levelOfSource(skill.source, skill.provider)
    const i18n = translations.get(skill.name)
    const entry: SkillEntry = {
      name: skill.name,
      description: skill.description,
      level,
      provider: skill.provider,
      modelInvocable: skill.invocation.modelInvocable,
      userInvocable: skill.invocation.userInvocable,
      ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
      ...i18n === undefined ? {} : { i18n },
    }
    seen.add(level + ':' + skill.name)
    ;(byGroup.get(level) ?? byGroup.get('custom'))?.push(entry)
  }
  // The host registry serves the bundled catalog; the project and user roots the
  // agent runs with are read here and merge under the registry by name, so a root
  // the registry does serve is listed once with the registry's own policy.
  for (const root of localSkillRoots(deps, projectRoots, findProjectRoot(cwd))) {
    for (const skill of await scanSkillRoot(root.path, root.level, root.workspace)) {
      if (seen.has(root.level + ':' + skill.name)) continue
      seen.add(root.level + ':' + skill.name)
      const i18n = await readSkillTranslation(skill.path) ?? (deps.translationRoot === undefined
        ? undefined
        : await readSkillTranslation(join(deps.translationRoot, skill.name, 'SKILL.md')))
      byGroup.get(root.level)?.push({
        name: skill.name,
        description: skill.description,
        level: skill.level,
        path: skill.path,
        linked: skill.linked,
        modelInvocable: skill.modelInvocable,
        userInvocable: skill.userInvocable,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
        ...skill.workspaceRoot === undefined ? {} : { workspaceRoot: skill.workspaceRoot },
        ...skill.workspaceName === undefined ? {} : { workspaceName: skill.workspaceName },
        ...skill.isActiveWorkspace === undefined ? {} : { isActiveWorkspace: skill.isActiveWorkspace },
        ...i18n === undefined ? {} : { i18n },
      })
    }
  }
  const groups: GroupPayload[] = []
  for (const g of SOURCE_GROUPS) {
    const skills = (byGroup.get(g.key) ?? []).sort((a, b) => a.name.localeCompare(b.name))
    if (skills.length > 0) groups.push({ key: g.key, title: g.title, skills })
  }
  return { cwd, projectRoots, complete: snapshot.complete, groups }
}

/**
 * The content handler: one skill's instruction body, without its frontmatter.
 *
 * The registry's summaries carry metadata only, so the body is read from the file
 * the name resolves to. The path the panel listed is preferred — the row already
 * names its own file, and the panel lists skills from workspaces other than the one
 * being viewed — then the registry's resolution, then the configured translation
 * set's own copy, which is what answers for a bundled skill.
 *
 * @param listedPath - the path the listing served with the row, when the caller sent one.
 */
async function handleContent(
  deps: SkillRoutesDeps,
  name: string,
  listedPath: string | undefined,
  cwd: string,
): Promise<{ name: string; content: string }> {
  const candidates: string[] = []
  if (listedPath !== undefined && listedPath !== '') candidates.push(listedPath)
  // The registry resolution is tried as well but must not be the only attempt: a bundled
  // skill serves its body from inside an installed package, and a provider that raises
  // must still reach the fallback below.
  try {
    const resolved = await deps.pathOf(name, cwd)
    if (resolved !== undefined && !candidates.includes(resolved)) candidates.push(resolved)
  } catch {
    // The fallback below resolves by name and needs no path.
  }
  if (deps.translationRoot !== undefined) candidates.push(join(deps.translationRoot, name, SKILL_FILE))
  for (const candidate of candidates) {
    let source: string
    try {
      source = await readFile(candidate, 'utf8')
    } catch {
      // A candidate that is absent or unreadable is the normal case for a skill that
      // resolved from the other source; the next candidate answers instead.
      continue
    }
    return { name, content: stripFrontmatter(source) }
  }
  throw new Error('skill "' + name + '" has no readable ' + SKILL_FILE)
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
      path: ROUTES.translationProgress,
      handler: async (_req, res) => {
        // The translation script rewrites this file as it advances, so the panel
        // reads it per request rather than caching it at mount.
        const progress = deps.translationRoot === undefined
          ? undefined
          : await readTranslationProgress(deps.translationRoot)
        writeJson(res, 200, progress === undefined ? {} : { progress })
      },
    },
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
      path: ROUTES.content,
      handler: async (req, res) => {
        try {
          const params = new URL(req.url ?? '/', 'http://localhost').searchParams
          const name = params.get('name') ?? ''
          if (name === '') throw new Error('missing name')
          writeJson(res, 200, await handleContent(deps, name, params.get('path') ?? undefined, currentCwd(deps, req)))
        } catch (error) {
          deps.logger.warn(error)
          writeJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
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
    ...config.translationRoot === undefined ? {} : { translationRoot: config.translationRoot },
  }
  for (const route of makeRoutes(deps)) ctx.effect(() => ctx.webServer.register(route), 'ui-skill-center: route ' + route.path)
}
