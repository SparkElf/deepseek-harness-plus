/**
 * The read-only knowledge-graph shape shared by the Host scanner and the browser.
 *
 * A graph is an ordinary knowledge folder: `<scope>/知识图谱/<graph>/` with one
 * visible sub-folder per topic and the relation documents under `.kg/links/`. The
 * graph tab therefore speaks a DOMAIN model (scope → graph → topic) rather than the
 * file tree's path model. Keeping the shape in one dependency-free module is what
 * lets the Host build it and the canvas page render it without a second translation
 * layer that could disagree about a field name.
 *
 * Paths here are VIEW-relative (`global/知识图谱/…`, `department/…`,
 * `personal/知识图谱/…`): the personal owner segment is deliberately absent, exactly
 * as the file tree shows it. The Host resolves the authoritative path first; the
 * browser never needs to know the caller's uid.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-types
 */

/** The folder name that marks a knowledge graph inside a scope. */
export const KNOWLEDGE_GRAPH_FOLDER = '知识图谱'

/** The hidden folder inside a graph that holds the relation documents. */
export const KNOWLEDGE_GRAPH_META_FOLDER = '.kg'

/** The trash folder `kg_del` moves topics into; never a topic itself. */
export const KNOWLEDGE_GRAPH_TRASH_FOLDER = '_trash'

/** How a document or node was produced. Absent on content that predates the field. */
export type KnowledgeGraphOrigin = 'human' | 'ai' | 'mixed'

/** Review lifecycle. Absent means the scanner did not report one. */
export type KnowledgeGraphReviewStatus = 'draft' | 'reviewed' | 'approved'

/** Authority level. Absent means the scanner did not report one. */
export type KnowledgeGraphAuthority = 'canonical' | 'advisory' | 'redline'

/** One document inside a topic folder, as the detail panel lists it. */
export interface KnowledgeGraphDocument {
  /** Human title: the document's first H1, else the file name without extension. */
  title: string
  /** Path relative to the topic folder, e.g. `岗位/张三.md`. */
  file: string
  /** View-relative path, for opening the document from a future write surface. */
  path: string
  /** ISO-8601 date (`YYYY-MM-DD`) from the file's modification instant. */
  date?: string
  /** First paragraph after the H1, when the file has one. */
  summary?: string
  /** Optional provenance: `ai`/`mixed` renders the [AI 生成] badge. */
  origin?: KnowledgeGraphOrigin
  /** Optional review lifecycle: `reviewed`/`approved` renders [已审核]. */
  reviewStatus?: KnowledgeGraphReviewStatus
  /** Optional authority: `redline` renders [红线] and only permits subscription. */
  authority?: KnowledgeGraphAuthority
}

/** One topic: a visible folder whose `index.md` is its card. */
export interface KnowledgeGraphTopic {
  /** Identity the relation documents reference. Front matter `id`, else folder name. */
  id: string
  /** Card title. Front matter `title`, else the folder name. */
  title: string
  /** Lifecycle state the prototype's cards colour. */
  status: string
  /** 1–5 progress dots on the card. */
  depth: number
  /** Optional grouping label shown as the first tag. */
  domain?: string
  /** Remaining card tags. */
  tags: string[]
  /** First paragraph after the H1, shown on the card and in the detail panel. */
  summary: string
  /** Free body from the card, H1 and summary removed; the detail panel renders it. */
  body: string
  /** Visible folder name. */
  folder: string
  /** View-relative topic folder path. */
  path: string
  /** Documents below the topic folder, including nested document folders. */
  documents: KnowledgeGraphDocument[]
  /** Optional provenance for the topic card; mirrors the node-level field. */
  origin?: KnowledgeGraphOrigin
  /** Optional review lifecycle for the topic card. */
  reviewStatus?: KnowledgeGraphReviewStatus
  /** Optional authority for the topic card; `redline` is subscribe-only. */
  authority?: KnowledgeGraphAuthority
  /**
   * Overview projection only: the graph this node was aggregated from.
   *
   * A topic inside the synthesized `总图` carries the namespaced id
   * `<graphId>:<nodeId>`; these two fields let a click navigate back to the real
   * graph and node instead of treating the copy as an editable topic.
   */
  sourceGraphId?: string
  /** Overview projection only: the node id inside {@link sourceGraphId}. */
  sourceNodeId?: string
  /** Overview projection only: the source graph's scope, for the scope filter. */
  scope?: KnowledgeGraphScopeKey
  /** True when this node came from a higher scope and is read-only here. */
  contributed?: boolean
  /** True when the overview must treat this node as read-only (a contributed copy). */
  readOnly?: boolean
}

/** One relation document under `<graph>/.kg/links/`. */
export interface KnowledgeGraphLink {
  /** Topic id at one end. */
  a: string
  /** Topic id at the other end. */
  b: string
  /** Short edge label; the canvas falls back to `a ↔ b` when absent. */
  label?: string
  /** ISO-8601 date from front matter or the file. */
  updated?: string
  /** First body paragraph, shown when the relation pill is opened. */
  body: string
  /** File name under `<graph>/.kg/links/`, used by the Host-side del tool. */
  file?: string
  /**
   * Overview projection only: endpoints belong to different source graphs.
   *
   * The canvas draws these dashed and keeps them visible without enabling the
   * ordinary cross-link toggle, because crossing graphs is the overview's point.
   */
  crossGraph?: boolean
  /** Overview projection only: at least one endpoint came from a higher scope. */
  contributed?: boolean
}

/** One graph node under a scope. */
export interface KnowledgeGraphNode {
  /** Stable view-relative folder path; unique across the tree. */
  id: string
  /** Display name: the graph folder's name. */
  name: string
  /** Scope the graph lives in. */
  scope: KnowledgeGraphScopeKey
  /** View-relative graph folder path. */
  path: string
  /** Department display chain for a department graph, empty for the other scopes. */
  group: string
  /** Topics in folder order. */
  topics: KnowledgeGraphTopic[]
  /** Relations whose two ends both resolve to topics in this graph. */
  links: KnowledgeGraphLink[]
  /** What the header states beside the breadcrumb. */
  counts: { topics: number; links: number; documents: number }
  /** Optional provenance for the graph row; absent on graphs scanned before it existed. */
  origin?: KnowledgeGraphOrigin
  /** Optional review lifecycle for the graph row. */
  reviewStatus?: KnowledgeGraphReviewStatus
  /** Optional authority for the graph row; `redline` is subscribe-only. */
  authority?: KnowledgeGraphAuthority
  /**
   * Authoritative path relative to the knowledge root, used by Host-side graph
   * tools. Stripped before the tree is sent to the browser.
   */
  actualPath?: string
  /**
   * True for the synthesized overview (`总图`).
   *
   * A computed graph has no `.graphs/<id>/graph.json`: the Host builds it at read
   * time from the graphs the caller may read. It is excluded from every recursive
   * aggregation so the overview never contains itself.
   */
  computed?: boolean
  /**
   * True when the graph is a derived, read-only view.
   *
   * Legacy folder graphs are also read-only for their graph-level metadata, and
   * the Host marks those rows `readOnly` too; `computed` is what distinguishes the
   * synthesized overview from a stored graph.
   */
  readOnly?: boolean
}

/** One group inside a scope: the department chain for 部门, empty elsewhere. */
export interface KnowledgeGraphGroup {
  /** Stable key (the department code chain), empty for a flat scope. */
  key: string
  /** Display label (department names, joined by ` / `). */
  label: string
  /** Graphs directly in this group. */
  graphs: KnowledgeGraphNode[]
}

/** One of the three knowledge scopes. */
export type KnowledgeGraphScopeKey = 'global' | 'department' | 'personal'

/** One scope level of the graph tree. */
export interface KnowledgeGraphScope {
  key: KnowledgeGraphScopeKey
  /** Groups under the scope; a flat scope carries one group with an empty key. */
  groups: KnowledgeGraphGroup[]
}

/** The caller identity the tree names, without credentials. */
export interface KnowledgeGraphCaller {
  /** Stable user id, for tests and for a future owner label. */
  userId: string
  /** Human label from DataOps. */
  label: string
  /** The caller's organization chain, root first, when the backend reported one. */
  departmentPathCodes?: string[]
  /** Index-aligned display names for {@link departmentPathCodes}. */
  departmentPathNames?: string[]
}

/**
 * What `GET /knowledge-base/api/graph` answers.
 *
 * `scanned` counts graph folders the Host saw on disk; `visible` counts the ones
 * that passed `canReadPath`; `denied` is the difference. The names of denied graphs
 * never leave the Host, which is why this is counts rather than a refused list.
 */
export interface KnowledgeGraphTree {
  scopes: KnowledgeGraphScope[]
  caller: KnowledgeGraphCaller
  /**
   * Authoritative knowledge root the scanner read.
   *
   * Returned for a future write surface that must reuse the Host's own resolver
   * instead of building `personal/<uid>/…` in the browser. The panel already shows
   * this value in its status header, so naming it here adds no disclosure.
   */
  actualRoot: string
  scanned: number
  visible: number
  denied: number
}

/** An empty tree, for the loading and failure states. */
export function emptyKnowledgeGraphTree(): KnowledgeGraphTree {
  return {
    scopes: [
      { key: 'global', groups: [] },
      { key: 'department', groups: [] },
      { key: 'personal', groups: [] },
    ],
    caller: { userId: '', label: '' },
    actualRoot: '',
    scanned: 0,
    visible: 0,
    denied: 0,
  }
}

/** Flatten the tree into the list the canvas page consumes. */
export function knowledgeGraphsOf(tree: KnowledgeGraphTree): KnowledgeGraphNode[] {
  return tree.scopes.flatMap(scope => scope.groups.flatMap(group => group.graphs))
}

/**
 * Whether a graph or one of its topics matches the tree's in-place filter.
 *
 * This narrows what the Host already returned; it is not a permission filter and
 * must never be used as one. Exported so the rule can be tested without rendering
 * the tree.
 *
 * @param graph - one permission-filtered graph.
 * @param needle - already lower-cased filter term.
 * @returns true when the graph name or a topic title contains the term.
 */
export function knowledgeGraphMatches(graph: KnowledgeGraphNode, needle: string): boolean {
  if (needle === '') return true
  return graph.name.toLowerCase().includes(needle)
    || graph.topics.some(topic => topic.title.toLowerCase().includes(needle))
}
