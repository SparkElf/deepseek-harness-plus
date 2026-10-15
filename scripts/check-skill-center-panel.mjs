/** Assert the Skill Center panel renders in a real browser instead of blanking on a runtime error.
 *
 * A plugin can pass tsc, its bundler, and the client i18n gate and still render nothing: a
 * component that resolves to `undefined` at runtime makes React throw error #130 ("element type is
 * invalid"), the slot entry unmounts, and the panel becomes an empty region. The failure is
 * invisible to every static check because the compile-time module is not the one the deployment
 * serves (see `scripts/check-browser-platform-module-exports.mjs`).
 *
 * Measured 2026-10-16: a skill-center build importing `IconSearchOutline16` blanked the panel on
 * deploy while every gate passed. The panel must therefore be opened once and judged on what it
 * renders.
 *
 * Usage:
 *   node scripts/check-skill-center-panel.mjs [--base-url <url>] [--out <dir>] [--tag <name>]
 *
 * The browser is the system Chrome through Playwright; set `NODE_PATH` to a tree that provides
 * `playwright` when it is not resolvable from this repository.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const optionOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index === -1 ? fallback : args[index + 1]
}

const baseUrl = optionOf('--base-url', 'http://127.0.0.1:3080/')
const out = resolve(optionOf('--out', '/tmp'))
const tag = optionOf('--tag', 'panel')
const chrome = optionOf('--chrome', '/usr/bin/google-chrome')

let chromium
try {
  ({ chromium } = await import('playwright'))
} catch (cause) {
  console.error('check-skill-center-panel: playwright is not resolvable from this tree')
  console.error('  point NODE_PATH at a tree that provides it, for example')
  console.error('  NODE_PATH=<modules-with-playwright> node scripts/check-skill-center-panel.mjs')
  throw cause
}
mkdirSync(out, { recursive: true })

const browser = await chromium.launch({ headless: true, executablePath: chrome,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const pageErrors = []
const consoleErrors = []
page.on('pageerror', error => pageErrors.push(String(error).slice(0, 300)))
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)) })

const results = []
const check = (name, ok, detail) => results.push({ name, ok: Boolean(ok), detail })

/** Open the panel from the sidebar row. */
async function openPanel() {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
  await page.waitForTimeout(3000)
  await page.getByText('Skill Center', { exact: true }).click()
  await page.waitForTimeout(5000)
}

try {
  await openPanel()

  const cards = await page.locator('li[class*="card"]').count()
  check('panel renders cards rather than a blank region', cards > 0, 'cards=' + String(cards))
  await page.screenshot({ path: resolve(out, 'skill-center-' + tag + '-panel.png') })

  // The bar reports a running batch and is hidden once every skill is indexed, so it is absent
  // in the shipped state. What the check can still assert is that nothing is left mid-flight: any
  // count on the page must be complete, because a partial one means the batch did not finish.
  const progress = await page.locator('[class*="progressCount"]').allInnerTexts()
  const partial = progress.filter((text) => {
    const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text)
    return match === null || Number(match[1]) < Number(match[2])
  })
  check('no translation batch is left incomplete', partial.length === 0,
    'counts=' + JSON.stringify(progress) + ' partial=' + JSON.stringify(partial))

  // The crash signature of an undefined component: React #130 and the unmounted slot entry.
  const crash = pageErrors.concat(consoleErrors)
    .filter(text => /#130|slot entry crashed|Minified React error/i.test(text))
  check('no React #130 / crashed slot entry', crash.length === 0, JSON.stringify(crash.slice(0, 3)))

  const search = page.locator('input[placeholder*="Search skills"], input[placeholder*="搜索技能"]').first()
  const hasSearch = await search.count()
  check('search box present', hasSearch === 1, 'matches=' + String(hasSearch))

  // The shared Input atom wraps the native input beside a leading icon, and its focus ring is the
  // brand colour. A locally styled control would satisfy "a search box exists" while skipping both.
  if (hasSearch === 1) {
    const atom = await search.evaluate((element) => {
      const wrap = element.parentElement
      const icon = wrap === null ? null : wrap.firstElementChild
      return { children: wrap === null ? -1 : wrap.children.length,
               icon: icon !== null && icon.querySelector !== null && icon.querySelector('svg') !== null }
    })
    check('search box is the shared Input atom (icon + input in one wrapper)',
      atom.children === 2 && atom.icon, JSON.stringify(atom))

    await search.focus()
    await page.waitForTimeout(300)
    const ring = await search.evaluate((element) => {
      // The token is declared on an ancestor rather than on :root, so walk up for it; a bare
      // :root lookup returns empty and would make the comparison vacuously true.
      let node = element
      let brand = ''
      while (node !== null && brand === '') {
        brand = getComputedStyle(node).getPropertyValue('--dsw-alias-state-business-primary').trim()
        node = node.parentElement
      }
      const probe = document.createElement('span')
      probe.style.color = brand === '' ? 'inherit' : brand
      document.body.appendChild(probe)
      const resolved = getComputedStyle(probe).color
      probe.remove()
      return { border: getComputedStyle(element.parentElement).borderColor, resolved }
    })
    check('search box focus ring is the brand colour',
      ring.resolved !== '' && ring.border === ring.resolved, JSON.stringify(ring))
    await page.screenshot({ path: resolve(out, 'skill-center-' + tag + '-search.png') })
    await search.blur()

    if (cards > 0) {
      await search.fill('genui')
      await page.waitForTimeout(1200)
      const filtered = await page.locator('li[class*="card"]').count()
      await search.fill('')
      await page.waitForTimeout(800)
      const restored = await page.locator('li[class*="card"]').count()
      check('search box narrows the list and restores it',
        filtered > 0 && filtered < cards && restored === cards,
        'filtered=' + String(filtered) + ' restored=' + String(restored) + ' total=' + String(cards))
    }
  }

  // One line of copy per card: the summary, without the description the card used to repeat. A
  // second body paragraph is the defect this asserts against, so both class names are counted.
  const summaries = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('li[class*="card"]')]
    return { total: cards.length,
             one: cards.filter(card => card.querySelectorAll('[class*="cardSummary"]').length === 1
               && card.querySelectorAll('[class*="cardDesc"]').length === 0).length }
  })
  check('every card carries exactly one line of copy',
    summaries.total > 0 && summaries.one === summaries.total, JSON.stringify(summaries))

  // The detail dialog serves the skill's own SKILL.md body, frontmatter stripped.
  const details = page.getByText(/^(Details|详情)$/)
  if (await details.count() > 0) {
    await details.first().click()
    await page.waitForTimeout(2500)
    const body = await page.evaluate(() => {
      const pre = document.querySelector('pre[data-skill-body]')
      if (pre === null) return { found: false }
      const text = pre.innerText
      return { found: true, chars: text.length, frontmatter: /^\s*---/.test(text) }
    })
    check('detail dialog renders the skill body',
      body.found && body.chars > 200 && !body.frontmatter, JSON.stringify(body))
    await page.screenshot({ path: resolve(out, 'skill-center-' + tag + '-detail.png') })
    const close = page.getByRole('button', { name: /Close|关闭/ })
    if (await close.count() > 0) { await close.first().click(); await page.waitForTimeout(600) }
  } else {
    check('detail dialog renders the skill body', false, 'no Details control found')
  }

  check('no page error', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 3)))
} catch (error) {
  check('panel opened', false, String(error && error.message).slice(0, 300))
} finally {
  await browser.close()
}

console.log('===RESULTS===')
for (const result of results) {
  console.log((result.ok ? 'PASS  ' : 'FAIL  ') + result.name + (result.ok ? '' : '   :: ' + result.detail))
}
const failed = results.filter(result => !result.ok).length
console.log('===SUMMARY=== total=' + String(results.length) + ' failed=' + String(failed))
console.log('SHOTS: ' + resolve(out, 'skill-center-' + tag + '-panel.png'))
process.exit(failed === 0 ? 0 : 1)
