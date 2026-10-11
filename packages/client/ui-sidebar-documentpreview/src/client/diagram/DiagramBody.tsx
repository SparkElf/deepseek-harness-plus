/** Diagram body: draw.io XML and XMind archives rendered as boxes and routed links. */
import { useMemo, type ReactNode } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DocumentPreviewProps } from '../document/contract.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import { parseDrawio, parseXmind, type Diagram } from './parse.ts'
import { edgePath, layoutDiagram, NODE_HEIGHT, NODE_WIDTH } from './layout.ts'
import type {} from './locales.ts'
import css from './DiagramBody.module.css'

/** Standard document props plus the diagram dictionary. */
export type DiagramBodyProps = DocumentPreviewProps & PropsLocale<'documentDiagram'> & {
  /** Which format this tab carries, decided from the file suffix by the registering module. */
  readonly format: DiagramFormat
}

/** The diagram formats this body understands. */
export type DiagramFormat = 'drawio' | 'xmind'

/**
 * Decode the file bytes as UTF-8 text.
 * @param data - the document bytes.
 * @returns the decoded text.
 */
function decode(data: Uint8Array<ArrayBuffer>): string {
  return new TextDecoder('utf-8').decode(data)
}

/**
 * Read the `content.json` member out of an XMind zip.
 *
 * An XMind file is a zip whose first entry is that JSON. Only the entry is needed, so the local
 * file header is walked directly rather than inflating the whole archive.
 * @param data - the document bytes.
 * @returns the decoded JSON text.
 */
function readXmindContent(data: Uint8Array<ArrayBuffer>): string {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let offset = 0
  while (offset + 30 <= data.byteLength) {
    // A local file header is 30 bytes, then the name, then the stored data.
    const signature = view.getUint32(offset, true)
    if (signature !== 0x04034b50) break
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    const start = offset + 30 + nameLength + extraLength
    const name = decode(data.subarray(offset + 30, offset + 30 + nameLength))
    if (name === 'content.json') {
      const method = view.getUint16(offset + 8, true)
      const compressedSize = view.getUint32(offset + 18, true)
      const raw = data.subarray(start, start + compressedSize)
      if (method !== 0) throw new Error('compressed XMind entry')
      return decode(raw)
    }
    offset = start + view.getUint32(offset + 18, true)
  }
  throw new Error('XMind archive has no content.json')
}

/**
 * Parse whichever format this body was registered for.
 * @param format - the registered format.
 * @param data - the document bytes.
 * @returns the parsed diagram.
 */
function parse(format: DiagramFormat, data: Uint8Array<ArrayBuffer>): Diagram {
  const text = decode(data)
  if (format === 'xmind') return parseXmind(readXmindContent(data))
  // A draw.io file exported with compression carries base64 in a `<diagram>` element.
  return parseDrawio(text)
}

/**
 * Render a parsed diagram.
 * @param props - standard document props plus this renderer’s dictionary and format.
 * @returns the diagram canvas, or the loading indicator while content is absent.
 */
export function DiagramBody({ content, format, t }: DiagramBodyProps): ReactNode {
  const data = content.kind === 'bytes' ? content.data : undefined
  const parsed = useMemo(() => {
    if (data === undefined) return undefined
    try {
      return { diagram: layoutDiagram(parse(format, data)) }
    } catch {
      return { failed: true as const }
    }
  }, [data, format])

  if (data === undefined) return <LoadingIndicator label={t('loading')} />
  if (parsed === undefined || 'failed' in parsed) return <div className={css.failure}>{t('failed')}</div>

  const { diagram } = parsed
  if (diagram.placements.length === 0) return <div className={css.failure}>{t('empty')}</div>
  const at = new Map(diagram.placements.map(item => [item.node.id, item]))

  return (
    <div className={css.frame} data-diagram-preview>
      <div className={css.canvas} style={{ width: diagram.width, height: diagram.height }}>
        <svg className={css.edges} width={diagram.width} height={diagram.height} aria-hidden>
          {diagram.edges.map((edge, index) => {
            const from = at.get(edge.from)
            const to = at.get(edge.to)
            if (from === undefined || to === undefined) return undefined
            return <path key={index} className={css.edge} d={edgePath(from, to)} />
          })}
        </svg>
        {diagram.placements.map(({ node, x, y }) => (
          <div key={node.id} className={css.node} style={{ left: x, top: y, width: NODE_WIDTH, height: NODE_HEIGHT }}
            title={node.label}>
            <span className={css.label}>{node.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
