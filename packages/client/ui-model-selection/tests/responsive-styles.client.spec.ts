import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const modelCss = readFileSync(fileURLToPath(new URL('../src/client/ModelSelect.module.css', import.meta.url)), 'utf8')
const inputCss = readFileSync(fileURLToPath(new URL('../../ui-conversation/src/client/skeleton/InputBar.module.css', import.meta.url)), 'utf8')

describe('responsive composer model trigger styles', () => {
  it('keeps the toolbar on one line and lets the trailing group shrink', () => {
    const row = inputCss.slice(inputCss.indexOf('.row {'), inputCss.indexOf('.tools,'))
    expect(row).toContain('flex-wrap: nowrap;')
    expect(inputCss).toContain('.trailing {\n  flex: 0 1 auto;')
  })

  it('drops effort before replacing the model label with an icon', () => {
    const compact = modelCss.slice(modelCss.indexOf('@container (max-width: 560px)'), modelCss.indexOf('@container (max-width: 420px)'))
    const iconOnly = modelCss.slice(modelCss.indexOf('@container (max-width: 420px)'), modelCss.indexOf('.menu {'))
    expect(compact).toContain('.triggerEffort')
    expect(compact).toContain('display: none;')
    expect(iconOnly).toContain('.triggerIcon')
    expect(iconOnly).toContain('display: inline-flex;')
    expect(iconOnly).toContain('.triggerLabel,')
  })

  it('constrains only the mobile menu while preserving the desktop content-sized menu', () => {
    const desktopMenu = modelCss.slice(modelCss.indexOf('.menu {'), modelCss.indexOf('.status,'))
    const mobileMenu = modelCss.slice(modelCss.indexOf('.portalMenu {'))
    expect(desktopMenu).toContain('width: max-content;')
    expect(desktopMenu).toContain('max-width: min(420px, calc(100vw - 32px));')
    expect(mobileMenu).toContain('box-sizing: border-box;')
    expect(mobileMenu).toContain('width: min(240px, calc(100vw - 24px));')
    expect(mobileMenu).toContain('max-height: min(300px, calc(100dvh - 80px));')
  })

  it('keeps the full model label available to ellipsis and hover surfaces', () => {
    const label = modelCss.slice(modelCss.indexOf('.triggerLabel {'), modelCss.indexOf('.triggerEffort {'))
    expect(label).toContain('text-overflow: ellipsis;')
    expect(label).toContain('white-space: nowrap;')
  })
})
