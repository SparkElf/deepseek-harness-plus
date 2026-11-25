// @ts-nocheck
import type { CatalogColumn, JsonValue, PreviewFilter, PreviewFilterOperator } from '../types.ts'

export interface PreviewFilterState {
  operator: PreviewFilterOperator
  value: string
}

const NUMBER_TYPE = /(?:^|\W)(?:bigint|bigserial|decimal|double|float|int|integer|money|numeric|number|real|serial|smallint|tinyint)(?:\W|$)/i
const DATE_TYPE = /(?:date|time|timestamp|interval|year)/i
const BOOLEAN_TYPE = /(?:bool|boolean|bit\s*\(1\))/i

export type PreviewFilterType = 'text' | 'number' | 'date' | 'boolean'

export function previewFilterType(column: CatalogColumn): PreviewFilterType {
  if (BOOLEAN_TYPE.test(column.dataType)) return 'boolean'
  if (NUMBER_TYPE.test(column.dataType)) return 'number'
  if (DATE_TYPE.test(column.dataType)) return 'date'
  return 'text'
}

export function defaultPreviewOperator(column: CatalogColumn): PreviewFilterOperator {
  return previewFilterType(column) === 'text' ? 'contains' : 'eq'
}

export function previewOperators(column: CatalogColumn): PreviewFilterOperator[] {
  const type = previewFilterType(column)
  if (type === 'text') return ['contains', 'startsWith', 'eq', 'neq', 'isNull', 'isNotNull']
  if (type === 'boolean') return ['eq', 'neq', 'isNull', 'isNotNull']
  return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'isNotNull']
}

export function previewFilterValue(column: CatalogColumn, value: string): JsonValue {
  const type = previewFilterType(column)
  if (type === 'number') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (type === 'boolean') {
    if (/^(?:true|1)$/i.test(value)) return true
    if (/^(?:false|0)$/i.test(value)) return false
  }
  return value
}

export function previewFilterStates(columns: CatalogColumn[], filters: PreviewFilter[]): Record<string, PreviewFilterState> {
  const states: Record<string, PreviewFilterState> = {}
  for (const column of columns) {
    const filter = filters.find(item => item.column === column.name)
    states[column.name] = {
      operator: filter?.operator ?? defaultPreviewOperator(column),
      value: filter?.value === undefined || filter.value === null ? '' : String(filter.value),
    }
  }
  return states
}

export function buildPreviewFilters(columns: CatalogColumn[], states: Record<string, PreviewFilterState>): PreviewFilter[] {
  const filters: PreviewFilter[] = []
  for (const column of columns) {
    const state = states[column.name]
    if (state === undefined) continue
    if (state.operator === 'isNull' || state.operator === 'isNotNull') {
      filters.push({ column: column.name, operator: state.operator })
    } else if (state.value !== '') {
      filters.push({ column: column.name, operator: state.operator, value: previewFilterValue(column, state.value) })
    }
  }
  return filters
}
