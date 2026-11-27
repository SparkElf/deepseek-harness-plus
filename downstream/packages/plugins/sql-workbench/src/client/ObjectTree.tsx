// @ts-nocheck
import { useEffect, useRef, useState } from 'react'
import {
  VscChevronDown,
  VscChevronRight,
  VscDatabase,
  VscEye,
  VscFolder,
  VscSymbolField,
  VscTable,
} from 'react-icons/vsc'
import type { CatalogDatabase, CatalogObject, CatalogSnapshot } from '../types.ts'
import { useT } from './i18n.tsx'
import css from './SqlWorkbench.module.css'

export type ObjectContextTarget =
  | { kind: 'database'; database: CatalogDatabase }
  | { kind: 'object'; object: CatalogObject }

export interface ObjectTreeProps {
  catalog: CatalogSnapshot | null
  search: string
  selectedDatabase: CatalogDatabase | null
  selected: CatalogObject | null
  onSelectDatabase(database: CatalogDatabase): void
  onSelect(object: CatalogObject): void
  onPreview(object: CatalogObject): void
  onContextMenu(event: React.MouseEvent, target: ObjectContextTarget): void
}

function Toggle({ open }: { open: boolean }) {
  return open ? <VscChevronDown size={14} /> : <VscChevronRight size={14} />
}

/** Navicat 式对象树，数据库、Schema、表/视图和列使用一致的逐级展开行为。 */
export function ObjectTree({ catalog, search, selectedDatabase, selected, onSelectDatabase, onSelect, onPreview, onContextMenu }: ObjectTreeProps) {
  const t = useT()
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const toggle = (key: string): void => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }
  useEffect(() => () => {
    if (clickTimer.current !== null) clearTimeout(clickTimer.current)
  }, [])
  const selectObject = (object: CatalogObject): void => {
    if (clickTimer.current !== null) clearTimeout(clickTimer.current)
    clickTimer.current = setTimeout(() => { clickTimer.current = null; onSelect(object) }, 180)
  }
  const previewObject = (object: CatalogObject): void => {
    if (clickTimer.current !== null) clearTimeout(clickTimer.current)
    clickTimer.current = null
    onPreview(object)
  }
  if (catalog === null) return <div className={css.empty}>{t('tree.selectConnection')}</div>
  const keyword = search.trim().toLowerCase()

  return <div className={css.tree} data-sql-object-tree>
    {catalog.databases.map(database => {
      const databaseKey = 'db:' + database.name
      const databaseOpen = expanded.has(databaseKey) || keyword !== ''
      return <div key={databaseKey}>
        <button
          className={css.treeRow}
          data-selected={selectedDatabase?.name === database.name}
          onClick={() => { onSelectDatabase(database); toggle(databaseKey) }}
          onContextMenu={event => { onContextMenu(event, { kind: 'database', database }) }}
        >
          <Toggle open={databaseOpen} />
          <VscDatabase size={15} />
          <span>{database.name}</span>
        </button>
        {databaseOpen && database.schemas.map(schema => {
          const schemaKey = databaseKey + ':schema:' + String(schema.name)
          const schemaOpen = expanded.has(schemaKey) || keyword !== ''
          const objects = schema.objects.filter(object => keyword === '' || object.name.toLowerCase().includes(keyword))
          return <div key={schemaKey} className={css.treeLevel}>
            {schema.name !== null && <button className={css.treeRow} onClick={() => { toggle(schemaKey) }}>
              <Toggle open={schemaOpen} />
              <VscFolder size={15} />
              <span>{schema.name}</span>
            </button>}
            {(schema.name === null || schemaOpen) && objects.map(object => {
              const objectKey = schemaKey + ':object:' + object.name
              const objectOpen = expanded.has(objectKey)
              return <div key={objectKey} className={schema.name === null ? '' : css.treeLevel}>
                <button
                  className={css.treeRow}
                  data-selected={selected?.database === object.database && selected.schema === object.schema && selected.name === object.name}
                  onClick={() => { selectObject(object) }}
                  onDoubleClick={() => { previewObject(object) }}
                  onContextMenu={event => { onContextMenu(event, { kind: 'object', object }) }}
                >
                  <span onClick={event => { event.stopPropagation(); toggle(objectKey) }}><Toggle open={objectOpen} /></span>
                  {object.kind === 'table' ? <VscTable size={15} /> : <VscEye size={15} />}
                  <span>{object.name}</span>
                  <span className={css.rowMeta}>{object.columns.length}</span>
                </button>
                {objectOpen && object.columns.map(column => <div key={column.name} className={css.treeLevel}>
                  <div className={css.treeRow}>
                    <span className={css.treeSpacer} />
                    <VscSymbolField size={14} />
                    <span>{column.name}</span>
                    <span className={css.rowMeta}>{column.dataType}</span>
                  </div>
                </div>)}
              </div>
            })}
          </div>
        })}
      </div>
    })}
  </div>
}
