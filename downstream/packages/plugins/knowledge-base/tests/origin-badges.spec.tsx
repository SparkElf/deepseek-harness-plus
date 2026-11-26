/**
 * The provenance badges must be readable without a browser.
 *
 * The assertions below use `react-dom/server` on purpose: the badge is a pure
 * presentational mapping, so its visible text, tooltip and accessible name can be
 * checked without mounting a panel or mocking the primitives package. They also
 * pin the "purely presentational" contract — no field combination hides the row,
 * it only adds/removes chips.
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { OriginBadges, originBadgeItems } from '../src/client/graph/OriginBadges.tsx'

describe('originBadgeItems', () => {
  it('returns nothing when no provenance field is present', () => {
    expect(originBadgeItems({})).toEqual([])
    expect(originBadgeItems({ origin: 'human', reviewStatus: 'draft', authority: 'advisory' })).toEqual([])
  })

  it('maps AI origin, review status and redline authority to three items in reading order', () => {
    const items = originBadgeItems({ origin: 'ai', reviewStatus: 'approved', authority: 'redline' })
    expect(items.map(item => item.label)).toEqual(['AI 生成', '已审核', '红线'])
    expect(items.map(item => item.key)).toEqual(['origin', 'reviewStatus', 'authority'])
  })

  it('treats mixed origin as an AI badge with a mixed-content explanation', () => {
    const items = originBadgeItems({ origin: 'mixed' })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ key: 'origin', label: 'AI 生成' })
    expect(items[0]?.title).toContain('混合')
  })

  it('does not invent an authority badge for canonical or advisory', () => {
    expect(originBadgeItems({ authority: 'canonical' })).toEqual([])
    expect(originBadgeItems({ authority: 'advisory' })).toEqual([])
  })
})

describe('OriginBadges server render', () => {
  it('renders nothing for a legacy row with no provenance fields', () => {
    expect(renderToStaticMarkup(<OriginBadges />)).toBe('')
    expect(renderToStaticMarkup(<OriginBadges origin="human" reviewStatus="draft" authority="advisory" />)).toBe('')
  })

  it('renders the AI and reviewed chips with visible text, title and aria-label', () => {
    const html = renderToStaticMarkup(<OriginBadges origin="ai" reviewStatus="reviewed" />)
    expect(html).toContain('[AI 生成]')
    expect(html).toContain('[已审核]')
    expect(html).toContain('aria-label="AI 生成"')
    expect(html).toContain('aria-label="已审核"')
    expect(html).toContain('title="AI 生成内容；发布时必须保留来源标签"')
    expect(html).toContain('title="已审核"')
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="内容标签"')
    expect(html).toContain('data-badge="origin"')
    expect(html).toContain('data-badge="reviewStatus"')
  })

  it('renders the redline chip with its non-overridable explanation', () => {
    const html = renderToStaticMarkup(<OriginBadges authority="redline" />)
    expect(html).toContain('[红线]')
    expect(html).toContain('aria-label="红线"')
    expect(html).toContain('title="红线：只能订阅，不可内化或覆盖"')
    expect(html).toContain('data-badge="authority"')
  })

  it('renders an approved row with the approved tooltip', () => {
    const html = renderToStaticMarkup(<OriginBadges reviewStatus="approved" />)
    expect(html).toContain('[已审核]')
    expect(html).toContain('title="已审核并批准"')
  })

  it('keeps origin before review before authority in the markup', () => {
    const html = renderToStaticMarkup(<OriginBadges origin="ai" reviewStatus="reviewed" authority="redline" />)
    const ai = html.indexOf('[AI 生成]')
    const reviewed = html.indexOf('[已审核]')
    const redline = html.indexOf('[红线]')
    expect(ai).toBeGreaterThanOrEqual(0)
    expect(reviewed).toBeGreaterThan(ai)
    expect(redline).toBeGreaterThan(reviewed)
  })

  it('does not filter the row: a redline also renders its AI and review chips', () => {
    const html = renderToStaticMarkup(
      <OriginBadges origin="mixed" reviewStatus="approved" authority="redline" compact />,
    )
    expect(html).toContain('[AI 生成]')
    expect(html).toContain('[已审核]')
    expect(html).toContain('[红线]')
  })
})
