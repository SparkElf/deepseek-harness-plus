/**
 * The graph tab's data hook.
 *
 * The tree is loaded once per activation and kept across tab switches: moving back
 * to 「知识库」 and forward to 「图谱」 must not refetch or remount into a blank
 * canvas, because the tab is the same navigation surface with a different data
 * source. A caller that changes permissions reloads through {@link reload}.
 *
 * The Host's answer is already permission-filtered; this hook never filters by
 * itself and never receives a raw scope to trim.
 *
 * @module @sparkelf/dsh-knowledge-base/client/graph/useKnowledgeGraph
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { KB_API, kbApiPath, readKnowledgeJson } from '../../api.ts'
import {
  emptyKnowledgeGraphTree,
  type KnowledgeGraphTree,
} from '../../graphTypes.ts'

/** The four states the panel and the rail tree render. */
export type KnowledgeGraphLoadState =
  | { kind: 'idle'; tree: KnowledgeGraphTree }
  | { kind: 'loading'; tree: KnowledgeGraphTree }
  | { kind: 'ready'; tree: KnowledgeGraphTree }
  | { kind: 'failed'; tree: KnowledgeGraphTree; error: string }

/** What the hook returns: the state plus the manual reload. */
export type KnowledgeGraphController = KnowledgeGraphLoadState & {
  /** Re-read the tree, keeping the previous one visible while it loads. */
  reload: () => Promise<void>
}

/**
 * Load the permission-filtered graph tree when the graph tab is first shown.
 *
 * @param active - whether the graph tab is the current scope.
 * @returns The load state and a reload function.
 */
export function useKnowledgeGraph(active: boolean): KnowledgeGraphController {
  const [state, setState] = useState<KnowledgeGraphLoadState>({ kind: 'idle', tree: emptyKnowledgeGraphTree() })
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const reload = useCallback(async (): Promise<void> => {
    setState(previous => ({ kind: 'loading', tree: previous.tree }))
    try {
      const response = await fetch(kbApiPath(KB_API.graph), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        cache: 'no-store',
      })
      const body = await readKnowledgeJson<Record<string, unknown>>(response)
      if (!response.ok || typeof body.error === 'string') {
        throw new Error(typeof body.error === 'string' ? body.error : 'HTTP ' + String(response.status))
      }
      const tree = body as unknown as KnowledgeGraphTree
      if (!mounted.current) return
      setState({ kind: 'ready', tree })
    } catch (error) {
      if (!mounted.current) return
      setState(previous => ({
        kind: 'failed',
        tree: previous.tree,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }, [])

  useEffect(() => {
    if (active && state.kind === 'idle') void reload()
  }, [active, state.kind, reload])

  return { ...state, reload }
}
