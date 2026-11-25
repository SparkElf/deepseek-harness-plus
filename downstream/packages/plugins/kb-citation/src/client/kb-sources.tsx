/**
 * Source panel rendered above one assistant answer.
 *
 * A conversation Definition opens one node per Turn at its first step, then folds every
 * `assistant/message` in that Turn into the same node. The panel sorts before the answer by
 * anchor sequence, so the reader sees sources first, answer second, deliverables last (the
 * deliverables tail keeps its own later anchor).
 */
import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { parseCitations, type Citation } from '../shared/citation.ts'
import { applyCitationView, fetchChunkGroups, resolveOpenTarget, waitForDocumentTab } from './citation-view.ts'
import { markCitationTiming } from './timing.ts'
import { normalizeCitationLinks, sourceLabelForLink } from './link-label.ts'

/** Payload consumed by the kb-sources renderer. */
export interface KbSourcesData {
  readonly turn: number
  readonly citations: readonly Citation[]
}

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** One Turn's deduplicated KB sources, rendered above the assistant answer. */
    'kb-sources': KbSourcesData
  }
}

interface KbSourcesState {
  readonly turn: number
  readonly citations: readonly Citation[]
  /** Anchor just before the assistant answer, after its thinking/process block. */
  readonly anchorSeq?: number
}

/** Stable identity for one Turn's source panel. */
function sourceId(turn: number): string {
  return 'kb-sources:' + String(turn)
}

/** Read the text blocks of one assistant message. */
function messageText(data: unknown): string {
  const record = typeof data === 'object' && data !== null ? data as Record<string, unknown> : {}
  const message = typeof record.message === 'object' && record.message !== null ? record.message as Record<string, unknown> : {}
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(part => {
    const block = typeof part === 'object' && part !== null ? part as Record<string, unknown> : {}
    return block.type === 'text' && typeof block.text === 'string' ? block.text : ''
  }).join('\n')
}

/** Deduplicate citations by canonical source, preserving first-seen order. */
export function uniqueCitations(citations: readonly Citation[]): Citation[] {
  const seen = new Set<string>()
  const out: Citation[] = []
  for (const citation of citations) {
    const key = (citation.path ?? citation.raw) + '|' + String(citation.line ?? '') + '|' + String(citation.page ?? '') + '|' + String(citation.sheet ?? '') + '|' + String(citation.cell ?? '') + '|' + String(citation.chunkId ?? '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(citation)
  }
  return out
}

/** Merge newly parsed citations into a Turn's existing list. */
export function mergeCitations(existing: readonly Citation[], text: string): Citation[] {
  return uniqueCitations([...existing, ...parseCitations(text)])
}

/** Conversation Definition: one source panel per Turn, above the assistant answer. */
export const kbSourcesDefinition = {
  kind: 'kb-sources',
  target: 'chat',
  match: (event: { type: string; data?: unknown }) => {
    if (event.type === 'step/start') {
      const data = event.data as { turn?: number; step?: number } | undefined
      if (data?.turn !== undefined && data.step === 1) return { id: sourceId(data.turn), role: 'start' as const }
      return null
    }
    if (event.type === 'assistant/message') {
      const data = event.data as { turn?: number } | undefined
      if (data?.turn !== undefined) return { id: sourceId(data.turn), role: 'update' as const }
    }
    return null
  },
  start: (_context: unknown, match: { event: { type: string; data?: unknown } }): KbSourcesState => {
    const data = match.event.data as { turn?: number } | undefined
    return { turn: data?.turn ?? 0, citations: [] }
  },
  update: (context: { state: KbSourcesState }, match: { event: { type: string; data?: unknown; seq?: number } }): KbSourcesState => {
    if (match.event.type !== 'assistant/message') return context.state
    return {
      ...context.state,
      citations: mergeCitations(context.state.citations, messageText(match.event.data)),
      ...(typeof match.event.seq === 'number' ? { anchorSeq: match.event.seq - 0.05 } : {}),
    }
  },
  buildViewNode: (context: {
    key: string
    id: string
    state: KbSourcesState | undefined
    start?: { seq: number; location: unknown }
  }) => {
    const state = context.state
    if (state === undefined || state.citations.length === 0 || context.start === undefined) return null
    return {
      key: context.key,
      kind: 'kb-sources',
      id: context.id,
      target: 'chat',
      anchorSeq: state.anchorSeq ?? context.start.seq,
      location: context.start.location,
      // The panel is part of the Turn, not of the collapsible process disclosure.
      // Without this the host nests it in the zero-height process body and the panel
      // is invisible until the reader expands "Completed".
      groupTree: 'turn' as const,
      visibility: 'visible',
      data: { turn: state.turn, citations: state.citations },
    }
  },
}

/** Whether the host should route this file through the document-preview (Office→PDF) tab. */
export function usesDocumentTab(path: string): boolean {
  return /\.(docx|doc|xlsx|xls|pptx|ppt)$/i.test(path)
}

/** The visible source name: `文件名:第N块` whenever the chunk identity is known. */
export function sourceFileName(citation: Citation, resolved?: string): string {
  if (resolved !== undefined && resolved !== '') return resolved
  if (citation.path !== undefined) {
    return sourceLabelForLink(citation.path, citation.chunkId, undefined, citation.chunkOrdinal)
      ?? citation.path.split('/').pop()
      ?? citation.label
  }
  return citation.label
}

/** Document glyph for one source row. */
function SourceIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 2.5h5l3 3v8H4v-11Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M9 2.5v3h3M6 8h4M6 10.5h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  )
}

/** Source panel: collapsible header + one clickable row per unique source. */
export function KbSourcesNodeView(props: {
  node: { data: KbSourcesData }
  sessionId?: string
  openFile?: (path: string) => void
  /** Open a docx through the document-preview tab (host Office→PDF), not a text tab. */
  openDocument?: (sessionId: string, path: string) => boolean
}): ReactNode {
  const { citations, turn } = props.node.data
  const sectionRef = useRef<HTMLElement>(null)
  const [open, setOpen] = useState(false)
  const [labels, setLabels] = useState<Record<string, string>>({})
  const count = citations.length
  useEffect(() => {
    if (!open) return
    let cancelled = false
    for (const citation of citations) {
      if (citation.docId === undefined || citation.chunkId === undefined) continue
      // A token with both a path and an ordinal can render without a round trip. A bare
      // token, or one missing its ordinal, needs the chunk response to name the block.
      if (citation.path !== undefined && citation.chunkOrdinal !== undefined) continue
      void fetchChunkGroups(citation.docId, citation.chunkId).then(chunk => {
        if (cancelled || chunk?.path === undefined) return
        const label = sourceLabelForLink(chunk.path, chunk.chunkKey ?? chunk.chunkId, undefined, chunk.chunkOrdinal)
        if (label !== undefined) setLabels(current => ({ ...current, [citation.raw]: label }))
      })
    }
    return () => { cancelled = true }
  }, [open, citations])
  // One scan per rendered Turn/message; no MutationObserver here (the plugin-level normalizer owns
  // late GenUI mounts). Historical messages each mount this panel once; new messages re-run when
  // citations settle. The scan is root-scoped to assistant/GenUI content, never user prompts.
  useEffect(() => {
    normalizeCitationLinks(document)
  }, [citations])
  const labelOf = (citation: Citation): string => sourceFileName(citation, labels[citation.raw])
  const openOne = async (citation: Citation): Promise<void> => {
    if (props.openFile === undefined) return
    markCitationTiming('click')
    // A bare kb://doc/<id>/chunk/<id> has no path in the token; resolve it through the KB
    // chunk endpoint first (which also returns every page box), then open the actual file.
    const resolved = await resolveOpenTarget(citation)
    if (resolved === undefined) return
    markCitationTiming('resolved', resolved.path)
    const docx = usesDocumentTab(resolved.path)
    if (docx && props.sessionId !== undefined && props.openDocument?.(props.sessionId, resolved.path) === true) {
      // The document-preview tab owns the Office→PDF conversion; wait for its PDF text layer.
    } else {
      props.openFile(resolved.path)
    }
    markCitationTiming('resource-open')
    if (docx) await waitForDocumentTab(resolved.path)
    else await new Promise(resolve => setTimeout(resolve, 200))
    await applyCitationView(resolved.citation, resolved.options)
    markCitationTiming('apply-done')
  }
  return (
    <section ref={sectionRef} data-kb-sources={String(turn)} style={{ margin: '2px 0 8px' }}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => { setOpen(current => !current) }}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '3px 0',
          border: 0, background: 'transparent', color: 'var(--dsw-alias-label-secondary, #667085)',
          font: 'inherit', fontSize: 13, lineHeight: '22px', textAlign: 'left', cursor: 'pointer',
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <span>使用了 {count} 个来源</span>
      </button>
      {open ? (
        <ul style={{ display: 'flex', flexDirection: 'column', gap: 2, margin: '3px 0 0', padding: 0, listStyle: 'none' }}>
          {citations.map((citation, index) => (
            <li key={citation.raw + ':' + String(index)}>
              <button
                type="button"
                title={citation.title}
                onClick={() => { void openOne(citation) }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '4px 6px',
                  border: 0, borderRadius: 4, background: 'transparent',
                  color: 'var(--dsw-alias-label-primary, #111)', font: 'inherit', fontSize: 13,
                  lineHeight: '22px', textAlign: 'left', cursor: 'pointer',
                }}
              >
                <span style={{ display: 'inline-flex', color: 'var(--dsw-alias-state-business-primary, #2563eb)' }}><SourceIcon /></span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{labelOf(citation)}</span>
                {citation.heading === undefined && citation.page === undefined ? null : (
                  <span style={{ flex: 'none', color: 'var(--dsw-alias-label-tertiary, #98a2b3)', fontSize: 11 }}>
                    {citation.heading ?? ''}{citation.page === undefined ? '' : ' · p.' + String(citation.page)}
                  </span>
                )}
                <span style={{ marginLeft: 'auto', color: 'var(--dsw-alias-label-tertiary, #98a2b3)', fontSize: 10 }}>↗</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
