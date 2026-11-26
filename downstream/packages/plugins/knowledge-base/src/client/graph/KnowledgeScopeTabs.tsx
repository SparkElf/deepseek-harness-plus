/**
 * The two scope pills that replace the tree band's plain title.
 *
 * They switch the navigation tree's DATA SOURCE (knowledge folders or graph
 * scopes), not the list/grid presentation; that is why they sit where the band's
 * name used to be rather than in the view-mode control.
 *
 * The selected pill takes `bg-layer-2` and `label-primary`; the unselected one
 * keeps the band's `label-tertiary`. Metrics are the brief's: a 26px control, 13px
 * type, 6px radius.
 *
 * @module @sparkelf/dsh-knowledge-base/client/graph/KnowledgeScopeTabs
 */

import styles from './KnowledgeScopeTabs.module.css'

/** The two scopes the panels can show. */
export type KnowledgePanelScope = 'kb' | 'graph'

/** Props for the scope pills. */
export interface KnowledgeScopeTabsProps {
  /** Which scope is current. */
  value: KnowledgePanelScope
  /** Called with the newly chosen scope. */
  onChange: (scope: KnowledgePanelScope) => void
  /** Accessible name for the group. */
  label: string
  /** Copy for the knowledge-base pill. */
  knowledgeLabel: string
  /** Copy for the graph pill. */
  graphLabel: string
}

/**
 * Render the scope tablist.
 *
 * @param props - the current scope, its setter, and both labels.
 * @returns The two pills.
 */
export function KnowledgeScopeTabs(props: KnowledgeScopeTabsProps) {
  return (
    <div className={styles.tabs} role="tablist" aria-label={props.label}>
      <button
        type="button"
        role="tab"
        aria-selected={props.value === 'kb'}
        className={styles.tab + (props.value === 'kb' ? ' ' + styles.tabSelected : '')}
        onClick={() => { props.onChange('kb') }}
      >
        {props.knowledgeLabel}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={props.value === 'graph'}
        className={styles.tab + (props.value === 'graph' ? ' ' + styles.tabSelected : '')}
        onClick={() => { props.onChange('graph') }}
      >
        {props.graphLabel}
      </button>
    </div>
  )
}
