import { chromium } from 'playwright'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const b = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--disable-dev-shm-usage'] })
const p = await b.newPage()
await p.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(9000)
const pair = await p.evaluate(async () => {
  const r = await fetch('/mgw/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'dos-probe' }) })
  return await r.text()
})
const code = JSON.parse(pair).payload.pairingCode
await b.close()
console.log('  配对码:', code.slice(0, 12) + '...')

const before = execFileSync('pgrep', ['-f', 'bin.js --profile plus --port 3080'], { encoding: 'utf8' }).trim().split('\n')[0]
console.log('  发送前 pid:', before)

const socket = net.connect(3080, '127.0.0.1')
const key = randomBytes(16).toString('base64')
let upgraded = false
socket.on('connect', () => {
  socket.write(
    'GET /ws/mobile HTTP/1.1\r\nHost: 127.0.0.1:3080\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
    + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + key + '\r\n'
    + 'Sec-WebSocket-Protocol: dsh-mobile-v1, dsh-pair.' + code + '\r\n'
    + 'X-DSH-Device-ID: dos-' + Date.now() + '\r\n\r\n',
  )
})
socket.on('data', (chunk) => {
  const text = chunk.toString('utf8', 0, 60)
  if (!upgraded && text.startsWith('HTTP/1.1')) {
    console.log('  握手:', text.split('\r\n')[0])
    if (!text.includes('101')) { console.log('  未升级，跳过'); process.exit(0) }
    upgraded = true
    // 升级成功后发一个 RSV1 置位的未掩码帧 —— 正是杀死 DSH 的那种帧
    setTimeout(() => {
      socket.write(Buffer.concat([Buffer.from([0xc1, 0x02]), Buffer.from('{}')]))
      console.log('  已发送坏帧（RSV1 置位、未掩码）')
    }, 500)
  }
})
socket.on('error', (e) => console.log('  连接错误:', e.code))
setTimeout(() => {
  try {
    const after = execFileSync('pgrep', ['-f', 'bin.js --profile plus --port 3080'], { encoding: 'utf8' }).trim().split('\n')[0]
    console.log('  发送后 pid:', after, after === before ? '（存活）' : '（★ 进程已重启）')
  } catch { console.log('  发送后: 进程不存在') }
  process.exit(0)
}, 6000)
