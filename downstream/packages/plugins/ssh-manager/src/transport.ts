import type { Duplex } from 'node:stream'
import { Client, type ConnectConfig } from 'ssh2'
import type { SshCommandResult, SshCredentialInput, SshHost } from './types.ts'
import { SshManagerStore } from './store.ts'

const OUTPUT_LIMIT = 1 << 20
export interface SshConnectionTest { hostId: string; latencyMs: number; fingerprint: string }
export interface SshDraftTest { latencyMs: number; fingerprint: string; pinned: boolean }
export interface SshConnection { client: Client; host: SshHost; fingerprint: string; latencyMs: number; close(): void }

export function fingerprintFromHash(hash: string): string {
  if (!/^[0-9a-f]+$/iu.test(hash) || hash.length % 2 !== 0) throw new Error('SSH host key hash is invalid')
  return 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/u, '')
}

export function sshConnectConfig(host: SshHost, credential: SshCredentialInput | undefined, socket?: Duplex): ConnectConfig {
  if (host.knownHostFingerprint === null || host.knownHostFingerprint.trim() === '') throw new Error('SSH known-host fingerprint is required before connecting')
  const config: ConnectConfig = { host: host.hostname, port: host.port, username: host.username, readyTimeout: 10_000, keepaliveInterval: Math.max(0, host.keepAliveSeconds) * 1000, keepaliveCountMax: 3, hostHash: 'sha256' }
  if (socket !== undefined) config.sock = socket
  if (host.authKind === 'password') {
    if (!credential?.password) throw new Error('SSH password is not configured')
    config.password = credential.password
  } else if (host.authKind === 'private-key') {
    if (!credential?.privateKey) throw new Error('SSH private key is not configured')
    config.privateKey = credential.privateKey
    if (credential.passphrase) config.passphrase = credential.passphrase
  } else {
    if (!process.env.SSH_AUTH_SOCK) throw new Error('SSH_AUTH_SOCK is not available')
    config.agent = process.env.SSH_AUTH_SOCK
  }
  return config
}

async function connectOne(host: SshHost, credential: SshCredentialInput | undefined, socket?: Duplex): Promise<SshConnection> {
  const config = sshConnectConfig(host, credential, socket)
  const expected = host.knownHostFingerprint as string
  const client = new Client()
  const started = performance.now()
  let observed: string | undefined
  let closed = false
  config.hostVerifier = (hash: string) => { observed = fingerprintFromHash(hash); return observed === expected }
  return new Promise((resolve, reject) => {
    let settled = false
    const close = (): void => { if (closed) return; closed = true; client.end(); socket?.destroy() }
    const fail = (error: Error): void => { if (settled) return; settled = true; close(); reject(error) }
    client.once('ready', () => { if (settled) return; settled = true; resolve({ client, host, fingerprint: observed as string, latencyMs: Math.round(performance.now() - started), close }) })
    client.once('error', error => { if (observed !== undefined && observed !== expected) fail(new Error('SSH host fingerprint mismatch. Observed ' + observed)); else fail(error) })
    try { client.connect(config) } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
  })
}

export async function openSshConnection(store: SshManagerStore, hostId: string, visited: ReadonlySet<string> = new Set()): Promise<SshConnection> {
  if (visited.has(hostId)) throw new Error('SSH jump-host cycle detected at ' + hostId)
  const nextVisited = new Set(visited).add(hostId)
  const host = await store.host(hostId)
  const credential = await store.credential(hostId)
  if (host.jumpHostId === null) return connectOne(host, credential)
  const jump = await openSshConnection(store, host.jumpHostId, nextVisited)
  let socket: Duplex
  try {
    socket = await new Promise<Duplex>((resolve, reject) => {
      jump.client.forwardOut('127.0.0.1', 0, host.hostname, host.port, (error, stream) => { if (error !== undefined) reject(error); else resolve(stream) })
    })
    const target = await connectOne(host, credential, socket)
    const closeTarget = target.close
    let closed = false
    target.close = () => { if (closed) return; closed = true; closeTarget(); jump.close() }
    return target
  } catch (error) {
    jump.close()
    throw error
  }
}

export async function testSshHost(store: SshManagerStore, hostId: string): Promise<SshConnectionTest> {
  const connection = await openSshConnection(store, hostId)
  connection.close()
  return { hostId, latencyMs: connection.latencyMs, fingerprint: connection.fingerprint }
}

/**
 * Observe a host key without authenticating.
 *
 * The wizard has no pinned fingerprint yet, and refusing to connect until the user
 * pastes one by hand defeats the point of a connection wizard. A key-exchange probe
 * answers the one question the user cannot answer from memory — which key does this
 * address present — and the caller decides whether to pin it (trust on first use).
 * Authentication never starts: the probe closes as soon as the key is seen.
 * @param host - address to probe; only hostname/port are used.
 * @returns the observed OpenSSH SHA256 fingerprint.
 */
export async function probeSshHostKey(host: SshHost): Promise<string> {
  const client = new Client()
  const config: ConnectConfig = {
    host: host.hostname,
    port: host.port,
    username: host.username === '' ? 'probe' : host.username,
    readyTimeout: 8_000,
    hostHash: 'sha256',
  }
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, fingerprint?: string): void => {
      if (settled) return
      settled = true
      try { client.end() } catch { /* the handshake may already be gone */ }
      if (error !== undefined) reject(error)
      else resolve(fingerprint as string)
    }
    config.hostVerifier = (hash: string) => {
      const fingerprint = fingerprintFromHash(hash)
      // Leaving the verifier true lets the handshake finish; ending the client in the
      // same tick keeps the probe from ever offering credentials.
      queueMicrotask(() => { finish(undefined, fingerprint) })
      return true
    }
    client.once('error', (error: Error) => { finish(error) })
    try { client.connect(config) } catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
  })
}

/**
 * Test a host that has not been saved yet.
 *
 * A stored host without a pinned fingerprint is tested against the key its address
 * presents, and the result reports `pinned: false` so the wizard can show that this
 * test also pinned the key. With a pinned fingerprint the connection must match it;
 * a mismatch reports the observed value.
 * @param host - draft host identity and advanced options.
 * @param credential - draft credential; never returned to the browser.
 * @returns latency, the fingerprint used, and whether it came from the stored host.
 */
export async function testSshDraft(host: SshHost, credential: SshCredentialInput | undefined): Promise<SshDraftTest> {
  const stored = host.knownHostFingerprint !== null && host.knownHostFingerprint.trim() !== ''
  const fingerprint = stored ? host.knownHostFingerprint as string : await probeSshHostKey(host)
  const connection = await connectOne({ ...host, knownHostFingerprint: fingerprint }, credential)
  connection.close()
  return { latencyMs: connection.latencyMs, fingerprint: connection.fingerprint, pinned: stored }
}

function appendBounded(current: string, chunk: Buffer): { value: string; truncated: boolean } {
  if (Buffer.byteLength(current) >= OUTPUT_LIMIT) return { value: current, truncated: true }
  const remaining = OUTPUT_LIMIT - Buffer.byteLength(current)
  if (chunk.byteLength <= remaining) return { value: current + chunk.toString('utf8'), truncated: false }
  return { value: current + chunk.subarray(0, remaining).toString('utf8'), truncated: true }
}

export async function executeSshCommand(store: SshManagerStore, hostId: string, command: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<SshCommandResult> {
  if (command.trim() === '' || command.length > 32_768) throw new Error('SSH command must contain 1 to 32768 characters')
  const timeout = Math.min(10 * 60_000, Math.max(1_000, Math.trunc(timeoutMs)))
  const connection = await openSshConnection(store, hostId)
  const started = performance.now()
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    let truncated = false
    let settled = false
    let streamRef: { close(): void } | undefined
    const finish = (error?: Error, exitCode: number | null = null, exitSignal: string | null = null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      connection.close()
      if (error !== undefined) reject(error)
      else resolve({ hostId, exitCode, signal: exitSignal, stdout, stderr, durationMs: Math.round(performance.now() - started), truncated })
    }
    const abort = (): void => { streamRef?.close(); finish(new Error('SSH command was cancelled')) }
    const timer = setTimeout(() => { streamRef?.close(); finish(new Error('SSH command timed out after ' + timeout.toString() + ' ms')) }, timeout)
    signal?.addEventListener('abort', abort, { once: true })
    connection.client.exec(command, (error, stream) => {
      if (error !== undefined) { finish(error); return }
      streamRef = stream
      stream.on('data', (chunk: Buffer) => { const next = appendBounded(stdout, Buffer.from(chunk)); stdout = next.value; truncated ||= next.truncated })
      stream.stderr.on('data', (chunk: Buffer) => { const next = appendBounded(stderr, Buffer.from(chunk)); stderr = next.value; truncated ||= next.truncated })
      stream.once('close', (code: number | null, remoteSignal: string | null) => { finish(undefined, code, remoteSignal) })
      stream.once('error', (streamError: Error) => { finish(streamError) })
    })
  })
}
