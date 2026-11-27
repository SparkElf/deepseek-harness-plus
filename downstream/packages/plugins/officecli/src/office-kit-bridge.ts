/**
 * Localhost bridge from the `officecli-pdf` exporter sidecar to this Host's officeKit service.
 *
 * The exporter is a short-lived process spawned by the OfficeCLI binary; it has no Cordis
 * context and therefore no access to `officeKit.convert`. It posts one conversion request to
 * this loopback listener instead. The bridge is the trust boundary: it authenticates with a
 * static internal token, confines both paths to the workspace, restricts source formats to
 * docx/xlsx/pptx, and bounds concurrency, input size, and wall-clock time. A failure is
 * reported to the sidecar as a structured error; nothing falls back to another engine.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { chmod, link, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** Source formats this bridge accepts; anything else is rejected before officeKit sees it. */
export const SUPPORTED_EXTENSIONS = ['docx', 'xlsx', 'pptx'] as const
export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number]

/** The subset of `@deepseek-ai/dsh-office-kit` this bridge depends on, kept structural. */
export interface OfficeKitConversionResult {
  readonly pdf: Uint8Array
  readonly missingFonts: readonly string[]
  /** Provider generation, reported back to the sidecar for diagnostics. */
  readonly generation?: unknown
}

export interface OfficeKitConversionSource {
  readonly key: string
  readonly version: string
  readonly bytes: number
  read(signal: AbortSignal, maxBytes: number): Promise<{ readonly bytes: Uint8Array; readonly version: string }>
}

export interface OfficeKitConversionRequest {
  readonly extension: string
  readonly priority: 'foreground' | 'background'
  readonly source: OfficeKitConversionSource
}

/** The `officeKit` Context service as far as this bridge uses it. */
export interface OfficeKitService {
  convert(request: OfficeKitConversionRequest, signal?: AbortSignal): Promise<OfficeKitConversionResult>
  readonly generation?: unknown
}

export interface OfficeKitBridgeOptions {
  /** Absolute path of the config file written for the sidecar. */
  configPath?: string
  /** Absolute workspace roots a source or target path must live under. */
  workspaceRoots?: string[]
  /** Loopback port; `0` asks the kernel for a free one. */
  port?: number
  /** Static internal token; generated once and persisted when omitted. */
  token?: string
  /** Conversion deadline in milliseconds. */
  timeoutMs?: number
  /** Maximum simultaneous conversions; additional requests queue. */
  concurrency?: number
  /** Maximum queued conversions before new requests are refused as busy. */
  maxQueued?: number
  /** Maximum source file bytes. */
  maxInputBytes?: number
  /** Skip starting the listener. */
  enabled?: boolean
}

/** On-disk contract read by `officecli-pdf`; secrets live only in this 0600 file. */
export interface OfficeKitBridgeConfig {
  readonly version: 1
  readonly host: '127.0.0.1'
  readonly port: number
  readonly url: string
  readonly token: string
  /** Static deployment token: always null; rotation replaces the file, not an expiry. */
  readonly tokenExpiresAt: null
  readonly workspaceRoots: string[]
  readonly maxInputBytes: number
  readonly timeoutMs: number
  readonly concurrency: number
  readonly maxQueued: number
  readonly pid: number
  readonly startedAt: string
}

export interface OfficeKitBridgeHandle {
  readonly url: string
  readonly port: number
  readonly configPath: string
  readonly workspaceRoots: string[]
  close(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 600_000
const DEFAULT_CONCURRENCY = 2
const DEFAULT_MAX_QUEUED = 8
const DEFAULT_MAX_INPUT_BYTES = 100 * 1024 * 1024
const MAX_REQUEST_BYTES = 64 * 1024
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{32,512}$/
const STARTED = Symbol.for('@sparkelf/dsh-officecli/office-kit-bridge')
const CONFIG_FILE = 'office-kit-bridge.json'

interface BridgeState {
  handle: Promise<OfficeKitBridgeHandle>
}

interface GlobalWithBridge {
  [STARTED]?: BridgeState
}

interface ConversionBody {
  source?: unknown
  target?: unknown
  force?: unknown
}

interface BridgeError {
  status: number
  code: string
  message: string
}

function bridgeError(status: number, code: string, message: string): BridgeError {
  return { status, code, message }
}

function isBridgeError(value: unknown): value is BridgeError {
  return typeof value === 'object' && value !== null && 'status' in value && 'code' in value && 'message' in value
}

/** Working directory the sidecar and the Host agree on: an explicit option, DSH_HOME, then the container default. */
export function defaultConfigPath(configured?: string): string {
  const explicit = configured?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  const fromEnv = process.env.DSH_HOME?.trim()
  if (fromEnv !== undefined && fromEnv !== '') return join(resolve(fromEnv), CONFIG_FILE)
  return join('/workspace/.dataops/dsh', CONFIG_FILE)
}

/** Workspace roots: explicit option, deployment mount, `/workspace`, then the process directory. */
export function defaultWorkspaceRoots(configured?: string[]): string[] {
  if (configured !== undefined && configured.length > 0) return configured.map(root => resolve(root))
  const fromEnv = process.env.OFFICE_KIT_BRIDGE_ROOTS?.split(':').map(root => root.trim()).filter(root => root !== '')
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv.map(root => resolve(root))
  const mount = process.env.DATAOPS_AI_WORKSPACE_MOUNT_PATH?.trim()
  if (mount !== undefined && mount !== '') return [resolve(mount)]
  return [resolve(process.env.DSH_WORKSPACE_ROOT ?? process.cwd())]
}

/** Port 0 asks the kernel for a free port; only the bridge config records the actual one. */
function readPort(): number {
  const raw = process.env.OFFICE_KIT_BRIDGE_PORT?.trim()
  if (raw === undefined || raw === '') return 0
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 0 || value > 65535) throw new Error('OFFICE_KIT_BRIDGE_PORT must be a TCP port')
  return value
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`)
  return value
}

/** Persist the sidecar-visible contract; the containing directory is private and the file is 0600. */
async function writeConfig(configPath: string, config: OfficeKitBridgeConfig): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 })
  const temporary = `${configPath}.${process.pid}.tmp`
  const handle = await open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, configPath)
  await chmod(configPath, 0o600)
}

/** Reuse the persisted token so a Host restart does not invalidate a live deployment's sidecar. */
async function resolveToken(configPath: string, configured?: string): Promise<string> {
  const fromEnv = process.env.OFFICE_KIT_BRIDGE_TOKEN?.trim()
  const candidate = configured ?? (fromEnv !== undefined && fromEnv !== '' ? fromEnv : undefined)
  if (candidate !== undefined) {
    if (!TOKEN_PATTERN.test(candidate)) throw new Error('office kit bridge token must be 32-512 URL-safe characters')
    return candidate
  }
  try {
    const existing = JSON.parse(await readFile(configPath, 'utf8')) as { token?: unknown }
    if (typeof existing.token === 'string' && TOKEN_PATTERN.test(existing.token)) return existing.token
  } catch {
    // Missing or unreadable config: mint a new token below.
  }
  return randomBytes(32).toString('base64url')
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(provided, 'utf8')
  if (left.byteLength !== right.byteLength) return false
  return timingSafeEqual(left, right)
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

async function readBody(request: IncomingMessage): Promise<ConversionBody> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.byteLength
    if (total > MAX_REQUEST_BYTES) throw bridgeError(413, 'request_too_large', 'The bridge request exceeds 64 KiB.')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') throw bridgeError(400, 'invalid_request', 'The bridge request body is empty.')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw bridgeError(400, 'invalid_request', 'The bridge request body is not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null) throw bridgeError(400, 'invalid_request', 'The bridge request body must be an object.')
  return parsed as ConversionBody
}

function requirePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw bridgeError(400, 'invalid_request', `${field} must be a non-empty path string.`)
  if (value.includes('\0')) throw bridgeError(400, 'invalid_request', `${field} contains a NUL byte.`)
  return value
}

function extensionOf(path: string): string {
  return extname(path).slice(1).toLowerCase()
}

/** Source must be a regular file whose real path is inside a workspace root. */
async function authorizeSource(raw: string, roots: string[], maxInputBytes: number): Promise<{ path: string; size: number; version: string }> {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(roots[0] ?? process.cwd(), raw)
  if (!roots.some(root => isInside(root, absolute))) throw bridgeError(403, 'path_outside_workspace', 'The source path is outside the workspace.')
  const extension = extensionOf(absolute)
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw bridgeError(415, 'unsupported_format', `Unsupported source format ".${extension}"; expected docx, xlsx, or pptx.`)
  }
  let real: string
  try {
    real = await realpath(absolute)
  } catch {
    throw bridgeError(400, 'source_not_found', 'The source file does not exist.')
  }
  if (!roots.some(root => isInside(root, real))) throw bridgeError(403, 'path_outside_workspace', 'The source path resolves outside the workspace.')
  const info = await stat(real)
  if (!info.isFile()) throw bridgeError(400, 'source_not_file', 'The source path is not a regular file.')
  if (info.size > maxInputBytes) throw bridgeError(413, 'input_too_large', `The source is ${info.size} bytes, above the ${maxInputBytes}-byte limit.`)
  return { path: real, size: info.size, version: `${info.mtimeMs}:${info.size}` }
}

/** Target must end in `.pdf` and its real parent directory must be inside a workspace root. */
async function authorizeTarget(raw: string, roots: string[]): Promise<string> {
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(roots[0] ?? process.cwd(), raw)
  if (extensionOf(absolute) !== 'pdf') throw bridgeError(415, 'unsupported_format', 'The target path must end in .pdf.')
  if (!roots.some(root => isInside(root, absolute))) throw bridgeError(403, 'path_outside_workspace', 'The target path is outside the workspace.')
  let parent: string
  try {
    parent = await realpath(dirname(absolute))
  } catch {
    throw bridgeError(400, 'target_directory_missing', 'The target directory does not exist.')
  }
  if (!roots.some(root => isInside(root, parent))) throw bridgeError(403, 'path_outside_workspace', 'The target directory resolves outside the workspace.')
  return join(parent, basename(absolute))
}

/** Write the PDF next to its destination, then publish it atomically and exclusively. */
async function publish(target: string, bytes: Uint8Array, force: boolean): Promise<void> {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    if (force) await rename(temporary, target)
    else {
      try {
        // link() is atomic and fails when the destination exists, unlike rename(). Filesystems
        // without hard links fall back to an exclusive create, which still refuses a raced target.
        try {
          await link(temporary, target)
        } catch (cause) {
          const code = (cause as { code?: string }).code
          if (code !== 'EPERM' && code !== 'ENOSYS' && code !== 'EXDEV' && code !== 'EMLINK') throw cause
          const exclusive = await open(target, 'wx', 0o644)
          try { await exclusive.writeFile(await readFile(temporary)) } finally { await exclusive.close() }
        }
      } finally {
        await unlink(temporary)
      }
    }
  } catch (cause) {
    await unlink(temporary).catch(() => undefined)
    if ((cause as { code?: string }).code === 'EEXIST') throw bridgeError(409, 'target_exists', 'The target PDF already exists; retry with --force to overwrite it.')
    throw cause
  }
}

class Limiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number, private readonly maxQueued: number) {}

  get activeCount(): number { return this.active }
  get queuedCount(): number { return this.waiting.length }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueued) throw bridgeError(429, 'busy', 'The Office conversion queue is full; retry shortly.')
      await new Promise<void>((resolveWaiter) => this.waiting.push(resolveWaiter))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      const next = this.waiting.shift()
      if (next !== undefined) next()
    }
  }
}

function officeKitError(cause: unknown): BridgeError {
  const code = typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string' ? cause.code : 'failed'
  const message = cause instanceof Error ? cause.message : 'The Office conversion failed.'
  switch (code) {
    case 'input-too-large': return bridgeError(413, code, message)
    case 'output-too-large': return bridgeError(413, code, message)
    case 'source-changed': return bridgeError(409, code, message)
    case 'unsupported-format': return bridgeError(415, code, message)
    case 'invalid-request': return bridgeError(400, code, message)
    case 'invalid-document': return bridgeError(422, code, message)
    case 'invalid-output': return bridgeError(502, code, message)
    case 'unavailable': return bridgeError(503, code, message)
    case 'timeout': return bridgeError(504, code, message)
    case 'busy': return bridgeError(429, code, message)
    default: return bridgeError(500, code, message)
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/** Start the bridge once per Host process; later calls share the listener. */
export async function startOfficeKitBridge(ctx: Context, options: OfficeKitBridgeOptions = {}): Promise<OfficeKitBridgeHandle> {
  if (options.enabled === false) throw new Error('office kit bridge is disabled')
  const global = globalThis as GlobalWithBridge
  const existing = global[STARTED]
  if (existing !== undefined) return await existing.handle
  let settle: { resolve: (handle: OfficeKitBridgeHandle) => void; reject: (cause: unknown) => void } | undefined
  const handle = new Promise<OfficeKitBridgeHandle>((resolveHandle, rejectHandle) => {
    settle = { resolve: resolveHandle, reject: rejectHandle }
  })
  global[STARTED] = { handle }
  launch(ctx, options).then(
    (started) => settle?.resolve(started),
    (cause: unknown) => {
      delete global[STARTED]
      settle?.reject(cause)
    },
  )
  return await handle
}

async function launch(ctx: Context, options: OfficeKitBridgeOptions): Promise<OfficeKitBridgeHandle> {
  const configPath = defaultConfigPath(options.configPath)
  const workspaceRoots = await Promise.all(defaultWorkspaceRoots(options.workspaceRoots).map(async root => {
    try {
      return await realpath(root)
    } catch {
      return root
    }
  }))
  const timeoutMs = options.timeoutMs ?? readPositiveInteger('OFFICE_KIT_BRIDGE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
  const concurrency = options.concurrency ?? readPositiveInteger('OFFICE_KIT_BRIDGE_CONCURRENCY', DEFAULT_CONCURRENCY)
  const maxQueued = options.maxQueued ?? readPositiveInteger('OFFICE_KIT_BRIDGE_MAX_QUEUED', DEFAULT_MAX_QUEUED)
  const maxInputBytes = options.maxInputBytes ?? readPositiveInteger('OFFICE_KIT_BRIDGE_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES)
  const token = await resolveToken(configPath, options.token)
  const limiter = new Limiter(concurrency, maxQueued)
  const pending = new Set<AbortController>()

  const officeKit = (): OfficeKitService | undefined => {
    try {
      return ctx.get('officeKit') as OfficeKitService | undefined
    } catch {
      return undefined
    }
  }

  const convert = async (body: ConversionBody): Promise<{ target: string; bytes: number; missingFonts: string[]; generation?: unknown }> => {
    const service = officeKit()
    if (service === undefined) throw bridgeError(503, 'unavailable', 'The officeKit service is not available in this Host.')
    const source = await authorizeSource(requirePath(body.source, 'source'), workspaceRoots, maxInputBytes)
    const target = await authorizeTarget(requirePath(body.target, 'target'), workspaceRoots)
    const force = body.force === true
    if (!force) {
      const present = await stat(target).then(() => true, () => false)
      if (present) throw bridgeError(409, 'target_exists', 'The target PDF already exists; retry with --force to overwrite it.')
    }

    const controller = new AbortController()
    pending.add(controller)
    const timer = setTimeout(() => controller.abort(new Error(`The conversion exceeded ${timeoutMs} ms.`)), timeoutMs)
    try {
      const result = await limiter.run(async () => await service.convert({
        extension: extensionOf(source.path),
        priority: 'foreground',
        source: {
          key: JSON.stringify(['office-kit-bridge', source.path]),
          version: source.version,
          bytes: source.size,
          read: async (signal: AbortSignal, maxBytes: number) => {
            const bytes = await readFile(source.path, { signal })
            if (bytes.byteLength > maxBytes) {
              throw Object.assign(new Error(`The source is ${bytes.byteLength} bytes, above the ${maxBytes}-byte reservation.`), { code: 'input-too-large' })
            }
            const after = await stat(source.path)
            if (`${after.mtimeMs}:${after.size}` !== source.version) {
              throw Object.assign(new Error('The source changed during conversion.'), { code: 'source-changed' })
            }
            return { bytes, version: source.version }
          },
        },
      }, controller.signal))
      if (result.pdf.byteLength === 0) throw bridgeError(502, 'invalid_output', 'The converter returned an empty PDF.')
      await publish(target, result.pdf, force)
      return { target, bytes: result.pdf.byteLength, missingFonts: [...result.missingFonts], ...(result.generation === undefined ? {} : { generation: result.generation }) }
    } catch (cause) {
      if (isBridgeError(cause)) throw cause
      if (controller.signal.aborted) throw bridgeError(504, 'timeout', `The conversion exceeded ${timeoutMs} ms.`)
      throw officeKitError(cause)
    } finally {
      clearTimeout(timer)
      pending.delete(controller)
    }
  }

  const server: Server = createServer((request, response) => {
    void (async () => {
      const provided = request.headers['x-dataops-internal-token']
      const header = Array.isArray(provided) ? provided[0] : provided
      if (!tokenMatches(token, header)) {
        json(response, 401, { ok: false, error: { code: 'unauthorized', message: 'Missing or invalid X-DataOps-Internal-Token.' } })
        return
      }
      const url = request.url ?? '/'
      if (request.method === 'GET' && url === '/internal/office-kit/health') {
        json(response, 200, {
          ok: true,
          pid: process.pid,
          active: limiter.activeCount,
          queued: limiter.queuedCount,
          concurrency,
          timeoutMs,
          workspaceRoots,
        })
        return
      }
      if (request.method === 'POST' && url === '/internal/office-kit/convert') {
        try {
          const result = await convert(await readBody(request))
          json(response, 200, { ok: true, ...result })
        } catch (cause) {
          const error = isBridgeError(cause) ? cause : bridgeError(500, 'internal_error', cause instanceof Error ? cause.message : 'The bridge failed.')
          json(response, error.status, { ok: false, error: { code: error.code, message: error.message } })
        }
        return
      }
      json(response, 404, { ok: false, error: { code: 'not_found', message: 'Unknown bridge route.' } })
    })().catch((cause: unknown) => {
      if (!response.headersSent) json(response, 500, { ok: false, error: { code: 'internal_error', message: cause instanceof Error ? cause.message : 'The bridge failed.' } })
      else response.end()
    })
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(options.port ?? readPort(), '127.0.0.1', () => {
      server.off('error', rejectListen)
      resolveListen()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    server.close()
    throw new Error('office kit bridge did not bind a TCP port')
  }
  const config: OfficeKitBridgeConfig = {
    version: 1,
    host: '127.0.0.1',
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    token,
    tokenExpiresAt: null,
    workspaceRoots,
    maxInputBytes,
    timeoutMs,
    concurrency,
    maxQueued,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  }
  await writeConfig(configPath, config)
  ctx.logger.info(`office-kit bridge listening on 127.0.0.1:${address.port} (config ${configPath})`)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const controller of pending) controller.abort(new Error('The office kit bridge is closing.'))
    pending.clear()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    delete (globalThis as GlobalWithBridge)[STARTED]
  }
  return { url: config.url, port: config.port, configPath, workspaceRoots, close }
}

/** Cordis plugin entry: `apply(ctx)` starts (or joins) the loopback bridge. */
export const name = 'office-kit-bridge'
export const inject: string[] = []

export function apply(ctx: Context, options: OfficeKitBridgeOptions = {}): void {
  // The disposer is registered synchronously, while Cordis still considers this
  // plugin's context active. Registering it after the listener binds raced the
  // activation lifecycle on 0.2.3 and surfaced as a fatal inactive-context error.
  let disposed = false
  let close: (() => Promise<void>) | undefined
  ctx.effect(() => async () => {
    disposed = true
    await close?.()
  })
  void startOfficeKitBridge(ctx, options).then((bridge) => {
    if (disposed) {
      void bridge.close()
      return
    }
    close = bridge.close
  }).catch((cause: unknown) => {
    ctx.logger.warn(cause instanceof Error ? cause : new Error(String(cause)))
  })
}