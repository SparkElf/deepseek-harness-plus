import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

// 1. 生成配对码（通过页面，同源）
const b = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox','--disable-dev-shm-usage'] })
const p = await b.newPage()
await p.goto('http://127.0.0.1:3080/', { waitUntil: 'domcontentloaded', timeout: 60000 })
await p.waitForTimeout(9000)
const pair = await p.evaluate(async () => {
  const r = await fetch('/mgw/pair', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'e2e' }) })
  return await r.text()
})
const code = JSON.parse(pair).payload.pairingCode
console.log('  配对码:', code.slice(0, 16) + '...')
await b.close()

// 2. 立刻经代理测试
const sshOptions = '-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o LogLevel=ERROR'
const pw = execFileSync('python3', ['-c', "import yaml; d=yaml.safe_load(open('/root/.dsh/.credentials.yaml')); print([r['payload']['password'] for k,r in d.get('records',{}).items() if 'ssh' in k.lower()][0])"], { encoding: 'utf8' }).trim()
const env = { ...process.env, SSHPASS: pw }
execFileSync('sshpass', ['-e', 'scp', ...sshOptions.split(' '), '/tmp/client-raw.mjs', 'root@154.201.72.205:/tmp/'], { env })
console.log('  === 经代理测试 ===')
const out = execFileSync('sshpass', ['-e', 'ssh', ...sshOptions.split(' '), 'root@154.201.72.205', 'node /tmp/client-raw.mjs ' + code], { env, encoding: 'utf8', timeout: 90000 })
console.log(out.split('\n').slice(0, 20).map(l => '  ' + l).join('\n'))
