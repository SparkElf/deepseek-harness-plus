/**
 * Share-dialog proportion acceptance (task 16).
 *
 * Opens the real Share dialog from a KB row's context menu, measures the dialog
 * and the principal list at 1680x1000 and 1280x800, and records the old
 * 380px/240px-list layout by applying that prior geometry inline for one frame.
 * Screenshots are the fixed layout at both viewports.
 *
 * Run: node tests/share-dialog-acceptance.mjs
 */
import { chromium } from 'playwright'

const SHOTS = '/root/projects/dsh-ui-shots'
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail)))
  if (!ok) process.exitCode = 1
}

const browser = await chromium.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const context = await browser.newContext({ viewport: { width: 1680, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()

async function openShare(frame) {
  const row = frame.locator('span').filter({ hasText: /^制度$/u }).first()
  await row.waitFor({ state: 'visible', timeout: 10000 })
  const box = await row.boundingBox()
  if (box === null) throw new Error('no row box')
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
  const share = frame.getByText('分享', { exact: true }).last()
  await share.waitFor({ state: 'visible', timeout: 5000 })
  await share.click()
  const dialog = frame.locator('[role=dialog]')
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  await frame.locator('[data-testid=share-list] button[role=option]').first().waitFor({ state: 'visible', timeout: 10000 })
  await page.waitForTimeout(500)
  return dialog
}

async function measure(frame) {
  return frame.evaluate(() => {
    const dialog = document.querySelector('[role=dialog]')
    const list = document.querySelector('[data-testid=share-list]')
    const rows = [...list.querySelectorAll('button[role=option]')]
    const listRect = list.getBoundingClientRect()
    const rowRects = rows.map(row => row.getBoundingClientRect())
    const visibleRows = rowRects.filter(rect => rect.top < listRect.bottom - 2 && rect.bottom > listRect.top + 2).length
    const rowHeight = rowRects.length === 0 ? 0 : Math.round(rowRects[0].height)
    const dialogRect = dialog.getBoundingClientRect()
    return {
      dialog: { width: Math.round(dialogRect.width), height: Math.round(dialogRect.height), top: Math.round(dialogRect.top), bottom: Math.round(dialogRect.bottom) },
      list: { width: Math.round(listRect.width), height: Math.round(listRect.height), clientHeight: list.clientHeight, scrollHeight: list.scrollHeight },
      rows: { total: rows.length, visible: visibleRows, rowHeight },
      viewport: { width: innerWidth, height: innerHeight },
    }
  })
}

async function oldGeometry(frame) {
  return frame.evaluate(() => {
    const dialog = document.querySelector('[role=dialog]')
    const content = dialog.querySelector(':scope > div')
    const body = document.querySelector('[data-testid=share-body]')
    const list = document.querySelector('[data-testid=share-list]')
    const save = {
      dialogWidth: dialog.style.width, dialogMin: dialog.style.minHeight, dialogMax: dialog.style.maxHeight,
      contentFlex: content.style.flex, bodyFlex: body.style.flex,
      listMax: list.style.maxHeight, listFlex: list.style.flex, listMin: list.style.minHeight,
    }
    // The prior stylesheet: a 380px sheet, an auto height, and a list capped at
    // min(240px, 40vh) that could not consume the dialog's free space.
    dialog.style.width = '380px'
    dialog.style.minHeight = '0'
    dialog.style.maxHeight = 'none'
    content.style.flex = 'none'
    body.style.flex = 'none'
    list.style.maxHeight = 'min(240px, 40vh)'
    list.style.flex = 'none'
    list.style.minHeight = '0'
    const rect = dialog.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    const rows = [...list.querySelectorAll('button[role=option]')]
    const visible = rows.filter(row => {
      const r = row.getBoundingClientRect()
      return r.top < listRect.bottom - 2 && r.bottom > listRect.top + 2
    }).length
    const measured = {
      dialog: { width: Math.round(rect.width), height: Math.round(rect.height) },
      list: { height: Math.round(listRect.height) },
      rows: { total: rows.length, visible },
    }
    dialog.style.width = save.dialogWidth
    dialog.style.minHeight = save.dialogMin
    dialog.style.maxHeight = save.dialogMax
    content.style.flex = save.contentFlex
    body.style.flex = save.bodyFlex
    list.style.maxHeight = save.listMax
    list.style.flex = save.listFlex
    list.style.minHeight = save.listMin
    return measured
  })
}

try {
  await page.goto('http://127.0.0.1:3000/?test=true', { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForTimeout(12000)
  await page.locator('input').nth(0).fill('admin', { force: true })
  await page.locator('input[type=password]').fill('DataOps!2026', { force: true })
  await page.getByRole('button', { name: '进入工作台', exact: true }).click({ force: true })
  await page.waitForTimeout(8000)
  await page.goto('http://127.0.0.1:3000/ai/dsh', { waitUntil: 'domcontentloaded', timeout: 40000 })
  await page.waitForTimeout(18000)
  const frame = page.frames().find(candidate => candidate.url().includes(':32000') && !candidate.url().includes('/knowledge-base/'))
  if (frame === undefined) throw new Error('DSH frame not found')
  await frame.locator('button').filter({ hasText: /^知识库$/u }).first().click()
  await page.waitForTimeout(2500)

  // 1680x1000
  await openShare(frame)
  const fixed1680 = await measure(frame)
  const old1680 = await oldGeometry(frame)
  console.log('BEFORE 1680', JSON.stringify(old1680))
  console.log('AFTER  1680', JSON.stringify(fixed1680))
  check('1680: dialog fits the viewport', fixed1680.dialog.top >= 0 && fixed1680.dialog.bottom <= fixed1680.viewport.height,
    fixed1680)
  check('1680: dialog is wider than the old 380px sheet', fixed1680.dialog.width > 380, fixed1680.dialog)
  check('1680: dialog height is a proportional band, not auto-shrunk', fixed1680.dialog.height >= 560 && fixed1680.dialog.height <= 720, fixed1680.dialog)
  check('1680: principal list shows at least 6 rows', fixed1680.rows.visible >= 6, fixed1680.rows)
  check('1680: the list scrolls inside the dialog, not the dialog', fixed1680.list.clientHeight <= fixed1680.list.scrollHeight, fixed1680.list)
  await page.screenshot({ path: SHOTS + '/share-dialog-1680.png' })

  await frame.getByRole('button', { name: '取消' }).last().click()
  await page.waitForTimeout(500)

  // 1280x800
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.waitForTimeout(800)
  await openShare(frame)
  const fixed1280 = await measure(frame)
  const old1280 = await oldGeometry(frame)
  console.log('BEFORE 1280', JSON.stringify(old1280))
  console.log('AFTER  1280', JSON.stringify(fixed1280))
  check('1280: dialog fits the viewport', fixed1280.dialog.top >= 0 && fixed1280.dialog.bottom <= fixed1280.viewport.height,
    fixed1280)
  check('1280: dialog narrows with the viewport, never overflows', fixed1280.dialog.width <= fixed1280.viewport.width - 48, fixed1280.dialog)
  check('1280: dialog keeps its minimum band', fixed1280.dialog.height >= 540 && fixed1280.dialog.height <= 640, fixed1280.dialog)
  check('1280: principal list shows at least 6 rows', fixed1280.rows.visible >= 6, fixed1280.rows)
  await page.screenshot({ path: SHOTS + '/share-dialog-1280.png' })

  console.log('\nRESULT ' + JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }))
} catch (error) {
  check('share-dialog script completed', false, String(error))
  await page.screenshot({ path: SHOTS + '/share-dialog-failure.png' }).catch(() => {})
} finally {
  await browser.close()
}