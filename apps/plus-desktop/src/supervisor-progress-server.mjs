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

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (!key.startsWith('--')) continue
    values[key.slice(2)] = argv[index + 1]
    index += 1
  }
  return values
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendSupervisorCommand(socketPath, command, onProgress) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
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
    socket.write(JSON.stringify({ command }) + String.fromCharCode(10))
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

const args = parseArgs(process.argv.slice(2))
if (!args.port || !args.manifest || !args.socket) throw new Error('progress server requires --port, --manifest, and --socket')

const directory = dirname(fileURLToPath(import.meta.url))
const pageDirectory = join(directory, '..', 'progress')
const port = Number(args.port)
const manifestPath = args.manifest
const socketPath = args.socket
const initialManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const logPath = args.log ?? join(initialManifest.dshHome, 'supervisor', 'runtime.log')
const clients = new Set()
let activeCommand
let lastCommand
let publishing = false
let publishRequested = false

await mkdir(dirname(logPath), { recursive: true })
await writeFile(logPath, '', { flag: 'a', mode: 0o600 })

function parsePhaseLine(line) {
  const delimiter = line.indexOf(' ', '[phase] '.length)
  return {
    at: line.slice('[phase] '.length, delimiter),
    phase: JSON.parse(line.slice(delimiter + 1)),
  }
}

async function readLogTail() {
  const details = await stat(logPath)
  const start = Math.max(0, details.size - LOG_TAIL_BYTES)
  const handle = await open(logPath, 'r')
  try {
    const buffer = Buffer.alloc(details.size - start)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const content = buffer.toString('utf8', 0, bytesRead)
    return start === 0 ? content : content.slice(content.indexOf(String.fromCharCode(10)) + 1)
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

async function runCommand(command) {
  activeCommand = { command, state: 'running', phase: { key: 'queued' } }
  await publish()
  try {
    const result = await sendSupervisorCommand(socketPath, command, phase => {
      activeCommand = { command, state: 'running', phase }
      broadcast('progress', { operation: activeCommand, at: new Date().toISOString() })
      void publish().catch(error => reportAsyncFailure('publish progress failed', error))
    })
    lastCommand = { command, state: 'completed', result }
  } catch (error) {
    console.error('[supervisor-progress] command failed', error)
    lastCommand = { command, state: 'failed', error: errorMessage(error) }
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
      if (activeCommand !== undefined) {
        response.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ error: 'a Supervisor command is already running' }))
        return
      }
      void runCommand(payload.command).catch(error => reportAsyncFailure('command task failed', error))
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
const manifestWatcher = watch(dirname(manifestPath), publishAfterChange)
const logWatcher = watch(dirname(logPath), publishAfterChange)
server.listen(port, '127.0.0.1', () => console.log('Supervisor progress page: http://127.0.0.1:' + String(port)))

function close() {
  manifestWatcher.close()
  logWatcher.close()
  for (const client of clients) client.end()
  server.close(() => process.exit(0))
}

process.once('SIGTERM', close)
process.once('SIGINT', close)
