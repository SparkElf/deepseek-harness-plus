// @ts-nocheck
import { useEffect, useState } from 'react'
import { VscAdd, VscArrowDown, VscArrowUp, VscChevronDown, VscChevronLeft, VscChevronRight, VscClearAll, VscClose, VscFilter, VscListOrdered } from 'react-icons/vsc'
import type { CatalogColumn, ObjectPreviewRequest, PagedQueryResult, PreviewFilter, PreviewFilterLogic, PreviewFilterOperator, PreviewSort, QueryResult } from '../types.ts'
import { useT } from './i18n.tsx'
import { defaultPreviewOperator, previewFilterType, previewFilterValue, previewOperators } from './previewFilters.ts'
import css from './SqlWorkbench.module.css'

interface ResultGridProps { result: QueryResult | PagedQueryResult | null; onPreviewChange?(request: ObjectPreviewRequest): void }
interface FilterDraft { id: string; column: string; operator: PreviewFilterOperator; value: string }
type Builder = 'filters' | 'sorts' | null
let filterSequence = 0
function isPaged(result: QueryResult): result is PagedQueryResult { return 'page' in result && 'object' in result }
function nextFilter(column: CatalogColumn): FilterDraft { return { id: 'filter-' + String(++filterSequence), column: column.name, operator: defaultPreviewOperator(column), value: '' } }
function filterDraft(filter: PreviewFilter): FilterDraft { return { id: 'filter-' + String(++filterSequence), column: filter.column, operator: filter.operator, value: filter.value === undefined || filter.value === null ? '' : typeof filter.value === 'object' ? JSON.stringify(filter.value) : String(filter.value) } }
function filterLabel(filter: PreviewFilter, operator: string): string { const value = filter.value === undefined ? '' : ' ' + String(filter.value); return filter.column + ' ' + operator + value }

export function ResultGrid({ result, onPreviewChange }: ResultGridProps) {
  const t = useT()
  const [builder, setBuilder] = useState<Builder>(null)
  const [filterDrafts, setFilterDrafts] = useState<FilterDraft[]>([])
  const [sortDrafts, setSortDrafts] = useState<PreviewSort[]>([])
  const [filterLogic, setFilterLogic] = useState<PreviewFilterLogic>('and')
  const paged = result !== null && isPaged(result) ? result : null
  useEffect(() => {
    setFilterDrafts(paged?.filters.map(filterDraft) ?? [])
    setSortDrafts(paged?.sorts ?? (paged?.sort === null || paged?.sort === undefined ? [] : [paged.sort]))
    setFilterLogic(paged?.filterLogic ?? 'and')
    setBuilder(null)
  }, [paged])
  if (result === null) return <div className={css.empty}>{t('result.empty')}</div>
  const change = (request: ObjectPreviewRequest): void => { onPreviewChange?.(request) }
  const sorts = paged?.sorts ?? (paged?.sort === null || paged?.sort === undefined ? [] : [paged.sort])
  const base = (overrides: Partial<ObjectPreviewRequest> = {}): ObjectPreviewRequest | null => paged === null ? null : { object: paged.object, page: 1, pageSize: paged.pageSize, sorts, filters: paged.filters, filterLogic: paged.filterLogic, ...overrides }
  const serializeFilters = (): PreviewFilter[] => {
    if (paged === null) return []
    return filterDrafts.flatMap<PreviewFilter>(draft => {
      const column = paged.object.columns.find(item => item.name === draft.column)
      if (column === undefined) return []
      if (draft.operator === 'isNull' || draft.operator === 'isNotNull') return [{ column: draft.column, operator: draft.operator }]
      if (draft.value.trim() === '') return []
      return [{ column: draft.column, operator: draft.operator, value: previewFilterValue(column, draft.value) }]
    })
  }
  const applyFilters = (): void => { const request = base({ filters: serializeFilters(), filterLogic }); if (request !== null) change(request) }
  const clearFilters = (): void => { setFilterDrafts([]); const request = base({ filters: [], filterLogic: 'and' }); if (request !== null) change(request) }
  const removeFilter = (index: number): void => { if (paged === null) return; const filters = paged.filters.filter((_, item) => item !== index); setFilterDrafts(filters.map(filterDraft)); change({ ...base({ filters }) as ObjectPreviewRequest }) }
  const cycleSort = (column: string, additive: boolean): void => {
    if (paged === null) return
    const index = sorts.findIndex(sort => sort.column === column)
    let next: PreviewSort[]
    if (index < 0) next = additive ? [...sorts, { column, direction: 'asc' }] : [{ column, direction: 'asc' }]
    else if (sorts[index]?.direction === 'asc') next = additive ? sorts.map((sort, item) => item === index ? { ...sort, direction: 'desc' } : sort) : [{ column, direction: 'desc' }]
    else next = additive ? sorts.filter((_, item) => item !== index) : []
    setSortDrafts(next)
    const request = base({ sorts: next, sort: next[0] ?? null }); if (request !== null) change(request)
  }
  const removeSort = (index: number): void => { const next = sorts.filter((_, item) => item !== index); setSortDrafts(next); const request = base({ sorts: next, sort: next[0] ?? null }); if (request !== null) change(request) }
  const applySorts = (): void => { const request = base({ sorts: sortDrafts, sort: sortDrafts[0] ?? null }); if (request !== null) change(request) }
  const openColumnFilter = (column: string): void => { if (paged === null) return; setFilterDrafts(current => current.some(filter => filter.column === column) ? current : [...current, nextFilter(paged.object.columns.find(item => item.name === column) as CatalogColumn)]); setBuilder('filters') }
  const addFilter = (): void => { const column = paged?.object.columns[0]; if (column !== undefined) setFilterDrafts(current => [...current, nextFilter(column)]) }
  const addSort = (): void => { const column = paged?.object.columns.find(item => !sortDrafts.some(sort => sort.column === item.name)) ?? paged?.object.columns[0]; if (column !== undefined) setSortDrafts(current => [...current, { column: column.name, direction: 'asc' }]) }
  const moveSort = (index: number, offset: number): void => { const target = index + offset; if (target < 0 || target >= sortDrafts.length) return; setSortDrafts(current => { const next = [...current]; const [item] = next.splice(index, 1); next.splice(target, 0, item as PreviewSort); return next }) }
  const rowOffset = paged === null ? 0 : (paged.page - 1) * paged.pageSize
  return <div className={css.resultArea} data-sql-result-grid>
    {paged !== null && <>
      <div className={css.resultTools}>
        <button className={css.toolButton} data-active={builder === 'filters' || paged.filters.length > 0} onClick={() => { setBuilder(builder === 'filters' ? null : 'filters'); if (filterDrafts.length === 0) addFilter() }}><VscFilter />{t('result.filters')}{paged.filters.length > 0 && <b>{paged.filters.length}</b>}</button>
        <button className={css.toolButton} data-active={builder === 'sorts' || sorts.length > 0} onClick={() => { setBuilder(builder === 'sorts' ? null : 'sorts'); setSortDrafts(sorts) }}><VscListOrdered />{t('result.sorts')}{sorts.length > 0 && <b>{sorts.length}</b>}</button>
        {(paged.filters.length > 0 || sorts.length > 0) && <button className={css.iconButton} title={t('result.clearAllCriteria')} onClick={() => { setFilterDrafts([]); setSortDrafts([]); const request = base({ filters: [], filterLogic: 'and', sorts: [], sort: null }); if (request !== null) change(request) }}><VscClearAll /></button>}
        <div className={css.criteriaSummary}>{paged.filters.map((filter, index) => <span key={'filter-' + String(index)}><VscFilter />{filterLabel(filter, t(('operator.' + filter.operator) as Parameters<typeof t>[0]))}<button title={t('result.removeCriterion')} onClick={() => { removeFilter(index) }}><VscClose /></button></span>)}{sorts.map((sort, index) => <span key={'sort-' + sort.column}><b>{index + 1}</b>{sort.column}{sort.direction === 'asc' ? <VscArrowUp /> : <VscArrowDown />}<button title={t('result.removeCriterion')} onClick={() => { removeSort(index) }}><VscClose /></button></span>)}</div>
      </div>
      {builder === 'filters' && <section className={css.criteriaBuilder} aria-label={t('result.filterBuilder')}>
        <header><strong>{t('result.filters')}</strong><label>{t('result.match')}<select value={filterLogic} onChange={event => { setFilterLogic(event.target.value as PreviewFilterLogic) }}><option value="and">{t('result.matchAll')}</option><option value="or">{t('result.matchAny')}</option></select></label><span /><button className={css.iconButton} title={t('result.closeBuilder')} onClick={() => { setBuilder(null) }}><VscClose /></button></header>
        <div className={css.builderRows}>{filterDrafts.map((draft, index) => { const metadata = paged.object.columns.find(column => column.name === draft.column) ?? paged.object.columns[0]; if (metadata === undefined) return null; const requiresValue = draft.operator !== 'isNull' && draft.operator !== 'isNotNull'; const inputType = previewFilterType(metadata); return <div className={css.builderRow} key={draft.id}><select aria-label={t('result.filterColumn')} value={draft.column} onChange={event => { const column = paged.object.columns.find(item => item.name === event.target.value) as CatalogColumn; setFilterDrafts(current => current.map((filter, item) => item === index ? { ...filter, column: column.name, operator: defaultPreviewOperator(column), value: '' } : filter)) }}>{paged.object.columns.map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select><select aria-label={t('result.filterOperator', { column: draft.column })} value={draft.operator} onChange={event => { setFilterDrafts(current => current.map((filter, item) => item === index ? { ...filter, operator: event.target.value as PreviewFilterOperator } : filter)) }}>{previewOperators(metadata).map(operator => <option key={operator} value={operator}>{t(('operator.' + operator) as Parameters<typeof t>[0])}</option>)}</select>{requiresValue ? inputType === 'boolean' ? <select aria-label={t('result.filterValue', { column: draft.column })} value={draft.value} onChange={event => { setFilterDrafts(current => current.map((filter, item) => item === index ? { ...filter, value: event.target.value } : filter)) }}><option value="">-</option><option value="true">true</option><option value="false">false</option></select> : <input type={inputType === 'number' ? 'number' : inputType === 'date' ? 'date' : 'text'} aria-label={t('result.filterValue', { column: draft.column })} value={draft.value} placeholder={t('result.value')} onChange={event => { setFilterDrafts(current => current.map((filter, item) => item === index ? { ...filter, value: event.target.value } : filter)) }} onKeyDown={event => { if (event.key === 'Enter') applyFilters() }} /> : <span className={css.noValue}>-</span>}<button className={css.iconButton} title={t('result.removeCriterion')} onClick={() => { setFilterDrafts(current => current.filter((_, item) => item !== index)) }}><VscClose /></button></div> })}</div>
        <footer><button className={css.commandButton} onClick={addFilter}><VscAdd />{t('result.addCondition')}</button><span /><button className={css.commandButton} onClick={clearFilters}><VscClearAll />{t('result.clearFilters')}</button><button className={css.primaryButton} onClick={() => { applyFilters(); setBuilder(null) }}><VscFilter />{t('result.applyFilters')}</button></footer>
      </section>}
      {builder === 'sorts' && <section className={css.criteriaBuilder} aria-label={t('result.sortBuilder')}>
        <header><strong>{t('result.sorts')}</strong><span /><button className={css.iconButton} title={t('result.closeBuilder')} onClick={() => { setBuilder(null) }}><VscClose /></button></header>
        <div className={css.builderRows}>{sortDrafts.map((sort, index) => <div className={css.sortBuilderRow} key={sort.column + String(index)}><b>{index + 1}</b><select aria-label={t('result.sortColumn')} value={sort.column} onChange={event => { setSortDrafts(current => current.map((item, row) => row === index ? { ...item, column: event.target.value } : item)) }}>{paged.object.columns.map(column => <option key={column.name} value={column.name}>{column.name}</option>)}</select><select aria-label={t('result.sortDirection')} value={sort.direction} onChange={event => { setSortDrafts(current => current.map((item, row) => row === index ? { ...item, direction: event.target.value as PreviewSort['direction'] } : item)) }}><option value="asc">{t('result.ascending')}</option><option value="desc">{t('result.descending')}</option></select><button className={css.iconButton} title={t('result.moveUp')} disabled={index === 0} onClick={() => { moveSort(index, -1) }}><VscArrowUp /></button><button className={css.iconButton} title={t('result.moveDown')} disabled={index === sortDrafts.length - 1} onClick={() => { moveSort(index, 1) }}><VscArrowDown /></button><button className={css.iconButton} title={t('result.removeCriterion')} onClick={() => { setSortDrafts(current => current.filter((_, row) => row !== index)) }}><VscClose /></button></div>)}</div>
        <footer><button className={css.commandButton} onClick={addSort}><VscAdd />{t('result.addSort')}</button><span /><button className={css.commandButton} onClick={() => { setSortDrafts([]) }}><VscClearAll />{t('result.clearSorts')}</button><button className={css.primaryButton} onClick={() => { applySorts(); setBuilder(null) }}><VscListOrdered />{t('result.applySorts')}</button></footer>
      </section>}
    </>}
    <div className={css.resultScroll}><table className={css.resultTable}><thead><tr><th className={css.rowNumber}>#</th>{result.columns.map(column => { const sortIndex = sorts.findIndex(sort => sort.column === column); const activeFilter = paged?.filters.some(filter => filter.column === column) ?? false; return <th key={column}>{paged === null ? column : <div className={css.columnHeader}><button className={css.columnSort} title={t('result.sortHint')} onClick={event => { cycleSort(column, event.shiftKey) }}>{column}{sortIndex >= 0 && <><span>{sorts[sortIndex]?.direction === 'asc' ? '↑' : '↓'}</span>{sorts.length > 1 && <b>{sortIndex + 1}</b>}</>}</button><button className={css.columnFilter} data-active={activeFilter} title={t('result.filterColumnAction', { column })} onClick={() => { openColumnFilter(column) }}><VscChevronDown /></button></div>}</th> })}</tr></thead><tbody>{result.rows.map((row, rowIndex) => <tr key={rowIndex}><td className={css.rowNumber}>{rowOffset + rowIndex + 1}</td>{row.map((cell, columnIndex) => <td key={columnIndex} data-null={cell === null}>{cell === null ? 'NULL' : typeof cell === 'object' ? JSON.stringify(cell) : String(cell)}</td>)}</tr>)}</tbody></table></div>
    <div className={css.resultStatus}><span>{t('result.status', { rows: result.rowCount, duration: result.durationMs })}</span>{paged !== null && <div className={css.pagination}><span>{t('result.total', { rows: paged.totalRows })}</span><button className={css.iconButton} title={t('result.previous')} disabled={!paged.hasPrevious} onClick={() => { const request = base({ page: paged.page - 1 }); if (request !== null) change(request) }}><VscChevronLeft /></button><span>{t('result.page', { page: paged.page, pages: paged.totalPages })}</span><button className={css.iconButton} title={t('result.next')} disabled={!paged.hasNext} onClick={() => { const request = base({ page: paged.page + 1 }); if (request !== null) change(request) }}><VscChevronRight /></button><select value={paged.pageSize} onChange={event => { const request = base({ page: 1, pageSize: Number(event.target.value) }); if (request !== null) change(request) }}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option><option value={200}>200</option></select></div>}</div>
  </div>
}
