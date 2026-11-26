/**
 * The graph tab's canvas surface.
 *
 * The first version embeds the proven prototype canvas as a same-origin page. The
 * page owns layout, pan/zoom and the topic detail panel; this component owns the
 * permission-filtered data and the small message protocol:
 *
 * - host → page: `kg:set-graphs`, `kg:select-graph`, `kg:select-topic`
 * - page → host: `kg:ready` (the panel then (re)sends the payload), `kg:selection`
 *   (acknowledgement only; the rail keeps its own selection state)
 *
 * Splitting the data from the rendering is what makes the later native component
 * a replacement of one file rather than a rewrite of the tab.
 *
 * @module @sparkelf/dsh-knowledge-base/client/graph/KnowledgeGraphView
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { KB_API, kbApiPath } from '../../api.ts'
import { knowledgeGraphsOf, type KnowledgeGraphNode } from '../../graphTypes.ts'
import type { KnowledgeGraphLoadState } from './useKnowledgeGraph.ts'
import { OriginBadges, originBadgeItems } from './OriginBadges.tsx'
import styles from './KnowledgeGraphView.module.css'

/** Props for the canvas surface. */
export interface KnowledgeGraphViewProps {
  /** Load state from {@link useKnowledgeGraph}. */
  state: KnowledgeGraphLoadState
  /** Copy resolver for the loading, failed and empty states. */
  t: (key: string) => string
  /** The graph the tree selected; the first graph when undefined. */
  activeGraphId?: string
  /** The topic the tree selected; focusing it opens the page's detail panel. */
  activeTopicId?: string
  /** Retry a failed read. */
  onRetry: () => void
  /** Open one document (view-relative path) in the right sidebar. */
  onOpenDocument?: (path: string) => void
  /**
   * Navigate from an aggregated 总图 node to its source graph and node.
   *
   * The overview is a computed view; editing or inspecting a copy would hide which
   * real graph owns the data, so a card click leaves the overview instead.
   */
  onOpenSourceGraph?: (graphId: string, topicId: string) => void
}

/** The three overview filter dimensions; `all` keeps every value. */
interface OverviewFilters {
  scope: string
  type: string
  authority: string
}

const ALL_FILTERS: OverviewFilters = { scope: 'all', type: 'all', authority: 'all' }

/** Display names for the three scopes the overview can span. */
const SCOPE_FILTER_LABELS: Record<string, string> = {
  global: '全局',
  department: '部门',
  personal: '个人',
}

/** One message the canvas page accepts. */
interface CanvasMessage {
  type: 'kg:set-graphs' | 'kg:select-graph' | 'kg:select-topic' | 'kg:theme'
  graphs?: KnowledgeGraphNode[]
  activeGraphId?: string | null
  selectedTopicId?: string | null
  graphId?: string
  topicId?: string
  /** Host alias-token values, for `kg:theme`. */
  tokens?: Record<string, string>
  /** Whether the host is in its dark color scheme, for `kg:theme`. */
  dark?: boolean
}

/**
 * The host tokens the embedded page consumes.
 *
 * A dedicated list rather than a blanket copy of every custom property: the page
 * owns its own layout variables, and only the alias colors are the host's to
 * decide. Missing values are omitted, so the page keeps its first-paint fallback
 * instead of receiving an empty string that would clear a CSS rule.
 */
const THEME_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-link',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-primary',
  '--dsw-elevation-panel',
] as const

/**
 * Render the canvas, or the state that explains why there is none.
 *
 * @param props - the permission-filtered tree and the current selection.
 * @returns The canvas surface.
 */
export function KnowledgeGraphView(props: KnowledgeGraphViewProps) {
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const [frameReady, setFrameReady] = useState(false)
  const sentDataRef = useRef(false)
  const loadedGraphRef = useRef<string | undefined>(undefined)
  const loadedTopicRef = useRef<string | undefined>(undefined)
  const graphs = useMemo(() => knowledgeGraphsOf(props.state.tree), [props.state.tree])
  const [filters, setFilters] = useState<OverviewFilters>(ALL_FILTERS)
  const hasOverview = useMemo(() => graphs.some(graph => graph.computed === true), [graphs])
  /**
   * The overview payload narrowed by the three filters.
   *
   * Filtering happens in the browser on an already permission-filtered payload;
   * it can only hide rows the Host returned, never reveal another graph. Links
   * survive only when both endpoints survive, so a filter cannot leave a dangling
   * arrow pointing at a hidden card.
   */
  const visibleGraphs = useMemo(() => {
    if (!hasOverview) return graphs
    return graphs.map(graph => {
      if (graph.computed !== true) return graph
      const topics = graph.topics.filter(topic => (
        (filters.scope === 'all' || topic.scope === filters.scope)
        && (filters.type === 'all' || (topic.domain ?? '') === filters.type)
        && (filters.authority === 'all' || (topic.authority ?? '') === filters.authority)
      ))
      const ids = new Set(topics.map(topic => topic.id))
      const links = graph.links.filter(link => ids.has(link.a) && ids.has(link.b))
      return {
        ...graph,
        topics,
        links,
        counts: { ...graph.counts, topics: topics.length, links: links.length, documents: topics.length },
      }
    })
  }, [graphs, hasOverview, filters])
  const activeGraph = visibleGraphs.find(graph => graph.id === props.activeGraphId) ?? visibleGraphs[0]
  // Filter options come from the ACTIVE overview's unfiltered rows, so choosing a
  // value never removes the other choices from the same select.
  const activeOverviewSource = graphs.find(graph => graph.id === activeGraph?.id)
  const overviewTopics = activeGraph?.computed === true ? (activeOverviewSource?.topics ?? []) : []
  const filterOptions = useMemo(() => ({
    scopes: [...new Set(overviewTopics.map(topic => topic.scope).filter((value): value is NonNullable<typeof value> => value !== undefined))],
    types: [...new Set(overviewTopics.map(topic => topic.domain).filter((value): value is string => typeof value === 'string' && value !== ''))],
    authorities: [...new Set(overviewTopics.map(topic => topic.authority).filter((value): value is NonNullable<typeof value> => value !== undefined))],
  }), [overviewTopics])
  const activeTopic = activeGraph?.topics.find(topic => topic.id === props.activeTopicId)
  const graphBadges = activeGraph === undefined ? [] : originBadgeItems(activeGraph)
  const topicBadges = activeTopic === undefined ? [] : originBadgeItems(activeTopic)
  // The bar speaks for the subject currently on screen: the selected topic when it
  // carries provenance, otherwise the graph itself. The tree already keeps the
  // other level's chips visible, so the canvas does not need a second stack.
  const topicHasBadges = activeTopic !== undefined && topicBadges.length > 0
  const badgeSubject = topicHasBadges ? activeTopic : activeGraph
  const badgeLabel = topicHasBadges && activeTopic !== undefined ? activeTopic.title : activeGraph?.name
  // Resolve against the ORIGIN the browser is actually on, not the document's
  // <base> (a gateway may inject one pointing at a container-internal host:port).
  // A relative URL alone is not enough when a base element is present.
  const canvasUrl = useMemo(() => {
    const path = kbApiPath(KB_API.graphCanvas)
    if (typeof window === 'undefined') return path
    try { return new URL(path, window.location.origin).href } catch { return path }
  }, [])

  /** Post one message into the embedded page. */
  const post = useCallback((message: CanvasMessage): void => {
    const frame = frameRef.current
    if (frame === null || frame.contentWindow === null) return
    frame.contentWindow.postMessage(message, '*')
  }, [])

  /**
   * Send the host's live color tokens into the embedded page.
   *
   * The iframe is a separate document, so `var(--dsw-*)` cannot cross the boundary
   * by inheritance. Reading the computed values from this document and posting them
   * is what keeps the canvas on the same light/dark palette as the panel instead of
   * carrying the prototype's fixed one.
   */
  const sendTheme = useCallback((): void => {
    const style = getComputedStyle(document.body)
    const tokens: Record<string, string> = {}
    for (const name of THEME_TOKENS) {
      const value = style.getPropertyValue(name).trim()
      if (value !== '') tokens[name] = value
    }
    post({ type: 'kg:theme', tokens, dark: document.body.hasAttribute('data-ds-dark-theme') })
  }, [post])

  /** Send the whole payload, which makes the page rebuild its canvas. */
  const sendAll = useCallback((): void => {
    post({
      type: 'kg:set-graphs',
      graphs: visibleGraphs,
      activeGraphId: activeGraph?.id ?? null,
      selectedTopicId: props.activeTopicId ?? null,
    })
    loadedGraphRef.current = activeGraph?.id
    loadedTopicRef.current = props.activeTopicId
    sentDataRef.current = true
  }, [post, visibleGraphs, activeGraph, props.activeTopicId])
  // Effects that send the initial payload run on structural changes (load, tree
  // reload), not on every selection, so they read the latest closure through a ref
  // instead of re-firing when the active topic changes.
  const sendAllRef = useRef(sendAll)
  useEffect(() => { sendAllRef.current = sendAll }, [sendAll])

  // A new document starts empty. `load` is the earliest point at which its message
  // listener exists; the data effect below sends the payload from here, and the
  // page's own `kg:ready` covers a document restored from the origin cache.
  const onFrameLoad = useCallback((): void => {
    sentDataRef.current = false
    setFrameReady(true)
  }, [])

  // Follow the host's scheme for the life of the frame: the panel toggles
  // `data-ds-dark-theme` on the body and may apply theme token overrides inline.
  useEffect(() => {
    if (!frameReady) return
    sendTheme()
    let frame = 0
    const schedule = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(sendTheme)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'class', 'style'] })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [frameReady, sendTheme])

  // A reloaded tree is a new payload; the frame stays mounted.
  useEffect(() => {
    sentDataRef.current = false
  }, [props.state.tree])

  useEffect(() => {
    if (!frameReady || props.state.kind !== 'ready') return
    if (visibleGraphs.length === 0 || sentDataRef.current) return
    sendAllRef.current()
  }, [frameReady, props.state.kind, props.state.tree, visibleGraphs.length])

  // A filter change is a new payload, not a selection: rebuild the canvas so the
  // hidden cards and their dangling arrows disappear together.
  const filterKey = filters.scope + '|' + filters.type + '|' + filters.authority
  useEffect(() => {
    if (!frameReady || props.state.kind !== 'ready' || !sentDataRef.current) return
    sendAllRef.current()
  }, [filterKey, frameReady, props.state.kind])

  // A graph switch is one message, not a whole payload: reloading the graph would
  // rebuild every card and close a detail panel the reader may still be reading.
  useEffect(() => {
    if (!frameReady || activeGraph === undefined) return
    if (loadedGraphRef.current === activeGraph.id) return
    post({ type: 'kg:select-graph', graphId: activeGraph.id })
    loadedGraphRef.current = activeGraph.id
    loadedTopicRef.current = undefined
  }, [activeGraph, frameReady, post])

  // A topic selected in the rail focuses the same card in the canvas. The payload
  // already carries the initial topic, so this only sends a later change -- a
  // duplicate would toggle the page's own detail panel closed.
  useEffect(() => {
    if (!frameReady || props.activeTopicId === undefined) return
    if (loadedTopicRef.current === props.activeTopicId) return
    post({ type: 'kg:select-topic', topicId: props.activeTopicId })
    loadedTopicRef.current = props.activeTopicId
  }, [props.activeTopicId, frameReady, post])

  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as { type?: unknown } | null
      if (message === null || typeof message !== 'object') return
      if (message.type === 'kg:ready') {
        sendTheme()
        if (!sentDataRef.current && visibleGraphs.length > 0) sendAllRef.current()
      }
      if (message.type === 'kg:open-document') {
        const path = (message as { path?: unknown }).path
        if (typeof path === 'string' && path !== '') props.onOpenDocument?.(path)
      }
      if (message.type === 'kg:open-source') {
        const graphId = (message as { graphId?: unknown }).graphId
        const topicId = (message as { topicId?: unknown }).topicId
        if (typeof graphId === 'string' && graphId !== '') {
          props.onOpenSourceGraph?.(graphId, typeof topicId === 'string' ? topicId : '')
        }
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [visibleGraphs.length, sendTheme, props.onOpenSourceGraph])

  if (props.state.kind === 'failed') {
    return (
      <div className={styles.state} data-testid="kg-view-failed">
        <p className={styles.error}>{props.t('graphFailed')}</p>
        <p className={styles.detail}>{props.state.error}</p>
        <button type="button" className={styles.retry} onClick={props.onRetry}>
          {props.t('graphRetry')}
        </button>
      </div>
    )
  }
  if (props.state.kind === 'loading' && graphs.length === 0) {
    return <div className={styles.state} data-testid="kg-view-loading">{props.t('graphLoading')}</div>
  }
  if (graphs.length === 0) {
    return (
      <div className={styles.state} data-testid="kg-view-empty">
        <p className={styles.emptyTitle}>{props.t('graphEmptyTitle')}</p>
        <p className={styles.detail}>{props.t('graphEmptyBody')}</p>
        {props.state.tree.denied > 0 && <p className={styles.detail}>{props.t('graphNoAccess')}</p>}
      </div>
    )
  }

  return (
    <div className={styles.host}>
      {activeGraph?.computed === true && (
        <div className={styles.overviewBar} data-testid="kg-overview-filters">
          <span
            className={styles.overviewLabel}
            title="由调用者可读的图谱实时聚合，只读；点击节点会打开源图谱"
          >
            {activeGraph.name} · {activeGraph.counts.topics} 节点 · {activeGraph.counts.links} 关系
          </span>
          <label className={styles.filterField}>
            <span>范围</span>
            <select
              className={styles.filterSelect}
              aria-label="按范围筛选"
              value={filters.scope}
              onChange={(event) => { setFilters(current => ({ ...current, scope: event.target.value })) }}
            >
              <option value="all">全部</option>
              {filterOptions.scopes.map(scope => (
                <option key={scope} value={scope}>{SCOPE_FILTER_LABELS[scope] ?? scope}</option>
              ))}
            </select>
          </label>
          <label className={styles.filterField}>
            <span>类型</span>
            <select
              className={styles.filterSelect}
              aria-label="按类型筛选"
              value={filters.type}
              onChange={(event) => { setFilters(current => ({ ...current, type: event.target.value })) }}
            >
              <option value="all">全部</option>
              {filterOptions.types.map(type => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
          <label className={styles.filterField}>
            <span>权威</span>
            <select
              className={styles.filterSelect}
              aria-label="按权威级别筛选"
              value={filters.authority}
              onChange={(event) => { setFilters(current => ({ ...current, authority: event.target.value })) }}
            >
              <option value="all">全部</option>
              {filterOptions.authorities.map(authority => (
                <option key={authority} value={authority}>{authority}</option>
              ))}
            </select>
          </label>
        </div>
      )}
      {graphBadges.length + topicBadges.length > 0 && badgeSubject !== undefined && (
        <div className={styles.badgeBar} data-testid="kg-view-badges">
          <span className={styles.badgeBarLabel}>{badgeLabel}</span>
          <OriginBadges
            origin={badgeSubject.origin}
            reviewStatus={badgeSubject.reviewStatus}
            authority={badgeSubject.authority}
          />
        </div>
      )}
      <iframe
        ref={frameRef}
        className={styles.frame}
        title="知识图谱画布"
        data-testid="kg-canvas-frame"
        src={canvasUrl}
        data-canvas-src={canvasUrl}
        onLoad={onFrameLoad}
      />
    </div>
  )
}
