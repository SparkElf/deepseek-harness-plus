/**
 * The knowledge base's search: find a document, then open it.
 *
 * The field itself lives in the page's rail, not here, because it is navigation:
 * a reader reaches "find a document" the same way they reach the permission or
 * indexing section, and a menu row labelled "Search" asked them to click through
 * to a box before they could type. `useKnowledgeSearch` owns the one piece of
 * state both halves need, so the rail's field and this result list cannot
 * disagree about which term produced which hits.
 *
 * This replaces an earlier summary of mount state, which answered a question the
 * operator had not asked: the mount path, the file count, and a sync timestamp are
 * facts about the deployment, while the reason to open this page is to locate a
 * document.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconSearchOutlineRegular,
  IconWarningOutline16,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { KB_API, kbApiPath, readKnowledgeJson } from '../api.ts'
import styles from './KnowledgePanel.module.css'

/** One result row, as the Host returns it. */
interface SearchHit {
  /** Path relative to the mount point. */
  relPath: string
  /** File name alone. */
  name: string
  /** Whether the term matched the file body rather than only its name. */
  inContent: boolean
  /** Matching line, when the term was found inside the file. */
  line?: string
  /** 1-based line number of {@link line}. */
  lineNumber?: number
  /** Last-modified instant in Unix ms, when the Host could stat the file. */
  mtimeMs?: number
}

/** How long typing must pause before a search runs. */
const DEBOUNCE_MS = 250

/**
 * Render a modification instant the way a reader compares them: at a glance.
 *
 * A raw timestamp invites mental arithmetic, and the recent past is what matters
 * when deciding whether a document is current, so anything inside a week reads as
 * a relative span and older dates show the date alone.
 * @param mtimeMs - the instant, in Unix ms.
 * @param locale - locale tag for the absolute form.
 * @returns A short label, or undefined when there is no instant.
 */
function shortTime(mtimeMs: number | undefined, locale: string): string | undefined {
  if (mtimeMs === undefined) return undefined
  const then = new Date(mtimeMs)
  const minutes = Math.floor((Date.now() - mtimeMs) / 60000)
  if (minutes < 1) return locale.startsWith('zh') ? '刚刚' : 'just now'
  if (minutes < 60) return String(minutes) + (locale.startsWith('zh') ? ' 分钟前' : 'm ago')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return String(hours) + (locale.startsWith('zh') ? ' 小时前' : 'h ago')
  const days = Math.floor(hours / 24)
  if (days < 7) return String(days) + (locale.startsWith('zh') ? ' 天前' : 'd ago')
  return then.toLocaleDateString(locale.startsWith('zh') ? 'zh-CN' : 'en-US', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

/** What {@link useKnowledgeSearch} hands back to the rail and the result list. */
export interface KnowledgeSearchState {
  /** Current term, owned here so the field and the results read one value. */
  term: string
  /** Replace the term. */
  setTerm: (value: string) => void
  /** Hits for the settled term, empty while idle. */
  hits: SearchHit[]
  /** Which surface the result list should draw. */
  status: 'idle' | 'searching' | 'done' | 'error'
  /** Index of the keyboard-highlighted row. */
  active: number
  /** Highlight a row, so pointer movement and the arrow keys agree. */
  setActive: (index: number) => void
  /** Arrow-key handling for the rail's field. */
  onKeyDown: (event: { key: string; preventDefault: () => void }) => void
}

/**
 * Own the search term, its debounced request, and the highlighted row.
 *
 * Extracted rather than left inside the result component because the field it is
 * driven by now sits in the rail: a hook keeps one owner for the term while the
 * input and the list render in different regions of the page.
 *
 * @param mountPoint - the mount to search; empty while the page is still loading.
 * @returns The term, its hits, and the keyboard handler for the field.
 */
export function useKnowledgeSearch(mountPoint: string): KnowledgeSearchState {
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [status, setStatus] = useState<'idle' | 'searching' | 'done' | 'error'>('idle')
  const [active, setActive] = useState(0)
  const seq = useRef(0)

  const run = useCallback(async (value: string) => {
    if (value.trim() === '' || mountPoint === '') {
      setHits([])
      setStatus('idle')
      return
    }
    // Results are matched to the request that produced them, so a slower earlier
    // search cannot overwrite a newer one's results.
    const mine = ++seq.current
    setStatus('searching')
    try {
      const response = await fetch(kbApiPath(KB_API.search), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ term: value }),
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(String(response.status))
      const body = await readKnowledgeJson<{ hits?: SearchHit[] }>(response)
      if (mine !== seq.current) return
      setHits(body.hits ?? [])
      setActive(0)
      setStatus('done')
    } catch {
      if (mine !== seq.current) return
      setHits([])
      setStatus('error')
    }
  }, [mountPoint])

  // Typing is debounced so a term is searched once it settles rather than per key.
  useEffect(() => {
    const timer = setTimeout(() => { void run(term) }, DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [term, run])

  /** Move the highlight, so the list is usable from the keyboard alone. */
  const onKeyDown = useCallback((event: { key: string; preventDefault: () => void }): void => {
    if (hits.length === 0) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(current => (current + 1) % hits.length)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => (current - 1 + hits.length) % hits.length)
    }
  }, [hits.length])

  return { term, setTerm, hits, status, active, setActive, onKeyDown }
}

/** Props for the result list. */
export interface KnowledgeSearchProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Term and hits, owned by {@link useKnowledgeSearch}. */
  search: KnowledgeSearchState
  /** Called with the chosen path so the page can show its preview. */
  onOpen: (path: string) => void
  /** Locale tag, used to render dates and relative spans in the reader's language. */
  locale?: string
  /** Shown while no term is entered, so the surface is useful before searching. */
  idle?: React.ReactNode
}

/**
 * Render the results for the rail's search field.
 * @param props - copy resolver, the search state, and the open callback.
 * @returns The result list, or the idle content when nothing is typed.
 */
export function KnowledgeSearch(props: KnowledgeSearchProps) {
  const { hits, status, active, setActive } = props.search

  return (
    <div className={styles.surface}>
      {status === 'idle' && props.idle}

      {/* The three non-result states share the product's centered panel state
          rather than a bare grey sentence: a caption-ink glyph over tertiary
          copy, which is how every panel without content reads in this product. */}
      {status === 'searching' && (
        <div className={styles.empty} role="status" aria-label={props.t('searching')}>
          <StateDot state="ongoing" />
          <p className={styles.emptyTitle}>{props.t('searching')}</p>
        </div>
      )}
      {status === 'error' && (
        <div className={styles.empty}>
          <IconWarningOutline16 size={24} className={styles.emptyGlyph} />
          <p className={styles.emptyTitle} role="alert">{props.t('searchFailed')}</p>
        </div>
      )}
      {status === 'done' && hits.length === 0 && (
        <div className={styles.empty} role="status">
          <IconSearchOutlineRegular size={24} className={styles.emptyGlyph} />
          <p className={styles.emptyTitle}>{props.t('searchEmpty')}</p>
        </div>
      )}

      {/* The results are a listbox of rows, not a stack of Buttons: the row is one
          line of text with a selected fill, and arrow keys move the selection,
          which is a different interaction from a button that activates on Enter. */}
      {hits.length > 0 && (
        <ul className={styles.hits}>
          {hits.map((hit, index) => (
            <li key={hit.relPath}>
              <button
                type="button"
                className={index === active ? styles.hitActive : styles.hit}
                onClick={() => { props.onOpen(hit.relPath) }}
                // Pointer movement selects, so clicking and arrowing agree on one
                // highlighted row instead of keeping two independent cursors.
                onMouseEnter={() => { setActive(index) }}
              >
                <span className={styles.hitName}>{hit.name}</span>
                <span className={styles.hitPath}>{hit.relPath}</span>
                {shortTime(hit.mtimeMs, props.locale ?? 'zh-CN') !== undefined && (
                  <span className={styles.hitTime}>{shortTime(hit.mtimeMs, props.locale ?? 'zh-CN')}</span>
                )}
                {hit.line !== undefined && (
                  <span className={styles.hitLine}>
                    <span className={styles.hitLineNo}>{String(hit.lineNumber ?? 0)}</span>
                    {hit.line}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
