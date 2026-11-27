/**
 * Multi-user bridge server: phones and desktops authenticate with email
 * verification codes or WeChat and bind to a pairing code. The server is a
 * BLIND payload forwarder: the server parses only outer device route ids;
 * encrypted `blob` payloads stay opaque between the phone Service Worker and
 * desktop plugin.
 * Bridges dial OUT from the local network, so no inbound port is needed.
 * @module @sparkelf/dsh-mobile-bridge-server/server
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { SW_SOURCE, CLIENT_SOURCE, SOCKET_CLIENT_SOURCE } from './phone.ts'
import { UserStore, type DeviceRecord } from './store.ts'
import type { WechatConfig } from './wechat.ts'
import { generateScheme } from './wechat-scheme.ts'

/** Verifies one external login payload and returns the stable identity. */
export type ExternalAuthVerifier = (payload: Record<string, unknown>) => Promise<string>

/** Sends one verification code email; injected so tests never touch SMTP. */
export type CodeMailer = (email: string, code: string) => Promise<void>

/** Options for the bridge server. */
export interface BridgeServerOptions {
  /** Enabled external login providers (e.g. wechat) with their verifiers. */
  externalAuth?: Record<string, ExternalAuthVerifier>
  /** Delivers email verification codes; required for email login. */
  mailer?: CodeMailer
  /** WeChat credentials enabling URL Scheme generation for mini-program QRs. */
  wechatScheme?: WechatConfig
}

const COOKIE = 'mbs'
const require = createRequire(import.meta.url)
const QR_SCANNER_SOURCE = readFileSync(require.resolve('qr-scanner'), 'utf8')
const QR_SCANNER_WORKER_SOURCE = readFileSync(require.resolve('qr-scanner/qr-scanner-worker.min.js'), 'utf8')
const ZXING_READER_ENTRY = require.resolve('zxing-wasm/reader')
const ZXING_READER_SOURCE = readFileSync(resolve(dirname(ZXING_READER_ENTRY), '../../iife/reader/index.js'), 'utf8')
const ZXING_READER_WASM = readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'))
const DEEPSEEK_LOGO = readFileSync(new URL('./deepseek-logo.svg', import.meta.url), 'utf8')
const DEEPSEEK_LOGO_DATA_URL = 'data:image/svg+xml;base64,' + Buffer.from(DEEPSEEK_LOGO).toString('base64')

const LANDING = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="dark light"><title>DeepSeek Harness Mobile</title><link rel="icon" type="image/svg+xml" href="${DEEPSEEK_LOGO_DATA_URL}">
<style>
:root{color-scheme:dark;--page:#090d13;--field:#151b25;--field-focus:#1b2330;--label:#f4f7fb;--muted:#aeb8c8;--placeholder:#768296;--primary:#4d6bfe;--primary-hover:#5a76ff;--secondary:#222a37;--secondary-hover:#2a3443;--danger:#ff7b84;--grid:rgb(105 132 255/.12)}
:root[data-theme=light]{color-scheme:light;--page:#f6f8fc;--field:#e9edf5;--field-focus:#e2e8f3;--label:#182033;--muted:#5c687b;--placeholder:#7d8899;--primary:#405de6;--primary-hover:#3452dc;--secondary:#e1e7f1;--secondary-hover:#d8e0ed;--danger:#d93d54;--grid:rgb(77 107 254/.045)}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;background:var(--page)}
body{min-height:100dvh;margin:0;padding:max(32px,env(safe-area-inset-top)) 16px max(28px,env(safe-area-inset-bottom));background:var(--page);color:var(--label);font:14px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
body::before{position:fixed;inset:0;content:"";pointer-events:none;background-image:linear-gradient(var(--grid) 1px,transparent 1px),linear-gradient(90deg,var(--grid) 1px,transparent 1px);background-size:32px 32px}
main{position:relative;width:min(100%,390px);margin:clamp(12px,5vh,48px) auto 0;padding:0 8px}
.brand{display:flex;align-items:center;justify-content:space-between;gap:16px}
.brand img{display:block;width:min(195px,65%);height:auto}
.product{color:var(--muted);font-size:11px;font-weight:700;text-transform:uppercase}
.preferences{display:flex;justify-content:flex-end;gap:8px;margin-top:22px}
.segmented{display:flex;padding:3px;border-radius:8px;background:var(--field)}
.preferences button{width:auto;height:30px;padding:0 10px;border-radius:6px;background:transparent;color:var(--muted);font-size:12px;font-weight:650}
.preferences button:hover{background:var(--field-focus)}
.preferences button[aria-pressed=true]{background:var(--primary);color:white}
.intro{margin:30px 0 28px}
h1{margin:0;font-size:22px;line-height:1.35;font-weight:650}
.scanFirst{display:grid;gap:14px;margin:0;color:var(--muted);font-size:13px}
.scanFirst p{margin:0}
.scanButton{max-width:220px}
.scanner{position:fixed;inset:0;z-index:20;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#05070b;color:#f4f7fb;padding:max(12px,env(safe-area-inset-top)) 0 max(16px,env(safe-area-inset-bottom))}
.scannerHeader{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px 12px}
.scannerHeader h2{margin:0;font-size:18px;line-height:40px}
.scannerClose{width:40px;height:40px;padding:0;border-radius:50%;background:rgb(255 255 255/.1);font-size:26px;font-weight:400;line-height:40px}
.scannerClose:hover{background:rgb(255 255 255/.16)}
.scannerStage{position:relative;min-height:0;overflow:hidden;background:#000}
.scanner video{display:block;width:100%;height:100%;object-fit:cover}
.scannerFrame{border:2px solid #6f89ff;border-radius:8px;box-shadow:0 0 0 200vmax rgb(0 0 0/.34)}
.scannerFrame.manual{position:absolute;top:50%;left:50%;width:min(67vw,320px);aspect-ratio:1;transform:translate(-50%,-50%)}
.wasmOutline{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.wasmOutline polygon{fill:rgb(69 196 129/.16);stroke:#45c481;stroke-width:4;vector-effect:non-scaling-stroke}
.scannerFrame.invalid .wasmOutline polygon{fill:rgb(255 104 120/.14);stroke:#ff6878}
.scannerFrame .code-outline-highlight{fill:rgb(69 196 129/.16)!important;stroke:#45c481!important;stroke-width:4!important;stroke-dasharray:none!important}
.scannerFrame.invalid .code-outline-highlight{fill:rgb(255 104 120/.14)!important;stroke:#ff6878!important}
.scannerStatus{min-height:48px;margin:0;padding:14px 20px 0;color:#c6cedb;text-align:center}
.scannerStatus.error{color:#ff9aa2}
body.scannerOpen{overflow:hidden}
[hidden]{display:none!important}
#loginForm{padding-bottom:12px}
.field{display:grid;gap:7px}
.field+.field,.codeRow+.field{margin-top:16px}
label{color:var(--muted);font-size:12px;font-weight:600}
input,button{width:100%;min-width:0;height:46px;border:0;border-radius:8px;font:inherit}
input{padding:0 13px;outline:none;background:var(--field);color:var(--label);font-size:16px}
input::placeholder{color:var(--placeholder)}
input:focus{background:var(--field-focus);box-shadow:inset 0 -2px 0 var(--primary)}
#b{text-transform:uppercase;font-variant-numeric:tabular-nums}
.codeRow{display:grid;grid-template-columns:minmax(0,1fr) 92px;align-items:end;gap:8px;margin-top:16px}
button{background:var(--primary);color:white;font-weight:650;cursor:pointer;transition:background-color .16s ease,transform .08s ease}
button:hover{background:var(--primary-hover)}
button:active{transform:translateY(1px)}
button.ghost{background:var(--secondary);color:var(--label)}
button.ghost:hover{background:var(--secondary-hover)}
button:disabled{opacity:.6;cursor:wait}
#l{margin-top:22px}
p.err{min-height:20px;margin:12px 0 0;color:var(--danger);font-size:13px;line-height:20px}
@media(max-width:340px){main{padding:0 2px}.brand img{width:168px}.preferences{justify-content:flex-start}.preferences button{padding:0 8px}.codeRow{grid-template-columns:minmax(0,1fr) 82px}}
@media(prefers-reduced-motion:reduce){button{transition:none}}
</style></head><body>
<main aria-labelledby="title"><header class="brand"><img src="${DEEPSEEK_LOGO_DATA_URL}" alt="DeepSeek"><span class="product">Harness Mobile</span></header><nav class="preferences" aria-label="显示偏好"><div class="segmented"><button id="langZh" type="button" aria-pressed="true">中文</button><button id="langEn" type="button" aria-pressed="false">EN</button></div><div class="segmented"><button id="themeLight" type="button" aria-pressed="false" data-i18n="light">浅色</button><button id="themeDark" type="button" aria-pressed="true" data-i18n="dark">深色</button></div></nav><div class="intro"><h1 id="title" data-i18n="title">移动连接</h1></div><section class="scanFirst" id="scanFirst"><p data-i18n="scanFirst">请扫描桌面端二维码</p><button id="openScanner" class="scanButton" type="button" data-i18n="openScanner">打开相机扫码</button></section><section id="loginForm" hidden><div class="field"><label for="e" data-i18n="email">邮箱</label><input id="e" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" data-i18n-placeholder="emailPlaceholder"></div><div class="codeRow"><div class="field"><label for="c" data-i18n="code">验证码</label><input id="c" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" data-i18n-placeholder="codePlaceholder"></div><button id="s" class="ghost" type="button" data-i18n="send">发送</button></div><div class="field"><label for="b" data-i18n="pairingCode">配对码</label><input id="b" autocomplete="off" placeholder="6 位字符" data-i18n-placeholder="pairingPlaceholder"></div><button id="l" type="button" data-i18n="connect">登录并连接</button><p class="err" id="x" role="alert"></p></section></main><section id="scanner" class="scanner" role="dialog" aria-modal="true" aria-labelledby="scannerTitle" hidden><header class="scannerHeader"><h2 id="scannerTitle" data-i18n="scannerTitle">扫描配对二维码</h2><button id="closeScanner" class="scannerClose" type="button" aria-label="关闭相机" data-i18n-aria-label="closeScanner">×</button></header><div class="scannerStage"><video id="scannerVideo" autoplay muted playsinline></video><div id="scannerFrame" class="scannerFrame" aria-hidden="true"><svg id="wasmOutline" class="wasmOutline" aria-hidden="true"><polygon id="wasmOutlinePolygon"></polygon></svg></div></div><p id="scannerStatus" class="scannerStatus" role="status" data-i18n="cameraStarting">正在打开相机</p></section>
<script src="/bridge/client.js"></script></body></html>`

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

function sameToken(expected: string, actual: string): boolean {
  const left = Buffer.from(expected)
  const right = Buffer.from(actual)
  return left.length === right.length && timingSafeEqual(left, right)
}

function cookieToken(req: IncomingMessage): string {
  const header = req.headers.cookie ?? ''
  const match = header.match(new RegExp('(?:^|; )' + COOKIE + '=([^;]+)'))
  return match ? decodeURIComponent(match[1]) : ''
}

/** Options for the bridge server. */
export interface BridgeServerRuntimeOptions extends BridgeServerOptions {
  /** Pairing login ticket lifetime; defaults to five minutes. */
  ticketTtlMs?: number
}

/** Device fields projected to the authenticated desktop, including live relay state. */
export interface BridgeDeviceView extends DeviceRecord {
  online: boolean
}

const DEFAULT_SESSION_DAYS = 7
const MAX_SESSION_DAYS = 365

// 桌面桥接请求是保活期限的唯一输入边界；配对票据只保存已验证的整天数。
function sessionDays(value: unknown): number {
  if (value === undefined) return DEFAULT_SESSION_DAYS
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_SESSION_DAYS) throw new Error('session days must be an integer from 1 to 365')
  return value
}

interface PairingTicketRecord {
  bridgeId: string
  code: string
  refreshToken: string
  expiresAt: number
  used: boolean
  sessionDays: number
  email2fa?: string
}

function bearerToken(req: IncomingMessage): string {
  return (req.headers.authorization ?? '').replace(/^Bearer /, '')
}

function requestIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  return value?.trim() || req.socket.remoteAddress || 'unknown'
}

/**
 * Whether one request reached this server over TLS.
 *
 * The session cookie carries `Secure` only when it does, because a browser refuses to store or send
 * a `Secure` cookie over plain HTTP. The phone service worker authenticates its relay socket from
 * that cookie alone -- it opens `/ws/client` without a token -- so a deployment served over HTTP
 * without this check lost the cookie, and the phone could not authenticate its socket at all.
 * @param req - Request whose scheme to classify.
 * @returns True when the client used HTTPS.
 */
function requestIsSecure(req: IncomingMessage): boolean {
  const forwarded = req.headers['x-forwarded-proto']
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]
  if (value !== undefined && value.trim() !== '') return value.trim() === 'https'
  return (req.socket as { encrypted?: boolean }).encrypted === true
}

/**
 * Session cookie attributes, with `Secure` only where a browser can return the cookie.
 * @param req - Request the cookie answers.
 * @param token - Session token to store.
 * @param days - Lifetime in days.
 * @returns The `Set-Cookie` value.
 */
function sessionCookie(req: IncomingMessage, token: string, days: number): string {
  return COOKIE + '=' + encodeURIComponent(token)
    + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' + String(days * 86400)
    + (requestIsSecure(req) ? '; Secure' : '')
}

function requestDeviceName(req: IncomingMessage): string {
  const userAgent = req.headers['user-agent'] ?? ''
  const platform = /iPad/u.test(userAgent)
    ? 'iPad'
    : /iPhone/u.test(userAgent)
      ? 'iPhone'
      : /Android/u.test(userAgent)
        ? 'Android'
        : /Windows/u.test(userAgent)
          ? 'Windows'
          : /Macintosh/u.test(userAgent)
            ? 'Mac'
            : 'Mobile browser'
  const browser = /Edg\//u.test(userAgent)
    ? 'Edge'
    : /Firefox\//u.test(userAgent)
      ? 'Firefox'
      : /(?:Chrome|CriOS)\//u.test(userAgent)
        ? 'Chrome'
        : /Safari\//u.test(userAgent)
          ? 'Safari'
          : ''
  return browser === '' ? platform : platform + ' · ' + browser
}

const SCANNER_DIAGNOSTIC_EVENTS = new Set(['open', 'library', 'controls', 'camera', 'scan', 'adjustment', 'decoded', 'accepted', 'rejected', 'error', 'close'])
const SCANNER_STRING_FIELDS = new Map([['state', 80], ['name', 80], ['message', 320], ['facingMode', 80], ['focusMode', 80], ['exposureMode', 80]])
const SCANNER_NUMBER_FIELDS = new Set(['attempts', 'elapsedMs', 'width', 'height', 'frameRate', 'corners', 'zoom', 'focusDistance', 'zoomMin', 'zoomMax', 'focusMin', 'focusMax', 'sharpness'])
const SCANNER_SIGNED_NUMBER_FIELDS = new Set(['exposureMin', 'exposureMax', 'exposureCompensation'])

function rawDataByteLength(raw: RawData): number {
  return Array.isArray(raw) ? raw.reduce((total, part) => total + part.byteLength, 0) : raw.byteLength
}

// Scanner diagnostics are an unauthenticated public ingress; only bounded, non-secret telemetry fields reach the server log.
function scannerDiagnostic(value: unknown): Record<string, string | number | boolean> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('scanner diagnostic must be an object')
  const input = value as Record<string, unknown>
  if (typeof input.event !== 'string' || !SCANNER_DIAGNOSTIC_EVENTS.has(input.event)) throw new Error('scanner diagnostic event is invalid')
  const output: Record<string, string | number | boolean> = { event: input.event }
  for (const [field, maxLength] of SCANNER_STRING_FIELDS) {
    const fieldValue = input[field]
    if (fieldValue === undefined) continue
    if (typeof fieldValue !== 'string') throw new Error('scanner diagnostic ' + field + ' must be a string')
    output[field] = fieldValue.slice(0, maxLength)
  }
  if (input.stack !== undefined) {
    if (typeof input.stack !== 'string') throw new Error('scanner diagnostic stack must be a string')
    output.stack = input.stack
  }
  for (const field of SCANNER_NUMBER_FIELDS) {
    const fieldValue = input[field]
    if (fieldValue === undefined) continue
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue) || fieldValue < 0) throw new Error('scanner diagnostic ' + field + ' must be a non-negative number')
    output[field] = fieldValue
  }
  for (const field of SCANNER_SIGNED_NUMBER_FIELDS) {
    const fieldValue = input[field]
    if (fieldValue === undefined) continue
    if (typeof fieldValue !== 'number' || !Number.isFinite(fieldValue)) throw new Error('scanner diagnostic ' + field + ' must be a finite number')
    output[field] = fieldValue
  }
  if (input.valid !== undefined) {
    if (typeof input.valid !== 'boolean') throw new Error('scanner diagnostic valid must be a boolean')
    output.valid = input.valid
  }
  return output
}

/**
 * Build the public bridge, pairing-ticket lifecycle, device registry, and
 * ciphertext relay around stable desktop identities.
 * @param store - durable identity, bridge, token, and device owner.
 * @param options - mail and external authentication providers.
 * @returns the Node HTTP server; its caller owns listen and close.
 */
export function createBridgeServer(store: UserStore, options: BridgeServerRuntimeOptions = {}) {
  const externalAuth = options.externalAuth ?? {}
  const mailer = options.mailer
  const ticketTtlMs = options.ticketTtlMs ?? 5 * 60_000
  const bridges = new Map<string, WebSocket>()
  const tickets = new Map<string, PairingTicketRecord>()
  const bridgeTickets = new Map<string, string>()
  const clientsByDevice = new Map<string, Set<WebSocket>>()
  // Relay 诊断默认关闭，只记录外层传输元数据；密文、身份和请求路径不得进入日志。
  const relayDiagnostics = process.env.MOBILE_BRIDGE_RELAY_DIAGNOSTICS === '1'
  const relayDiagnostic = (event: string, fields: Record<string, unknown>): void => {
    if (relayDiagnostics) console.info('[mobile-bridge relay] ' + JSON.stringify({ event, ...fields }))
  }

  // 持久设备记录是事实源，在线状态只由当前 WebSocket 集合投影。
  const deviceViews = (bridgeId: string): BridgeDeviceView[] => store.devicesForBridge(bridgeId).map(device => ({
    ...device,
    online: [...(clientsByDevice.get(device.id) ?? [])].some(socket => socket.readyState === WebSocket.OPEN),
  }))

  const notifyDevices = (bridgeId: string): void => {
    const socket = bridges.get(bridgeId)
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ control: 'devices', devices: deviceViews(bridgeId) }))
  }

  const issueTicket = (bridgeId: string, cookieDays: number, email2fa?: string): PairingTicketRecord => {
    const previousCode = bridgeTickets.get(bridgeId)
    if (previousCode !== undefined) tickets.delete(previousCode)
    const createdAt = Date.now()
    const ticket: PairingTicketRecord = {
      bridgeId,
      code: randomBytes(3).toString('hex'),
      refreshToken: randomBytes(24).toString('hex'),
      expiresAt: createdAt + ticketTtlMs,
      used: false,
      sessionDays: cookieDays,
      ...email2fa ? { email2fa } : {},
    }
    tickets.set(ticket.code, ticket)
    bridgeTickets.set(bridgeId, ticket.code)
    return ticket
  }

  const publicTicket = ({ code, refreshToken, expiresAt }: PairingTicketRecord) => ({ code, refreshToken, expiresAt })

  const liveTicket = (code: string): PairingTicketRecord => {
    const ticket = tickets.get(code)
    const socket = ticket === undefined ? undefined : bridges.get(ticket.bridgeId)
    if (ticket === undefined || socket?.readyState !== WebSocket.OPEN) throw new Error('unknown or offline pairing code')
    if (ticket.used) throw new Error('pairing code already used')
    if (ticket.expiresAt <= Date.now()) throw new Error('pairing code expired')
    return ticket
  }

  const pairDevice = (req: IncomingMessage, ticket: PairingTicketRecord, provider: string, externalId: string) => {
    const priorToken = cookieToken(req)
    const priorDevice = store.deviceFor(priorToken)
    const token = store.loginExternal(provider, externalId)
    const device = store.bindDevice(token, ticket.bridgeId, {
      name: requestDeviceName(req),
      ip: requestIp(req),
    }, priorDevice?.bridgeId === ticket.bridgeId ? priorDevice.id : undefined)
    ticket.used = true
    notifyDevices(ticket.bridgeId)
    const socket = bridges.get(ticket.bridgeId)
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ control: 'paired', devices: deviceViews(ticket.bridgeId) }))
    return { token, device }
  }

  const respondLogin = (req: IncomingMessage, res: ServerResponse, token: string, days: number): void => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'set-cookie': [sessionCookie(req, token, days)],
    })
    res.end(JSON.stringify({ token }))
  }

  const fail = (res: ServerResponse, status: number, label: string, error: unknown): void => {
    console.error('[dsh-mobile-bridge-server] ' + label, error)
    json(res, status, { error: error instanceof Error ? error.message : String(error) })
  }

  const http = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === '/bridge' || url.pathname === '/bridge/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(LANDING)
        return
      }
      if (url.pathname === '/bridge/deepseek-logo.svg') {
        res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'public, max-age=86400' })
        res.end(DEEPSEEK_LOGO)
        return
      }
      if (url.pathname === '/bridge/qr-scanner.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(QR_SCANNER_SOURCE)
        return
      }
      if (url.pathname === '/bridge/qr-scanner-worker.min.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(QR_SCANNER_WORKER_SOURCE)
        return
      }
      if (url.pathname === '/bridge/zxing-reader.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(ZXING_READER_SOURCE)
        return
      }
      if (url.pathname === '/bridge/zxing-reader.wasm') {
        res.writeHead(200, { 'content-type': 'application/wasm', 'cache-control': 'no-store' })
        res.end(ZXING_READER_WASM)
        return
      }
      if (url.pathname === '/bridge/client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(CLIENT_SOURCE)
        return
      }
      if (url.pathname === '/bridge/socket-client.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' })
        res.end(SOCKET_CLIENT_SOURCE)
        return
      }
      if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'service-worker-allowed': '/' })
        res.end(SW_SOURCE)
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/email/code') {
        if (mailer === undefined) { json(res, 503, { error: 'email login not configured' }); return }
        try {
          const { email } = JSON.parse(await readBody(req)) as { email: string }
          const code = store.issueEmailCode(email)
          await mailer(email, code)
          json(res, 200, { sent: true })
        } catch (error) { fail(res, 400, 'email code request failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/email') {
        try {
          const { email, code, bridge } = JSON.parse(await readBody(req)) as { email: string; code: string; bridge?: string }
          let days = DEFAULT_SESSION_DAYS
          store.consumeEmailCode(email, code)
          const token = store.loginExternal('email', email.trim().toLowerCase())
          if (typeof bridge === 'string' && bridge.trim() !== '') {
            const ticket = liveTicket(bridge.trim())
            days = ticket.sessionDays
            const priorDevice = store.deviceFor(cookieToken(req))
            store.bindDevice(token, ticket.bridgeId, { name: requestDeviceName(req), ip: requestIp(req) }, priorDevice?.bridgeId === ticket.bridgeId ? priorDevice.id : undefined)
            ticket.used = true
            const socket = bridges.get(ticket.bridgeId)
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ control: 'paired', devices: deviceViews(ticket.bridgeId) }))
          } else {
            const priorDevice = store.deviceFor(cookieToken(req))
            if (priorDevice === undefined) throw new Error('scan a desktop pairing QR first')
            store.bindDevice(token, priorDevice.bridgeId, { name: requestDeviceName(req), ip: requestIp(req) }, priorDevice.id)
          }
          respondLogin(req, res, token, days)
        } catch (error) { fail(res, 401, 'email login failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/external') {
        try {
          const { provider, payload } = JSON.parse(await readBody(req)) as { provider: string; payload: Record<string, unknown> }
          const verify = externalAuth[provider]
          if (verify === undefined) throw new Error('unknown provider')
          const externalId = await verify(payload)
          respondLogin(req, res, store.loginExternal(provider, externalId), DEFAULT_SESSION_DAYS)
        } catch (error) { fail(res, 401, 'external login failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/bridge') {
        try {
          const { code } = JSON.parse(await readBody(req)) as { code: string }
          const ticket = liveTicket(code)
          if (ticket.email2fa !== undefined) {
            if (mailer === undefined) throw new Error('email login not configured')
            await mailer(ticket.email2fa, store.issueEmailCode(ticket.email2fa))
            json(res, 200, { challenge: 'email' })
            return
          }
          const { token } = pairDevice(req, ticket, 'bridge', randomBytes(12).toString('hex'))
          respondLogin(req, res, token, ticket.sessionDays)
        } catch (error) { fail(res, 401, 'pairing login failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/login/bridge/verify') {
        try {
          const { code, emailCode } = JSON.parse(await readBody(req)) as { code: string; emailCode: string }
          const ticket = liveTicket(code)
          if (ticket.email2fa === undefined) throw new Error('no pending challenge')
          store.consumeEmailCode(ticket.email2fa, emailCode)
          const { token } = pairDevice(req, ticket, 'bridge', randomBytes(12).toString('hex'))
          respondLogin(req, res, token, ticket.sessionDays)
        } catch (error) { fail(res, 401, 'pairing verification failed', error) }
        return
      }
      const token = cookieToken(req) || bearerToken(req)
      if (req.method === 'GET' && url.pathname === '/bridge/api/me') {
        const name = store.userFor(token)
        if (name === undefined) { json(res, 401, { error: 'unknown token' }); return }
        json(res, 200, { name, bridge: store.bridgeFor(token), device: store.deviceFor(token) })
        return
      }
      if (req.method === 'GET' && url.pathname === '/bridge/api/bridge/devices') {
        try {
          const bridgeId = url.searchParams.get('bridgeId') ?? ''
          store.verifyBridge(bridgeId, bearerToken(req))
          json(res, 200, { devices: deviceViews(bridgeId) })
        } catch (error) { fail(res, 401, 'device list failed', error) }
        return
      }
      if (req.method === 'DELETE' && url.pathname.startsWith('/bridge/api/bridge/devices/')) {
        try {
          const bridgeId = url.searchParams.get('bridgeId') ?? ''
          const deviceId = decodeURIComponent(url.pathname.slice('/bridge/api/bridge/devices/'.length))
          store.verifyBridge(bridgeId, bearerToken(req))
          const sockets = clientsByDevice.get(deviceId)
          if (sockets !== undefined) for (const socket of sockets) socket.close(4003, 'device revoked')
          clientsByDevice.delete(deviceId)
          store.revokeDevice(bridgeId, deviceId)
          notifyDevices(bridgeId)
          json(res, 200, { devices: deviceViews(bridgeId) })
        } catch (error) { fail(res, 400, 'device revoke failed', error) }
        return
      }
      if (req.method === 'GET' && url.pathname === '/bridge/wxauth') {
        const code = url.searchParams.get('code') ?? ''
        const pair = url.searchParams.get('pair') ?? ''
        const verify = externalAuth.wechat
        if (verify === undefined) { json(res, 503, { error: 'wechat not configured' }); return }
        try {
          const externalId = await verify({ code })
          const token = store.loginExternal('wechat', externalId)
          let days = DEFAULT_SESSION_DAYS
          if (pair !== '') {
            const ticket = liveTicket(pair)
            days = ticket.sessionDays
            const priorDevice = store.deviceFor(cookieToken(req))
            store.bindDevice(token, ticket.bridgeId, { name: requestDeviceName(req), ip: requestIp(req) }, priorDevice?.bridgeId === ticket.bridgeId ? priorDevice.id : undefined)
            ticket.used = true
            const socket = bridges.get(ticket.bridgeId)
            if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ control: 'paired', devices: deviceViews(ticket.bridgeId) }))
          }
          res.writeHead(302, {
            'set-cookie': [sessionCookie(req, token, days)],
            location: '/',
          })
          res.end()
        } catch (error) { fail(res, 401, 'wechat login failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/scheme') {
        if (options.wechatScheme === undefined) { json(res, 503, { error: 'wechat not configured' }); return }
        try {
          const { query } = JSON.parse(await readBody(req)) as { query: string }
          const openlink = await generateScheme(options.wechatScheme, query.slice(0, 512))
          json(res, 200, { openlink })
        } catch (error) { fail(res, 502, 'wechat scheme failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/bridge/start') {
        try {
          const { bridgeId, bridgeToken, email2fa, sessionDays: requestedDays } = JSON.parse(await readBody(req)) as { bridgeId: string; bridgeToken: string; email2fa?: string; sessionDays?: number }
          if (!/^[a-f0-9]{32}$/u.test(bridgeId) || !/^[a-f0-9]{64}$/u.test(bridgeToken)) throw new Error('invalid bridge credentials')
          const days = sessionDays(requestedDays)
          store.authenticateBridge(bridgeId, bridgeToken)
          const ticket = issueTicket(bridgeId, days, typeof email2fa === 'string' && email2fa !== '' ? email2fa : undefined)
          json(res, 200, publicTicket(ticket))
        } catch (error) { fail(res, 401, 'bridge start failed', error) }
        return
      }
      if (req.method === 'POST' && url.pathname === '/bridge/api/bridge/rotate') {
        try {
          const { bridgeId, code, refreshToken } = JSON.parse(await readBody(req)) as { bridgeId: string; code: string; refreshToken: string }
          const ticket = tickets.get(code)
          if (ticket === undefined || ticket.bridgeId !== bridgeId || !sameToken(ticket.refreshToken, refreshToken)) throw new Error('invalid pairing refresh token')
          const socket = bridges.get(bridgeId)
          if (socket?.readyState !== WebSocket.OPEN) throw new Error('bridge is offline')
          json(res, 200, publicTicket(issueTicket(bridgeId, ticket.sessionDays, ticket.email2fa)))
        } catch (error) { fail(res, 401, 'pairing rotation failed', error) }
        return
      }
      json(res, 404, { error: 'not found' })
    })().catch(error => { fail(res, 500, 'request failed', error) })
  })

  const wss = new WebSocketServer({ noServer: true })
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.pathname === '/ws/scanner') {
      const origin = req.headers.origin
      const host = req.headers.host ?? ''
      if (typeof origin !== 'string' || (origin !== 'https://' + host && origin !== 'http://' + host)) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, scanner => {
        const id = randomBytes(4).toString('hex')
        let messages = 0
        const lifetime = setTimeout(() => { scanner.close(1000, 'scanner timeout') }, 10 * 60_000)
        console.info('[mobile-bridge scanner]', { id, event: 'connected', ip: requestIp(req), device: requestDeviceName(req) })
        scanner.on('message', (raw, isBinary) => {
          try {
            if (isBinary) { scanner.close(1003, 'binary scanner diagnostic unsupported'); return }
            if (rawDataByteLength(raw) > 8192) { scanner.close(1009, 'scanner diagnostic too large'); return }
            messages += 1
            if (messages > 180) { scanner.close(1008, 'scanner diagnostic limit reached'); return }
            console.info('[mobile-bridge scanner]', { id, ...scannerDiagnostic(JSON.parse(String(raw))) })
          } catch (error) {
            console.warn('[mobile-bridge scanner]', { id, event: 'invalid', error })
            scanner.close(1003, 'invalid scanner diagnostic')
          }
        })
        scanner.on('close', (code, reason) => {
          clearTimeout(lifetime)
          console.info('[mobile-bridge scanner]', { id, event: 'disconnected', code, reason: String(reason).slice(0, 123), messages })
        })
      })
      return
    }
    if (url.pathname === '/ws/bridge') {
      const bridgeId = url.searchParams.get('bridgeId') ?? ''
      const code = bridgeTickets.get(bridgeId)
      const ticket = code === undefined ? undefined : tickets.get(code)
      const credential = bearerToken(req)
      if (ticket === undefined || !sameToken(ticket.refreshToken, credential)) { socket.destroy(); return }
      wss.handleUpgrade(req, socket, head, ws => {
        const connectionId = randomBytes(4).toString('hex')
        relayDiagnostic('desktop-connected', { connectionId })
        const previous = bridges.get(bridgeId)
        bridges.set(bridgeId, ws)
        if (previous !== undefined && previous !== ws) previous.close(4001, 'desktop reconnected')
        ws.on('message', raw => {
          try {
            const frame = JSON.parse(String(raw)) as Record<string, unknown>
            if (typeof frame.id !== 'string') throw new Error('relay response is missing id')
            // 服务端只解析外层设备前缀，E2EE blob 始终保持不透明。
            const separator = frame.id.indexOf(':')
            if (separator <= 0) throw new Error('relay response has an invalid route id')
            const deviceId = frame.id.slice(0, separator)
            const requestId = frame.id.slice(separator + 1)
            const outgoing = JSON.stringify({ ...frame, id: requestId })
            const clients = [...(clientsByDevice.get(deviceId) ?? [])].filter(client => client.readyState === WebSocket.OPEN)
            relayDiagnostic('desktop-frame', { connectionId, requestId, bytes: Buffer.byteLength(outgoing), clients: clients.length, desktopBuffered: ws.bufferedAmount })
            for (const client of clients) {
              const bufferedBefore = client.bufferedAmount
              client.send(outgoing, error => {
                if (error) {
                  console.error('[mobile-bridge relay] desktop frame send failed', { connectionId, requestId, bytes: Buffer.byteLength(outgoing), bufferedBefore }, error)
                  return
                }
                relayDiagnostic('desktop-frame-sent', { connectionId, requestId, bufferedBefore, bufferedAfter: client.bufferedAmount })
              })
            }
          } catch (error) {
            console.error('[dsh-mobile-bridge-server] desktop relay frame failed', error)
          }
        })
        ws.on('close', (code, reason) => {
          relayDiagnostic('desktop-closed', { connectionId, code, reason: String(reason).slice(0, 123) })
          if (bridges.get(bridgeId) === ws) bridges.delete(bridgeId)
        })
        notifyDevices(bridgeId)
      })
      return
    }
    if (url.pathname === '/ws/client') {
      const token = url.searchParams.get('token') ?? cookieToken(req)
      const device = store.deviceFor(token)
      const bridgeId = device?.bridgeId
      if (device === undefined || bridgeId === undefined) {
        // 4003 means the desktop revoked this device, and the phone treats it as terminal: it clears
        // the pairing and stops reconnecting. A request that simply arrived without a usable session
        // is not that, and reporting it as a revocation left a phone whose cookie was missing with a
        // dead pairing it never got told to renew. 4004 keeps the two apart.
        wss.handleUpgrade(req, socket, head, client => { client.close(4004, 'pairing required') })
        return
      }
      if (bridges.get(bridgeId)?.readyState !== WebSocket.OPEN) {
        wss.handleUpgrade(req, socket, head, client => { client.close(1012, 'desktop offline') })
        return
      }
      wss.handleUpgrade(req, socket, head, client => {
        const connectionId = randomBytes(4).toString('hex')
        relayDiagnostic('phone-connected', { connectionId })
        let connections = clientsByDevice.get(device.id)
        if (connections === undefined) {
          connections = new Set()
          clientsByDevice.set(device.id, connections)
        }
        connections.add(client)
        store.touchDevice(device.id, requestIp(req))
        notifyDevices(bridgeId)
        client.on('message', raw => {
          try {
            const frame = JSON.parse(String(raw)) as Record<string, unknown>
            if (typeof frame.id !== 'string') throw new Error('relay request is missing id')
            const desktop = bridges.get(bridgeId)
            if (desktop?.readyState !== WebSocket.OPEN) { client.close(1012, 'desktop offline'); return }
            const outgoing = JSON.stringify({ ...frame, id: device.id + ':' + frame.id })
            const bufferedBefore = desktop.bufferedAmount
            relayDiagnostic('phone-frame', { connectionId, requestId: frame.id, bytes: Buffer.byteLength(outgoing), bufferedBefore })
            desktop.send(outgoing, error => {
              if (error) {
                console.error('[mobile-bridge relay] phone frame send failed', { connectionId, requestId: frame.id, bytes: Buffer.byteLength(outgoing), bufferedBefore }, error)
                return
              }
              relayDiagnostic('phone-frame-sent', { connectionId, requestId: frame.id, bufferedBefore, bufferedAfter: desktop.bufferedAmount })
            })
          } catch (error) {
            console.error('[dsh-mobile-bridge-server] phone relay frame failed', error)
            client.close(1003, 'invalid relay frame')
          }
        })
        client.on('close', (code, reason) => {
          relayDiagnostic('phone-closed', { connectionId, code, reason: String(reason).slice(0, 123) })
          connections.delete(client)
          if (connections.size === 0) clientsByDevice.delete(device.id)
          notifyDevices(bridgeId)
        })
      })
      return
    }
    socket.destroy()
  })

  return http
}
