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
