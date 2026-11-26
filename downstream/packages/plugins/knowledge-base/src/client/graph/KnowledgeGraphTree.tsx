/**
 * The graph tab's rail tree, rendered as the same file tree the Knowledge base
 * tab shows.
 *
 * The reader asked for the knowledge tree's four-level shape: three top-level
 * folders (全局/部门/个人), the caller's department chain, the graph as a file row,
 * then its topics. Row metrics and the folder/chevron affordances are borrowed from
 * `KnowledgeListing.module.css` (`.entry`, `.entryDir`, `.entryGlyph`,
 * `.entryName`, `.entryTime`) rather than restated here, so both tabs keep the
 * explorer's 28px row, 12px type, 22px indent step and hover fill.
 *
 * The Host has already dropped every graph DataOps did not resolve; this component
 * only filters names for the in-place search. It never decides who may see a graph.
 *
 * @module @sparkelf/dsh-knowledge-base/client/graph/KnowledgeGraphTree
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconChevronDownOutlineRegular,
  IconChevronRightOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  knowledgeGraphMatches,
  type KnowledgeGraphNode,
  type KnowledgeGraphScopeKey,
} from '../../graphTypes.ts'
import { OriginBadges } from './OriginBadges.tsx'
import type { KnowledgeGraphLoadState } from './useKnowledgeGraph.ts'
import { builtinFileIcon, builtinFolderIcon } from 'dsh-better-sidebar/src/client/file-icons.tsx'
import styles from './KnowledgeGraphTree.module.css'

/** Props for the rail tree. */
export interface KnowledgeGraphTreeProps {
  /** Load state from {@link useKnowledgeGraph}. */
  state: KnowledgeGraphLoadState
  /** Copy resolver for state lines and the group labels. */
  t: (key: string) => string
  /** The graph whose topics are expanded, when one is selected. */
  activeGraphId?: string
  /** The topic highlighted as current, when one is selected. */
  activeTopicId?: string
  /** The in-place filter term from the band's search control. */
  filter: string
  /** Select a graph: the canvas switches to it. */
  onSelectGraph: (graphId: string) => void
  /** Select a topic: the canvas focuses it and opens its detail panel. */
  onSelectTopic: (graphId: string, topicId: string) => void
  /** Retry a failed read. */
  onRetry: () => void
}

/** One level of the caller's department chain. */
interface DepartmentNode {
  /** Cumulative code path, used as the expansion key. */
  id: string
  /** Display name for this level. */
  label: string
  /** Nested levels below this one. */
  children: DepartmentNode[]
  /** Graphs attached at this exact level. */
  graphs: KnowledgeGraphNode[]
}

/** A scope's row label. */
const SCOPE_COPY: ReadonlyArray<{ key: KnowledgeGraphScopeKey; copy: string }> = [
  { key: 'global', copy: 'bucketGlobal' },
  { key: 'department', copy: 'bucketDepartment' },
  { key: 'personal', copy: 'bucketPersonal' },
]

/** A graph-shaped file glyph, drawn inline because primitives has no network icon. */
function GraphFileGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="2" />
      <circle cx="5.6" cy="6" r="1.15" />
      <circle cx="10.6" cy="6" r="1.15" />
      <circle cx="8" cy="10.6" r="1.15" />
      <path d="M6.55 6h2.9M5.9 7.05l1.35 2.45M10.3 7.05l-1.35 2.45" />
    </svg>
  )
}

/** The chevron shown before an expandable row. */
function ExpandGlyph(props: { open: boolean }) {
  return props.open
    ? <IconChevronDownOutlineRegular size={12} />
    : <IconChevronRightOutline14 size={12} />
}

/**
 * Build the department forest from the flat group list.
 *
 * `group.key` is the code chain (`a/b/c`); `group.label` is the display chain
 * (`A / B / C`). Splitting both here is what makes a multi-level department
 * readable as nested folders without asking the Host for a second tree.
 */
function departmentForest(groups: ReadonlyArray<{ key: string; label: string; graphs: KnowledgeGraphNode[] }>): {
  roots: DepartmentNode[]
  loose: KnowledgeGraphNode[]
} {
  const roots: DepartmentNode[] = []
  const loose: KnowledgeGraphNode[] = []
  for (const group of groups) {
    const codes = group.key === '' ? [] : group.key.split('/').filter(code => code !== '')
    const labels = group.label === '' ? codes : group.label.split(' / ')
    if (codes.length === 0) {
      loose.push(...group.graphs)
      continue
    }
    let level = roots
    let path = ''
    codes.forEach((code, index) => {
      path = path === '' ? code : path + '/' + code
      let node = level.find(candidate => candidate.id === path)
      if (node === undefined) {
        node = { id: path, label: labels[index] ?? code, children: [], graphs: [] }
        level.push(node)
      }
      if (index === codes.length - 1) node.graphs.push(...group.graphs)
      level = node.children
    })
  }
  return { roots, loose }
}

/** One row, built from the host explorer's own `.explorerRow` classes. */
function TreeRow(props: {
  depth: number
  label: string
  testId: string
  attrs?: Record<string, string>
  dir?: boolean
  expandable?: boolean
  open?: boolean
  active?: boolean
  trailing?: string
  /** Provenance chips shown after the name, before the trailing count. */
  badges?: ReactNode
  glyph: ReactNode
  onClick: () => void
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      className={styles.explorerRow
        + (props.dir === true ? ' ' + styles.explorerDir : '')
        + (props.active === true ? ' ' + styles.explorerRowSelected : '')}
      style={{ paddingLeft: props.depth * 16 + 6 }}
      data-testid={props.testId}
      {...props.attrs}
      {...(props.active === true ? { 'data-dsh-selected': 'true', 'aria-pressed': true } : {})}
      {...(props.expandable === true ? { 'aria-expanded': props.open === true } : {})}
      title={props.label}
      onClick={props.onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          props.onClick()
        }
      }}
    >
      {props.expandable === true
        ? <span className={styles.chevron} aria-hidden="true"><ExpandGlyph open={props.open === true} /></span>
        : <span className={styles.chevronPlaceholder} aria-hidden="true" />}
      {props.glyph}
      <span className={styles.explorerName}>{props.label}</span>
      {props.badges === undefined ? null : <span className={styles.rowBadges}>{props.badges}</span>}
      {props.trailing === undefined ? null : <span className={styles.explorerTime}>{props.trailing}</span>}
    </div>
  )
}

/**
 * Render the graph tree.
 *
 * @param props - load state, selection, filter, and the two selectors.
 * @returns The tree, or the loading/failed/empty state.
 */
export function KnowledgeGraphTree(props: KnowledgeGraphTreeProps) {
  const needle = props.filter.trim().toLowerCase()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const scopeViews = useMemo(() => props.state.tree.scopes.map(scope => ({
    ...scope,
    groups: scope.groups
      .map(group => ({
        ...group,
        graphs: group.graphs.filter(graph => knowledgeGraphMatches(graph, needle)),
      }))
      .filter(group => group.graphs.length > 0),
  })), [props.state.tree, needle])

  // When the reader is searching, hide a scope that has no match; otherwise all
  // three folders stay visible even when a bucket has no graph yet.
  const visibleScopes = useMemo(
    () => scopeViews.filter(scope => needle === '' || scope.groups.length > 0),
    [scopeViews, needle],
  )
  const allGraphs = useMemo(
    () => scopeViews.flatMap(scope => scope.groups.flatMap(group => group.graphs)),
    [scopeViews],
  )

  // Selecting a graph opens its scope, its department chain and its own topics.
  // Collapsing a scope afterwards is a deliberate reader action and is not undone
  // until the selection changes.
  const initialSelection = useRef(true)
  useEffect(() => {
    // The canvas selects its first graph on load; the tree must NOT unfold itself
    // for that implicit selection. Only a later graph choice opens the path.
    if (props.activeGraphId === undefined) return
    if (initialSelection.current) { initialSelection.current = false; return }
    const graph = allGraphs.find(candidate => candidate.id === props.activeGraphId)
    if (graph === undefined) return
    setExpanded((previous) => {
      const next = new Set(previous)
      next.add('scope:' + graph.scope)
      next.add('graph:' + graph.id)
      if (graph.scope === 'department') {
        const group = visibleScopes
          .find(scope => scope.key === 'department')?.groups
          .find(candidate => candidate.graphs.some(node => node.id === graph.id))
        if (group !== undefined) {
          let path = ''
          for (const code of group.key.split('/').filter(value => value !== '')) {
            path = path === '' ? code : path + '/' + code
            next.add('dept:' + path)
          }
        }
      }
      return next
    })
  }, [props.activeGraphId, allGraphs, visibleScopes])

  const isOpen = (key: string): boolean => needle !== '' || expanded.has(key)
  const toggle = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const graphRow = (graph: KnowledgeGraphNode, depth: number, keyPrefix = ''): ReactNode => {
    const open = isOpen('graph:' + graph.id)
    const active = graph.id === props.activeGraphId
    // The computed overview is a read-only synthesis of the other graphs: its rows
    // are already namespaced copies, so the rail keeps it one clickable row instead
    // of expanding a second tree of nodes that belong to real graphs.
    const computed = graph.computed === true
    const expandable = !computed && graph.topics.length > 0
    return (
      <div key={keyPrefix + graph.id}>
        <TreeRow
          depth={depth}
          label={graph.name}
          testId="kg-graph"
          attrs={{ 'data-graph-id': graph.id }}
          expandable={expandable}
          open={open}
          active={active}
          trailing={graph.counts.topics + ' · ' + graph.counts.links}
          badges={(
            <>
              {computed && (
                <span className={styles.computedBadges} data-testid="kg-computed-badges">
                  <span className={styles.computedBadge} title="由调用者可读的图谱实时聚合，没有 graph.json">[计算]</span>
                  <span className={styles.readOnlyBadge} title="只读：新增或修改请到源图谱">[只读]</span>
                </span>
              )}
              <OriginBadges compact origin={graph.origin} reviewStatus={graph.reviewStatus} authority={graph.authority} />
            </>
          )}
          glyph={<GraphFileGlyph />}
          onClick={() => {
            if (active && expandable && open) {
              toggle('graph:' + graph.id)
              return
            }
            if (!active) props.onSelectGraph(graph.id)
            if (expandable && !open) toggle('graph:' + graph.id)
          }}
        />
        {open && expandable && (
          <div>
            {graph.topics.map(topic => (
              <TreeRow
                key={topic.id}
                depth={depth + 1}
                label={topic.title}
                testId="kg-topic"
                attrs={{ 'data-topic-id': topic.id }}
                active={topic.id === props.activeTopicId}
                badges={<OriginBadges compact origin={topic.origin} reviewStatus={topic.reviewStatus} authority={topic.authority} />}
                glyph={builtinFileIcon('index.md', 14)}
                onClick={() => { props.onSelectTopic(graph.id, topic.id) }}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const departmentRow = (node: DepartmentNode, depth: number): ReactNode => {
    const key = 'dept:' + node.id
    const open = isOpen(key)
    return (
      <div key={node.id}>
        <TreeRow
          depth={depth}
          label={node.label}
          testId="kg-dept"
          attrs={{ 'data-dept-id': node.id }}
          dir
          expandable
          open={open}
          glyph={builtinFolderIcon(false, 14)}
          onClick={() => { toggle(key) }}
        />
        {open && (
          <div>
            {node.children.map(child => departmentRow(child, depth + 1))}
            {node.graphs.map(graph => graphRow(graph, depth + 1))}
          </div>
        )}
      </div>
    )
  }

  if (props.state.kind === 'loading' && props.state.tree.visible === 0) {
    return <p className={styles.state} data-testid="kg-tree-loading">{props.t('graphLoading')}</p>
  }
  if (props.state.kind === 'failed') {
    return (
      <div className={styles.state} data-testid="kg-tree-failed">
        <p className={styles.error}>{props.t('graphFailed')}</p>
        <p className={styles.detail}>{props.state.error}</p>
        <button type="button" className={styles.retry} onClick={props.onRetry}>
          {props.t('graphRetry')}
        </button>
      </div>
    )
  }
  if (allGraphs.length === 0) {
    return (
      <div className={styles.state} data-testid="kg-tree-empty">
        <p className={styles.emptyTitle}>{needle === '' ? props.t('graphEmptyTitle') : props.t('filterNoMatch')}</p>
        {needle === '' && <p className={styles.detail}>{props.t('graphEmptyBody')}</p>}
        {needle === '' && props.state.tree.denied > 0 && <p className={styles.detail}>{props.t('graphNoAccess')}</p>}
      </div>
    )
  }

  return (
    <div className={styles.tree} data-testid="kg-tree">
      {SCOPE_COPY.map((scopeCopy) => {
        const scope = visibleScopes.find(candidate => candidate.key === scopeCopy.key)
        if (scope === undefined) return null
        const graphs = scope.groups.flatMap(group => group.graphs)
        const key = 'scope:' + scopeCopy.key
        const open = isOpen(key)
        const forest = scopeCopy.key === 'department'
          ? departmentForest(scope.groups)
          : { roots: [], loose: graphs }
        return (
          <section key={scopeCopy.key} className={styles.scope} data-testid="kg-scope" data-scope={scopeCopy.key}>
            <TreeRow
              depth={0}
              label={props.t(scopeCopy.copy)}
              testId="kg-scope-row"
              dir
              expandable
              open={open}
              glyph={builtinFolderIcon(false, 14)}
              onClick={() => { toggle(key) }}
            />
            {open && (
              <div>
                {scopeCopy.key === 'department'
                  ? (
                    <>
                      {forest.loose.map(graph => graphRow(graph, 1))}
                      {forest.roots.map(node => departmentRow(node, 1))}
                    </>
                    )
                  : graphs.map(graph => graphRow(graph, 1))}
                {graphs.length === 0 && (
                  <p className={styles.emptyRow} style={{ paddingLeft: 22 + 6 + 16 }}>（空）</p>
                )}
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
