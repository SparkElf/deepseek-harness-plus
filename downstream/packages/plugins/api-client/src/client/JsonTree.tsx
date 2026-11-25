/**
 * A collapsible JSON tree for the response viewer.
 *
 * The pretty tab used to be formatted text. Text answers "what does the body say"; it does
 * not answer "where in this 400-line object is the field I need", which is the question a
 * reader actually has. A tree folds the branches, and every node carries its own path so a
 * value can be pasted into code or a ticket without counting brackets.
 *
 * @module @sparkelf/dsh-api-client/client
 */

import { useState } from 'react'
import { VscCheck, VscChevronDown, VscChevronRight, VscCopy } from 'react-icons/vsc'
import { jsonPathLabel } from './model.ts'
import { copyText } from './clipboard.ts'
import { useT } from './i18n.tsx'
import css from './ApiClient.module.css'

/** A JSON value as `JSON.parse` produces it. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/**
 * Parse a response body as JSON.
 * @param body - the raw text.
 * @returns the parsed value, or undefined when the body is not JSON.
 */
export function parseJsonValue(body: string): JsonValue | undefined {
  try { return JSON.parse(body) as JsonValue } catch { return undefined }
}

/** Render one primitive with the token that names its type. */
function Primitive({ value }: { value: null | boolean | number | string }) {
  if (value === null) return <span className={css.jsonNull}>null</span>
  if (typeof value === 'string') return <span className={css.jsonString}>{JSON.stringify(value)}</span>
  if (typeof value === 'boolean') return <span className={css.jsonBoolean}>{String(value)}</span>
  return <span className={css.jsonNumber}>{String(value)}</span>
}

/** One node: a primitive row, or a container header plus its children. */
function Node({ name, value, path, depth }: { name?: string; value: JsonValue; path: (string | number)[]; depth: number }) {
  const t = useT()
  const container = typeof value === 'object' && value !== null
  const entries: Array<[string | number, JsonValue]> = container
    ? Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value)
    : []
  const [open, setOpen] = useState(depth < 2)
  const [copied, setCopied] = useState(false)
  const pathLabel = jsonPathLabel(path)
  const copy = async (): Promise<void> => {
    if (await copyText(pathLabel)) {
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1_200)
    }
  }
  return <div className={css.jsonNode}>
    <div className={css.jsonRow} style={{ paddingLeft: String(depth * 12) + 'px' }}>
      {container ? (
        <button type="button" className={css.jsonToggle} aria-label={open ? t('json.collapse', { path: pathLabel }) : t('json.expand', { path: pathLabel })} onClick={() => { setOpen(current => !current) }}>
          {open ? <VscChevronDown aria-hidden="true" /> : <VscChevronRight aria-hidden="true" />}
        </button>
      ) : <span className={css.jsonToggleSpacer} />}
      {name === undefined ? null : <span className={css.jsonKey}>{name}</span>}
      {container ? (
        <span className={css.jsonPunct}>
          {Array.isArray(value) ? '[' : '{'}
          {open ? '' : ' … ' + String(entries.length) + ' ' + (Array.isArray(value) ? 'items' : 'keys')}
          {open ? '' : Array.isArray(value) ? ']' : '}'}
        </span>
      ) : <Primitive value={value} />}
      <button type="button" className={css.jsonCopy} aria-label={t('json.copyPath', { path: pathLabel })} title={pathLabel} onClick={() => { void copy() }}>
        {copied ? <VscCheck aria-hidden="true" /> : <VscCopy aria-hidden="true" />}
      </button>
    </div>
    {container && open && (
      <div>
        {entries.map(([key, child]) => <Node key={String(key)} name={String(key)} value={child} path={[...path, key]} depth={depth + 1} />)}
        <div className={css.jsonRow} style={{ paddingLeft: String(depth * 12) + 'px' }}>
          <span className={css.jsonToggleSpacer} /><span className={css.jsonPunct}>{Array.isArray(value) ? ']' : '}'}</span>
        </div>
      </div>
    )}
  </div>
}

/**
 * Render one parsed JSON document.
 * @param props.value - the parsed body.
 * @returns the tree.
 */
export function JsonTree({ value }: { value: JsonValue }) {
  return <div className={css.jsonTree} data-json-tree><Node value={value} path={[]} depth={0} /></div>
}
