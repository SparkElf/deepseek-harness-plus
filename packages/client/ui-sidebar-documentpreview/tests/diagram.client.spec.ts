/** Diagram parsing and layout: the two shipped formats and their shared geometry. */
// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { parseDrawio, parseXmind, plainLabel } from '../src/client/diagram/parse.ts'
import { edgePath, layoutDiagram, NODE_HEIGHT, NODE_WIDTH } from '../src/client/diagram/layout.ts'

const DRAWIO = [
  '<mxfile><diagram><mxGraphModel><root>',
  '<mxCell id="0" /><mxCell id="1" parent="0" />',
  '<mxCell id="a" value="Start" vertex="1" style="rounded=0" />',
  '<mxCell id="b" value="End" vertex="1" style="rounded=0" />',
  '<mxCell id="e" edge="1" source="a" target="b" value="yes" />',
  '</root></mxGraphModel></diagram></mxfile>',
].join('')

const XMIND = JSON.stringify([
  { rootTopic: { title: 'root', children: { attached: [
    { title: 'child', children: { attached: [{ title: 'leaf' }] } },
  ] } } },
])

describe('diagram parsing', () => {
  it('reads draw.io vertices and the edges between them', () => {
    const diagram = parseDrawio(DRAWIO)
    expect(diagram.nodes.map(node => node.label)).toEqual(['Start', 'End'])
    // The edge names both ends by the vertex ids, which the first pass recorded.
    expect(diagram.edges).toEqual([{ from: 'a', to: 'b', label: 'yes' }])
  })

  it('drops the structural cells that carry no text', () => {
    const diagram = parseDrawio(DRAWIO)
    expect(diagram.nodes.some(node => node.id === '0' || node.id === '1')).toBe(false)
  })

  it('decodes entities and strips embedded markup from a label', () => {
    expect(plainLabel('A &amp; B')).toBe('A & B')
    expect(plainLabel('&lt;b&gt;bold&lt;/b&gt; text')).toBe('bold text')
  })

  it('flattens an XMind topic tree with one edge per child', () => {
    const diagram = parseXmind(XMIND)
    expect(diagram.nodes.map(node => [node.label, node.depth])).toEqual([
      ['root', 0], ['child', 1], ['leaf', 2],
    ])
    // Three nodes in one chain means two links, not one per ancestor.
    expect(diagram.edges).toHaveLength(2)
  })
})

describe('diagram layout', () => {
  it('places a tree by depth in one column per level', () => {
    const layout = layoutDiagram(parseXmind(XMIND))
    const columns = layout.placements.map(placement => placement.x)
    expect(columns).toEqual([0, NODE_WIDTH + 96, 2 * (NODE_WIDTH + 96)])
    expect(layout.width).toBe(3 * NODE_WIDTH + 2 * 96)
    expect(layout.height).toBeGreaterThan(0)
  })

  it('drops an edge whose endpoint was not placed', () => {
    const layout = layoutDiagram({ nodes: [{ id: 'a', label: 'A', depth: 0 }], edges: [{ from: 'a', to: 'gone', label: '' }] })
    expect(layout.edges).toEqual([])
  })

  it('routes a rightward link between facing borders', () => {
    const path = edgePath(
      { node: { id: 'a', label: 'A', depth: 0 }, x: 0, y: 0 },
      { node: { id: 'b', label: 'B', depth: 1 }, x: 400, y: 100 },
    )
    expect(path.startsWith('M' + String(NODE_WIDTH) + ',' + String(NODE_HEIGHT / 2))).toBe(true)
    expect(path.endsWith('H400')).toBe(true)
  })
})
