/**
 * Lay out a parsed diagram as positioned boxes and orthogonal links.
 *
 * MXGraph and XMind both describe a graph, not a picture, so the renderer needs coordinates. The
 * two arrangements a reader expects are laid out here: a mind map fans out to the right, one depth
 * per column, and a general graph keeps document order in rows. Both then route each edge as a
 * three-segment path between box borders, which stays readable without a routing library.
 */
import type { Diagram, DiagramEdge, DiagramNode } from './parse.ts'

/** Box size in CSS pixels, matching the card the renderer draws. */
export const NODE_WIDTH = 200

/** Vertical distance between the tops of neighbouring boxes. */
export const NODE_HEIGHT = 48

/** Horizontal distance between successive columns. */
const COLUMN_GAP = 96

/** Vertical distance between rows in a wrapped graph. */
const ROW_GAP = 28

/** Boxes per row once a diagram stops being a tree. */
const ROW_WIDTH = 4

/** Where one node sits. */
export interface Placement {
  /** The node being placed. */
  readonly node: DiagramNode
  /** Left edge in diagram coordinates. */
  readonly x: number
  /** Top edge in diagram coordinates. */
  readonly y: number
}

/** A diagram with coordinates and the canvas it needs. */
export interface Layout {
  /** Every node with its position. */
  readonly placements: readonly Placement[]
  /** Links between placed nodes. */
  readonly edges: readonly DiagramEdge[]
  /** Canvas width in diagram coordinates. */
  readonly width: number
  /** Canvas height in diagram coordinates. */
  readonly height: number
}

/**
 * Arrange nodes by their depth, one depth per column.
 * @param nodes - nodes in document order.
 * @returns each node with a column and a row inside that column.
 */
function byDepth(nodes: readonly DiagramNode[]): readonly Placement[] {
  const rows = new Map<number, number>()
  return nodes.map((node) => {
    const row = rows.get(node.depth) ?? 0
    rows.set(node.depth, row + 1)
    return { node, x: node.depth * (NODE_WIDTH + COLUMN_GAP), y: row * (NODE_HEIGHT + ROW_GAP) }
  })
}

/**
 * Arrange nodes in document order, wrapped into rows.
 * @param nodes - nodes in document order.
 * @returns each node with a grid position.
 */
function byRow(nodes: readonly DiagramNode[]): readonly Placement[] {
  return nodes.map((node, index) => ({
    node,
    x: (index % ROW_WIDTH) * (NODE_WIDTH + COLUMN_GAP),
    y: Math.floor(index / ROW_WIDTH) * (NODE_HEIGHT + ROW_GAP),
  }))
}

/**
 * Place a parsed diagram.
 * @param diagram - the parsed diagram.
 * @returns coordinates plus the canvas size they need.
 */
export function layoutDiagram(diagram: Diagram): Layout {
  const rooted = diagram.edges.length === 0 || diagram.nodes.every(node => node.depth > 0 || node.depth === 0)
  // A converted mind map carries depth; a general graph does not, so it keeps document order.
  const placements = rooted && diagram.nodes.some(node => node.depth > 0) ? byDepth(diagram.nodes) : byRow(diagram.nodes)
  const width = Math.max(0, ...placements.map(item => item.x + NODE_WIDTH))
  const height = Math.max(0, ...placements.map(item => item.y + NODE_HEIGHT))
  const placed = new Set(placements.map(item => item.node.id))
  return {
    placements,
    edges: diagram.edges.filter(edge => placed.has(edge.from) && placed.has(edge.to)),
    width,
    height,
  }
}

/**
 * Route one link as a path between the facing borders of its two boxes.
 * @param from - source placement.
 * @param to - target placement.
 * @returns the SVG path data.
 */
export function edgePath(from: Placement, to: Placement): string {
  const fromRight = from.x + NODE_WIDTH
  const fromMiddle = from.y + NODE_HEIGHT / 2
  const toMiddle = to.y + NODE_HEIGHT / 2
  // A link that runs leftward leaves from the source’s left edge instead.
  if (to.x >= fromRight) {
    const middle = (fromRight + to.x) / 2
    return 'M' + String(fromRight) + ',' + String(fromMiddle)
      + ' H' + String(middle) + ' V' + String(toMiddle) + ' H' + String(to.x)
  }
  if (to.x + NODE_WIDTH <= from.x) {
    const middle = (to.x + NODE_WIDTH + from.x) / 2
    return 'M' + String(from.x) + ',' + String(fromMiddle)
      + ' H' + String(middle) + ' V' + String(toMiddle) + ' H' + String(to.x + NODE_WIDTH)
  }
  const below = to.y >= from.y
  const start = below ? from.y + NODE_HEIGHT : from.y
  const end = below ? to.y : to.y + NODE_HEIGHT
  const middle = (start + end) / 2
  const centre = from.x + NODE_WIDTH / 2
  return 'M' + String(centre) + ',' + String(start)
    + ' V' + String(middle) + ' H' + String(to.x + NODE_WIDTH / 2) + ' V' + String(end)
}
