#!/usr/bin/env node
/**
 * 企微历史同步 CLI 桥（在 bot 容器内以 nobody 运行）。
 *
 * DSH Host 进程会丢掉全部 capabilities（CapEff=0、NoNewPrivs=1），无法再 `spawn({uid})`
 * 降权；而 CLI 凭据目录属于 nobody（0700），root agent bash 没有 DAC_OVERRIDE 时读不到。
 * 所以把 CLI 调用放到这个独立进程：
 *
 * - 进程以 nobody 运行，`HOME=/opt/wecom-history/home`；
 * - 只暴露 `auth show`、`chat groups list`、`chat messages list` 三个只读命令；
 * - 不接受任意命令/参数拼接，不返回 `security_notice` / `extra_identity_context`；
 * - 不打印请求正文、消息正文或凭据。
 *
 * 启动（容器 root 有 capabilities 时）：
 *   setpriv --reuid=65534 --regid=65534 --clear-groups \
 *     env HOME=/opt/wecom-history/home ... node /opt/wecom-history/bridge/server.mjs
 *
 * @module wecom-history-bridge
 */

import http from 'node:http'
import { execFile } from 'node:child_process'

const CLI = process.env.WECOM_HISTORY_CLI_PATH
  ?? '/opt/wecom-history/cli/node_modules/@wecom/cli/bin/wecom.js'
const NODE = process.env.WECOM_HISTORY_NODE_PATH ?? process.execPath
const HOME = process.env.HOME ?? '/opt/wecom-history/home'
const PORT = Number(process.env.WECOM_HISTORY_BRIDGE_PORT ?? 3199)
const HOST = process.env.WECOM_HISTORY_BRIDGE_HOST ?? '127.0.0.1'
const TIMEOUT_MS = Number(process.env.WECOM_HISTORY_REQUEST_TIMEOUT_MS ?? 60_000)
const MAX_OUTPUT = 16 * 1024 * 1024

/** 只允许固定格式的时间参数。 */
const TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u
/** 群 id / cursor 只允许可见 ASCII，禁止控制字符。 */
const TOKEN_RE = /^[\x21-\x7e]{1,200}$/u

/** 跑一次 CLI；stdout 原样返回，stderr 只用于错误消息。 */
function runCli(args) {
  return new Promise((resolve) => {
    execFile(NODE, [CLI, ...args], {
      env: {
        ...process.env,
        HOME,
        XDG_CONFIG_HOME: `${HOME}/.config`,
        NO_COLOR: '1',
        TERM: 'dumb',
        WECOM_CLI_NO_UPDATE_CHECK: '1',
      },
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = typeof stderr === 'string' && stderr.trim() !== '' ? stderr.trim().slice(0, 500) : error.message
        resolve({ code: typeof error.code === 'number' ? error.code : 1, stdout: '', stderr: detail })
        return
      }
      resolve({ code: 0, stdout, stderr: '' })
    })
  })
}

/** 只取 CLI 响应里的业务字段，丢弃安全提示/身份上下文。 */
function sanitize(payload) {
  if (payload === null || typeof payload !== 'object') return payload
  if (Array.isArray(payload.chats)) {
    return {
      chats: payload.chats.map(chat => ({
        chat_id: chat.chat_id,
        chat_name: chat.chat_name,
        last_msg_time: chat.last_msg_time,
        msg_count: chat.msg_count,
      })),
      chats_count: payload.chats_count,
      has_more: payload.has_more === true,
      next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : '',
    }
  }
  if (Array.isArray(payload.messages)) {
    return {
      messages: payload.messages,
      messages_count: payload.messages_count,
      has_more: payload.has_more === true,
      next_cursor: typeof payload.next_cursor === 'string' ? payload.next_cursor : '',
    }
  }
  return payload
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    'cache-control': 'no-store',
  })
  response.end(body)
}

function param(url, name) {
  const value = url.searchParams.get(name)
  return typeof value === 'string' ? value : ''
}

const server = http.createServer(async (request, response) => {
  if (request.method !== 'GET') {
    sendJson(response, 405, { ok: false, error: 'method_not_allowed' })
    return
  }
  const url = new URL(request.url ?? '/', 'http://localhost')
  try {
    if (url.pathname === '/health') {
      sendJson(response, 200, { ok: true })
      return
    }
    if (url.pathname === '/auth') {
      const result = await runCli(['auth', 'show', '--status'])
      const text = `${result.stdout}\n${result.stderr}`.toLowerCase()
      const status = /\bunauthorized\b|\u672a\u6388\u6743|\u672a\u767b\u5f55/u.test(text)
        ? 'unauthorized'
        : /\bauthorized\b|\u5df2\u6388\u6743/u.test(text) ? 'authorized' : 'unavailable'
      sendJson(response, 200, { status })
      return
    }
    if (url.pathname === '/groups') {
      const begin = param(url, 'begin-time')
      const end = param(url, 'end-time')
      const cursor = param(url, 'cursor')
      if (!TIME_RE.test(begin) || !TIME_RE.test(end) || (cursor !== '' && !TOKEN_RE.test(cursor))) {
        sendJson(response, 400, { ok: false, error: 'invalid_arguments' })
        return
      }
      const result = await runCli([
        'chat', 'groups', 'list',
        '--begin-time', begin,
        '--end-time', end,
        ...cursor === '' ? [] : ['--cursor', cursor],
      ])
      if (result.code !== 0) {
        sendJson(response, 502, { ok: false, error: 'cli_failed', detail: result.stderr.slice(0, 300) })
        return
      }
      sendJson(response, 200, sanitize(JSON.parse(result.stdout)))
      return
    }
    if (url.pathname === '/messages') {
      const chatId = param(url, 'chat-id')
      const begin = param(url, 'begin-time')
      const end = param(url, 'end-time')
      const cursor = param(url, 'cursor')
      if (!TOKEN_RE.test(chatId) || !TIME_RE.test(begin) || !TIME_RE.test(end)
        || (cursor !== '' && !TOKEN_RE.test(cursor))) {
        sendJson(response, 400, { ok: false, error: 'invalid_arguments' })
        return
      }
      const result = await runCli([
        'chat', 'messages', 'list',
        '--chat-id', chatId,
        '--begin-time', begin,
        '--end-time', end,
        ...cursor === '' ? [] : ['--cursor', cursor],
      ])
      if (result.code !== 0) {
        sendJson(response, 502, { ok: false, error: 'cli_failed', detail: result.stderr.slice(0, 300) })
        return
      }
      sendJson(response, 200, sanitize(JSON.parse(result.stdout)))
      return
    }
    sendJson(response, 404, { ok: false, error: 'not_found' })
  } catch {
    sendJson(response, 500, { ok: false, error: 'bridge_failed' })
  }
})

server.listen(PORT, HOST, () => {
  process.stdout.write(`wecom-history-bridge listening on ${HOST}:${String(PORT)}\n`)
})