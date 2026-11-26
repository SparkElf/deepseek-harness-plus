/**
 * Deployment-runner seam for the knowledge base.
 *
 * Deploying MinerU or an NFS export means running commands on a remote host.
 * This plugin does not implement SSH: the workspace already ships
 * `@sparkelf/dsh-ssh-manager`, which owns connection handling, host-key
 * verification, credential storage, and command execution. Reusing it keeps one
 * authoritative credential store and one host inventory, per the managed
 * DataOps authorization rule in AGENTS.md.
 *
 * The seam is intentionally narrow: callers pass a host id and a command, and
 * receive stdout/stderr/exit code. Swapping the transport (for example to an
 * in-process call) requires no change to callers.
 *
 * @module @sparkelf/dsh-knowledge-base/remote
 */

/** Result of one remote command. */
export interface RemoteCommandResult {
  /** Process exit status, or null when the command died from a signal. */
  exitCode: number | null
  /** Captured standard output. */
  stdout: string
  /** Captured standard error. */
  stderr: string
  /** True when the transport truncated the output. */
  truncated: boolean
}

/** One SSH host as the manager reports it. Secrets are never included. */
export interface RemoteHost {
  id: string
  name: string
  hostname: string
  username: string
  port: number
  /** Host-key fingerprint the manager will verify against. */
  knownHostFingerprint: string | null
  /** Whether a usable credential is configured for this host. */
  credentialConfigured: boolean
}

/** Transport the deployment steps run over. */
export interface RemoteRunner {
  /** List the hosts available for deployment. */
  listHosts(): Promise<RemoteHost[]>
  /**
   * Run one command on a host.
   * @param hostId - id from {@link RemoteHost}.
   * @param command - shell command executed by the remote login shell.
   * @param timeoutMs - abort the command after this long.
   */
  execute(hostId: string, command: string, timeoutMs?: number): Promise<RemoteCommandResult>
}

/** Why a remote call failed. */
export class RemoteError extends Error {
  readonly code: 'manager-unavailable' | 'unknown-host' | 'transport'

  constructor(message: string, code: RemoteError['code'], options?: ErrorOptions) {
    super(message, options)
    this.name = 'RemoteError'
    this.code = code
  }
}

/** Options accepted by {@link sshManagerRunner}. */
export interface SshManagerRunnerOptions {
  /**
   * Origin the ssh-manager API answers on, for example `http://127.0.0.1:3080`.
   * Required on the Host: `fetch` in Node rejects a relative URL outright, so a
   * path-only base cannot work there even though the browser would accept it.
   */
  origin: string
  /** Request timeout for inventory reads. */
  timeoutMs?: number
}

/**
 * The listener facts {@link originFrom} reads.
 *
 * `protocol` is optional because the seam added it after the peer range this
 * package declares against; a deployment without it speaks plain HTTP, which is
 * also the default here.
 */
export interface WebServerFacts {
  /** Configured bind address. */
  host: string
  /** Live listening port. */
  port: number
  /** `http:` or `https:`, when the seam reports it. */
  protocol?: 'http:' | 'https:'
}

/**
 * Build the origin this process's own HTTP server answers on.
 *
 * A Host-side plugin cannot call its sibling's route with a relative path: Node's
 * `fetch` throws `Failed to parse URL` before any request is made, which is why
 * the runner needs this. `ctx.webServer` exposes the listener's real host, port,
 * and protocol, so the value follows configuration rather than a guessed port.
 *
 * @param webServer - the live listener facts.
 * @returns an origin suitable for {@link SshManagerRunnerOptions.origin}.
 */
export function originFrom(webServer: WebServerFacts): string {
  // A wildcard bind (or an IPv6 literal) is not a usable URL host as written, and
  // this process is the client: loopback always reaches its own listener.
  const host = /^[0-9.]+$/u.test(webServer.host) && webServer.host !== '0.0.0.0'
    ? webServer.host
    : '127.0.0.1'
  const scheme = webServer.protocol === 'https:' ? 'https' : 'http'
  return `${scheme}://${host}:${String(webServer.port)}`
}

/** One JSON reply from the ssh-manager API. */
interface ManagerReply<T> {
  ok?: boolean
  value?: T
  error?: string
}

/**
 * Build a runner that reaches SSH hosts through the ssh-manager HTTP API.
 *
 * The manager already exposes `hosts.list`-equivalent state and
 * `hosts.execute`; this adapter only adapts shapes, so a change to the
 * manager's own auth or approval rules takes effect here without a code change.
 *
 * @param options - optional base URL and timeout overrides.
 * @returns a runner bound to the manager API.
 */
export function sshManagerRunner(options: SshManagerRunnerOptions): RemoteRunner {
  const base = options.origin.replace(/\/+$/u, '')
  if (base === '') throw new RemoteError('an origin is required to reach the SSH Manager', 'manager-unavailable')
  const timeoutMs = options.timeoutMs ?? 20_000

  async function call<T>(method: string, payload: Record<string, unknown>, signalTimeout = timeoutMs): Promise<T> {
    const url = `${base}/dsh-ssh-manager/api/${method}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(signalTimeout),
      })
    } catch (cause) {
      throw new RemoteError('SSH Manager is not reachable; is the ssh-manager plugin installed?', 'manager-unavailable', { cause })
    }
    const body = (await response.json().catch(() => ({}))) as ManagerReply<T>
    if (!response.ok || body.error !== undefined) {
      throw new RemoteError(body.error ?? `SSH Manager returned HTTP ${String(response.status)}`, 'transport')
    }
    // The manager answers either the bare value or an { ok, value } envelope.
    return (body.value ?? (body as unknown as T))
  }

  return {
    async listHosts(): Promise<RemoteHost[]> {
      const state = await call<{ hosts?: RemoteHost[] }>('state', {})
      return state.hosts ?? []
    },
    async execute(hostId: string, command: string, commandTimeoutMs = 120_000): Promise<RemoteCommandResult> {
      const raw = await call<{
        exitCode?: number | null
        stdout?: string
        stderr?: string
        truncated?: boolean
      }>('hosts.execute', { hostId, command, timeoutMs: commandTimeoutMs }, commandTimeoutMs + 10_000)
      return {
        exitCode: raw.exitCode ?? null,
        stdout: raw.stdout ?? '',
        stderr: raw.stderr ?? '',
        truncated: raw.truncated ?? false,
      }
    },
  }
}
