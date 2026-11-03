/** Graph tree vs KB tree visual comparison + collapsed/expanded states. */
import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'

const SHOTS = '/root/projects/dsh-ui-shots'
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(12000)
await page.locator('input').nth(0).fill('admin', { force: true })
await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
await page.waitForTimeout(8000)
await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
await page.waitForTimeout(18000)
const frame = page.frames().find(f => f.url().includes(':32000') && !f.url().includes('/knowledge-base/'))
await frame.getByText('知识库', { exact: true }).first().click()
await page.waitForTimeout(2500)
const railClip = { x: 280, y: 0, width: 290, height: 1000 }
const metrics = async () => frame.evaluate(() => {
  const row = document.querySelector('[data-testid=kg-scope-row], [class*=explorerRow]')
  const svgs = row?.querySelectorAll('svg') ?? []
  const icon = svgs[svgs.length - 1]
  const rr = row?.getBoundingClientRect()
  const ir = icon?.getBoundingClientRect()
  return { rowHeight: rr?.height, fontSize: row ? getComputedStyle(row).fontSize : null, icon: ir ? { w: ir.width, h: ir.height } : null, paddingLeft: row ? getComputedStyle(row).paddingLeft : null }
})
const kbMetrics = await metrics()
await page.screenshot({ path: SHOTS + '/kg-tree-kb-rail.png', clip: railClip })
// Switch to graph: capture the all-collapsed state first.
await frame.getByRole('tab', { name: '图谱', exact: true }).click()
await page.waitForTimeout(3000)
await frame.locator('[data-testid=kg-tree]').waitFor({ state: 'visible', timeout: 20000 })
await page.screenshot({ path: SHOTS + '/kg-tree-collapsed.png' })
await page.screenshot({ path: SHOTS + '/kg-tree-graph-rail-collapsed.png', clip: railClip })
const collapsedMetrics = await metrics()
// Expand 全局 → 平台建设 → topics, and capture the expanded tree.
await frame.locator('[data-testid=kg-scope][data-scope=global] [data-testid=kg-scope-row]').click()
await page.waitForTimeout(400)
await frame.locator('[data-testid=kg-graph]').filter({ hasText: '平台建设' }).click()
await page.waitForTimeout(800)
const graphMetrics = await frame.evaluate(() => {
  const row = document.querySelector('[data-testid=kg-graph]')
  const topic = document.querySelector('[data-testid=kg-topic]')
  const svgs = row?.querySelectorAll('svg') ?? []
  const icon = svgs[svgs.length - 1]
  const rr = row?.getBoundingClientRect()
  const tr = topic?.getBoundingClientRect()
  const ir = icon?.getBoundingClientRect()
  return { rowHeight: rr?.height, topicHeight: tr?.height, fontSize: row ? getComputedStyle(row).fontSize : null,
    icon: ir ? { w: ir.width, h: ir.height } : null, graphPadding: row ? getComputedStyle(row).paddingLeft : null,
    topicPadding: topic ? getComputedStyle(topic).paddingLeft : null, count: document.querySelector('[data-testid=kg-graph] [class*=explorerTime]')?.textContent }
})
await page.screenshot({ path: SHOTS + '/kg-tree-filetree.png' })
await page.screenshot({ path: SHOTS + '/kg-tree-graph-rail-expanded.png', clip: railClip })
console.log(JSON.stringify({ kbMetrics, collapsedMetrics, graphMetrics }, null, 2))
// Compose the comparison image with labels.
execFileSync('python3', ['-c', `
from PIL import Image, ImageDraw
a = Image.open('${SHOTS}/kg-tree-graph-rail-expanded.png').convert('RGB')
b = Image.open('${SHOTS}/kg-tree-kb-rail.png').convert('RGB')
h = max(a.height, b.height)
out = Image.new('RGB', (a.width + b.width + 24, h + 34), (20,20,22))
out.paste(a, (0,34)); out.paste(b, (a.width+24,34))
d = ImageDraw.Draw(out)
d.text((10,10), 'GRAPH TAB (file-tree rows)', fill=(240,240,240))
d.text((a.width+34,10), 'KNOWLEDGE TAB (KB tree)', fill=(240,240,240))
out.save('${SHOTS}/kg-tree-vs-kb.png')
`])
await browser.close()
