/**
 * Skill Center grid layout contract.
 *
 * The overlap bug was CSS-only: a `grid-auto-rows: 1fr` track plus a `height: 100%`
 * card compressed rows inside a height-limited page, so card content painted over
 * the next row. These assertions keep the row track content-sized and keep the
 * equal-height/bottom-aligned behaviour that a row of cards needs.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/client/SkillCenterPage.module.css', import.meta.url)), 'utf8')

/** Declarations of one exact selector. */
function declarations(selector: string): Map<string, string> | undefined {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, ' ')
  for (const [, selectorList = '', body = ''] of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectorList.split(',').map(value => value.trim()).includes(selector)) continue
    const found = new Map<string, string>()
    for (const part of body.split(';')) {
      const colon = part.indexOf(':')
      if (colon === -1) continue
      found.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim().replace(/\s+/g, ' '))
    }
    return found
  }
  return undefined
}

describe('SkillCenterPage grid layout', () => {
  it('lets rows grow to the tallest card instead of compressing them to a fraction', () => {
    const cards = declarations('.cards')
    expect(cards).toBeDefined()
    expect(cards?.get('grid-auto-rows')).toBeUndefined()
    expect(cards?.get('align-content')).toBe('start')
    expect(cards?.get('align-items')).toBe('stretch')
    expect(css).not.toMatch(/grid-auto-rows\s*:\s*(?:1fr|\d+px)/u)
  })

  it('does not pin a card to a percentage of a row that is still being sized', () => {
    const card = declarations('.card')
    expect(card?.get('height')).toBeUndefined()
    expect(card?.get('max-height')).toBeUndefined()
    expect(card?.get('display')).toBe('flex')
    expect(card?.get('flex-direction')).toBe('column')
  })

  it('keeps action rows bottom-aligned and equal-height within a grid row', () => {
    expect(declarations('.cardEnd')?.get('margin-top')).toBe('auto')
    expect(declarations('.card')?.get('min-height')).toBe('0')
    expect(declarations('.cards')?.get('align-items')).toBe('stretch')
  })
})

describe('SkillCenterPage tab and search measurements', () => {
  it('matches the automation task page pill', () => {
    const tab = declarations('.tab')
    expect(tab?.get('height')).toBe('28px')
    expect(tab?.get('padding')).toBe('0 10px')
    expect(tab?.get('border-radius')).toBe('14px')
    expect(tab?.get('color')).toBe('var(--dsw-alias-label-tertiary)')
    const active = declarations('.tabActive')
    expect(active?.get('background')).toBe('var(--dsw-alias-interactive-bg-hover)')
    expect(active?.get('color')).toBe('var(--dsw-alias-label-primary)')
    expect(declarations('.tab:focus-visible')?.get('outline')).toContain('2px solid')
  })

  it('matches the automation task page search box', () => {
    const search = declarations('.searchField')
    expect(search?.get('height')).toBe('36px')
    expect(search?.get('border')).toBe('0.5px solid var(--dsw-alias-border-l3)')
    expect(search?.get('border-radius')).toBe('12px')
    expect(declarations('.searchField:focus-within')?.get('border-color')).toBe('var(--dsw-alias-state-business-primary)')
    expect(declarations('.searchField input::placeholder')?.get('color')).toBe('var(--dsw-alias-label-caption)')
  })
})

describe('publish dialog frame', () => {
  it('caps the desktop dialog and gives the body the only scrollport', () => {
    const dialog = declarations('.publishDialog.publishDialog')
    expect(dialog?.get('width')).toBe('min(720px, calc(100vw - 32px))')
    expect(dialog?.get('max-height')).toBe('min(82vh, 760px)')
    const body = declarations('.dialogBody')
    expect(body?.get('flex')).toBe('1')
    expect(body?.get('min-height')).toBe('0')
    expect(body?.get('overflow-y')).toBe('auto')
    expect(declarations('.dialogHeader')?.get('flex')).toBe('none')
    expect(declarations('.dialogFooter')?.get('flex')).toBe('none')
  })

  it('inherits an explicit color scheme through the portal and styles native options', () => {
    expect(css).toMatch(/:global\(body\[data-ds-dark-theme\]\) \.dialog \{\s*color-scheme: dark;/u)
    expect(css).toMatch(/\.input option \{[^}]*background-color: var\(--dsw-alias-bg-layer-2\);[^}]*color: var\(--dsw-alias-label-primary\);/u)
    expect(css).toMatch(/\.input option:disabled \{[^}]*color: var\(--dsw-alias-label-caption\);/u)
    expect(declarations('.input:focus-visible')?.get('outline')).toContain('2px solid')
  })
})
