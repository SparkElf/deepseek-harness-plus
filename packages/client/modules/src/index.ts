/**
 * Node half of the client module system (`dsh.client` dual-face package): scans
 * the host Loader's entries for packages declaring `dsh.client`, composes the
 * `window.__DSH_BOOT__` entry graph (wire single source: {@link WebBootEntry}
 * in `./client/manifest.ts`) in module-graph order, serves
 * `/plugins/<id>/client.js` and its source map, taps the index render to
 * inject the boot manifest plus the parser-blocking bootstrap preloads, and
 * provides the `clientModuleHost` service (the HMR node half's
 * registration/notification face).
 *
 * Scanning is incremental per package — there is no full-rescan code path.
 * Every cordis `internal/plugin` emission (fiber construction/disposal) marks
 * the fiber's entry name dirty; a microtask flush reconciles each dirty name
 * against the live loader entries. The activation pass seeds the same dirty
 * set with all current entries and flushes synchronously, so first scan and
 * steady state share one implementation. Package metadata (including the
 * negative "not a client package" verdict) is cached per name and never
 * expires — plugin-set changes take effect on restart; bundle content
 * changes reach the graph only through
 * {@link ClientModuleRegistry.rebuilt}.
 * @module @deepseek-ai/dsh-client-modules
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { optionalStringArray, stripClientSuffix } from './client/manifest.ts'
import type { WebBootEntry, WebBootGraph } from './client/manifest.ts'

export { stripClientSuffix } from './client/manifest.ts'
export type {
  BootManifest, BootModuleRow, BootPluginRow, WebBootEntry, WebBootGraph,
} from './client/manifest.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    clientModules: ClientModuleRegistry
  }
}

interface DshClientDeclaration {
  inject?: string[]
  platform: string
  immediately?: boolean
  external?: string[]
}

interface WebBootRowFields {
  inject?: string[]
  external: string[]
  immediately: boolean
}

interface PkgMeta extends WebBootRowFields {
  clientPath: string
}

const CLIENT_BUNDLE_BUILD_INSTRUCTION = 'run `pnpm run build` before launch'

class MissingClientBundleError extends Error {
  constructor(
    readonly packageName: string,
    readonly clientPath: string,
    cause: unknown,
  ) {
    super(
      [
        `client-modules: client bundle not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`,
        `  package: ${packageName}`,
        `  path: ${clientPath}`,
      ].join('\n'),
      { cause },
    )
  }
}

class ClientPackageCompositionError extends AggregateError {
  constructor(failures: Error[]) {
    const missingBundles = failures.filter((error): error is MissingClientBundleError => error instanceof MissingClientBundleError)
    const otherFailures = failures.filter(error => !(error instanceof MissingClientBundleError))
    const packageNoun = failures.length === 1 ? 'package' : 'packages'
    const lines = [`client-modules: ${String(failures.length)} client ${packageNoun} failed to compose:`]
    if (missingBundles.length > 0) {
      lines.push(`  client bundles not found; ${CLIENT_BUNDLE_BUILD_INSTRUCTION}:`)
      for (const error of missingBundles) {
        lines.push(`    - package: ${error.packageName}`, `      path: ${error.clientPath}`)
      }
    }
    if (otherFailures.length > 0) {
      lines.push('  other failures:', ...otherFailures.map(error => `    - ${error.message}`))
    }
    super(failures, lines.join('\n'))
  }
}

interface WebPluginRecord {
  entry: WebBootEntry
  meta: PkgMeta
}

function parseDshClient(pkgName: string, value: unknown): DshClientDeclaration | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null) {
    throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`)
  }
  const decl = value as Record<string, unknown>
  if (typeof decl.platform !== 'string') {
    throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`)
  }
  const inject = optionalStringArray(pkgName, 'dsh.client.inject', decl.inject)
  const external = optionalStringArray(pkgName, 'dsh.client.external', decl.external)
  if (decl.immediately !== undefined && typeof decl.immediately !== 'boolean') {
    throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`)
  }
  return {
    platform: decl.platform,
    ...(inject !== undefined ? { inject } : {}),
    ...(external !== undefined ? { external } : {}),
    ...(decl.immediately !== undefined ? { immediately: decl.immediately } : {}),
  }
}

function clientExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const client = (exportsField as Record<string, unknown>)['./client']
  if (client === undefined) return undefined
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null) {
    const fallback = (client as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`)
}

function shortHash(input: string | Buffer): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12)
}

/**
 * Graph URLs are document-base relative. The Host still serves the logical
 * `/plugins` route; a reverse-proxy mount is owned solely by the injected
 * document base and the webserver's prefix stripping.
 */
function graphRow(id: string, rev: string, fields: WebBootRowFields): WebBootEntry {
  return {
    id,
    url: `plugins/${id}/client.js?rev=${rev}`,
    rev,
    ...(fields.inject !== undefined ? { inject: fields.inject } : {}),
    ...(fields.immediately ? { immediately: true } : {}),
    ...(fields.external.length > 0 ? { external: fields.external } : {}),
  }
}

export function orderByModuleGraph(entries: readonly WebBootEntry[]): WebBootEntry[] {
  const rowsById = new Map<string, WebBootEntry>()
  for (const entry of entries) rowsById.set(entry.id, entry)
  const ordered: WebBootEntry[] = []
  const placed = new Set<string>()
  const open: string[] = []
  const visit = (entry: WebBootEntry): void => {
    if (placed.has(entry.id)) return
    const cycleStart = open.indexOf(entry.id)
    if (cycleStart !== -1) {
      throw new Error(
        `client-modules: module graph cycle ${[...open.slice(cycleStart), entry.id].join(' -> ')} `
        + '— a requested package row must precede its consumers, and factory-form CJS cannot deliver partial exports',
      )
    }
    open.push(entry.id)
    for (const name of entry.external ?? []) {
      const dependency = rowsById.get(name) ?? rowsById.get(stripClientSuffix(name))
      if (dependency === entry) {
        throw new Error(
          `client-modules: "${entry.id}" requests module "${name}" that it answers itself `
          + '— a row must not declare its own package in dsh.client.external',
        )
      }
      if (dependency !== undefined) visit(dependency)
    }
    open.pop()
    placed.add(entry.id)
    ordered.push(entry)
  }
  for (const entry of entries) visit(entry)
  return ordered
}

const CLIENT_MODULES_ID = '@deepseek-ai/dsh-client-modules'
const CLIENT_RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'
const PARSER_PRELOAD_IDS = [CLIENT_MODULES_ID, CLIENT_RUNTIME_ID] as const

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function injectBootManifest(html: string, graph: WebBootGraph): string {
  const json = JSON.stringify(graph).replaceAll('<', '\\u003c')
  const bootstrapId = JSON.stringify(CLIENT_MODULES_ID)
  const queue = `<script>(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${bootstrapId})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${CLIENT_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${CLIENT_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${CLIENT_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()</script>`
  const preload = PARSER_PRELOAD_IDS.map(id => graph.entries.find(entry => entry.id === id))
    .filter((entry): entry is WebBootEntry => entry !== undefined)
    .map(entry => `<script src="${escapeHtmlAttribute(entry.url)}"></script>`)
    .join('')
  const script = `${queue}${preload}<script>window.__DSH_BOOT__ = ${json}</script>`
  const head = html.indexOf('<head>')
  if (head !== -1) return `${html.slice(0, head + 6)}${script}${html.slice(head + 6)}`
  return `${script}${html}`
}

export class ClientModuleRegistry extends Service {
  static inject = ['webServer', 'loader']

  private readonly table = new Map<string, WebPluginRecord>()
  private readonly pkgMeta = new Map<string, PkgMeta | null>()
  private readonly rebuildListeners = new Set<(id: string, rev: string) => void>()
  private readonly graphListeners = new Set<() => void>()
  private readonly dirty = new Set<string>()
  private readonly resolvePkgJson: (spec: string) => string
  private flushQueued = false
  private composed: WebBootGraph

  constructor(ctx: Context) {
    super(ctx, 'clientModules')
    if (ctx.baseUrl === undefined) {
      throw new Error('client-modules: ctx.baseUrl missing; cannot resolve configured plugin packages')
    }
    this.resolvePkgJson = createRequire(new URL('package.json', ctx.baseUrl)).resolve
    this.composed = { rev: shortHash('[]'), entries: [] }

    ctx.on('internal/plugin', (entry) => {
      if (entry.name === undefined) return
      this.markDirty(entry.name)
    })
    for (const entry of ctx.loader.entries()) {
      if (entry.name !== undefined) this.dirty.add(entry.name)
    }
    const failures = this.flushDirty()
    if (failures.length > 0) throw new ClientPackageCompositionError(failures)

    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/plugins',
      handler: (req, res) => this.serveBundle(req, res),
    }), 'client-modules: bundle route')
    ctx.effect(() => ctx.webServer.tapIndex(html => injectBootManifest(html, this.composed)), 'client-modules: boot manifest')
    ctx.effect(() => () => {
      this.rebuildListeners.clear()
      this.graphListeners.clear()
    }, 'client-modules: listeners')
  }

  get graph(): WebBootGraph {
    return this.composed
  }

  onRebuilt(listener: (id: string, rev: string) => void): () => void {
    this.rebuildListeners.add(listener)
    return () => { this.rebuildListeners.delete(listener) }
  }

  onGraphChanged(listener: () => void): () => void {
    this.graphListeners.add(listener)
    return () => { this.graphListeners.delete(listener) }
  }

  async rebuilt(id: string): Promise<void> {
    const record = this.table.get(id)
    if (record === undefined) throw new Error(`client-modules: unknown client package ${id}`)
    let source: string
    try {
      source = await readFile(record.meta.clientPath, 'utf8')
    } catch (cause) {
      throw new MissingClientBundleError(id, record.meta.clientPath, cause)
    }
    const rev = shortHash(source)
    if (rev === record.entry.rev) return
    record.entry = graphRow(id, rev, record.meta)
    this.recompose()
    for (const listener of [...this.rebuildListeners]) listener(id, rev)
  }

  private markDirty(name: string): void {
    this.dirty.add(name)
    if (this.flushQueued) return
    this.flushQueued = true
    queueMicrotask(() => {
      this.flushQueued = false
      const failures = this.flushDirty()
      for (const error of failures) this.ctx.logger.warn(error)
    })
  }

  private flushDirty(): Error[] {
    if (this.dirty.size === 0) return []
    const names = [...this.dirty]
    this.dirty.clear()
    const failures: Error[] = []
    let changed = false
    for (const name of names) {
      try {
        changed = this.reconcile(name) || changed
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)))
      }
    }
    if (changed) this.recompose()
    return failures
  }

  private reconcile(name: string): boolean {
    const entry = this.ctx.loader.entries().find(candidate => candidate.name === name)
    if (entry === undefined) return this.table.delete(name)
    const meta = this.metaOf(name)
    if (meta === null) return this.table.delete(name)
    let source: string
    try {
      source = readFileSync(meta.clientPath, 'utf8')
    } catch (cause) {
      throw new MissingClientBundleError(name, meta.clientPath, cause)
    }
    const rev = shortHash(source)
    const current = this.table.get(name)
    if (current !== undefined && current.entry.rev === rev) return false
    this.table.set(name, { entry: graphRow(name, rev, meta), meta })
    return true
  }

  private metaOf(name: string): PkgMeta | null {
    if (this.pkgMeta.has(name)) return this.pkgMeta.get(name) ?? null
    let pkgJsonPath: string
    try {
      pkgJsonPath = this.resolvePkgJson(`${name}/package.json`)
    } catch {
      this.pkgMeta.set(name, null)
      return null
    }
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<string, unknown>
    const declaration = parseDshClient(name, pkg['dsh.client'])
    const clientExport = clientExportOf(name, pkg.exports)
    if (declaration === undefined || declaration.platform !== 'web' || clientExport === undefined) {
      this.pkgMeta.set(name, null)
      return null
    }
    const meta: PkgMeta = {
      clientPath: join(dirname(pkgJsonPath), clientExport),
      inject: declaration.inject,
      external: declaration.external ?? [],
      immediately: declaration.immediately === true,
    }
    this.pkgMeta.set(name, meta)
    return meta
  }

  private recompose(): void {
    const entries = orderByModuleGraph([...this.table.values()].map(record => record.entry))
    this.composed = {
      rev: shortHash(JSON.stringify(entries)),
      entries,
    }
    for (const listener of [...this.graphListeners]) listener()
  }

  private async serveBundle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const match = /^\/plugins\/(.+)\/client\.js(?:\.map)?$/u.exec(pathname)
    if (match === null) {
      res.writeHead(404)
      res.end()
      return
    }
    const encodedId = match[1]
    let id: string
    try {
      id = decodeURIComponent(encodedId)
    } catch {
      res.writeHead(400)
      res.end()
      return
    }
    const record = this.table.get(id)
    if (record === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const isMap = pathname.endsWith('.map')
    const path = isMap ? `${record.meta.clientPath}.map` : record.meta.clientPath
    try {
      const body = await readFile(path)
      res.writeHead(200, {
        'content-type': isMap ? 'application/json' : 'text/javascript; charset=utf-8',
        'cache-control': 'no-cache',
      })
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    } catch {
      res.writeHead(404)
      res.end()
    }
  }
}