/**
 * Four knowledge-graph tools: real chat loop + filesystem proof.
 *
 * The model is asked to call kg_add / kg_get / kg_set / kg_del. Assertions do not
 * depend on how the model formats prose: they check the authoritative tree before
 * and after each confirm, and the audit log at the end.
 */
import { chromium } from 'playwright'
import { execSync } from 'node:child_process'

const SHOTS = '/root/projects/dsh-ui-shots'
const UID = '260afb31-f8d9-44ba-b161-2a9bfe283a79'
const GRAPH = `/nas/kb/actual/personal/${UID}/知识图谱/工作轨迹`
const TOPIC = '图谱工具E2E'
const ID = 'kg-tool-e2e'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500)))
  if (!ok) process.exitCode = 1
}
const sh = (cmd) => execSync(`docker exec dataops-ai-admin-dsh-runtime sh -c ${JSON.stringify(cmd)}`, { encoding: 'utf8' }).trim()
const folder = () => sh(`find ${GRAPH} -maxdepth 1 -type d -name ${JSON.stringify(TOPIC)} | head -1`)
const card = () => sh(`cat ${GRAPH}/${TOPIC}/index.md 2>/dev/null || true`)

const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
const errors = []
page.on('pageerror', error => errors.push(String(error)))

try {
  await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForTimeout(12000)
  await page.locator('input').nth(0).fill('admin', { force: true })
  await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
  await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
  await page.waitForTimeout(8000)
  await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForTimeout(18000)
  const frame = page.frames().find(f => f.url().includes(':32000') && !f.url().includes('/knowledge-base/'))
  if (frame === undefined) throw new Error('DSH frame not found')
  await frame.getByRole('button', { name: '新会话' }).first().click().catch(() => undefined)
  await page.waitForTimeout(1200)
  const input = frame.locator('[contenteditable=true]').first()
  const text = () => frame.evaluate(() => document.body.innerText)
  const send = async (value) => {
    await input.click()
    await page.keyboard.press('Control+A')
    await page.keyboard.type(value, { delay: 2 })
    await page.waitForTimeout(400)
    await input.press('Enter')
  }
  const waitFor = async (needle, timeoutMs = 120000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if ((await text()).includes(needle)) return true
      await page.waitForTimeout(1500)
    }
    return false
  }
  const waitFile = async (predicate, timeoutMs = 60000) => {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true
      await page.waitForTimeout(1000)
    }
    return false
  }

  await send(`请调用 kg_add 工具新增图谱主题：graph="personal/知识图谱/工作轨迹"，kind="topic"，id="${ID}"，title="${TOPIC}"，summary="E2E 初始摘要。" 先不要 confirm，只返回草稿。`)
  await waitFor(TOPIC)
  check('kg_add returned a draft before writing', folder() === '', folder())
  await page.screenshot({ path: SHOTS + '/kg-tool-01-add-draft.png' })

  await send('确认，请带 confirm:true 落盘。')
  check('kg_add wrote the topic after confirm', await waitFile(() => folder() !== ''), { folder: folder(), card: card().slice(0, 120) })
  await page.screenshot({ path: SHOTS + '/kg-tool-02-add-written.png' })

  await send(`请调用 kg_get 工具，graph="personal/知识图谱/工作轨迹"，id="${ID}"。`)
  check('kg_get read the topic back', await waitFor(TOPIC) && (await text()).includes('E2E 初始摘要'), (await text()).slice(-300))
  await page.screenshot({ path: SHOTS + '/kg-tool-03-get.png' })

  await send(`请调用 kg_set 工具，graph="personal/知识图谱/工作轨迹"，id="${ID}"，summary="E2E 修改后的摘要。" 先不要 confirm，只返回草稿。`)
  await waitFor('E2E 修改后的摘要')
  check('kg_set draft left the card unchanged', card().includes('E2E 初始摘要') && !card().includes('E2E 修改后的摘要'), card().slice(0, 160))
  await page.screenshot({ path: SHOTS + '/kg-tool-04-set-draft.png' })

  await send('确认，请带 confirm:true 落盘。')
  check('kg_set wrote the new summary after confirm', await waitFile(() => card().includes('E2E 修改后的摘要')), card().slice(0, 200))
  await page.screenshot({ path: SHOTS + '/kg-tool-05-set-written.png' })

  await send(`请调用 kg_del 工具，graph="personal/知识图谱/工作轨迹"，id="${ID}"，先不要 confirm，返回将移入 _trash 的路径。`)
  await waitFor('_trash')
  check('kg_del draft left the topic in place', folder() !== '', folder())
  await page.screenshot({ path: SHOTS + '/kg-tool-06-del-draft.png' })

  await send('确认，请带 confirm:true 和 force:true 移入 _trash。')
  check('kg_del moved the topic under _trash', await waitFile(() => folder() === '' && sh(`find ${GRAPH}/_trash/topics -maxdepth 1 -type d -name '*${TOPIC}*' | head -1`) !== ''),
    { original: folder(), trash: sh(`find ${GRAPH}/_trash/topics -maxdepth 1 -type d -name '*${TOPIC}*' | head -3`) })
  await page.screenshot({ path: SHOTS + '/kg-tool-07-del-written.png' })

  const audit = sh(`grep -h ${JSON.stringify(ID)} /nas/kb/views/*/.kb-audit.jsonl 2>/dev/null | tail -20`)
  check('audit records create / edit / delete for this topic',
    audit.includes('"action":"create"') && audit.includes('"action":"edit"') && audit.includes('"action":"delete"')
    && audit.includes('_trash') && audit.includes('kg_del'), audit.slice(-500))
  check('no uncaught page errors during the tool loop', errors.length === 0, errors.slice(0, 2))
  console.log('\nRESULT ' + JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }))
} catch (error) {
  check('kg tools script completed', false, String(error))
  await page.screenshot({ path: SHOTS + '/kg-tool-failure.png' }).catch(() => {})
} finally {
  await browser.close()
}
