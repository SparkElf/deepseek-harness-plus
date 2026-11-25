export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export type ConnectionKind = 'sqlite' | 'postgres' | 'mysql' | 'mariadb' | 'doris' | 'oracle'

export interface ConnectionBase {
  id: string
  name: string
  kind: ConnectionKind
  description?: string
  tags?: string[]
  versionHint?: string
  /**
   * DSH credential reference holding this connection's password.
   *
   * A connection saved by a model tool carries the reference, never the value: the tool
   * accepts no plaintext password, and the Host resolves the reference only for the duration
   * of a test or query. Connections configured in the UI keep using the workbench vault and
   * may omit this field.
   */
  credentialRef?: string
}

export interface SqliteConnection extends ConnectionBase {
  kind: 'sqlite'
  file: string
}

export interface NetworkConnection extends ConnectionBase {
  host: string
  port: number
  user: string
  password?: string
  database: string
  ssl?: boolean
}

export interface PostgresConnection extends NetworkConnection { kind: 'postgres' }
export interface MysqlConnection extends NetworkConnection { kind: 'mysql' | 'mariadb' | 'doris' }

export interface OracleConnection extends NetworkConnection {
  kind: 'oracle'
  serviceName: string
  privilege?: 'normal' | 'sysdba' | 'sysoper'
}

export type ConnectionConfig = SqliteConnection | PostgresConnection | MysqlConnection | OracleConnection

export interface DriverCapabilities {
  kind: ConnectionKind
  label: string
  protocol: 'file' | 'postgres' | 'mysql' | 'oracle'
  defaultPort: number | null
  versionRange: string
  schemas: boolean
  views: boolean
  indexes: boolean
  estimatedRows: boolean
  serverPagination: boolean
  serverSort: boolean
  serverFilter: boolean
}

export interface CatalogColumn {
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  ordinal: number
  comment?: string | null
}

export interface CatalogObject {
  kind: 'table' | 'view'
  database: string
  schema: string | null
  name: string
  columns: CatalogColumn[]
  definition: string | null
  comment?: string | null
  owner?: string | null
  engine?: string | null
  estimatedRows?: number | null
  sizeBytes?: number | null
}

export interface CatalogSchema {
  name: string | null
  objects: CatalogObject[]
}

export interface CatalogDatabase {
  name: string
  schemas: CatalogSchema[]
  product?: string
  version?: string
  charset?: string | null
  collation?: string | null
}

export interface CatalogSnapshot {
  connectionId: string
  capabilities?: DriverCapabilities
  databases: CatalogDatabase[]
}

export interface ObjectIndex {
  name: string
  unique: boolean
  primary: boolean
  columns: string[]
  type?: string | null
}

export interface ObjectConstraint {
  name: string
  kind: 'primary' | 'unique' | 'foreign' | 'check'
  columns: string[]
  definition?: string | null
}

/**
 * One foreign key, flattened from the constraint catalogue.
 *
 * The inspectors render it as "local columns → referenced table(columns)" and the
 * conversation reference serialises the same shape, so the mapping is done once on
 * the Host instead of being re-derived by each surface.
 */
export interface ObjectForeignKey {
  name: string
  columns: string[]
  referencedTable: string
  referencedColumns: string[]
  onDelete?: string | null
  onUpdate?: string | null
  definition?: string | null
}

/** A metadata block that failed while the rest of the object loaded. */
export interface ObjectDetailsBlockError {
  block: 'indexes' | 'constraints' | 'foreignKeys' | 'ddl'
  message: string
}

export interface ObjectDetails {
  connectionId: string
  capabilities: DriverCapabilities
  object: CatalogObject
  qualifiedName: string
  indexes: ObjectIndex[]
  constraints: ObjectConstraint[]
  foreignKeys: ObjectForeignKey[]
  /** Native DDL when the driver offers it, otherwise generated from the catalogue. */
  ddl: string | null
  ddlSource: 'native' | 'generated' | 'none'
  /** Blocks that failed; the remaining blocks are still served. */
  blockErrors: ObjectDetailsBlockError[]
}

export type PreviewFilterOperator = 'eq' | 'neq' | 'contains' | 'startsWith' | 'gt' | 'gte' | 'lt' | 'lte' | 'isNull' | 'isNotNull'
export interface PreviewFilter {
  column: string
  operator: PreviewFilterOperator
  value?: JsonValue
}
export type PreviewFilterLogic = 'and' | 'or'
export interface PreviewSort {
  column: string
  direction: 'asc' | 'desc'
}
export interface ObjectPreviewRequest {
  object: CatalogObject
  page: number
  pageSize: number
  /** Legacy single-column sort; new callers should use sorts. */
  sort?: PreviewSort | null
  sorts?: PreviewSort[]
  filters?: PreviewFilter[]
  filterLogic?: PreviewFilterLogic
}

export interface QueryResult {
  connectionId: string
  sql: string
  columns: string[]
  rows: JsonValue[][]
  rowCount: number
  durationMs: number
}

export interface PagedQueryResult extends QueryResult {
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
  hasPrevious: boolean
  hasNext: boolean
  sort: PreviewSort | null
  sorts: PreviewSort[]
  filters: PreviewFilter[]
  filterLogic: PreviewFilterLogic
  object: CatalogObject
}

export interface SavedQuery {
  id: string
  connectionId: string
  name: string
  sql: string
  updatedAt: number
}

export interface QueryDraft {
  id: string
  sessionId: string
  connectionId: string
  name: string
  sql: string
  savedQueryId: string | null
  dirty: boolean
  updatedAt: number
}

export interface StoredWorkbenchData {
  connections: ConnectionConfig[]
  savedQueries: SavedQuery[]
  drafts: QueryDraft[]
  currentBySession: Record<string, string>
}

export interface WorkbenchState {
  connections: ConnectionConfig[]
  savedQueries: SavedQuery[]
  drafts: QueryDraft[]
  currentDraftId: string | null
  result: QueryResult | null
  objectDetails?: ObjectDetails | null
  preview?: PagedQueryResult | null
}
