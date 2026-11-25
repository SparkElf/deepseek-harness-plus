// @ts-nocheck
import { useEffect, useRef } from 'react'
import { basicSetup } from 'codemirror'
import { defaultKeymap, historyKeymap } from '@codemirror/commands'
import { MariaSQL, MySQL, PLSQL, PostgreSQL, SQLite, sql } from '@codemirror/lang-sql'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import type { ConnectionKind } from '../types.ts'

export interface CodeEditorProps {
  value: string
  kind: ConnectionKind
  onChange(value: string): void
  onCommit(value: string): void
  /** Read-only mode, used by the inspector's DDL tab. */
  readOnly?: boolean
}

function dialect(kind: ConnectionKind) {
  if (kind === 'postgres') return PostgreSQL
  if (kind === 'mysql' || kind === 'doris') return MySQL
  if (kind === 'mariadb') return MariaSQL
  if (kind === 'oracle') return PLSQL
  return SQLite
}

const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    backgroundColor: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
    font: 'var(--dsw-font-markdown-code-block-small)',
  },
  '.cm-content': { caretColor: 'var(--dsw-alias-state-business-primary)', padding: '10px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--dsw-alias-bg-layer-1)',
    color: 'var(--dsw-alias-label-caption)',
    borderRight: '1px solid var(--dsw-alias-border-l1)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover-solid)' },
  '&.cm-focused .cm-selectionBackground, ::selection': { backgroundColor: 'var(--dsw-alias-state-business-tertiary)' },
})

/** CodeMirror 生命周期归组件所有，外部 AI 更新与本地输入都落到同一文档。 */
export function CodeEditor({ value, kind, onChange, onCommit, readOnly = false }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const applyingRef = useRef(false)
  const changeRef = useRef(onChange)
  const commitRef = useRef(onCommit)
  changeRef.current = onChange
  commitRef.current = onCommit

  useEffect(() => {
    const host = hostRef.current
    if (host === null) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        sql({ dialect: dialect(kind) }),
        ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
        editorTheme,
        EditorView.updateListener.of(update => {
          if (update.docChanged && !applyingRef.current) changeRef.current(update.state.doc.toString())
        }),
        EditorView.domEventHandlers({
          blur: (_event, view) => {
            commitRef.current(view.state.doc.toString())
            return false
          },
        }),
      ],
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
  }, [kind, readOnly])

  useEffect(() => {
    const view = viewRef.current
    if (view === null || view.state.doc.toString() === value) return
    applyingRef.current = true
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
    applyingRef.current = false
  }, [value])

  return <div ref={hostRef} data-sql-editor />
}
