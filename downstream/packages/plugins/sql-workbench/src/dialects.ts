import type {
  CatalogObject,
  ConnectionKind,
  DriverCapabilities,
  JsonValue,
  ObjectPreviewRequest,
  PreviewFilter,
} from './types.ts'

export interface PreviewSqlPlan {
  readonly countSql: string
  readonly countParams: JsonValue[]
  readonly dataSql: string
  readonly dataParams: JsonValue[]
  readonly page: number
  readonly pageSize: number
  readonly offset: number
}

export const DRIVER_CAPABILITIES: Readonly<Record<ConnectionKind, DriverCapabilities>> = {
  sqlite: { kind: 'sqlite', label: 'SQLite', protocol: 'file', defaultPort: null, versionRange: '3.x', schemas: false, views: true, indexes: true, estimatedRows: false, serverPagination: true, serverSort: true, serverFilter: true },
  postgres: { kind: 'postgres', label: 'PostgreSQL', protocol: 'postgres', defaultPort: 5432, versionRange: '12-18', schemas: true, views: true, indexes: true, estimatedRows: true, serverPagination: true, serverSort: true, serverFilter: true },
  mysql: { kind: 'mysql', label: 'MySQL', protocol: 'mysql', defaultPort: 3306, versionRange: '5.7, 8.0, 8.4', schemas: false, views: true, indexes: true, estimatedRows: true, serverPagination: true, serverSort: true, serverFilter: true },
  mariadb: { kind: 'mariadb', label: 'MariaDB', protocol: 'mysql', defaultPort: 3306, versionRange: '10.6, 10.11, 11.x', schemas: false, views: true, indexes: true, estimatedRows: true, serverPagination: true, serverSort: true, serverFilter: true },
  doris: { kind: 'doris', label: 'Apache Doris', protocol: 'mysql', defaultPort: 9030, versionRange: '2.x, 3.x', schemas: false, views: true, indexes: false, estimatedRows: true, serverPagination: true, serverSort: true, serverFilter: true },
  oracle: { kind: 'oracle', label: 'Oracle Database', protocol: 'oracle', defaultPort: 1521, versionRange: '12c, 18c, 19c, 21c, 23ai', schemas: true, views: true, indexes: true, estimatedRows: true, serverPagination: true, serverSort: true, serverFilter: true },
}

export function driverCapabilities(kind: ConnectionKind): DriverCapabilities {
  return DRIVER_CAPABILITIES[kind]
}

export function quoteIdentifier(kind: ConnectionKind, value: string): string {
  if (kind === 'mysql' || kind === 'mariadb' || kind === 'doris') {
    const tick = String.fromCharCode(96)
    return tick + value.replaceAll(tick, tick + tick) + tick
  }
  return '"' + value.replaceAll('"', '""') + '"'
}

export function qualifiedObjectName(kind: ConnectionKind, object: CatalogObject): string {
  const names = kind === 'postgres' || kind === 'oracle'
    ? [object.schema, object.name]
    : kind === 'mysql' || kind === 'mariadb' || kind === 'doris'
      ? [object.database, object.name]
      : [object.name]
  return names.filter((name): name is string => name !== null && name !== '').map(name => quoteIdentifier(kind, name)).join('.')
}

function placeholder(kind: ConnectionKind, index: number): string {
  if (kind === 'postgres') return '$' + String(index)
  if (kind === 'oracle') return ':p' + String(index)
  return '?'
}

function assertColumn(object: CatalogObject, column: string): void {
  if (!object.columns.some(candidate => candidate.name === column)) throw new Error('Unknown preview column: ' + column)
}

function filterClause(kind: ConnectionKind, object: CatalogObject, filter: PreviewFilter, params: JsonValue[]): string {
  assertColumn(object, filter.column)
  const column = quoteIdentifier(kind, filter.column)
  if (filter.operator === 'isNull') return column + ' IS NULL'
  if (filter.operator === 'isNotNull') return column + ' IS NOT NULL'
  if (filter.value === undefined) throw new Error('Preview filter requires a value: ' + filter.column)
  let value = filter.value
  let operator: string
  if (filter.operator === 'eq') operator = '='
  else if (filter.operator === 'neq') operator = '<>'
  else if (filter.operator === 'gt') operator = '>'
  else if (filter.operator === 'gte') operator = '>='
  else if (filter.operator === 'lt') operator = '<'
  else if (filter.operator === 'lte') operator = '<='
  else {
    if (typeof value !== 'string') throw new Error('Text preview filter requires a string: ' + filter.column)
    value = filter.operator === 'startsWith' ? value + '%' : '%' + value + '%'
    operator = 'LIKE'
  }
  params.push(value)
  return column + ' ' + operator + ' ' + placeholder(kind, params.length)
}

export function buildPreviewSql(kind: ConnectionKind, request: ObjectPreviewRequest): PreviewSqlPlan {
  const page = Math.max(1, Math.trunc(request.page || 1))
  const pageSize = Math.min(500, Math.max(10, Math.trunc(request.pageSize || 50)))
  const offset = (page - 1) * pageSize
  const countParams: JsonValue[] = []
  const clauses = (request.filters ?? []).map(filter => filterClause(kind, request.object, filter, countParams))
  const filterLogic = request.filterLogic === 'or' ? 'OR' : 'AND'
  const where = clauses.length === 0 ? '' : ' WHERE ' + clauses.join(' ' + filterLogic + ' ')
  const qualified = qualifiedObjectName(kind, request.object)
  const countSql = 'SELECT COUNT(*) AS ' + quoteIdentifier(kind, '__dsh_total') + ' FROM ' + qualified + where
  const sorts = request.sorts ?? (request.sort === undefined || request.sort === null ? [] : [request.sort])
  for (const sort of sorts) assertColumn(request.object, sort.column)
  const order = sorts.length === 0 ? '' : ' ORDER BY ' + sorts.map(sort => quoteIdentifier(kind, sort.column) + ' ' + sort.direction.toUpperCase()).join(', ')
  const dataParams = [...countParams]
  let pagination: string
  if (kind === 'oracle') {
    dataParams.push(offset, pageSize)
    pagination = ' OFFSET ' + placeholder(kind, dataParams.length - 1) + ' ROWS FETCH NEXT ' + placeholder(kind, dataParams.length) + ' ROWS ONLY'
  } else {
    dataParams.push(pageSize, offset)
    pagination = ' LIMIT ' + placeholder(kind, dataParams.length - 1) + ' OFFSET ' + placeholder(kind, dataParams.length)
  }
  return { countSql, countParams, dataSql: 'SELECT * FROM ' + qualified + where + order + pagination, dataParams, page, pageSize, offset }
}
