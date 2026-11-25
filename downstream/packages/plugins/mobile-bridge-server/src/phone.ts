/**
 * Phone-side bootstrap sources served verbatim by the bridge server: the
 * service worker decrypts the end-to-end encrypted relay and serves the stock
 * Harness web from ciphertext; the client script owns login, pairing, and SW
 * registration. Both are plain auditable JavaScript with no secrets server-side.
 * @module @sparkelf/dsh-mobile-bridge-server/phone
 */

const CRYPTO_JS = `
async function deriveKey(userKey, pairingSecret) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode('dsh-mobile-bridge/v1:' + userKey + ':' + pairingSecret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('dsh-mobile-bridge'), info: new Uint8Array(0) }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
function bytesToBase64(bytes) { let b = ''; for (const x of bytes) b += String.fromCharCode(x); return btoa(b); }
function base64ToBytes(blob) { const b = atob(blob); const out = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i); return out; }
async function encryptJSON(key, value) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, new TextEncoder().encode(JSON.stringify(value)));
  const out = new Uint8Array(12 + ct.byteLength); out.set(nonce, 0); out.set(new Uint8Array(ct), 12);
  return bytesToBase64(out);
}
async function decryptJSON(key, blob) {
  const raw = base64ToBytes(blob);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
  return JSON.parse(new TextDecoder().decode(pt));
}
`

export const SW_SOURCE = `/* DSH mobile bridge service worker: blind-server E2EE client. */
${CRYPTO_JS}
let pairValue = null
let pairWaiters = []
let keyPromise = null
let revoked = false
const PAIR_CACHE = 'dsh-mobile-bridge-pair-v1'
const PAIR_CACHE_KEY = '/bridge/.pair-state'
async function waitForPair() {
  if (pairValue) return pairValue
  const cache = await caches.open(PAIR_CACHE)
  const stored = await cache.match(PAIR_CACHE_KEY)
  if (stored) {
    const state = await stored.json()
    if (state.revoked) { revoked = true; return null }
    pairValue = state.pair
    return pairValue
  }
  return new Promise(resolve => { pairWaiters.push(resolve) })
}
self.addEventListener('install', () => { self.skipWaiting() })
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })
self.addEventListener('message', event => {
  if (!event.data) return
  if (event.data.type === 'pair') {
    if (wsValue) wsValue.close(1000, 'pair replaced')
    wsValue = null
    wsPromise = null
    if (!revoked) {
      const replacedError = new Error('pair replaced')
      for (const entry of pending.values()) {
        if (entry.websocketPort) { entry.websocketPort.postMessage({ kind: 'websocket-error', message: replacedError.message }); entry.websocketPort.close() }
        else if (entry.controller) entry.controller.error(replacedError)
        else entry.reject(replacedError)
      }
    }
    pending.clear()
    pairValue = event.data.pair
    keyPromise = null
    revoked = false
    for (const resolve of pairWaiters) resolve(pairValue)
    pairWaiters = []
    const persist = caches.open(PAIR_CACHE).then(cache => cache.put(PAIR_CACHE_KEY, new Response(JSON.stringify({ pair: pairValue }), { headers: { 'content-type': 'application/json' } })))
    event.waitUntil(persist.then(() => { event.ports[0].postMessage({ ready: true }) }))
    return
  }
  if (event.data.type === 'application-websocket') {
    const port = event.ports[0]
    if (revoked) {
      port.start()
      pending.set('q' + (++counter), { websocketPort: port })
      return
    }
    event.waitUntil(openApplicationSocket(event.data, port).catch(error => {
      console.error('[dsh-mobile-bridge] application websocket setup failed', error)
      port.postMessage({ kind: 'websocket-error', message: error.message })
    }))
  }
})

let wsPromise = null
let wsValue = null
let counter = 0
const pending = new Map()

function wsReady() {
  if (wsPromise) return wsPromise
  wsPromise = new Promise((resolve, reject) => {
    const ws = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/client')
    wsValue = ws
    ws.onopen = () => resolve(ws)
    ws.onerror = () => {
      const error = new Error('bridge socket failed')
      console.error('[dsh-mobile-bridge] bridge socket failed', error)
      reject(error)
    }
    ws.onclose = event => {
      const isCurrent = wsValue === ws
      if (!isCurrent) return
      wsValue = null
      wsPromise = null
      const error = new Error('bridge socket closed')
      // 普通传输断开结算请求并触发重连；4003 定向下线保留现有请求为静默终态，直到用户离开 modal。
      const settlePending = () => {
        for (const entry of pending.values()) {
          if (entry.websocketPort) {
            entry.websocketPort.postMessage({ kind: 'websocket-error', message: error.message })
            entry.websocketPort.close()
          } else if (entry.controller) {
            entry.controller.error(error)
          } else entry.reject(error)
        }
        pending.clear()
      }
      if (event.code === 4003 && isCurrent) {
        pairValue = null
        keyPromise = null
        revoked = true
        void caches.open(PAIR_CACHE).then(cache => cache.put(PAIR_CACHE_KEY, new Response(JSON.stringify({ revoked: true }), { headers: { 'content-type': 'application/json' } }))).catch(error => { console.error('[dsh-mobile-bridge] revoked pair persistence failed', error) })
        void self.clients.matchAll({ type: 'window' })
          .then(clients => {
            for (const client of clients) client.postMessage({ type: 'dsh-mobile-bridge:revoked' })
          })
          .catch(error => { console.error('[dsh-mobile-bridge] revoked client notification failed', error) })
        return
      }
      settlePending()
    }
    ws.onmessage = event => {
      const frame = JSON.parse(event.data)
      const entry = pending.get(frame.id)
      if (!entry) return
      if (entry.websocketPort) {
        void decryptJSON(entry.key, frame.blob).then(payload => {
          entry.websocketPort.postMessage(payload)
          if (payload.kind === 'websocket-close') { entry.websocketPort.close(); pending.delete(frame.id) }
        }).catch(error => {
          console.error('[dsh-mobile-bridge] application websocket response failed', error)
          entry.websocketPort.postMessage({ kind: 'websocket-error', message: error.message })
          pending.delete(frame.id)
        })
        return
      }
      if (frame.end) { entry.controller.close(); pending.delete(frame.id); return }
      void (async () => {
        if (frame.stream) { const head = await decryptJSON(entry.key, frame.blob); entry.status = head.status; entry.headers = head.headers; entry.resolve(); return }
        if (frame.chunk !== undefined) { const payload = await decryptJSON(entry.key, frame.chunk); const bytes = base64ToBytes(payload.d); entry.controller.enqueue(bytes); return }
        const full = await decryptJSON(entry.key, frame.blob)
        let body = base64ToBytes(full.body ?? '')
        if (full.compression === 'gzip') {
          const decompressed = new Blob([body]).stream().pipeThrough(new DecompressionStream('gzip'))
          body = new Uint8Array(await new Response(decompressed).arrayBuffer())
        }
        if ((full.headers?.['content-type'] ?? '').includes('text/html')) {
          let html = new TextDecoder().decode(body)
          if (!html.includes('/bridge/socket-client.js')) html = html.replace('</head>', '<script src="/bridge/socket-client.js"></script></head>')
          body = new TextEncoder().encode(html)
        }
        pending.delete(frame.id)
        entry.resolve(new Response(body, { status: full.status, headers: full.headers }))
      })().catch(error => { console.error('[dsh-mobile-bridge] response decrypt failed', error); if (entry.controller) entry.controller.error(error); else entry.reject(error); pending.delete(frame.id) })
    }
  })
  return wsPromise
}

async function openApplicationSocket(command, port) {
  const pair = await waitForPair()
  if (revoked) throw new Error('device revoked')
  if (!keyPromise) keyPromise = deriveKey(pair.k ?? '', pair.s)
  const key = await keyPromise
  const ws = await wsReady()
  const id = 'w' + (++counter)
  pending.set(id, { key, websocketPort: port })
  port.onmessage = event => {
    void (async () => {
      const message = event.data
      const blob = await encryptJSON(key, message.kind === 'websocket-message'
        ? { kind: 'websocket-message', data: message.data, binary: message.binary }
        : { kind: 'websocket-close', code: message.code, reason: message.reason })
      ws.send(JSON.stringify({ id, blob }))
    })().catch(error => {
      console.error('[dsh-mobile-bridge] application websocket request failed', error)
      port.postMessage({ kind: 'websocket-error', message: error.message })
    })
  }
  port.start()
  const blob = await encryptJSON(key, { kind: 'websocket-open', path: command.path, protocols: command.protocols })
  ws.send(JSON.stringify({ id, blob }))
}

function revokedResponse() {
  const html = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>设备已下线</title><style>*{box-sizing:border-box}body{margin:0;padding:32px 20px;background:#0d1015;color:#f4f7fb;font:14px/1.5 system-ui,sans-serif}main{max-width:390px;margin:10vh auto;padding:8px}img{width:148px;height:auto}h1{margin:24px 0 8px;font-size:20px}p{margin:0;color:#aeb8c8}a{display:grid;height:44px;margin-top:24px;place-items:center;border-radius:8px;background:#405de6;color:white;font-weight:650;text-decoration:none}</style></head><body><main><img src="/bridge/deepseek-logo.svg" alt="DeepSeek"><h1>此设备已下线</h1><p>请在桌面端重新扫码后连接。</p><a href="/bridge/?revoked=1">返回配对</a></main></body></html>'
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.pathname.startsWith('/bridge') || url.pathname === '/sw.js' || url.pathname.startsWith('/ws')) return
  event.respondWith((async () => {
    let pair
    try {
      pair = await waitForPair()
    } catch (error) {
      console.error('[dsh-mobile-bridge] persisted pair state failed', error)
      return new Response('Mobile Bridge pair state failed', { status: 500 })
    }
    if (revoked) {
      if (event.request.mode === 'navigate') return revokedResponse()
      return new Promise(() => {})
    }
    if (!keyPromise) keyPromise = deriveKey(pair.k ?? '', pair.s)
    const key = await keyPromise
    const request = event.request
    const bodyBytes = new Uint8Array(await request.arrayBuffer())
    const id = 'r' + (++counter)
    const headers = { accept: request.headers.get('accept') ?? '' }
    const contentType = request.headers.get('content-type')
    if (contentType !== null) headers['content-type'] = contentType
    const blob = await encryptJSON(key, {
      kind: 'http',
      method: request.method,
      path: url.pathname + url.search,
      headers,
      body: bytesToBase64(bodyBytes),
      bodyEncoding: 'base64',
    })
    let ws
    try {
      ws = await wsReady()
    } catch (error) {
      if (revoked) return revokedResponse()
      console.error('[dsh-mobile-bridge] bridge connection failed', error)
      return new Response('Mobile Bridge connection failed', { status: 502 })
    }
    if ((request.headers.get('accept') ?? '').includes('text/event-stream')) {
      return new Promise((resolve, reject) => {
        let controller
        const readable = new ReadableStream({
          start(value) { controller = value },
          cancel() { pending.delete(id) },
        })
        pending.set(id, { key, controller, resolve: () => resolve(new Response(readable, { headers: { 'content-type': 'text/event-stream' } })), reject, status: 200, headers: {} })
        ws.send(JSON.stringify({ id, blob, streamHint: true }))
      })
    }
    return new Promise((resolve, reject) => {
      pending.set(id, { key, resolve, reject })
      ws.send(JSON.stringify({ id, blob }))
    })
  })())
})
`

export const SOCKET_CLIENT_SOURCE = `/* E2EE WebSocket facade for the relayed Harness application. */
(function () {
  function bytesToBase64(bytes) { var out = ''; for (var value of bytes) out += String.fromCharCode(value); return btoa(out) }
  function base64ToBytes(value) { var raw = atob(value); var out = new Uint8Array(raw.length); for (var i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i); return out }
  class BridgeWebSocket extends EventTarget {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3
    constructor(url, protocols) {
      super()
      var target = new URL(String(url), location.href)
      var socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
      if (target.protocol !== socketProtocol || target.host !== location.host) throw new DOMException('Cross-origin WebSocket is not available through Mobile Bridge', 'SecurityError')
      this.url = target.href
      this.protocol = ''
      this.extensions = ''
      this.readyState = BridgeWebSocket.CONNECTING
      this.bufferedAmount = 0
      this.binaryType = 'blob'
      this.onopen = null
      this.onmessage = null
      this.onerror = null
      this.onclose = null
      this._port = new MessageChannel()
      this._port.port1.onmessage = event => {
        var message = event.data
        if (message.kind === 'websocket-open') {
          console.info('[dsh-mobile-bridge] application websocket facade opened', target.pathname)
          this.protocol = message.protocol
          this.readyState = BridgeWebSocket.OPEN
          this._emit(new Event('open'))
          return
        }
        if (message.kind === 'websocket-message') {
          var data = message.binary
            ? (this.binaryType === 'arraybuffer' ? base64ToBytes(message.data).buffer : new Blob([base64ToBytes(message.data)]))
            : message.data
          this._emit(new MessageEvent('message', { data: data }))
          return
        }
        if (message.kind === 'websocket-close') {
          this.readyState = BridgeWebSocket.CLOSED
          this._emit(new CloseEvent('close', { code: message.code, reason: message.reason, wasClean: true }))
          this._port.port1.close()
          return
        }
        this._fail(new Error(message.message || 'application websocket failed'))
      }
      this._port.port1.start()
      var protocolList = protocols === undefined ? [] : (Array.isArray(protocols) ? protocols : [protocols])
      navigator.serviceWorker.controller.postMessage({ type: 'application-websocket', path: target.pathname + target.search, protocols: protocolList }, [this._port.port2])
    }
    _emit(event) {
      this.dispatchEvent(event)
      var handler = this['on' + event.type]
      if (typeof handler === 'function') handler.call(this, event)
    }
    _fail(error) {
      console.error('[dsh-mobile-bridge] application websocket facade failed', error)
      this.readyState = BridgeWebSocket.CLOSED
      this._emit(new ErrorEvent('error', { error: error, message: error.message }))
      this._emit(new CloseEvent('close', { code: 1011, reason: error.message, wasClean: false }))
      this._port.port1.close()
    }
    send(data) {
      if (this.readyState !== BridgeWebSocket.OPEN) throw new DOMException('WebSocket is not open', 'InvalidStateError')
      if (typeof data === 'string') {
        this._port.port1.postMessage({ kind: 'websocket-message', data: data, binary: false })
        return
      }
      if (data instanceof Blob) {
        data.arrayBuffer().then(buffer => { if (this.readyState === BridgeWebSocket.OPEN) this.send(buffer) }).catch(error => { this._fail(error) })
        return
      }
      var bytes = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      this._port.port1.postMessage({ kind: 'websocket-message', data: bytesToBase64(bytes), binary: true })
    }
    close(code, reason) {
      if (this.readyState === BridgeWebSocket.CLOSING || this.readyState === BridgeWebSocket.CLOSED) return
      this.readyState = BridgeWebSocket.CLOSING
      this._port.port1.postMessage({ kind: 'websocket-close', code: code === undefined ? 1000 : code, reason: reason === undefined ? '' : String(reason) })
    }
  }
  BridgeWebSocket.prototype.CONNECTING = BridgeWebSocket.CONNECTING
  BridgeWebSocket.prototype.OPEN = BridgeWebSocket.OPEN
  BridgeWebSocket.prototype.CLOSING = BridgeWebSocket.CLOSING
  BridgeWebSocket.prototype.CLOSED = BridgeWebSocket.CLOSED
  globalThis.WebSocket = BridgeWebSocket
})()
`

export const CLIENT_SOURCE = `/* DSH mobile bridge client bootstrap: login, pairing, preferences, and SW registration. */
(function () {
  var $ = function (id) { return document.getElementById(id) }
  var COPY = {
    zh: {
      preferences: '显示偏好', title: '移动连接', scanFirst: '扫描桌面端显示的配对二维码', openScanner: '打开相机扫码', scannerTitle: '扫描配对二维码', closeScanner: '关闭相机', cameraStarting: '正在打开相机', cameraReady: '将二维码放入扫描框', cameraFocused: '正在连续对焦，请将二维码放入扫描框', cameraAdjusting: '正在自动调焦', cameraLocked: '已锁定清晰焦点，请将二维码放入扫描框', qrDetected: '已识别，正在连接', cameraUnavailable: '无法使用相机，请检查浏览器相机权限。', invalidPairQr: '请扫描桌面端显示的 Mobile Bridge 配对二维码。', email: '邮箱', emailPlaceholder: 'name@example.com',
      code: '验证码', codePlaceholder: '6 位验证码', send: '发送', sending: '发送中', sent: '验证码已发送',
      pairingCode: '配对码', pairingPlaceholder: '6 位字符', connect: '登录并连接', connecting: '正在连接', light: '浅色', dark: '深色',
      ownerCode: '桌面所有者邮箱收到验证码，请输入', passphrase: '输入桌面端设置的加密口令', cancelled: '已取消',
      serviceWorkerUnsupported: '此浏览器不支持 Service Worker。', serviceWorkerTimeout: '移动连接初始化超时，请重新扫描最新二维码。', serviceWorkerUpdateFailed: '移动连接更新失败，请刷新页面后重新扫描。',
      unknownPair: '配对码无效或桌面端已离线，请扫描最新二维码。', expiredPair: '配对码已过期，请扫描最新二维码。',
      usedPair: '配对码已使用，请扫描最新二维码。', invalidCode: '验证码无效或已过期。'
    },
    en: {
      preferences: 'Display preferences', title: 'Mobile connection', scanFirst: 'Scan the pairing QR shown on the desktop', openScanner: 'Open camera scanner', scannerTitle: 'Scan pairing QR', closeScanner: 'Close camera', cameraStarting: 'Opening camera', cameraReady: 'Place the QR code inside the frame', cameraFocused: 'Continuous focus active. Place the QR code inside the frame', cameraAdjusting: 'Adjusting focus automatically', cameraLocked: 'Sharpest focus locked. Place the QR code inside the frame', qrDetected: 'QR recognized. Connecting', cameraUnavailable: 'The camera is unavailable. Check this browser’s camera permission.', invalidPairQr: 'Scan the Mobile Bridge pairing QR shown on the desktop.', email: 'Email', emailPlaceholder: 'name@example.com',
      code: 'Verification code', codePlaceholder: '6-digit code', send: 'Send', sending: 'Sending', sent: 'Code sent',
      pairingCode: 'Pairing code', pairingPlaceholder: '6 characters', connect: 'Sign in and connect', connecting: 'Connecting', light: 'Light', dark: 'Dark',
      ownerCode: 'Enter the code sent to the desktop owner email', passphrase: 'Enter the passphrase configured on the desktop', cancelled: 'Cancelled',
      serviceWorkerUnsupported: 'This browser does not support Service Workers.', serviceWorkerTimeout: 'Mobile connection setup timed out. Scan the latest QR code again.', serviceWorkerUpdateFailed: 'Mobile connection update failed. Refresh the page and scan again.',
      unknownPair: 'The pairing code is invalid or the desktop is offline. Scan the latest QR code.', expiredPair: 'The pairing code expired. Scan the latest QR code.',
      usedPair: 'The pairing code was already used. Scan the latest QR code.', invalidCode: 'The verification code is invalid or expired.'
    }
  }
  var language = localStorage.getItem('dshmb-language') || (navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en')
  var theme = localStorage.getItem('dshmb-theme') || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
  function tr(key) { return COPY[language][key] }
  function applyLanguage() {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    document.querySelector('.preferences').setAttribute('aria-label', tr('preferences'))
    document.querySelectorAll('[data-i18n]').forEach(function (node) { node.textContent = tr(node.getAttribute('data-i18n')) })
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) { node.placeholder = tr(node.getAttribute('data-i18n-placeholder')) })
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (node) { node.setAttribute('aria-label', tr(node.getAttribute('data-i18n-aria-label'))) })
    $('langZh').setAttribute('aria-pressed', String(language === 'zh'))
    $('langEn').setAttribute('aria-pressed', String(language === 'en'))
  }
  function applyTheme() {
    document.documentElement.dataset.theme = theme
    $('themeLight').setAttribute('aria-pressed', String(theme === 'light'))
    $('themeDark').setAttribute('aria-pressed', String(theme === 'dark'))
  }
  $('langZh').onclick = function () { language = 'zh'; localStorage.setItem('dshmb-language', language); applyLanguage() }
  $('langEn').onclick = function () { language = 'en'; localStorage.setItem('dshmb-language', language); applyLanguage() }
  $('themeLight').onclick = function () { theme = 'light'; localStorage.setItem('dshmb-theme', theme); applyTheme() }
  $('themeDark').onclick = function () { theme = 'dark'; localStorage.setItem('dshmb-theme', theme); applyTheme() }
  applyLanguage()
  applyTheme()

  if (new URLSearchParams(location.search).has('revoked')) {
    localStorage.removeItem('dshmb-pair')
    history.replaceState(null, '', '/bridge/')
  }
  function api(path, options) {
    return fetch('/bridge' + path, Object.assign({ credentials: 'same-origin' }, options)).then(function (response) {
      return response.json().then(function (body) { if (!response.ok) throw new Error(body.error || response.status); return body })
    })
  }
  function errorText(message) {
    if (message === 'unknown or offline pairing code') return tr('unknownPair')
    if (message === 'pairing code expired') return tr('expiredPair')
    if (message === 'pairing code already used') return tr('usedPair')
    if (message === 'invalid or expired code') return tr('invalidCode')
    if (message === 'serviceWorkerUnsupported') return tr('serviceWorkerUnsupported')
    if (message === 'serviceWorkerTimeout') return tr('serviceWorkerTimeout')
    if (message === 'serviceWorkerUpdateFailed') return tr('serviceWorkerUpdateFailed')
    if (message === 'cancelled') return tr('cancelled')
    return message
  }
  function showError(error) {
    console.error('[dsh-mobile-bridge] phone action failed', error)
    $('x').textContent = errorText(String(error && error.message || error))
  }
  function waitForControl() {
    if (navigator.serviceWorker.controller) return Promise.resolve()
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        navigator.serviceWorker.removeEventListener('controllerchange', controlled)
        reject(new Error('serviceWorkerTimeout'))
      }, 10000)
      function controlled() {
        clearTimeout(timer)
        resolve()
      }
      navigator.serviceWorker.addEventListener('controllerchange', controlled, { once: true })
    })
  }
  function persistPair(registration, pair) {
    return new Promise(function (resolve, reject) {
      var channel = new MessageChannel()
      var timer = setTimeout(function () { reject(new Error('serviceWorkerTimeout')) }, 10000)
      channel.port1.onmessage = function () { clearTimeout(timer); resolve() }
      channel.port1.onmessageerror = function () { clearTimeout(timer); reject(new Error('serviceWorkerTimeout')) }
      registration.active.postMessage({ type: 'pair', pair: pair }, [channel.port2])
    })
  }
  function activateLatestWorker(registration) {
    return registration.update().then(function () {
      var worker = registration.installing || registration.waiting
      if (!worker || worker.state === 'activated') return registration
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          worker.removeEventListener('statechange', changed)
          reject(new Error('serviceWorkerTimeout'))
        }, 10000)
        function changed() {
          if (worker.state === 'activated') {
            clearTimeout(timer)
            worker.removeEventListener('statechange', changed)
            resolve(registration)
          } else if (worker.state === 'redundant') {
            clearTimeout(timer)
            worker.removeEventListener('statechange', changed)
            reject(new Error('serviceWorkerUpdateFailed'))
          }
        }
        worker.addEventListener('statechange', changed)
        changed()
      })
    })
  }

  function registerSw(pair) {
    if (!('serviceWorker' in navigator)) return Promise.reject(new Error('serviceWorkerUnsupported'))
    return navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
      .then(activateLatestWorker)
      .then(function () { return navigator.serviceWorker.ready })
      .then(function (registration) { return persistPair(registration, pair) })
      .then(waitForControl)
  }
  function navigateToHarness() {
    var navigate = function () {
      history.replaceState(null, '', '/')
      location.assign('/')
    }
    if (document.readyState === 'loading') {
      // 先提交 landing 的 DOM 生命周期，再在下一帧切换 Harness，避免两次顶层 navigation 相互取消。
      document.addEventListener('DOMContentLoaded', function () { requestAnimationFrame(navigate) }, { once: true })
    } else navigate()
  }

  var scannerInstance = null
  var scannerSession = 0
  var scannerStream = null
  var scannerDecodeFrame = 0
  var scannerDecodeUsesVideoCallback = false
  var scannerDecodeBusy = false
  var scannerDecodeFailed = false
  var scannerLastDecodeAt = 0
  var scannerDecodeCanvas = document.createElement('canvas')
  var scannerScriptPromises = {}
  var scannerWasmOverrides = { locateFile: function () { return '/bridge/zxing-reader.wasm' } }
  var scannerResultTimer = 0
  var scannerDiagnosticSocket = null
  var scannerDiagnosticTimer = 0
  var scannerAdjustmentTimer = 0
  var scannerAnalysisCanvas = document.createElement('canvas')
  var scannerAdjustmentIndex = 0
  var scannerAttempts = 0
  var scannerOpenedAt = 0
  var scannerLastError = ''

  function reportScanner(event, detail) {
    if (!scannerDiagnosticSocket || scannerDiagnosticSocket.readyState !== WebSocket.OPEN) return
    scannerDiagnosticSocket.send(JSON.stringify(Object.assign({ event: event }, detail || {})))
  }

  function scannerTrackSettings() {
    var stream = $('scannerVideo').srcObject
    var track = stream && stream.getVideoTracks()[0]
    return track && typeof track.getSettings === 'function' ? track.getSettings() : {}
  }

  function loadScannerScript(source, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName])
    if (scannerScriptPromises[source]) return scannerScriptPromises[source]
    scannerScriptPromises[source] = new Promise(function (resolve, reject) {
      var script = document.createElement('script')
      script.src = source
      script.onload = function () { resolve(window[globalName]) }
      script.onerror = function () { reject(new Error('Failed to load scanner resource: ' + source)) }
      document.head.appendChild(script)
    })
    return scannerScriptPromises[source]
  }

  function supportsNativeQrDetector() {
    if (typeof window.BarcodeDetector !== 'function' || typeof window.BarcodeDetector.getSupportedFormats !== 'function') return Promise.resolve(false)
    return window.BarcodeDetector.getSupportedFormats()
      .then(function (formats) { return formats.includes('qr_code') })
      .catch(function (error) {
        console.info('[dsh-mobile-bridge] native BarcodeDetector capability check failed', error)
        reportScanner('error', { state: 'barcode-detector', name: error.name, message: error.message, stack: error.stack })
        return false
      })
  }

  // 诊断通道只发送 camera/decoder 结构化状态，不发送相机画面、cookie 或配对文本。
  function startScannerDiagnostics() {
    scannerAttempts = 0
    scannerLastError = ''
    scannerOpenedAt = Date.now()
    scannerDiagnosticSocket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws/scanner')
    scannerDiagnosticSocket.onopen = function () {
      reportScanner('open', { state: 'capability-pending' })
    }
    scannerDiagnosticSocket.onerror = function () {
      console.error('[dsh-mobile-bridge] scanner diagnostics socket failed', new Error('Scanner diagnostics WebSocket failed'))
    }
    scannerDiagnosticTimer = setInterval(function () {
      var settings = scannerTrackSettings()
      reportScanner('scan', {
        attempts: scannerAttempts,
        elapsedMs: Date.now() - scannerOpenedAt,
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        facingMode: settings.facingMode,
        focusMode: settings.focusMode,
        exposureMode: settings.exposureMode,
        zoom: settings.zoom,
        focusDistance: settings.focusDistance,
        exposureCompensation: settings.exposureCompensation,
        message: scannerLastError
      })
    }, 2000)
  }

  function stopScannerDiagnostics(reason) {
    clearInterval(scannerDiagnosticTimer)
    scannerDiagnosticTimer = 0
    reportScanner('close', { state: reason, attempts: scannerAttempts, elapsedMs: Date.now() - scannerOpenedAt })
    if (scannerDiagnosticSocket) scannerDiagnosticSocket.close(1000, 'scanner closed')
    scannerDiagnosticSocket = null
  }

  // 相机轨道只属于取景页；关闭、识别成功和页面离开都会销毁 scanner 并释放设备。
  function stopScanner(reason) {
    scannerSession += 1
    clearTimeout(scannerResultTimer)
    scannerResultTimer = 0
    clearTimeout(scannerAdjustmentTimer)
    scannerAdjustmentTimer = 0
    stopScannerDiagnostics(reason || 'closed')
    var video = $('scannerVideo')
    if (scannerDecodeFrame) {
      if (scannerDecodeUsesVideoCallback) video.cancelVideoFrameCallback(scannerDecodeFrame)
      else cancelAnimationFrame(scannerDecodeFrame)
    }
    scannerDecodeFrame = 0
    scannerDecodeBusy = false
    scannerDecodeFailed = false
    var activeStream = video.srcObject
    if (activeStream) activeStream.getTracks().forEach(function (track) { track.stop() })
    if (scannerInstance) scannerInstance.destroy()
    scannerInstance = null
    if (scannerStream) scannerStream.getTracks().forEach(function (track) { track.stop() })
    scannerStream = null
    video.srcObject = null
    var frame = $('scannerFrame')
    frame.className = 'scannerFrame'
    frame.removeAttribute('style')
    $('wasmOutlinePolygon').removeAttribute('points')
    $('scanner').hidden = true
    document.body.classList.remove('scannerOpen')
  }

  function setScannerStatus(key, error) {
    $('scannerStatus').textContent = tr(key)
    $('scannerStatus').classList.toggle('error', error)
  }

  function scannerRangeValue(range, ratio) {
    var step = typeof range.step === 'number' && range.step > 0 ? range.step : 0.1
    var raw = range.min + (range.max - range.min) * ratio
    return Math.min(range.max, Math.max(range.min, Math.round((raw - range.min) / step) * step + range.min))
  }

  function scannerSharpness() {
    var video = $('scannerVideo')
    var region = scannerRegion(video)
    var size = 192
    scannerAnalysisCanvas.width = size
    scannerAnalysisCanvas.height = size
    var context = scannerAnalysisCanvas.getContext('2d')
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, size, size)
    var pixels = context.getImageData(0, 0, size, size).data
    var edge = 0
    var clipped = 0
    var samples = 0
    for (var y = 1; y < size; y += 1) {
      for (var x = 1; x < size; x += 1) {
        var offset = (y * size + x) * 4
        var left = offset - 4
        var up = offset - size * 4
        var value = (pixels[offset] + pixels[offset + 1] * 2 + pixels[offset + 2]) / 4
        var leftValue = (pixels[left] + pixels[left + 1] * 2 + pixels[left + 2]) / 4
        var upValue = (pixels[up] + pixels[up + 1] * 2 + pixels[up + 2]) / 4
        edge += Math.abs(value - leftValue) + Math.abs(value - upValue)
        if (value > 248) clipped += 1
        samples += 1
      }
    }
    return Math.max(0, edge / (samples * 2) - clipped / samples * 80)
  }

  // 对设备真实支持的焦距各评估一次ROI清晰度，随后锁定最高分，不再无限往返调焦。
  function startScannerAdjustments(track, capabilities) {
    clearTimeout(scannerAdjustmentTimer)
    scannerAdjustmentIndex = 0
    var plans = []
    var focusModes = Array.isArray(capabilities.focusMode) ? capabilities.focusMode : []
    var zoomRange = capabilities.zoom
    var exposureRange = capabilities.exposureCompensation
    var basePlan = {}
    if (zoomRange && typeof zoomRange.min === 'number' && typeof zoomRange.max === 'number' && zoomRange.max > zoomRange.min) {
      var limitedZoom = { min: zoomRange.min, max: Math.min(zoomRange.max, Math.max(zoomRange.min, 1.5)), step: zoomRange.step }
      basePlan.zoom = scannerRangeValue(limitedZoom, 0.5)
    }
    if (exposureRange && typeof exposureRange.min === 'number' && typeof exposureRange.max === 'number' && exposureRange.min < 0) {
      var negativeExposure = { min: exposureRange.min, max: Math.min(0, exposureRange.max), step: exposureRange.step }
      basePlan.exposureCompensation = scannerRangeValue(negativeExposure, 0.45)
    }
    var focusRange = capabilities.focusDistance
    if (focusModes.includes('manual') && focusRange && typeof focusRange.min === 'number' && typeof focusRange.max === 'number' && focusRange.max > focusRange.min) {
      ;[0, 0.34, 0.67, 1].forEach(function (ratio) {
        plans.push(Object.assign({}, basePlan, { focusMode: 'manual', focusDistance: scannerRangeValue(focusRange, ratio) }))
      })
    }
    reportScanner('controls', {
      state: plans.length ? 'adjustment-ready' : 'adjustment-unavailable',
      zoomMin: zoomRange && zoomRange.min,
      zoomMax: zoomRange && zoomRange.max,
      focusMin: focusRange && focusRange.min,
      focusMax: focusRange && focusRange.max,
      exposureMin: exposureRange && exposureRange.min,
      exposureMax: exposureRange && exposureRange.max
    })
    if (plans.length === 0) return
    var best = null
    var evaluateNext = function () {
      if (!scannerInstance || scannerResultTimer) return
      if (scannerAdjustmentIndex >= plans.length) {
        if (!best) {
          reportScanner('controls', { state: 'adjustment-failed' })
          return
        }
        track.applyConstraints({ advanced: [best.plan] })
          .then(function () {
            if (!scannerInstance || scannerResultTimer) return
            var settings = scannerTrackSettings()
            setScannerStatus('cameraLocked', false)
            reportScanner('adjustment', { state: 'locked', sharpness: best.score, zoom: settings.zoom, focusDistance: settings.focusDistance, focusMode: settings.focusMode, exposureCompensation: settings.exposureCompensation })
          })
          .catch(function (error) {
            console.info('[dsh-mobile-bridge] camera focus lock failed', error)
            reportScanner('error', { state: 'focus-lock', name: error.name, message: error.message, stack: error.stack })
          })
        return
      }
      var plan = plans[scannerAdjustmentIndex]
      scannerAdjustmentIndex += 1
      track.applyConstraints({ advanced: [plan] })
        .then(function () {
          if (!scannerInstance || scannerResultTimer) return
          scannerAdjustmentTimer = setTimeout(function () {
            if (!scannerInstance || scannerResultTimer) return
            var settings = scannerTrackSettings()
            var score = Math.round(scannerSharpness() * 100) / 100
            if (!best || score > best.score) best = { plan: plan, score: score }
            var label = tr('cameraAdjusting')
            if (typeof settings.zoom === 'number') label += ' · ' + settings.zoom.toFixed(1) + '×'
            $('scannerStatus').textContent = label
            $('scannerStatus').classList.remove('error')
            reportScanner('adjustment', { state: 'sample', sharpness: score, zoom: settings.zoom, focusDistance: settings.focusDistance, focusMode: settings.focusMode, exposureCompensation: settings.exposureCompensation })
            evaluateNext()
          }, 1000)
        })
        .catch(function (error) {
          console.info('[dsh-mobile-bridge] automatic camera adjustment failed', error)
          reportScanner('error', { state: 'adjustment', name: error.name, message: error.message, stack: error.stack })
          evaluateNext()
        })
    }
    scannerAdjustmentTimer = setTimeout(evaluateNext, 1600)
  }

  // 浏览器能力是相机控制的事实源；先请求高分辨率和曝光，再启动一次性焦点评估。
  function configureScannerTrack() {
    var stream = $('scannerVideo').srcObject
    var track = stream && stream.getVideoTracks()[0]
    if (!track || typeof track.getCapabilities !== 'function' || typeof track.applyConstraints !== 'function') {
      reportScanner('controls', { state: 'capabilities-unavailable' })
      return Promise.resolve(false)
    }
    var capabilities = track.getCapabilities()
    var advanced = {}
    if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) advanced.focusMode = 'continuous'
    if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) advanced.exposureMode = 'continuous'
    if (capabilities.pointsOfInterest) advanced.pointsOfInterest = [{ x: 0.5, y: 0.5 }]
    var exposureRange = capabilities.exposureCompensation
    if (exposureRange && typeof exposureRange.min === 'number' && typeof exposureRange.max === 'number' && exposureRange.min < 0) {
      var negativeExposure = { min: exposureRange.min, max: Math.min(0, exposureRange.max), step: exposureRange.step }
      advanced.exposureCompensation = scannerRangeValue(negativeExposure, 0.45)
    }
    var zoomRange = capabilities.zoom
    if (zoomRange && typeof zoomRange.min === 'number' && typeof zoomRange.max === 'number' && zoomRange.max > zoomRange.min) {
      var limitedZoom = { min: zoomRange.min, max: Math.min(zoomRange.max, Math.max(zoomRange.min, 1.5)), step: zoomRange.step }
      advanced.zoom = scannerRangeValue(limitedZoom, 0.5)
    }
    return (Object.keys(advanced).length === 0 ? Promise.resolve() : track.applyConstraints({ advanced: [advanced] }))
      .catch(function (error) {
        console.info('[dsh-mobile-bridge] initial camera controls unavailable', error)
        reportScanner('error', { state: 'controls', name: error.name, message: error.message, stack: error.stack })
      })
      .then(function () {
        var settings = scannerTrackSettings()
        reportScanner('controls', { state: 'initial-applied', focusMode: settings.focusMode, exposureMode: settings.exposureMode, zoom: settings.zoom, focusDistance: settings.focusDistance, exposureCompensation: settings.exposureCompensation })
        startScannerAdjustments(track, capabilities)
        return settings.focusMode === 'continuous'
      })
  }

  function relayHostname(hostname) {
    return hostname.startsWith('www.') ? hostname.slice(4) : hostname
  }

  // 摄像头二维码是外部输入；只允许当前 relay 的 www/apex 别名、精确配对路径和 hash。
  function parseScannedPair(value) {
    var target = new URL(value)
    var sameRelay = target.protocol === location.protocol && target.port === location.port && relayHostname(target.hostname) === relayHostname(location.hostname)
    if (!sameRelay || target.pathname !== '/bridge/' || !target.hash) throw new Error('invalidPairQr')
    return target
  }

  function acceptScannedPair(target) {
    stopScanner('accepted')
    location.assign(target.href)
  }

  function onScannerResult(result) {
    if (scannerResultTimer) return
    reportScanner('decoded', { corners: result.cornerPoints.length })
    try {
      var target = parseScannedPair(result.data)
      clearTimeout(scannerAdjustmentTimer)
      scannerAdjustmentTimer = 0
      $('scannerFrame').classList.remove('invalid')
      setScannerStatus('qrDetected', false)
      reportScanner('accepted', { valid: true, corners: result.cornerPoints.length })
      scannerResultTimer = setTimeout(function () {
        scannerResultTimer = 0
        acceptScannedPair(target)
      }, 320)
    } catch (error) {
      console.info('[dsh-mobile-bridge] camera QR rejected', error)
      $('scannerFrame').classList.add('invalid')
      setScannerStatus('invalidPairQr', true)
      reportScanner('rejected', { valid: false, corners: result.cornerPoints.length, name: error.name, message: error.message, stack: error.stack })
    }
  }

  function scannerRegion(video) {
    var size = Math.round(Math.min(video.videoWidth, video.videoHeight) * 2 / 3)
    var outputSize = Math.min(size, 800)
    return {
      x: Math.round((video.videoWidth - size) / 2),
      y: Math.round((video.videoHeight - size) / 2),
      width: size,
      height: size,
      downScaledWidth: outputSize,
      downScaledHeight: outputSize
    }
  }

  function finishScannerStart(session, profile) {
    return configureScannerTrack().then(function (continuousFocus) {
      if (session !== scannerSession) return false
      var settings = scannerTrackSettings()
      setScannerStatus(continuousFocus ? 'cameraFocused' : 'cameraReady', false)
      reportScanner('camera', {
        state: 'ready',
        name: profile,
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        facingMode: settings.facingMode,
        focusMode: settings.focusMode,
        exposureMode: settings.exposureMode,
        zoom: settings.zoom,
        focusDistance: settings.focusDistance,
        exposureCompensation: settings.exposureCompensation
      })
      return true
    })
  }

  function startNativeScanner(session, QrScanner) {
    if (session !== scannerSession) return Promise.resolve()
    $('scannerFrame').classList.remove('manual')
    scannerInstance = new QrScanner($('scannerVideo'), function (result) {
      scannerAttempts += 1
      onScannerResult(result)
    }, {
      onDecodeError: function (error) {
        scannerAttempts += 1
        scannerLastError = error && error.message ? error.message : String(error)
      },
      preferredCamera: 'environment',
      maxScansPerSecond: 12,
      calculateScanRegion: scannerRegion,
      highlightScanRegion: true,
      highlightCodeOutline: true,
      overlay: $('scannerFrame'),
      returnDetailedScanResult: true
    })
    reportScanner('library', { state: 'ready', name: 'native-barcode-detector' })
    return scannerInstance.start().then(function () { return finishScannerStart(session, 'native-barcode-detector') })
  }

  function drawWasmOutline(position, size) {
    var points = [position.topLeft, position.topRight, position.bottomRight, position.bottomLeft]
      .map(function (point) { return point.x.toFixed(1) + ',' + point.y.toFixed(1) })
      .join(' ')
    $('wasmOutline').setAttribute('viewBox', '0 0 ' + size + ' ' + size)
    $('wasmOutlinePolygon').setAttribute('points', points)
  }

  function scheduleWasmScan(session) {
    if (session !== scannerSession || !scannerInstance || scannerDecodeBusy || scannerResultTimer) return
    var video = $('scannerVideo')
    if (typeof video.requestVideoFrameCallback === 'function') {
      scannerDecodeUsesVideoCallback = true
      scannerDecodeFrame = video.requestVideoFrameCallback(function (now) { scanWasmFrame(session, now) })
    } else {
      scannerDecodeUsesVideoCallback = false
      scannerDecodeFrame = requestAnimationFrame(function (now) { scanWasmFrame(session, now) })
    }
  }

  function scanWasmFrame(session, now) {
    scannerDecodeFrame = 0
    if (session !== scannerSession || !scannerInstance) return
    if (now - scannerLastDecodeAt < 140) { scheduleWasmScan(session); return }
    scannerLastDecodeAt = now
    var video = $('scannerVideo')
    var region = scannerRegion(video)
    var outputSize = Math.min(region.width, 720)
    scannerDecodeCanvas.width = outputSize
    scannerDecodeCanvas.height = outputSize
    var context = scannerDecodeCanvas.getContext('2d')
    context.drawImage(video, region.x, region.y, region.width, region.height, 0, 0, outputSize, outputSize)
    var image = context.getImageData(0, 0, outputSize, outputSize)
    scannerDecodeBusy = true
    scannerAttempts += 1
    window.ZXingWASM.readBarcodes(image, {
      formats: ['QRCode'],
      tryHarder: true,
      tryRotate: true,
      tryInvert: true,
      tryDownscale: false,
      tryDenoise: true,
      binarizer: 'LocalAverage',
      maxNumberOfSymbols: 1
    }).then(function (results) {
      if (session !== scannerSession) return
      var result = results.find(function (candidate) { return candidate.isValid })
      if (!result) {
        scannerLastError = 'No QR code found'
        return
      }
      scannerLastError = ''
      drawWasmOutline(result.position, outputSize)
      onScannerResult({
        data: result.text,
        cornerPoints: [result.position.topLeft, result.position.topRight, result.position.bottomRight, result.position.bottomLeft]
      })
    }).catch(function (error) {
      console.error('[dsh-mobile-bridge] ZXing WASM frame decode failed', error)
      if (session !== scannerSession) return
      scannerDecodeFailed = true
      setScannerStatus('cameraUnavailable', true)
      reportScanner('error', { state: 'zxing-decode', name: error.name, message: error.message, stack: error.stack })
    }).then(function () {
      scannerDecodeBusy = false
      if (session === scannerSession && scannerInstance && !scannerDecodeFailed) scheduleWasmScan(session)
    })
  }

  function startWasmScanner(session) {
    if (session !== scannerSession) return Promise.resolve()
    var video = $('scannerVideo')
    var frame = $('scannerFrame')
    frame.classList.add('manual')
    reportScanner('library', { state: 'ready', name: 'zxing-wasm' })
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1440 }, height: { ideal: 1920 } }
    }).then(function (stream) {
      if (session !== scannerSession) {
        stream.getTracks().forEach(function (track) { track.stop() })
        return false
      }
      scannerStream = stream
      scannerInstance = { destroy: function () {} }
      video.srcObject = stream
      return video.play().then(function () { return true })
    }).then(function (started) {
      if (!started || session !== scannerSession) return
      return finishScannerStart(session, 'zxing-wasm').then(function (ready) {
        if (ready) scheduleWasmScan(session)
      })
    })
  }

  function openScanner() {
    var session = scannerSession + 1
    scannerSession = session
    scannerDecodeFailed = false
    scannerLastDecodeAt = 0
    $('scanner').hidden = false
    document.body.classList.add('scannerOpen')
    setScannerStatus('cameraStarting', false)
    startScannerDiagnostics()
    supportsNativeQrDetector().then(function (nativeDetector) {
      if (session !== scannerSession) return
      if (nativeDetector) {
        reportScanner('library', { state: 'loading', name: 'qr-scanner' })
        return loadScannerScript('/bridge/qr-scanner.js', 'QrScanner')
          .then(function (QrScanner) { return startNativeScanner(session, QrScanner) })
      }
      reportScanner('library', { state: 'loading', name: 'zxing-wasm' })
      return loadScannerScript('/bridge/zxing-reader.js', 'ZXingWASM')
        .then(function (ZXingWASM) {
          if (session !== scannerSession) return
          return ZXingWASM.prepareZXingModule({
            overrides: scannerWasmOverrides,
            fireImmediately: true
          })
        })
        .then(function () { return startWasmScanner(session) })
    }).catch(function (error) {
      console.error('[dsh-mobile-bridge] camera start failed', error)
      if (session !== scannerSession) return
      var video = $('scannerVideo')
      var activeStream = video.srcObject
      if (activeStream) activeStream.getTracks().forEach(function (track) { track.stop() })
      if (scannerInstance) scannerInstance.destroy()
      scannerInstance = null
      scannerStream = null
      video.srcObject = null
      setScannerStatus('cameraUnavailable', true)
      reportScanner('error', { state: 'camera-start', name: error.name, message: error.message, stack: error.stack })
    })
  }

  $('openScanner').onclick = openScanner
  $('closeScanner').onclick = function () { stopScanner('closed') }
  window.addEventListener('pagehide', function () { stopScanner('pagehide') })

  var fragment = location.hash.slice(1)
  if (fragment) {
    try {
      var pair = JSON.parse(decodeURIComponent(fragment))
      var proceed = function () {
        $('x').textContent = tr('connecting')
        $('b').value = pair.b || pair.c
        localStorage.setItem('dshmb-pair', JSON.stringify(pair))
        // 先确认 Service Worker 已持久化密钥并接管页面，再消费一次性票据。
        registerSw(pair)
          .then(function () {
            return api('/api/login/bridge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.b || pair.c }) })
          })
          .then(function (result) {
            if (result.challenge === 'email') {
              var mailCode = prompt(tr('ownerCode'))
              if (mailCode === null) throw new Error('cancelled')
              return api('/api/login/bridge/verify', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.b || pair.c, emailCode: mailCode }) })
            }
            return result
          })
          .then(navigateToHarness)
          .catch(function (error) { history.replaceState(null, '', '/bridge/'); showError(error) })
      }
      if (pair.k === undefined) {
        var passphrase = prompt(tr('passphrase'))
        if (passphrase === null) showError(new Error('cancelled'))
        else { pair.k = passphrase; proceed() }
      } else proceed()
    } catch (error) {
      console.error('[dsh-mobile-bridge] QR payload failed', error)
    }
  }

  var stored = localStorage.getItem('dshmb-pair')
  $('loginForm').hidden = !stored
  $('scanFirst').hidden = !!stored
  if (!fragment && stored) {
    $('x').textContent = tr('connecting')
    api('/api/me')
      .then(function () { return registerSw(JSON.parse(stored)) })
      .then(navigateToHarness)
      .catch(showError)
  }
  $('s').onclick = function () {
    var button = $('s')
    button.disabled = true
    button.textContent = tr('sending')
    $('x').textContent = ''
    api('/api/email/code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('e').value }) })
      .then(function () { $('x').textContent = tr('sent') })
      .catch(showError)
      .finally(function () { button.disabled = false; button.textContent = tr('send') })
  }
  $('l').onclick = function () {
    var button = $('l')
    button.disabled = true
    button.textContent = tr('connecting')
    $('x').textContent = ''
    var pair = JSON.parse(localStorage.getItem('dshmb-pair'))
    pair.b = $('b').value
    localStorage.setItem('dshmb-pair', JSON.stringify(pair))
    registerSw(pair)
      .then(function () {
        return api('/api/login/email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: $('e').value, code: $('c').value, bridge: pair.b }) })
      })
      .then(navigateToHarness)
      .catch(showError)
      .finally(function () { button.disabled = false; button.textContent = tr('connect') })
  }
})()
`
