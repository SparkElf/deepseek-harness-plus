/**
 * Projection adapter: new `.graphs/<id>/graph.json` graphs into the graph tab's
 * existing DOMAIN tree (`scope -> graph -> topic -> documents`).
 *
 * The graph tab was built for the legacy layout, where every node was a visible
 * topic folder. The new model keeps node bodies wherever the classification tree
 * wants them and only records topology in `graph.json`, so it has no topic folder
 * to point at. Projecting each node into a topic card keeps the existing canvas,
 * tree and breadcrumb working unchanged while the authoritative topology stays in
 * `graph.json`; the projection is derived, never written back.
 *
 * The legacy scanner stays authoritative for legacy graphs. This module is pure:
 * it receives already-loaded graphs and returns browser-safe nodes, so it never
 * touches the filesystem and cannot widen what the Host resolved.
 *
 * @module @sparkelf/dsh-knowledge-base/graph-json-projection
 */

import type { LoadedGraph, LoadedGraphEdge, LoadedGraphNode } from './graphModel.ts'
import type {
  KnowledgeGraphLink,
  KnowledgeGraphNode,
  KnowledgeGraphScopeKey,
  KnowledgeGraphTopic,
} from './graphTypes.ts'

/** The folder name whose parent is the scope root that owns `.graphs/`. */
export const LEGACY_GRAPH_FOLDER = '知识图谱'

/** One browser-facing graph node produced from a `graph.json` manifest. */
export interface ProjectedGraphJsonNode extends KnowledgeGraphNode {
  /** Distinguishes the new model from a legacy folder graph in the browser. */
  format: 'graph-json'
  /** New graphs are editable surfaces; kept for symmetry with read-only legacy ones. */
  readOnly: boolean
}

/** Input for one scope's projection: where it sits and which graphs were loaded. */
export interface GraphJsonScopeProjectionInput {
  key: KnowledgeGraphScopeKey
  /** View-relative scope root, e.g. `global` or `department/D1`. */
  viewBase: string
  /** Authoritative scope root, e.g. the same path inside the knowledge root. */
  actualBase: string
  /** Department chain key; empty for global and personal. */
  groupKey?: string
  /** Department display label; empty for global and personal. */
  groupLabel?: string
  /** Graphs loaded from `<actualBase>/.graphs/`. */
  graphs: LoadedGraph[]
}

/** The scope directory that owns `.graphs/`, from a legacy graph root. */
export function graphScopeBase(actualGraphRoot: string): string {
  const parts = actualGraphRoot.split('/').filter(segment => segment !== '')
  if (parts.length > 0 && parts[parts.length - 1] === LEGACY_GRAPH_FOLDER) {
    parts.pop()
  }
  return parts.join('/')
}

/** The view-relative path of the hidden graph store under a scope base. */
export function graphStorePath(viewBase: string, graphId: string): string {
  return [viewBase, '.graphs', graphId].filter(segment => segment !== '').join('/')
}

/** A title from the node attributes, falling back to the file name. */
function nodeTitle(node: LoadedGraphNode): string {
  if (node.title.trim() !== '') return node.title
  const name = node.path.split('/').pop() ?? node.id
  return name.replace(/\.md$/i, '')
}

/** The visible folder a node body lives in, for the topic card's folder label. */
function nodeFolder(node: LoadedGraphNode): string {
  const parts = node.path.split('/')
  return parts.length > 1 ? (parts[parts.length - 2] ?? '') : ''
}

/** One loaded node as a topic card the existing canvas can render. */
function nodeAsTopic(node: LoadedGraphNode, viewBase: string): KnowledgeGraphTopic {
  const viewPath = [viewBase, node.path].filter(segment => segment !== '').join('/')
  const title = nodeTitle(node)
  const file = node.path.split('/').pop() ?? node.path
  return {
    id: node.id,
    title,
    // The card's lifecycle colour: review status is the closest honest signal.
    status: node.reviewStatus,
    depth: 1,
    domain: node.type,
    tags: [...node.tags],
    summary: '',
    body: '',
    folder: nodeFolder(node),
    path: viewPath,
    // The node body IS the topic's document. Without this entry the canvas shows
    // an empty cover and the card has nothing to open; the projection is still
    // derived and never writes back to graph.json.
    documents: [{ title, file, path: viewPath }],
    // Carried through so the tree/view badges can render without a second lookup.
    authority: node.authority,
    origin: node.origin,
    reviewStatus: node.reviewStatus,
  }
}

/** One loaded edge as the relation pill the canvas understands. */
function edgeAsLink(edge: LoadedGraphEdge): KnowledgeGraphLink {
  return {
    a: edge.from,
    b: edge.to,
    ...(edge.type.trim() === '' ? {} : { label: edge.type }),
    body: '',
    file: edge.docPath === undefined ? undefined : edge.docPath.split('/').pop(),
  }
}

/**
 * Project loaded graphs into graph-tab nodes for one scope.
 *
 * Only edges whose two ends exist as loaded nodes are projected; a broken edge is
 * a validator issue, not a canvas arrow to a card that will never render.
 */
export function projectGraphJsonScope(
  input: GraphJsonScopeProjectionInput,
): ProjectedGraphJsonNode[] {
  const projected: ProjectedGraphJsonNode[] = []
  for (const graph of input.graphs) {
    const nodeIds = new Set(graph.nodes.map(node => node.id))
    const topics = graph.nodes.map(node => nodeAsTopic(node, input.viewBase))
    const links = graph.edges
      .filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to))
      .map(edgeAsLink)
    projected.push({
      id: graphStorePath(input.viewBase, graph.manifest.id),
      name: graph.manifest.name,
      scope: input.key,
      path: graphStorePath(input.viewBase, graph.manifest.id),
      group: input.groupLabel ?? '',
      topics,
      links,
      counts: { topics: topics.length, links: links.length, documents: topics.reduce((total, topic) => total + topic.documents.length, 0) },
      actualPath: graphStorePath(input.actualBase, graph.manifest.id),
      format: 'graph-json',
      readOnly: false,
    })
  }
  return projected
}

/**
 * Merge projected graphs into the scanner's tree.
 *
 * The scanner's own order is preserved; a scope's projected graphs are appended
 * inside the matching department group (or the flat group for global/personal).
 * A projected graph never replaces a legacy graph with the same display name:
 * both are real sources and the browser can tell them apart by `format`.
 */
export function mergeProjectedGraphs(
  tree: { scopes: Array<{ key: KnowledgeGraphScopeKey; groups: Array<{ key: string; label: string; graphs: KnowledgeGraphNode[] }> }> },
  projectedByScope: Partial<Record<KnowledgeGraphScopeKey, ProjectedGraphJsonNode[]>>,
): void {
  for (const scope of tree.scopes) {
    const graphs = projectedByScope[scope.key]
    if (graphs === undefined || graphs.length === 0) continue
    if (scope.groups.length === 0) {
      scope.groups.push({ key: '', label: '', graphs: [...graphs] })
      continue
    }
    const first = scope.groups[0]
    if (first === undefined) continue
    first.graphs.push(...graphs)
  }
}
