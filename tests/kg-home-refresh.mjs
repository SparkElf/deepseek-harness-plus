/** Home list refresh after delete / favorite, in the real workbench. */
import { chromium } from 'playwright'
const SHOTS = '/root/projects/dsh-ui-shots'
const results = []
const check = (name, ok, detail) => { results.push({name,ok,detail}); console.log((ok?'PASS':'FAIL')+'  '+name+(detail===undefined?'':'  '+JSON.stringify(detail).slice(0,300))); if(!ok) process.exitCode=1 }
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] })
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await ctx.newPage()
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('dialog', d => { void d.accept() })
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
  await frame.getByText('知识库', { exact: true }).first().click()
  await page.waitForTimeout(3000)
  const rowsNow = () => frame.locator('tbody tr').count()
  const target = 'hello.txt'
  const targetRow = frame.locator('tbody tr').filter({ hasText: target }).first()
  await targetRow.waitFor({ state: 'visible', timeout: 15000 })
  const before = await rowsNow()

  // Favorite: star the row, switch to 收藏, it appears; unstar, it disappears.
  await targetRow.getByRole('button', { name: /取消收藏|收藏/u }).click()
  await page.waitForTimeout(500)
  await frame.getByRole('tab', { name: '收藏', exact: true }).click()
  await page.waitForTimeout(800)
  check('favoriting makes the row appear in 收藏', await frame.locator('tbody tr').filter({ hasText: target }).count() > 0)
  const favRow2 = frame.locator('tbody tr').filter({ hasText: target }).first()
  if (await favRow2.count()) await favRow2.getByRole('button', { name: /取消收藏|收藏/u }).click()
  await page.waitForTimeout(800)
  check('unfavoriting removes it from 收藏', await frame.locator('tbody tr').filter({ hasText: target }).count() === 0)
  await frame.getByRole('tab', { name: '最近访问', exact: true }).click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: SHOTS + '/home-favorite.png' })

  // Delete the only Home row and assert the table shrinks on the same click.
  await page.screenshot({ path: SHOTS + '/home-delete-before.png' })
  await targetRow.getByRole('button', { name: '删除' }).click()
  await page.waitForTimeout(2500)
  const after = await rowsNow()
  check('delete removes the row without switching tabs', before > 0 && after === before - 1
    && await frame.locator('tbody tr').filter({ hasText: target }).count() === 0, { before, after })
  await page.screenshot({ path: SHOTS + '/home-delete-after.png' })

  check('no uncaught page errors', errors.length === 0, errors.slice(0,3))
  console.log('\nRESULT ' + JSON.stringify({passed:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length}))
} catch (e) {
  check('home refresh script completed', false, String(e))
  await page.screenshot({ path: SHOTS + '/home-refresh-failure.png' }).catch(()=>{})
} finally { await browser.close() }
