/**
 * The provenance and authority badges a graph row, topic row or document row
 * shows: `[AI 生成]`, `[已审核]` and `[红线]`.
 *
 * The component is purely presentational. It never filters a row out and never
 * decides whether the caller may act on it — the Host has already resolved graph
 * visibility and the write policy; hiding a badge in the browser would not be a
 * permission check, only a lie about what the data is.
 *
 * Fields are optional so the existing scanner and older graphs keep rendering
 * exactly as before: an absent `origin` / `reviewStatus` / `authority` produces no
 * badge rather than a placeholder.
 *
 * @module @sparkelf/dsh-knowledge-base/client/graph/OriginBadges
 */

import type {
  KnowledgeGraphAuthority,
  KnowledgeGraphOrigin,
  KnowledgeGraphReviewStatus,
} from '../../graphTypes.ts'
import styles from './OriginBadges.module.css'

/** Props for {@link OriginBadges}. */
export interface OriginBadgesProps {
  /** How the content was produced; `ai` and `mixed` render `[AI 生成]`. */
  origin?: KnowledgeGraphOrigin
  /** Review lifecycle; `reviewed` and `approved` render `[已审核]`. */
  reviewStatus?: KnowledgeGraphReviewStatus
  /** Authority level; `redline` renders `[红线]`. */
  authority?: KnowledgeGraphAuthority
  /** Tighter metrics for a 28px tree row. */
  compact?: boolean
  /** Extra class from the row that hosts the badges. */
  className?: string
}

/** One badge before it becomes markup. */
export interface OriginBadgeItem {
  /** Which field produced the badge; unique within one set. */
  key: 'origin' | 'reviewStatus' | 'authority'
  /** Visible text without the bracket decoration. */
  label: string
  /** Answer shown by the native tooltip and used as the accessible name. */
  title: string
}

/**
 * Resolve the badge list for one set of optional fields.
 *
 * Exported so a host surface can test "does this row have anything to show?"
 * without rendering, and so the rules stay testable without a DOM.
 *
 * @param props - the optional provenance fields.
 * @returns Badges in reading order: origin, review, authority.
 */
export function originBadgeItems(props: Pick<OriginBadgesProps, 'origin' | 'reviewStatus' | 'authority'>): OriginBadgeItem[] {
  const items: OriginBadgeItem[] = []
  if (props.origin === 'ai') {
    items.push({ key: 'origin', label: 'AI 生成', title: 'AI 生成内容；发布时必须保留来源标签' })
  } else if (props.origin === 'mixed') {
    items.push({ key: 'origin', label: 'AI 生成', title: '人工与 AI 混合生成的内容' })
  }
  if (props.reviewStatus === 'reviewed') {
    items.push({ key: 'reviewStatus', label: '已审核', title: '已审核' })
  } else if (props.reviewStatus === 'approved') {
    items.push({ key: 'reviewStatus', label: '已审核', title: '已审核并批准' })
  }
  if (props.authority === 'redline') {
    items.push({ key: 'authority', label: '红线', title: '红线：只能订阅，不可内化或覆盖' })
  }
  return items
}

/**
 * Render the badges for one row, or nothing when the row has no provenance.
 *
 * @param props - optional origin/review/authority fields.
 * @returns A small inline group of badges, or `null`.
 */
export function OriginBadges(props: OriginBadgesProps) {
  const items = originBadgeItems(props)
  if (items.length === 0) return null
  const className = [styles.badges, props.compact === true ? styles.compact : '', props.className]
    .filter((name): name is string => typeof name === 'string' && name !== '')
    .join(' ')
  return (
    <span
      className={className}
      role="group"
      aria-label="内容标签"
    >
      {items.map(item => (
        <span
          key={item.key}
          className={[styles.badge, styles[item.key]]
            .filter((name): name is string => typeof name === 'string' && name !== '')
            .join(' ')}
          data-badge={item.key}
          title={item.title}
          aria-label={item.label}
        >
          [{item.label}]
        </span>
      ))}
    </span>
  )
}
