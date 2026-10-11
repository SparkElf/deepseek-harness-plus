/**
 * Read the diagram formats this preview renders into one node and edge list.
 *
 * Two shapes arrive here. A draw.io file is mxGraph XML whose cells carry an id, an optional
 * value, and a style that tells a vertex from an edge. An XMind file is a zip whose content.json
 * holds a topic tree. Both reduce to labelled boxes and the links between them, which is what the
 * renderer draws and what a reader wants from either format.
 */

/** One box or label in a diagram. */
export interface DiagramNode {
  /** Stable identity within the parsed document. */
  readonly id: string
  /** Visible text, unescaped and stripped of markup. */
  readonly label: string
  /** Nesting depth, so a parsed tree keeps its hierarchy visible. */
  readonly depth: number
}

/** One link between two nodes. */
export interface DiagramEdge {
  /** Source node id. */
  readonly from: string
  /** Target node id. */
  readonly to: string
  /** Visible edge label, empty when the document carries none. */
  readonly label: string
}

/** A parsed diagram, ready to draw. */
export interface Diagram {
  /** Nodes in document order. */
  readonly nodes: readonly DiagramNode[]
  /** Links whose endpoints both resolved. */
  readonly edges: readonly DiagramEdge[]
}

/**
 * Decode the entities mxGraph XML carries and drop any markup an embedded value holds.
 * @param value - raw attribute text.
 * @returns the visible label.
 */
export function plainLabel(value: string): string {
  const decoded = value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&#10;', ' ')
    .replaceAll('&amp;', '&')
  // A value may be HTML; the text between its tags is the label a reader recognizes.
  return decoded.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim()
}

/**
 * Read the attribute value of one start tag.
 * @param tag - the start tag text.
 * @param name - attribute name.
 * @returns the attribute value, or an empty string when absent.
 */
function attribute(tag: string, name: string): string {
  const match = new RegExp(name + '="([^"]*)"', 'u').exec(tag)
  return match?.[1] ?? ''
}

/**
 * Parse an mxGraph document into nodes and edges.
 * @param xml - the draw.io XML text.
 * @returns the parsed diagram.
 */
export function parseDrawio(xml: string): Diagram {
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  const known = new Set<string>()
  // Two passes: every vertex must exist before an edge can name both of its ends.
  for (const tag of xml.match(/<mxCell\b[^>]*>/gu) ?? []) {
    const id = attribute(tag, 'id')
    const edge = attribute(tag, 'edge') === '1'
    if (edge || id === '' || id === '0' || id === '1') continue
    const label = plainLabel(attribute(tag, 'value'))
    // A container cell with no text is structural, not a box a reader needs.
    if (label === '') continue
    known.add(id)
    nodes.push({ id, label, depth: 0 })
  }
  for (const tag of xml.match(/<mxCell\b[^>]*>/gu) ?? []) {
    if (attribute(tag, 'edge') !== '1') continue
    const from = attribute(tag, 'source')
    const to = attribute(tag, 'target')
    if (!known.has(from) || !known.has(to)) continue
    edges.push({ from, to, label: plainLabel(attribute(tag, 'value')) })
  }
  return { nodes, edges }
}

/** One topic as XMind stores it: a title and whatever is attached below. */
interface XmindTopic {
  readonly title?: string
  readonly children?: { readonly attached?: readonly XmindTopic[] }
}

/**
 * Flatten one level of topics, returning the ids of the nodes created for that level.
 * @param topics - the topics at this level.
 * @param depth - nesting level, used for the node indent.
 * @param nodes - accumulator for nodes.
 * @returns the ids created here, so the caller links only its own children.
 */
function walkTopics(topics: readonly XmindTopic[], depth: number, nodes: DiagramNode[], edges: DiagramEdge[]): readonly string[] {
  const created: string[] = []
  for (const topic of topics) {
    const label = (topic.title ?? '').trim()
    const id = 'n' + String(nodes.length)
    // A topic with no text still parents its children, so it keeps an id without a node.
    if (label !== '') {
      nodes.push({ id, label, depth })
      created.push(id)
    }
    const attached = topic.children?.attached ?? []
    if (attached.length === 0) continue
    const children = walkTopics(attached, depth + 1, nodes, edges)
    for (const child of children) edges.push({ from: id, to: child, label: '' })
  }
  return created
}
/**
 * Parse an XMind content.json document into nodes and edges.
 * @param json - the decoded content.json text.
 * @returns the parsed diagram.
 */
export function parseXmind(json: string): Diagram {
  const sheets = JSON.parse(json) as readonly { readonly rootTopic?: XmindTopic }[]
  const nodes: DiagramNode[] = []
  const edges: DiagramEdge[] = []
  for (const sheet of sheets) {
    if (sheet.rootTopic !== undefined) walkTopics([sheet.rootTopic], 0, nodes, edges)
  }
  return { nodes, edges }
}
