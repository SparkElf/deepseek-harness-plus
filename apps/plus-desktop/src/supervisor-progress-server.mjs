import { createServer } from 'node:http'
import { watch } from 'node:fs'
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLocalePreference } from './supervisor-locale.mjs'

const COMMANDS = new Set(['start', 'restart', 'rebuild-and-restart'])
const LOG_TAIL_BYTES = 256 * 1024
const contentTypes = new Map([
  ['/', 'text/html; charset=utf-8'],
  ['/styles.css', 'text/css; charset=utf-8'],
  ['/app.js', 'text/javascript; charset=utf-8'],
  ['/locales.js', 'text/javascript; charset=utf-8'],
  ['/assets/deepseek-logo.svg', 'image/svg+xml'],
  ['/assets/player-play.svg', 'image/svg+xml'],
  ['/assets/refresh.svg', 'image/svg+xml'],
  ['/assets/hammer.svg', 'image/svg+xml'],
])

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function pipePath(socketPath) {
  return process.platform === 'win32' ? String.fromCharCode(92, 92, 46, 92, 112, 105, 112, 101, 92) + socketPath : socketPath
}

function sendSupervisorCommand(socketPath, command, branch, onProgress) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipePath(socketPath))
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', chunk => {
      input += chunk
      const lines = input.split(String.fromCharCode(10))
      input = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        if (message.event === 'progress') {
          onProgress(message.message)
          continue
        }
        socket.end()
        if (message.ok) resolve(message.value)
        else reject(new Error(message.error))
      }
    })
    socket.once('error', reject)
    socket.write(JSON.stringify({ command, branch }) + String.fromCharCode(10))
  })
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', chunk => {
      body += chunk
      if (body.length > 1_024) request.destroy(new Error('command request exceeds 1024 bytes'))
    })
    request.once('end', () => resolve(body))
    request.once('error', reject)
  })
}

/**
 * 在 Supervisor process 内提供本地 progress 页面和 SSE stream。
 * @param {{ port: number, manifestPath: string, socketPath: string, logPath?: string }} options 监听端口和 Supervisor runtime 路径。
 * @returns {Promise<{ close: () => Promise<void> }>} 可等待关闭的页面服务。
 */
export async function startProgressServer({ port, manifestPath, socketPath, logPath }) {
  const directory = dirname(fileURLToPath(import.meta.url))
  const pageDirectory = join(directory, '..', 'progress')
  const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const resolvedLogPath = logPath ?? join(initialManifest.dshHome, 'supervisor', 'runtime.log')
  const clients = new Set()
  let activeCommand
  let lastCommand
  let publishing = false
  let publishRequested = false

  await mkdir(dirname(resolvedLogPath), { recursive: true })
  await writeFile(resolvedLogPath, '', { flag: 'a', mode: 0o600 })

  function parsePhaseLine(line) {
    const delimiter = line.indexOf(' ', '[phase] '.length)
    return {
      at: line.slice('[phase] '.length, delimiter),
      phase: JSON.parse(line.slice(delimiter + 1)),
    }
  }

  async function readLogTail() {
    const details = await stat(resolvedLogPath)
    const start = Math.max(0, details.size - LOG_TAIL_BYTES)
    const handle = await open(resolvedLogPath, 'r')
    try {
      const buffer = Buffer.alloc(details.size - start)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
      const content = buffer.toString('utf8', 0, bytesRead)
      const boundary = content.indexOf(String.fromCharCode(10))
      return start === 0 || boundary < 0 ? content : content.slice(boundary + 1)
    } finally {
      await handle.close()
    }
  }

  async function readSnapshot() {
    const [manifestText, logText] = await Promise.all([
      readFile(manifestPath, 'utf8'),
      readLogTail(),
    ])
    const runtime = JSON.parse(manifestText)
    const lines = logText.split(String.fromCharCode(10)).filter(Boolean)
    const phases = lines.filter(line => line.startsWith('[phase] ')).map(parsePhaseLine)
    return {
      runtime: { ...runtime, locale: await readLocalePreference(runtime.dshHome) },
      operation: activeCommand ?? lastCommand,
      timeline: phases.slice(-24),
      log: lines.slice(-120).map(line => line.startsWith('[phase] ')
        ? { kind: 'phase', ...parsePhaseLine(line) }
        : { kind: 'output', text: line }),
    }
  }

  function broadcast(name, value) {
    const payload = 'event: ' + name + String.fromCharCode(10) + 'data: ' + JSON.stringify(value) + String.fromCharCode(10) + String.fromCharCode(10)
    for (const client of clients) client.write(payload)
  }

  async function publish() {
    if (publishing) {
      publishRequested = true
      return
    }
    publishing = true
    try {
      do {
        publishRequested = false
        broadcast('status', await readSnapshot())
      } while (publishRequested)
    } finally {
      publishing = false
    }
  }

  function reportAsyncFailure(label, error) {
    console.error('[supervisor-progress] ' + label, error)
  }

  async function runCommand(command, branch) {
    activeCommand = { command, branch, state: 'running', phase: { key: 'queued' } }
    await publish()
    try {
      const result = await sendSupervisorCommand(socketPath, command, branch, phase => {
        activeCommand = { command, branch, state: 'running', phase }
        broadcast('progress', { operation: activeCommand, at: new Date().toISOString() })
        void publish().catch(error => reportAsyncFailure('publish progress failed', error))
      })
      lastCommand = { command, branch, state: 'completed', result }
    } catch (error) {
      console.error('[supervisor-progress] command failed', error)
      lastCommand = { command, branch, state: 'failed', error: errorMessage(error) }
    } finally {
      activeCommand = undefined
      await publish()
    }
  }

  async function serveAsset(path, response) {
    const contentType = contentTypes.get(path)
    if (contentType === undefined) return false
    const asset = path === '/' ? 'index.html' : path.slice(1)
    response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
    response.end(await readFile(join(pageDirectory, asset)))
    return true
  }

  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname
      if (request.method === 'GET' && path === '/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        clients.add(response)
        response.once('close', () => clients.delete(response))
        response.write(': connected' + String.fromCharCode(10) + String.fromCharCode(10))
        response.write('event: status' + String.fromCharCode(10) + 'data: ' + JSON.stringify(await readSnapshot()) + String.fromCharCode(10) + String.fromCharCode(10))
        return
      }
      if (request.method === 'GET' && path === '/api/status') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(await readSnapshot()))
        return
      }
      if (request.method === 'POST' && path === '/api/command') {
        const payload = JSON.parse(await requestBody(request))
        if (!COMMANDS.has(payload.command)) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: 'unsupported Supervisor command' }))
          return
        }
        if (payload.branch !== undefined && (typeof payload.branch !== 'string' || payload.branch.length === 0 || payload.branch.length > 255)) {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: 'branch must be a non-empty string of at most 255 characters' }))
          return
        }
        if (activeCommand !== undefined) {
          response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
          response.end(JSON.stringify({ error: 'a Supervisor command is already running' }))
          return
        }
        void runCommand(payload.command, payload.branch).catch(error => reportAsyncFailure('command task failed', error))
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ accepted: true, operation: activeCommand }))
        return
      }
      if (request.method === 'GET' && await serveAsset(path, response)) return
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
    } catch (error) {
      console.error('[supervisor-progress] request failed', error)
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ error: errorMessage(error) }))
    }
  })

  const publishAfterChange = () => { void publish().catch(error => reportAsyncFailure('filesystem update failed', error)) }
  const watchers = [...new Set([dirname(manifestPath), dirname(resolvedLogPath)])].map(path => watch(path, publishAfterChange))
  await new Promise((resolve, reject) => {
    const listening = () => {
      server.off('error', failed)
      console.log('Supervisor progress page: http://127.0.0.1:' + String(port))
      resolve()
    }
    const failed = error => {
      server.off('listening', listening)
      reject(error)
    }
    server.once('error', failed)
    server.once('listening', listening)
    server.listen(port, '127.0.0.1')
  })

  return {
    async close() {
      for (const watcher of watchers) watcher.close()
      for (const client of clients) client.end()
      clients.clear()
      await new Promise((resolve, reject) => server.close(error => error === undefined ? resolve() : reject(error)))
    },
  }
}
