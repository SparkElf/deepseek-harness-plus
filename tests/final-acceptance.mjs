import { chromium } from 'playwright'
const OUT = '/root/projects/dsh-ui-shots'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const errors = []
page.on('pageerror', e => errors.push(String(e).slice(0, 90)))
const results = {}
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 90000 })
await page.waitForTimeout(7000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(6000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 90000 })
let dsh = null
for (let i = 0; i < 9; i++) { await page.waitForTimeout(6000); dsh = page.frames().find(f => f !== page.mainFrame() && /dsh|32000/.test(f.url())); if (dsh && (await dsh.evaluate(() => document.querySelectorAll('nav button').length)) > 0) break }
results.frame = !!dsh
results.nav = await dsh.evaluate(() => [...document.querySelectorAll('nav button')].map(e => (e.textContent||'').trim()).filter(Boolean))
results.noPlugin = !results.nav.includes('插件')

async function clickNav(label) {
  await dsh.evaluate((l) => { const n = [...document.querySelectorAll('nav button')].find(x => (x.textContent||'').trim() === l); n && n.click() }, label)
  await page.waitForTimeout(5000)
}
// 任务中心
await dsh.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '任务中心'); b && b.click() })
await page.waitForTimeout(6000)
const tc = await dsh.evaluate(() => document.body.innerText)
results.taskCenter = { hasNew: /新建任务|新建/.test(tc.slice(tc.indexOf('任务中心'), tc.indexOf('任务中心')+400)), tabs: (tc.match(/全部\s*\d|待我处理|个人|群聊|连接器/g)||[]).slice(0,6) }
await page.screenshot({ path: OUT + '/final-taskcenter.png' })
await page.keyboard.press('Escape').catch(()=>{})
await page.waitForTimeout(1500)
// 技能中心
await clickNav('技能中心')
const sc = await dsh.evaluate(() => document.body.innerText)
results.skillTabs = (sc.match(/内置\d+|个人\d+|技能广场|连接器\d+/g)||[])
await page.screenshot({ path: OUT + '/final-skillcenter.png' })
// 知识库图谱
await clickNav('知识库')
await page.waitForTimeout(3000)
await dsh.evaluate(() => { const t = [...document.querySelectorAll('[role=tab],button')].find(x => (x.textContent||'').trim() === '图谱'); t && t.click() })
await page.waitForTimeout(7000)
results.kgCanvas = page.frames().some(f => f.url().includes('graph.canvas'))
results.kgError = /读取失败/.test(await dsh.evaluate(() => document.body.innerText))
await page.screenshot({ path: OUT + '/final-kg.png' })
// 右侧栏数据资源
await dsh.evaluate(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'') === '打开右侧边栏'); b && b.click() })
await page.waitForTimeout(3000)
await dsh.evaluate(() => { const el = [...document.querySelectorAll('*')].find(x => (x.textContent||'').trim() === '数据资源' && x.children.length === 0); el && el.click() })
await page.waitForTimeout(9000)
const embed = page.frames().find(f => f.url().includes('/embed/resources'))
results.resources = embed ? { url: embed.url(), hasTree: /数据目录|按库筛选/.test(await embed.evaluate(() => document.body.innerText)), hasPager: /共\s*\d+\s*条/.test(await embed.evaluate(() => document.body.innerText)) } : null
await page.screenshot({ path: OUT + '/final-resources.png' })
results.errors = errors.slice(0, 3)
console.log(JSON.stringify(results, null, 1))
await browser.close()
