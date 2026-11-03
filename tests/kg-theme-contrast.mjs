/**
 * Knowledge-graph canvas readability check.
 *
 * Opens the graph tab, measures the rendered text/background color pairs in both
 * host schemes, and writes the two screenshots the task asks for. The canvas is
 * a separate document, so the check also proves the theme bridge actually changed
 * the iframe: it asserts the card surface moved from the dark layer to white when
 * the host dropped `data-ds-dark-theme`.
 *
 * Run: node tests/kg-theme-contrast.mjs
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
  await page.waitForTimeout(2000)
  await frame.getByRole('tab', { name: '图谱', exact: true }).click()
  await page.waitForTimeout(3500)

  const canvas = () => page.frames().find(candidate => candidate.url().includes('/knowledge-base/api/graph.canvas'))
  let canvasFrame = canvas()
  for (let i = 0; i < 40 && (canvasFrame === undefined || await canvasFrame.locator('.card').count() === 0); i += 1) {
    await page.waitForTimeout(250)
    canvasFrame = canvas()
  }
  if (canvasFrame === undefined) throw new Error('canvas frame not found')

  const measure = async () => canvasFrame.evaluate(() => {
    const rgb = (color) => {
      const ctx = document.createElement('canvas').getContext('2d')
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const data = ctx.getImageData(0, 0, 1, 1).data
      return [data[0], data[1], data[2], data[3] / 255]
    }
    const composite = (fg, bg) => {
      const a = fg[3]
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
    }
    const luminance = (color) => {
      const f = (value) => {
        const v = value / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(color[0]) + 0.7152 * f(color[1]) + 0.0722 * f(color[2])
    }
    const contrast = (fg, bg) => {
      const front = composite(rgb(fg), rgb(bg))
      const back = rgb(bg)
      const a = luminance(front)
      const b = luminance(back)
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
    }
    const style = (selector) => {
      const element = document.querySelector(selector)
      return element === null ? null : getComputedStyle(element)
    }
    const surface = style('.card').backgroundColor
    const pairs = {
      'card title (primary / card)': [style('.card h3').color, surface],
      'card summary (secondary / card)': [style('.one').color, surface],
      'card tag (secondary / tag fill)': [style('.tags span').color, style('.tags span').backgroundColor, surface],
      'edge label (secondary / pill)': [style('.pill text').fill, style('.pill rect').fill],
    }
    if (style('.docMark') !== null) {
      pairs['cover mark (accent / cover)'] = [style('.docMark').color, style('.docGenerated').backgroundColor]
      pairs['cover title (primary / cover)'] = [style('.docGenerated b').color, style('.docGenerated').backgroundColor]
      pairs['cover date (tertiary / cover)'] = [style('.docGenerated i').color, style('.docGenerated').backgroundColor]
    }
    const panel = style('#panel').backgroundColor
    if (style('.p-doc') !== null) {
      pairs['panel body (secondary / panel)'] = [style('.p-doc').color, panel]
      pairs['panel kicker (tertiary / panel)'] = [style('.p-kicker').color, panel]
      pairs['panel document meta (tertiary / panel)'] = [style('.p-doc-item .m span').color, panel]
    }
    return {
      dark: document.body.hasAttribute('data-ds-dark-theme'),
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      pairs,
      colors: {
        surface, panel,
        primary: style('.card h3').color,
        secondary: style('.one').color,
        tertiary: style('.docGenerated i')?.color ?? null,
        rootBg: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      },
    }
  })

  const dark = await measure()
  check('iframe follows the host dark scheme', dark.dark === true && dark.colorScheme === 'dark', dark.colors)
  check('dark card surface is the host layer-2 color', dark.colors.surface === 'rgb(44, 44, 46)', dark.colors)
  await page.screenshot({ path: SHOTS + '/kg-dark.png' })

  // Open a topic so the detail panel participates in the same measurement, take
  // the screenshot with it closed, then close it for the light pass.
  await canvasFrame.locator('.card', { hasText: '任务总线' }).first().click()
  await page.waitForTimeout(500)
  const darkPanel = await measure()
  await page.screenshot({ path: SHOTS + '/kg-dark-detail.png' })

  // Toggle the host scheme exactly the way the theme presenter does.
  await frame.evaluate(() => {
    document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = 'light'
  })
  await page.waitForTimeout(1200)
  // Close the panel before the light screenshot so the canvas is comparable.
  await canvasFrame.locator('#close').click()
  await page.waitForTimeout(300)
  const light = await measure()
  check('iframe follows the host light scheme', light.dark === false && light.colorScheme === 'light', light.colors)
  check('light card surface became the host white layer', light.colors.surface === 'rgb(255, 255, 255)', light.colors)
  await page.screenshot({ path: SHOTS + '/kg-light.png' })
  await canvasFrame.locator('.card', { hasText: '任务总线' }).first().click()
  await page.waitForTimeout(400)
  const lightPanel = await measure()
  await canvasFrame.locator('#close').click()

  const lines = []
  for (const [mode, data] of [['dark', darkPanel], ['light', lightPanel]]) {
    for (const [name, [fg, bg, backdrop]] of Object.entries(data.pairs)) {
      lines.push({ mode, name, fg, bg, backdrop })
    }
  }
  // Compute the ratios in one page evaluation for exact CSS color parsing.
  const ratios = await canvasFrame.evaluate((pairs) => {
    const ctx = document.createElement('canvas').getContext('2d')
    const rgb = (color) => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const composite = (fg, bg) => {
      const a = fg[3]
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
    }
    const luminance = (color) => {
      const f = (value) => {
        const v = value / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(color[0]) + 0.7152 * f(color[1]) + 0.0722 * f(color[2])
    }
    return Object.fromEntries(Object.entries(pairs).map(([name, [fg, bg, backdrop]]) => {
      const back = backdrop === undefined ? [255, 255, 255, 1] : rgb(backdrop)
      const background = rgb(bg)
      const solidBackground = background[3] < 1 ? composite(background, back) : background
      const front = composite(rgb(fg), solidBackground)
      const a = luminance(front)
      const b = luminance(solidBackground)
      return [name, Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100]
    }))
  }, Object.fromEntries(lines.map(line => [line.mode + ' :: ' + line.name, [line.fg, line.bg, line.backdrop]])))

  for (const [key, ratio] of Object.entries(ratios)) {
    const isHeading = /title \(primary/.test(key) || /cover title/.test(key)
    const threshold = isHeading ? 3 : 4.5
    check(key + ' meets ' + threshold + ':1', ratio >= threshold, ratio)
  }

  // The rail tree is host markup, not the iframe; measure its text too.
  const rail = await frame.evaluate(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    const rgb = (color) => {
      ctx.fillStyle = color
      ctx.fillRect(0, 0, 1, 1)
      const d = ctx.getImageData(0, 0, 1, 1).data
      return [d[0], d[1], d[2], d[3] / 255]
    }
    const composite = (fg, bg) => {
      const a = fg[3]
      return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1]
    }
    const luminance = (color) => {
      const f = (value) => {
        const v = value / 255
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(color[0]) + 0.7152 * f(color[1]) + 0.0722 * f(color[2])
    }
    const ratio = (fg, bg) => {
      const background = rgb(bg)
      const front = composite(rgb(fg), background)
      const a = luminance(front)
      const b = luminance(background)
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100
    }
    const pageBg = getComputedStyle(document.body).backgroundColor
    const graph = [...document.querySelectorAll('[data-testid=kg-graph]')].find(el => (el.textContent || '').includes('平台建设'))
    const topic = document.querySelector('[data-testid=kg-topic]')
    const graphColor = getComputedStyle(graph).color
    const topicColor = getComputedStyle(topic).color
    return {
      graph: { color: graphColor, pageBg, ratio: ratio(graphColor, pageBg) },
      topic: { color: topicColor, pageBg, ratio: ratio(topicColor, pageBg) },
    }
  })
  console.log('RAIL', JSON.stringify(rail))
  check('graph tree row contrast meets 4.5:1', rail.graph.ratio >= 4.5, rail.graph)
  check('topic row contrast meets 4.5:1', rail.topic.ratio >= 4.5, rail.topic)

  console.log('\nRESULT ' + JSON.stringify({ passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length }))
} catch (error) {
  check('contrast script completed', false, String(error))
  await page.screenshot({ path: SHOTS + '/kg-theme-failure.png' }).catch(() => {})
} finally {
  await browser.close()
}