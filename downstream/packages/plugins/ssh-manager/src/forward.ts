import { randomUUID } from 'node:crypto'
import { connect, createServer, type Server, type Socket } from 'node:net'
import type { ClientChannel, TcpConnectionDetails } from 'ssh2'
import { SshManagerStore } from './store.ts'
import { openSshConnection, type SshConnection } from './transport.ts'
import type { SshPortForward, SshPortForwardRequest } from './types.ts'

const FORWARDS_PER_SESSION = 20

interface ForwardHandle {
  sessionId: string
  request: SshPortForwardRequest
  value: SshPortForward
  connection?: SshConnection
  server?: Server
  remoteListener?: (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void
  closing: boolean
}

function address(value: string, label: string): string {
  const result = value.trim()
  if (result === '') throw new Error(label + ' is required')
  return result
}

function port(value: number, label: string, allowZero: boolean): number {
  const result = Math.trunc(value)
  if (!Number.isFinite(result) || result < (allowZero ? 0 : 1) || result > 65_535) throw new Error(label + ' must be between ' + (allowZero ? '0' : '1') + ' and 65535')
  return result
}

function validated(request: SshPortForwardRequest): SshPortForwardRequest {
  if (request.direction !== 'local' && request.direction !== 'remote') throw new Error('Port forward direction must be local or remote')
  return {
    hostId: address(request.hostId, 'SSH host id'),
    direction: request.direction,
    bindHost: address(request.bindHost, 'Bind host'),
    bindPort: port(request.bindPort, 'Bind port', true),
    targetHost: address(request.targetHost, 'Target host'),
    targetPort: port(request.targetPort, 'Target port', false),
  }
}

function snapshot(handle: ForwardHandle): SshPortForward { return { ...handle.value } }

export class SshPortForwardManager {
  private readonly handles = new Map<string, ForwardHandle>()
  constructor(private readonly store: SshManagerStore) {}

  async open(sessionId: string, input: SshPortForwardRequest): Promise<SshPortForward> {
    if ([...this.handles.values()].filter(handle => handle.sessionId === sessionId).length >= FORWARDS_PER_SESSION) throw new Error('SSH port forward limit reached for this session')
    const request = validated(input)
    await this.store.host(request.hostId)
    const id = randomUUID()
    const handle: ForwardHandle = { sessionId, request, value: { id, ...request, createdAt: Date.now(), state: 'disconnected' }, closing: false }
    this.handles.set(id, handle)
    try {
      await this.start(handle)
      return snapshot(handle)
    } catch (error) {
      this.handles.delete(id)
      this.stopRuntime(handle)
      throw error
    }
  }

  list(sessionId: string): SshPortForward[] {
    return [...this.handles.values()].filter(handle => handle.sessionId === sessionId).map(snapshot)
  }

  async reconnect(sessionId: string, forwardId: string): Promise<SshPortForward> {
    const handle = this.owned(sessionId, forwardId)
    this.stopRuntime(handle)
    handle.value = { ...handle.value, state: 'disconnected', error: undefined }
    await this.start(handle)
    return snapshot(handle)
  }

  close(sessionId: string, forwardId: string): void {
    const handle = this.owned(sessionId, forwardId)
    this.handles.delete(forwardId)
    this.stopRuntime(handle)
  }

  closeAll(): void {
    for (const handle of this.handles.values()) this.stopRuntime(handle)
    this.handles.clear()
  }

  private owned(sessionId: string, forwardId: string): ForwardHandle {
    const handle = this.handles.get(forwardId)
    if (handle === undefined || handle.sessionId !== sessionId) throw new Error('SSH port forward not found: ' + forwardId)
    return handle
  }

  private async start(handle: ForwardHandle): Promise<void> {
    handle.closing = false
    const connection = await openSshConnection(this.store, handle.request.hostId)
    handle.connection = connection
    const disconnected = (): void => {
      if (handle.closing || this.handles.get(handle.value.id) !== handle) return
      handle.server?.close()
      handle.server = undefined
      handle.value = { ...handle.value, state: 'disconnected', error: 'SSH connection closed' }
    }
    const failed = (error: Error): void => {
      if (handle.closing || this.handles.get(handle.value.id) !== handle) return
      handle.server?.close()
      handle.server = undefined
      handle.value = { ...handle.value, state: 'failed', error: error.message }
    }
    connection.client.once('close', disconnected)
    connection.client.on('error', failed)
    try {
      if (handle.request.direction === 'local') await this.startLocal(handle)
      else await this.startRemote(handle)
      handle.value = { ...handle.value, state: 'active', error: undefined }
    } catch (error) {
      handle.closing = true
      connection.close()
      handle.connection = undefined
      throw error
    }
  }

  private async startLocal(handle: ForwardHandle): Promise<void> {
    const connection = handle.connection as SshConnection
    const server = createServer(socket => {
      const sourceHost = socket.remoteAddress ?? '127.0.0.1'
      const sourcePort = socket.remotePort ?? 0
      connection.client.forwardOut(sourceHost, sourcePort, handle.request.targetHost, handle.request.targetPort, (error, channel) => {
        if (error !== undefined) { socket.destroy(error); return }
        socket.on('error', () => { channel.destroy() })
        channel.on('error', () => { socket.destroy() })
        socket.pipe(channel).pipe(socket)
      })
    })
    handle.server = server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error): void => { server.off('listening', ready); reject(error) }
      const ready = (): void => { server.off('error', failed); resolve() }
      server.once('error', failed)
      server.once('listening', ready)
      server.listen(handle.request.bindPort, handle.request.bindHost)
    })
    server.on('error', error => { handle.value = { ...handle.value, state: 'failed', error: error.message } })
    const bound = server.address()
    if (bound === null || typeof bound === 'string') throw new Error('Local port forward did not bind to TCP')
    handle.value = { ...handle.value, bindPort: bound.port }
  }

  private async startRemote(handle: ForwardHandle): Promise<void> {
    const connection = handle.connection as SshConnection
    const listener = (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void): void => {
      if (details.destPort !== handle.value.bindPort) return
      let channel: ClientChannel | undefined
      const upstream: Socket = connect(handle.request.targetPort, handle.request.targetHost, () => {
        channel = accept()
        channel.on('error', () => { upstream.destroy() })
        upstream.pipe(channel).pipe(upstream)
      })
      upstream.once('error', () => { if (channel === undefined) reject(); else channel.destroy() })
    }
    handle.remoteListener = listener
    connection.client.on('tcp connection', listener)
    const assignedPort = await new Promise<number>((resolve, reject) => {
      connection.client.forwardIn(handle.request.bindHost, handle.request.bindPort, (error, assigned) => { if (error !== undefined) reject(error); else resolve(assigned) })
    })
    handle.value = { ...handle.value, bindPort: assignedPort }
  }

  private stopRuntime(handle: ForwardHandle): void {
    handle.closing = true
    const connection = handle.connection
    if (connection !== undefined && handle.remoteListener !== undefined) connection.client.off('tcp connection', handle.remoteListener)
    handle.server?.close()
    handle.server = undefined
    handle.remoteListener = undefined
    handle.connection = undefined
    connection?.close()
  }
}
