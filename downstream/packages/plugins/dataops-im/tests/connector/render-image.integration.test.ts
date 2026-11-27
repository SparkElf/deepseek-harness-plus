import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { specToHtml } from '../../src/connector/genui-html.ts'
import { detectChrome, renderGenUiPng } from '../../src/connector/render-image.ts'

const chrome = detectChrome()
const maybe = chrome === undefined ? describe.skip : describe

function pixelAt(png: PNG, x: number, y: number): { r: number; g: number; b: number } {
  const index = (png.width * y + x) * 4
  return { r: png.data[index]!, g: png.data[index + 1]!, b: png.data[index + 2]! }
}

maybe('renderGenUiPng (requires Chrome)', () => {
  it('渲染 720 宽 PNG，带中文与水印', async () => {
    const html = specToHtml({
      title: '经营概览',
      items: [
        { type: 'callout', tone: 'info', title: '结论', content: '整体运行正常，本周无重大风险。' },
        { type: 'table', columns: ['指标', '数值'], rows: [['任务数', '12'], ['成功率', '98%']] },
      ],
    })
    const pages = await renderGenUiPng(html, { width: 720 })
    expect(pages).toHaveLength(1)
    const png = PNG.sync.read(Buffer.from(pages[0]!))
    expect(png.width).toBe(720)
    expect(png.height).toBeGreaterThan(200)
    expect(png.height).toBeLessThanOrEqual(2_400)
  }, 30_000)

  it('本周概览 fixture：单张完整图，最后一条 bar/label 与 footer 都可见', async () => {
    const html = specToHtml({
      title: '本周经营概览',
      items: [
        { type: 'callout', tone: 'info', title: '结论', content: '整体运行正常，本周无重大风险。' },
        {
          type: 'table',
          columns: ['指标', '数值'],
          rows: [['任务数', '12'], ['成功率', '98%']],
        },
        {
          type: 'chart',
          kind: 'bars',
          data: [
            { label: '周一', value: 3 },
            { label: '周二', value: 8 },
            { label: '周三', value: 5 },
            { label: '周四', value: 7 },
            { label: '周五', value: 9, color: '#ff8800' },
          ],
        },
      ],
    })
    const pages = await renderGenUiPng(html, { width: 720 })
    expect(pages).toHaveLength(1)
    const png = PNG.sync.read(Buffer.from(pages[0]!))
    if (process.env.GENUI_FIXTURE_OUT !== undefined) writeFileSync(process.env.GENUI_FIXTURE_OUT, pages[0]!)
    expect(png.width).toBe(720)
    expect(png.height).toBeGreaterThan(400)

    let lastNonWhite = 0
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const pixel = pixelAt(png, x, y)
        if (pixel.r < 250 || pixel.g < 250 || pixel.b < 250) lastNonWhite = y
      }
    }
    // footer 正常文档流：图片底部 8px 内还有 footer 像素，不留大块空白。
    expect(png.height - lastNonWhite).toBeLessThanOrEqual(8)

    let maxOrangeY = -1
    let orangeLabelDarkPixels = 0
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const pixel = pixelAt(png, x, y)
        if (pixel.r > 220 && pixel.g > 80 && pixel.g < 190 && pixel.b < 90) {
          maxOrangeY = Math.max(maxOrangeY, y)
          if (x < 220) orangeLabelDarkPixels += 1
        }
      }
    }
    // 最后一条橙色 bar 在 footer 之上完整可见，左侧 label 同行有深色像素。
    expect(maxOrangeY).toBeGreaterThan(0)
    expect(maxOrangeY).toBeLessThan(png.height - 22)
    expect(orangeLabelDarkPixels).toBeGreaterThan(20)
  }, 45_000)

  it('超长内容默认仍输出一张，缩放后高度不超过目标', async () => {
    const items = Array.from({ length: 18 }, (_value, index) => ({
      type: 'callout' as const,
      title: `第 ${String(index + 1)} 项`,
      content: '这是一段用于撑高卡片的中文内容。'.repeat(3),
    }))
    const pages = await renderGenUiPng(specToHtml({ title: '长卡片', items }), { width: 720 })
    expect(pages).toHaveLength(1)
    const png = PNG.sync.read(Buffer.from(pages[0]!))
    // 内容过高时允许切到 1080 画布，仍必须是一张、完整、可读。
    expect([720, 1080]).toContain(png.width)
    expect(png.height).toBeLessThanOrEqual(2_400)
  }, 60_000)
})
