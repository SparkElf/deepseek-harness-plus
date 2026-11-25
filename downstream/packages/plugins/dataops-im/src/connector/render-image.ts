/**
 * GenUI HTML → PNG（企微图片投递）。
 *
 * 企微只能发图片消息，不能渲染 HTML/GenUI；这里用容器已有的 headless Chrome 把
 * render-policy 生成的 HTML 截成手机可读的 PNG：
 *
 * - 画布宽 720（内容过高时可用 1080），中文用 Noto Sans CJK / 微软雅黑；
 * - 默认只输出一张：内容按完整 scrollHeight 测量，过高时整体缩放内容区（footer 不缩），
 *   保证最后一个组件和 footer 都完整可见；
 * - footer 正常文档流、单行 22px，不 fixed/absolute、不遮挡内容；
 * - 单张 ≤2MB；只有极端超长（缩放后仍不可读）才拆图；
 * - 不新增 npm 依赖：直接调用 PATH/常见路径/Playwright 缓存里的 Chrome。
 *
 * @module connector/render-image
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 手机宽度优先；1080 只作为显式/缩放回退。 */
export type PngWidth = 720 | 1080

/** 渲染参数。 */
export interface PngRenderOptions {
  readonly width?: PngWidth
  readonly timeoutMs?: number
  readonly maxBytes?: number
  /** 目标最大总高度（含 footer）；超出时缩放内容区。 */
  readonly maxHeight?: number
}

const DEFAULT_WIDTH: PngWidth = 720
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
/** 一张图的目标最大高度；再高就缩放内容，而不是裁切/拆图。 */
const DEFAULT_MAX_HEIGHT = 2_400
/** 低于这个缩放比，字号接近不可读；仅在极端长内容时使用。 */
const MIN_READABLE_SCALE = 0.5
/** footer 固定 22px，单行小字号、正常文档流。 */
const FOOTER_HEIGHT = 22

/** Chrome 不可用（环境没有 Chromium）时抛出的稳定错误码。 */
export class GenUiImageError extends Error {
  constructor(
    readonly code: 'CHROME_UNAVAILABLE' | 'RENDER_TIMEOUT' | 'RENDER_FAILED' | 'IMAGE_TOO_LARGE' | 'TOO_TALL',
    message: string,
  ) {
    super(message)
    this.name = 'GenUiImageError'
  }
}

const CHROME_CANDIDATES = [
  'google-chrome-stable',
  'google-chrome',
  'chromium',
  'chromium-browser',
  'chrome',
]

const CHROME_PATHS = [
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/opt/google/chrome/chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

/** 解析可执行文件；PATH 中找不到时看常见安装路径。 */
function resolveExecutable(name: string): string | undefined {
  if (name.includes('/')) return existsSync(name) ? name : undefined
  const path = process.env.PATH ?? ''
  for (const directory of path.split(':')) {
    if (directory === '') continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Playwright 自带的 Chromium（容器里通常已装，优先于系统 PATH）。 */
function findPlaywrightChrome(): string | undefined {
  const roots = [
    '/ms-playwright',
    join(homedir(), '.cache', 'ms-playwright'),
    '/root/.cache/ms-playwright',
  ]
  for (const root of roots) {
    let entries: string[]
    try {
      entries = readdirSync(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.startsWith('chromium-') && !entry.startsWith('chromium_headless_shell-')) continue
      const base = join(root, entry)
      const candidates = [
        join(base, 'chrome-linux64', 'chrome'),
        join(base, 'chrome-linux', 'chrome'),
        join(base, 'chrome-linux', 'headless_shell'),
        join(base, 'chrome-linux64', 'headless_shell'),
      ]
      for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/** 定位 Chrome；结果按进程缓存。 */
let cachedChrome: string | null | undefined
export function detectChrome(): string | undefined {
  if (cachedChrome !== undefined) return cachedChrome ?? undefined
  const configured = process.env.DATAOPS_IM_CHROME_PATH?.trim()
  if (configured !== undefined && configured !== '' && configured !== 'disabled') {
    cachedChrome = resolveExecutable(configured) ?? null
    return cachedChrome ?? undefined
  }
  if (configured === 'disabled') {
    cachedChrome = null
    return undefined
  }
  const playwright = findPlaywrightChrome()
  if (playwright !== undefined) {
    cachedChrome = playwright
    return playwright
  }
  for (const candidate of CHROME_PATHS) {
    if (existsSync(candidate)) {
      cachedChrome = candidate
      return candidate
    }
  }
  for (const candidate of CHROME_CANDIDATES) {
    const resolved = resolveExecutable(candidate)
    if (resolved !== undefined) {
      cachedChrome = resolved
      return resolved
    }
  }
  cachedChrome = null
  return undefined
}

/** 测试用：清空 Chrome 探测缓存。 */
export function resetChromeCache(): void {
  cachedChrome = undefined
}

/** 测高脚本：等字体和两帧布局稳定后，报总高/内容高/footer 高。 */
const MEASURE_SCRIPT = `<script>
document.addEventListener('DOMContentLoaded', function () {
  var finish = function () {
    var sheet = document.getElementById('genui-sheet')
    var footer = document.getElementById('genui-footer')
    var height = Math.ceil(document.documentElement.scrollHeight)
    var content = sheet ? Math.ceil(sheet.getBoundingClientRect().height) : height
    var foot = footer ? Math.ceil(footer.getBoundingClientRect().height) : 0
    document.title = 'H=' + height + ';S=' + content + ';F=' + foot
  }
  // 先同步报一次，避免 headless dump 早于异步字体回调；字体就绪后再修正。
  finish()
  var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
  fonts.then(function () { setTimeout(finish, 30) }).catch(finish)
})
</script>`

function watermarkDate(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 组装最终 HTML：内容容器按逻辑宽度排版，`zoom` 缩到画布宽度；footer 不缩放。
 *
 * @param html - specToHtml 生成的文档。
 * @param canvasWidth - 输出 PNG 宽度。
 * @param scale - 内容缩放比（0.5–1）。
 */
function withLayout(html: string, canvasWidth: number, scale: number): string {
  const logicalWidth = Math.max(canvasWidth, Math.round(canvasWidth / scale))
  const footerStyle = `
  html,body{margin:0;padding:0;background:#fff}
  body{width:${String(canvasWidth)}px;overflow:visible}
  #genui-sheet{width:${String(logicalWidth)}px!important;${scale === 1 ? '' : `zoom:${String(scale)};`}}
  #genui-footer{display:flex;align-items:center;justify-content:space-between;box-sizing:border-box;
    width:${String(canvasWidth)}px;height:${String(FOOTER_HEIGHT)}px;padding:0 20px;border-top:1px solid #e5e7eb;
    background:#fff;color:#6b7280;font-size:10px;line-height:1;font-family:"Noto Sans CJK SC","Microsoft YaHei",sans-serif}
  `
  const injected = html.includes('</head>')
    ? html.replace('</head>', `<style>${footerStyle}</style>${MEASURE_SCRIPT}</head>`)
    : `${MEASURE_SCRIPT}${html}`
  const footer = `<div id="genui-footer"><span>万相 · DSH GenUI</span><span>${watermarkDate()}</span></div>`
  return injected.includes('</body>')
    ? injected.replace('</body>', `${footer}</body>`)
    : `${injected}${footer}`
}

async function runChrome(chrome: string, args: readonly string[], timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(chrome, [...args], {
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    return stdout
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new GenUiImageError('RENDER_TIMEOUT', 'GenUI 图片渲染超时。')
    }
    throw new GenUiImageError('RENDER_FAILED', `GenUI 图片渲染失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

/** 截图公共参数：容器里没有 DBus/GPU，全部禁用。 */
function baseArgs(width: number, height: number): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-extensions',
    '--disable-sync',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--default-background-color=FFFFFFFF',
    '--virtual-time-budget=1500',
    `--window-size=${String(width)},${String(height)}`,
  ]
}

interface Measured {
  readonly totalHeight: number
  readonly contentHeight: number
  readonly footerHeight: number
}

async function measure(
  chrome: string,
  htmlPath: string,
  chromeArgs: readonly string[],
): Promise<Measured> {
  const output = await runChrome(chrome, [...chromeArgs, '--dump-dom', `file://${htmlPath}`], 30_000)
  const match = /<title>H=(\d+);S=(\d+);F=(\d+)<\/title>/u.exec(output)
  if (match === null) throw new GenUiImageError('RENDER_FAILED', 'Chrome 未能返回页面高度。')
  return {
    totalHeight: Number(match[1]),
    contentHeight: Number(match[2]),
    footerHeight: Number(match[3]),
  }
}

interface LayoutCandidate {
  readonly canvasWidth: number
  readonly scale: number
  readonly htmlPath: string
  readonly measured: Measured
}

/**
 * 为一个画布宽度挑缩放比：目标总高 `maxHeight`，缩放只作用于内容区。
 * 先按 scale=1 量；超高时按比例缩，再量一次修正（宽度变化会改变换行）。
 */
async function layoutFor(
  chrome: string,
  directory: string,
  html: string,
  canvasWidth: number,
  maxHeight: number,
  timeoutMs: number,
): Promise<LayoutCandidate> {
  let scale = 1
  let measured: Measured | undefined
  let htmlPath = ''
  for (let attempt = 0; attempt < 3; attempt += 1) {
    htmlPath = join(directory, `card-${String(canvasWidth)}-${String(attempt)}.html`)
    writeFileSync(htmlPath, withLayout(html, canvasWidth, scale), 'utf8')
    measured = await measure(chrome, htmlPath, baseArgs(canvasWidth, 200))
    const available = maxHeight - measured.footerHeight
    if (available <= 0) throw new GenUiImageError('TOO_TALL', 'GenUI 卡片可用高度不足。')
    const needed = measured.contentHeight <= available ? 1 : available / measured.contentHeight
    const next = Math.max(MIN_READABLE_SCALE, Math.min(1, needed))
    if (Math.abs(next - scale) < 0.01) break
    scale = next
  }
  if (measured === undefined) throw new GenUiImageError('RENDER_FAILED', 'GenUI 卡片没有完成测量。')
  return { canvasWidth, scale, htmlPath, measured }
}

/** Playwright 可选加载：容器里通常有全局 playwright；没有则回退 Chrome CLI。 */
async function loadPlaywright(): Promise<{ chromium: { launch(options: Record<string, unknown>): Promise<unknown> } } | undefined> {
  const require = createRequire(import.meta.url)
  const candidates = [
    'playwright',
    '/usr/local/lib/node_modules/playwright',
    '/usr/lib/node_modules/playwright',
  ]
  for (const candidate of candidates) {
    try {
      // playwright 是 CJS；dynamic import 在容器里可能拿不到命名导出，必须 require。
      const module = require(candidate) as { chromium?: { launch(options: Record<string, unknown>): Promise<unknown> } }
      if (module.chromium !== undefined) return { chromium: module.chromium }
    } catch {
      // 继续尝试下一个位置。
    }
  }
  return undefined
}

interface PlaywrightPage {
  setViewportSize(size: { width: number; height: number }): Promise<void>
  setContent(html: string, options: { waitUntil: 'load' }): Promise<void>
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>
  screenshot(options: Record<string, unknown>): Promise<Buffer>
}

interface PlaywrightBrowser {
  newPage(options: Record<string, unknown>): Promise<PlaywrightPage>
  close(): Promise<void>
}

async function renderWithPlaywright(
  playwright: { chromium: { launch(options: Record<string, unknown>): Promise<unknown> } },
  chrome: string,
  html: string,
  baseWidth: number,
  maxHeight: number,
  maxBytes: number,
): Promise<Uint8Array[]> {
  const browser = await playwright.chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-background-networking'],
  }) as PlaywrightBrowser
  try {
    const page = await browser.newPage({ viewport: { width: baseWidth, height: 900 }, deviceScaleFactor: 1 })
    const measureAt = async (canvasWidth: number, scale: number): Promise<Measured> => {
      // 视口压到 200，scrollHeight 才反映内容真实高度而不是最小视口高度。
      await page.setViewportSize({ width: canvasWidth, height: 200 })
      await page.setContent(withLayout(html, canvasWidth, scale), { waitUntil: 'load' })
      await page.evaluate(async () => {
        if (document.fonts?.ready !== undefined) await document.fonts.ready
      })
      return page.evaluate(() => {
        const sheet = document.getElementById('genui-sheet')
        const footer = document.getElementById('genui-footer')
        return {
          totalHeight: Math.ceil(document.documentElement.scrollHeight),
          contentHeight: sheet === null ? 0 : Math.ceil(sheet.getBoundingClientRect().height),
          footerHeight: footer === null ? 0 : Math.ceil(footer.getBoundingClientRect().height),
        }
      })
    }
    const layoutForPlaywright = async (canvasWidth: number): Promise<{ canvasWidth: number; scale: number; measured: Measured }> => {
      let scale = 1
      let measured: Measured | undefined
      for (let attempt = 0; attempt < 3; attempt += 1) {
        measured = await measureAt(canvasWidth, scale)
        const available = maxHeight - measured.footerHeight
        if (available <= 0) throw new GenUiImageError('TOO_TALL', 'GenUI 卡片可用高度不足。')
        const needed = measured.contentHeight <= available ? 1 : available / measured.contentHeight
        const next = Math.max(MIN_READABLE_SCALE, Math.min(1, needed))
        if (Math.abs(next - scale) < 0.01) break
        scale = next
      }
      if (measured === undefined) throw new GenUiImageError('RENDER_FAILED', 'GenUI 卡片没有完成测量。')
      return { canvasWidth, scale, measured }
    }
    let chosen = await layoutForPlaywright(baseWidth)
    if (baseWidth === 720 && chosen.scale < 0.8) {
      const wide = await layoutForPlaywright(1080)
      if (wide.scale > chosen.scale + 0.05) chosen = wide
    }
    // 重新加载最终布局，确保截图与测量同一次排版。
    chosen = await layoutForPlaywright(chosen.canvasWidth)
    if (chosen.scale < MIN_READABLE_SCALE - 0.001) {
      throw new GenUiImageError('TOO_TALL', 'GenUI 卡片缩放后仍不可读，已转为文本。')
    }
    await page.setViewportSize({
      width: chosen.canvasWidth,
      height: Math.max(200, chosen.measured.totalHeight),
    })
    const buffer = await page.screenshot({ fullPage: true, type: 'png' })
    const bytes = new Uint8Array(buffer)
    if (bytes.byteLength === 0) throw new GenUiImageError('RENDER_FAILED', 'Playwright 输出的截图为空。')
    if (bytes.byteLength > maxBytes) {
      throw new GenUiImageError('IMAGE_TOO_LARGE', `GenUI 图片 ${String(bytes.byteLength)} 字节超过上限 ${String(maxBytes)} 字节。`)
    }
    return [bytes]
  } finally {
    await browser.close().catch(() => undefined)
  }
}

/**
 * 把 HTML 渲染为 PNG。
 *
 * 默认一张：内容过高时等比缩放内容区，footer 保持 22px 且不跟随缩放；
 * 只有缩放到底仍超过最大高度 2 倍时才拆图（极端长内容）。
 *
 * @param html - 完整 HTML 文档。
 * @param options - 宽度/最大高度/大小上限。
 * @returns 按顺序排列的 PNG 字节。
 */
export async function renderGenUiPng(html: string, options: PngRenderOptions = {}): Promise<Uint8Array[]> {
  const chrome = detectChrome()
  if (chrome === undefined) {
    throw new GenUiImageError('CHROME_UNAVAILABLE', '当前环境没有可用的 Chrome/Chromium，GenUI 图片渲染不可用。')
  }
  const baseWidth = options.width ?? DEFAULT_WIDTH
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT
  const playwright = await loadPlaywright()
  if (playwright !== undefined) {
    return renderWithPlaywright(playwright, chrome, html, baseWidth, maxHeight, maxBytes)
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-genui-'))
  try {
    const base = await layoutFor(chrome, directory, html, baseWidth, maxHeight, timeoutMs)
    let chosen = base
    // 720 需要明显缩放时，1080 画布能让字更大；只在能提升可读性时切换。
    if (baseWidth === 720 && base.scale < 0.8) {
      const wide = await layoutFor(chrome, directory, html, 1080, maxHeight, timeoutMs)
      if (wide.scale > base.scale + 0.05) chosen = wide
    }
    const final = await layoutFor(chrome, directory, html, chosen.canvasWidth, maxHeight, timeoutMs)
    if (final.scale < MIN_READABLE_SCALE - 0.001) {
      throw new GenUiImageError('TOO_TALL', 'GenUI 卡片缩放后仍不可读，已转为文本。')
    }
    const pngPath = join(directory, 'genui.png')
    const height = Math.max(200, final.measured.totalHeight)
    await runChrome(
      chrome,
      [...baseArgs(final.canvasWidth, height), `--screenshot=${pngPath}`, `file://${final.htmlPath}`],
      timeoutMs,
    )
    if (!existsSync(pngPath)) throw new GenUiImageError('RENDER_FAILED', 'Chrome 没有输出截图文件。')
    const bytes = new Uint8Array(readFileSync(pngPath))
    if (bytes.byteLength === 0) throw new GenUiImageError('RENDER_FAILED', 'Chrome 输出的截图为空。')
    if (bytes.byteLength > maxBytes) {
      throw new GenUiImageError('IMAGE_TOO_LARGE', `GenUI 图片 ${String(bytes.byteLength)} 字节超过上限 ${String(maxBytes)} 字节。`)
    }
    return [bytes]
  } finally {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // 临时目录清理失败不影响投递。
    }
  }
}
