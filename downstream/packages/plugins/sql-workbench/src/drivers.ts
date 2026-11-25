// @ts-nocheck
import { basename } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import mysql from 'mysql2/promise'
import type { FieldPacket, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import oracledb from 'oracledb'
import { Client } from 'pg'
import { buildPreviewSql, driverCapabilities, qualifiedObjectName, quoteIdentifier } from './dialects.ts'
import type {
  CatalogColumn,
  CatalogDatabase,
  CatalogObject,
  CatalogSchema,
  CatalogSnapshot,
  ConnectionConfig,
  MysqlConnection,
  ObjectConstraint,
  ObjectDetails,
  ObjectForeignKey,
  ObjectIndex,
  ObjectPreviewRequest,
  OracleConnection,
  PagedQueryResult,
  PostgresConnection,
  QueryResult,
  SqliteConnection,
  JsonValue,
} from './types.ts'

function isMysqlConnection(connection: ConnectionConfig): connection is MysqlConnection {
  return connection.kind === 'mysql' || connection.kind === 'mariadb' || connection.kind === 'doris'
}

interface TableRow {
  database: string
  schema: string | null
  name: string
  kind: 'table' | 'view'
  definition: string | null
  /** Table/view comment, when the catalogue exposes one. */
  comment?: string | null
}

interface ColumnRow {
  database: string
  schema: string | null
  object: string
  name: string
  dataType: string
  nullable: boolean
  defaultValue: string | null
  ordinal: number
  /** Column comment, or null where the driver has no column comments (SQLite). */
  comment?: string | null
}

function schemaKey(database: string, schema: string | null): string {
  return database + '::' + String(schema)
}

/** 将驱动返回的目录行组装为右栏对象树使用的数据库、Schema、对象层级。 */
function assembleCatalog(connectionId: string, tables: TableRow[], columns: ColumnRow[]): CatalogSnapshot {
  const databases = new Map<string, CatalogDatabase>()
  const schemas = new Map<string, CatalogSchema>()
  const objects = new Map<string, CatalogObject>()

  for (const row of tables) {
    let database = databases.get(row.database)
    if (database === undefined) {
      database = { name: row.database, schemas: [] }
      databases.set(row.database, database)
    }
    const key = schemaKey(row.database, row.schema)
    let schema = schemas.get(key)
    if (schema === undefined) {
      schema = { name: row.schema, objects: [] }
      schemas.set(key, schema)
      database.schemas.push(schema)
    }
    const object: CatalogObject = {
      kind: row.kind,
      database: row.database,
      schema: row.schema,
      name: row.name,
      columns: [],
      definition: row.definition,
      comment: row.comment ?? null,
    }
    schema.objects.push(object)
    objects.set(key + '::' + row.name, object)
  }

  for (const row of columns) {
    const object = objects.get(schemaKey(row.database, row.schema) + '::' + row.object)
    if (object === undefined) continue
    const column: CatalogColumn = {
      name: row.name,
      dataType: row.dataType,
      nullable: row.nullable,
      defaultValue: row.defaultValue,
      ordinal: row.ordinal,
      comment: row.comment ?? null,
    }
    object.columns.push(column)
  }

  return { connectionId, databases: [...databases.values()] }
}

function annotateCatalog(snapshot: CatalogSnapshot, product: string, version: string | undefined, charset?: string | null, collation?: string | null): CatalogSnapshot {
  for (const database of snapshot.databases) {
    database.product = product
    if (version !== undefined && version !== '') database.version = version
    if (charset !== undefined) database.charset = charset
    if (collation !== undefined) database.collation = collation
  }
  return snapshot
}

function postgresClient(connection: PostgresConnection): Client {
  return new Client({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
  })
}

async function postgresCatalog(connection: PostgresConnection): Promise<CatalogSnapshot> {
  const client = postgresClient(connection)
  await client.connect()
  try {
    const tableSql = [
      'SELECT t.table_catalog, t.table_schema, t.table_name, t.table_type, v.view_definition,',
      "(SELECT d.description FROM pg_catalog.pg_description d",
      '  JOIN pg_catalog.pg_class cl ON cl.oid = d.objoid',
      '  JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace',
      '  WHERE ns.nspname = t.table_schema AND cl.relname = t.table_name AND d.objsubid = 0) AS table_comment',
      'FROM information_schema.tables t',
      'LEFT JOIN information_schema.views v',
      'ON v.table_catalog = t.table_catalog',
      'AND v.table_schema = t.table_schema',
      'AND v.table_name = t.table_name',
      'ORDER BY t.table_catalog, t.table_schema, t.table_name',
    ].join(' ')
    const columnSql = [
      'SELECT c.table_catalog, c.table_schema, c.table_name, c.column_name, c.data_type,',
      'c.is_nullable, c.column_default, c.ordinal_position,',
      '(SELECT d.description FROM pg_catalog.pg_description d',
      '  JOIN pg_catalog.pg_class cl ON cl.oid = d.objoid',
      '  JOIN pg_catalog.pg_namespace ns ON ns.oid = cl.relnamespace',
      '  JOIN pg_catalog.pg_attribute a ON a.attrelid = cl.oid AND a.attnum = d.objsubid',
      '  WHERE ns.nspname = c.table_schema AND cl.relname = c.table_name AND a.attname = c.column_name) AS column_comment',
      'FROM information_schema.columns c',
      'ORDER BY table_catalog, table_schema, table_name, ordinal_position',
    ].join(' ')
    const tableResult = await client.query<{
      table_catalog: string
      table_schema: string
      table_name: string
      table_type: string
      view_definition: string | null
      table_comment: string | null
    }>(tableSql)
    const columnResult = await client.query<{
      table_catalog: string
      table_schema: string
      table_name: string
      column_name: string
      data_type: string
      is_nullable: string
      column_default: string | null
      ordinal_position: number
      column_comment: string | null
    }>(columnSql)
    const snapshot = assembleCatalog(
      connection.id,
      tableResult.rows.map(row => ({
        database: row.table_catalog,
        schema: row.table_schema,
        name: row.table_name,
        kind: row.table_type === 'VIEW' ? 'view' : 'table',
        definition: row.view_definition,
        comment: row.table_comment,
      })),
      columnResult.rows.map(row => ({
        database: row.table_catalog,
        schema: row.table_schema,
        object: row.table_name,
        name: row.column_name,
        dataType: row.data_type,
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default,
        ordinal: row.ordinal_position,
        comment: row.column_comment,
      })),
    )
    let version = connection.versionHint
    try {
      const result = await client.query<{ server_version: string }>('SHOW server_version')
      version = result.rows[0]?.server_version ?? version
    } catch {}
    return annotateCatalog(snapshot, 'PostgreSQL', version)
  } finally {
    await client.end()
  }
}

async function mysqlCatalog(connection: MysqlConnection): Promise<CatalogSnapshot> {
  const client = await mysql.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
  })
  try {
    const tableSql = [
      'SELECT t.TABLE_SCHEMA, t.TABLE_NAME, t.TABLE_TYPE, t.TABLE_COMMENT, v.VIEW_DEFINITION',
      'FROM information_schema.TABLES t',
      'LEFT JOIN information_schema.VIEWS v',
      'ON v.TABLE_SCHEMA = t.TABLE_SCHEMA AND v.TABLE_NAME = t.TABLE_NAME',
      'ORDER BY t.TABLE_SCHEMA, t.TABLE_NAME',
    ].join(' ')
    const columnSql = [
      'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,',
      'COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION',
      'FROM information_schema.COLUMNS',
      'ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION',
    ].join(' ')
    const [tableRows] = await client.query<RowDataPacket[]>(tableSql)
    const [columnRows] = await client.query<RowDataPacket[]>(columnSql)
    const snapshot = assembleCatalog(
      connection.id,
      tableRows.map(row => ({
        database: String(row.TABLE_SCHEMA),
        schema: null,
        name: String(row.TABLE_NAME),
        kind: String(row.TABLE_TYPE).includes('VIEW') ? 'view' : 'table',
        definition: row.VIEW_DEFINITION === null ? null : String(row.VIEW_DEFINITION),
        comment: row.TABLE_COMMENT === null || row.TABLE_COMMENT === undefined ? null : String(row.TABLE_COMMENT),
      })),
      columnRows.map(row => ({
        database: String(row.TABLE_SCHEMA),
        schema: null,
        object: String(row.TABLE_NAME),
        name: String(row.COLUMN_NAME),
        dataType: String(row.COLUMN_TYPE),
        nullable: String(row.IS_NULLABLE) === 'YES',
        defaultValue: row.COLUMN_DEFAULT === null ? null : String(row.COLUMN_DEFAULT),
        ordinal: Number(row.ORDINAL_POSITION),
        comment: row.COLUMN_COMMENT === null || row.COLUMN_COMMENT === undefined ? null : String(row.COLUMN_COMMENT),
      })),
    )
    let version = connection.versionHint
    let charset: string | null | undefined
    let collation: string | null | undefined
    try {
      const [rows] = await client.query<RowDataPacket[]>('SELECT VERSION() AS VERSION, @@character_set_database AS CHARSET, @@collation_database AS COLLATION')
      version = rows[0] === undefined ? version : String(rows[0].VERSION)
      charset = rows[0]?.CHARSET === undefined ? undefined : String(rows[0].CHARSET)
      collation = rows[0]?.COLLATION === undefined ? undefined : String(rows[0].COLLATION)
    } catch {}
    return annotateCatalog(snapshot, driverCapabilities(connection.kind).label, version, charset, collation)
  } finally {
    await client.end()
  }
}

async function oracleCatalog(connection: OracleConnection): Promise<CatalogSnapshot> {
  const client = await oracledb.getConnection({
    user: connection.user,
    password: connection.password,
    connectString: connection.host + ':' + String(connection.port) + '/' + connection.serviceName,
  })
  try {
    const owner = (connection.database || connection.user).toUpperCase()
    const tablesResult = await client.execute(
      "SELECT SYS_CONTEXT('USERENV','DB_NAME') AS DATABASE_NAME, o.OWNER, o.OBJECT_NAME, o.OBJECT_TYPE, tc.COMMENTS AS TABLE_COMMENT FROM ALL_OBJECTS o LEFT JOIN ALL_TAB_COMMENTS tc ON tc.OWNER = o.OWNER AND tc.TABLE_NAME = o.OBJECT_NAME WHERE o.OWNER = :owner AND o.OBJECT_TYPE IN ('TABLE','VIEW') ORDER BY o.OBJECT_NAME",
      { owner },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    )
    const columnsResult = await client.execute(
      'SELECT c.OWNER, c.TABLE_NAME, c.COLUMN_NAME, c.DATA_TYPE, c.NULLABLE, c.DATA_DEFAULT, c.COLUMN_ID, cc.COMMENTS AS COLUMN_COMMENT FROM ALL_TAB_COLUMNS c LEFT JOIN ALL_COL_COMMENTS cc ON cc.OWNER = c.OWNER AND cc.TABLE_NAME = c.TABLE_NAME AND cc.COLUMN_NAME = c.COLUMN_NAME WHERE c.OWNER = :owner ORDER BY c.TABLE_NAME, c.COLUMN_ID',
      { owner },
      { outFormat: oracledb.OUT_FORMAT_OBJECT },
    )
    const tables = (tablesResult.rows ?? []) as Array<Record<string, unknown>>
    const columns = (columnsResult.rows ?? []) as Array<Record<string, unknown>>
    const databaseName = String(tables[0]?.DATABASE_NAME ?? connection.serviceName)
    const snapshot = assembleCatalog(
      connection.id,
      tables.map(row => ({
        database: databaseName,
        schema: String(row.OWNER),
        name: String(row.OBJECT_NAME),
        kind: String(row.OBJECT_TYPE) === 'VIEW' ? 'view' : 'table',
        definition: null,
        comment: row.TABLE_COMMENT === null || row.TABLE_COMMENT === undefined ? null : String(row.TABLE_COMMENT),
      })),
      columns.map(row => ({
        database: databaseName,
        schema: String(row.OWNER),
        object: String(row.TABLE_NAME),
        name: String(row.COLUMN_NAME),
        dataType: String(row.DATA_TYPE),
        nullable: String(row.NULLABLE) === 'Y',
        defaultValue: row.DATA_DEFAULT === null ? null : String(row.DATA_DEFAULT).trim(),
        ordinal: Number(row.COLUMN_ID),
        comment: row.COLUMN_COMMENT === null || row.COLUMN_COMMENT === undefined ? null : String(row.COLUMN_COMMENT),
      })),
    )
    let version = connection.versionHint
    try {
      const result = await client.execute("SELECT VERSION FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle Database%' FETCH FIRST 1 ROWS ONLY", {}, { outFormat: oracledb.OUT_FORMAT_OBJECT })
      const row = (result.rows?.[0] ?? {}) as Record<string, unknown>
      version = row.VERSION === undefined ? version : String(row.VERSION)
    } catch {}
    return annotateCatalog(snapshot, 'Oracle Database', version)
  } finally {
    await client.close()
  }
}

function sqliteCatalog(connection: SqliteConnection): CatalogSnapshot {
  const client = new DatabaseSync(connection.file)
  try {
    const database = basename(connection.file)
    const entries = client.prepare(
      "SELECT name, type, sql FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
    ).all() as Array<{ name: string; type: string; sql: string | null }>
    const tables: TableRow[] = []
    const columns: ColumnRow[] = []
    for (const entry of entries) {
      tables.push({
        database,
        schema: null,
        name: entry.name,
        kind: entry.type === 'view' ? 'view' : 'table',
        definition: entry.sql,
      })
      const tableInfoSql = 'PRAGMA table_info("' + entry.name.replaceAll('"', '""') + '")'
      const objectColumns = client.prepare(tableInfoSql).all() as Array<{
        name: string
        type: string
        notnull: number
        dflt_value: string | null
        cid: number
      }>
      for (const column of objectColumns) {
        columns.push({
          database,
          schema: null,
          object: entry.name,
          name: column.name,
          dataType: column.type,
          nullable: column.notnull === 0,
          defaultValue: column.dflt_value,
          ordinal: column.cid + 1,
        })
      }
    }
    const snapshot = assembleCatalog(connection.id, tables, columns)
    const version = String((client.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version)
    return annotateCatalog(snapshot, 'SQLite', version)
  } finally {
    client.close()
  }
}

/** 读取一个连接的完整对象目录，客户端按对象树直接消费。 */
export async function loadCatalog(connection: ConnectionConfig): Promise<CatalogSnapshot> {
  const snapshot = connection.kind === 'postgres'
    ? await postgresCatalog(connection)
    : isMysqlConnection(connection)
      ? await mysqlCatalog(connection)
      : connection.kind === 'oracle'
        ? await oracleCatalog(connection)
        : sqliteCatalog(connection)
  snapshot.capabilities = driverCapabilities(connection.kind)
  return snapshot
}

function wireValue(value: unknown): JsonValue {
  return (typeof value === 'bigint' ? value.toString() : value) as JsonValue
}

async function postgresQuery(connection: PostgresConnection, sql: string): Promise<QueryResult> {
  const client = postgresClient(connection)
  await client.connect()
  const started = performance.now()
  try {
    const result = await client.query<Record<string, unknown>>(sql)
    const columns = result.fields.map(field => field.name)
    return {
      connectionId: connection.id,
      sql,
      columns,
      rows: result.rows.map(row => columns.map(column => wireValue(row[column]))),
      rowCount: result.rowCount ?? result.rows.length,
      durationMs: Math.round(performance.now() - started),
    }
  } finally {
    await client.end()
  }
}

async function mysqlQuery(connection: MysqlConnection, sql: string): Promise<QueryResult> {
  const client = await mysql.createConnection({
    host: connection.host,
    port: connection.port,
    user: connection.user,
    password: connection.password,
    database: connection.database,
  })
  const started = performance.now()
  try {
    const response = await client.query({ sql, rowsAsArray: true })
    const rawRows = response[0]
    const fields = response[1] as FieldPacket[]
    if (Array.isArray(rawRows)) {
      return {
        connectionId: connection.id,
        sql,
        columns: fields.map(field => field.name),
        rows: (rawRows as unknown[][]).map(row => row.map(wireValue)),
        rowCount: rawRows.length,
        durationMs: Math.round(performance.now() - started),
      }
    }
    const result = rawRows as ResultSetHeader
    return {
      connectionId: connection.id,
      sql,
      columns: ['affectedRows', 'insertId', 'warningStatus'],
      rows: [[result.affectedRows, wireValue(result.insertId), result.warningStatus]],
      rowCount: result.affectedRows,
      durationMs: Math.round(performance.now() - started),
    }
  } finally {
    await client.end()
  }
}

async function oracleQuery(connection: OracleConnection, sql: string): Promise<QueryResult> {
  const client = await oracledb.getConnection({
    user: connection.user,
    password: connection.password,
    connectString: connection.host + ':' + String(connection.port) + '/' + connection.serviceName,
  })
  const started = performance.now()
  try {
    const result = await client.execute(sql, {}, { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit: true })
    const columns = (result.metaData ?? []).map((column: { name: string }) => column.name)
    const rows = (result.rows ?? []) as unknown[][]
    return {
      connectionId: connection.id,
      sql,
      columns,
      rows: rows.map(row => row.map(wireValue)),
      rowCount: result.rowsAffected ?? rows.length,
      durationMs: Math.round(performance.now() - started),
    }
  } finally {
    await client.close()
  }
}

function sqliteQuery(connection: SqliteConnection, sql: string): QueryResult {
  const client = new DatabaseSync(connection.file)
  const started = performance.now()
  try {
    const statement = client.prepare(sql)
    const columns = statement.columns().map(column => column.name)
    if (columns.length > 0) {
      const objects = statement.all() as Array<Record<string, unknown>>
      return {
        connectionId: connection.id,
        sql,
        columns,
        rows: objects.map(row => columns.map(column => wireValue(row[column]))),
        rowCount: objects.length,
        durationMs: Math.round(performance.now() - started),
      }
    }
    const result = statement.run()
    return {
      connectionId: connection.id,
      sql,
      columns: ['changes', 'lastInsertRowid'],
      rows: [[wireValue(result.changes), wireValue(result.lastInsertRowid)]],
      rowCount: Number(result.changes),
      durationMs: Math.round(performance.now() - started),
    }
  } finally {
    client.close()
  }
}

/** 按连接方言执行用户或模型提供的 SQL，并保留驱动返回的全部结果行。 */
export async function runQuery(connection: ConnectionConfig, sql: string): Promise<QueryResult> {
  if (connection.kind === 'postgres') return postgresQuery(connection, sql)
  if (isMysqlConnection(connection)) return mysqlQuery(connection, sql)
  if (connection.kind === 'oracle') return oracleQuery(connection, sql)
  return sqliteQuery(connection, sql)
}

export async function testConnection(connection: ConnectionConfig): Promise<QueryResult> {
  return runQuery(connection, connection.kind === 'oracle' ? 'SELECT 1 AS connected FROM dual' : 'SELECT 1 AS connected')
}

function sqliteValue(value: JsonValue): string | number | bigint | Uint8Array | null {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint' || value instanceof Uint8Array) return value
  if (typeof value === 'boolean') return value ? 1 : 0
  return JSON.stringify(value)
}

function groupIndexes(rows: Array<{ name: string; column: string; position: number; unique: boolean; primary: boolean; type: string | null }>): ObjectIndex[] {
  const grouped = new Map<string, ObjectIndex>()
  for (const row of rows.sort((left, right) => left.position - right.position)) {
    let index = grouped.get(row.name)
    if (index === undefined) {
      index = { name: row.name, unique: row.unique, primary: row.primary, columns: [], type: row.type }
      grouped.set(row.name, index)
    }
    index.columns.push(row.column)
  }
  return [...grouped.values()]
}

async function loadIndexes(connection: ConnectionConfig, object: CatalogObject): Promise<ObjectIndex[]> {
  if (object.kind === 'view' || connection.kind === 'doris') return []
  if (connection.kind === 'postgres') {
    const client = postgresClient(connection)
    await client.connect()
    try {
      const result = await client.query<{ name: string; unique: boolean; primary: boolean; type: string; column: string; position: number }>([
        'SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary, am.amname AS type,',
        'a.attname AS column, keys.ordinality AS position',
        'FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace',
        'JOIN pg_index ix ON ix.indrelid = t.oid JOIN pg_class i ON i.oid = ix.indexrelid',
        'JOIN pg_am am ON am.oid = i.relam',
        'JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true',
        'JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keys.attnum',
        'WHERE n.nspname = $1 AND t.relname = $2 ORDER BY i.relname, keys.ordinality',
      ].join(' '), [object.schema ?? 'public', object.name])
      return groupIndexes(result.rows.map(row => ({ ...row, type: row.type })))
    } finally { await client.end() }
  }
  if (isMysqlConnection(connection)) {
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database })
    try {
      const [rows] = await client.query<RowDataPacket[]>([
        'SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX, INDEX_TYPE',
        'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
        'ORDER BY INDEX_NAME, SEQ_IN_INDEX',
      ].join(' '), [object.database, object.name])
      return groupIndexes(rows.map(row => ({ name: String(row.INDEX_NAME), column: String(row.COLUMN_NAME), position: Number(row.SEQ_IN_INDEX), unique: Number(row.NON_UNIQUE) === 0, primary: String(row.INDEX_NAME) === 'PRIMARY', type: row.INDEX_TYPE === null ? null : String(row.INDEX_TYPE) })))
    } finally { await client.end() }
  }
  if (connection.kind === 'oracle') {
    const client = await oracledb.getConnection({ user: connection.user, password: connection.password, connectString: connection.host + ':' + String(connection.port) + '/' + connection.serviceName })
    try {
      const result = await client.execute([
        'SELECT i.INDEX_NAME, i.UNIQUENESS, i.INDEX_TYPE, c.COLUMN_NAME, c.COLUMN_POSITION,',
        "CASE WHEN p.CONSTRAINT_TYPE = 'P' THEN 1 ELSE 0 END AS IS_PRIMARY",
        'FROM ALL_INDEXES i JOIN ALL_IND_COLUMNS c ON c.INDEX_OWNER = i.OWNER AND c.INDEX_NAME = i.INDEX_NAME',
        "LEFT JOIN ALL_CONSTRAINTS p ON p.OWNER = i.TABLE_OWNER AND p.TABLE_NAME = i.TABLE_NAME AND p.INDEX_NAME = i.INDEX_NAME AND p.CONSTRAINT_TYPE = 'P'",
        'WHERE i.TABLE_OWNER = :owner AND i.TABLE_NAME = :tableName ORDER BY i.INDEX_NAME, c.COLUMN_POSITION',
      ].join(' '), { owner: object.schema ?? connection.database.toUpperCase(), tableName: object.name }, { outFormat: oracledb.OUT_FORMAT_OBJECT })
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>
      return groupIndexes(rows.map(row => ({ name: String(row.INDEX_NAME), column: String(row.COLUMN_NAME), position: Number(row.COLUMN_POSITION), unique: String(row.UNIQUENESS) === 'UNIQUE', primary: Number(row.IS_PRIMARY) === 1, type: row.INDEX_TYPE === null ? null : String(row.INDEX_TYPE) })))
    } finally { await client.close() }
  }
  const client = new DatabaseSync(connection.file)
  try {
    const list = client.prepare('PRAGMA index_list(' + quoteIdentifier('sqlite', object.name) + ')').all() as Array<{ name: string; unique: number; origin: string }>
    const rows: Array<{ name: string; column: string; position: number; unique: boolean; primary: boolean; type: string | null }> = []
    for (const index of list) {
      const columns = client.prepare('PRAGMA index_info(' + quoteIdentifier('sqlite', index.name) + ')').all() as Array<{ name: string; seqno: number }>
      for (const column of columns) rows.push({ name: index.name, column: column.name, position: column.seqno + 1, unique: index.unique === 1, primary: index.origin === 'pk', type: 'btree' })
    }
    return groupIndexes(rows)
  } finally { client.close() }
}


function groupConstraints(rows: Array<{ name: string; kind: ObjectConstraint['kind']; column: string | null; position: number; definition: string | null }>): ObjectConstraint[] {
  const grouped = new Map<string, ObjectConstraint>()
  for (const row of rows.sort((left, right) => left.position - right.position)) {
    let constraint = grouped.get(row.name)
    if (constraint === undefined) {
      constraint = { name: row.name, kind: row.kind, columns: [], definition: row.definition }
      grouped.set(row.name, constraint)
    }
    if (row.column !== null && row.column !== '' && !constraint.columns.includes(row.column)) constraint.columns.push(row.column)
    if ((constraint.definition === null || constraint.definition === undefined) && row.definition !== null) constraint.definition = row.definition
  }
  return [...grouped.values()]
}

function constraintKind(value: string): ObjectConstraint['kind'] | null {
  if (value === 'p' || value === 'P' || value === 'PRIMARY KEY') return 'primary'
  if (value === 'u' || value === 'U' || value === 'UNIQUE') return 'unique'
  if (value === 'f' || value === 'R' || value === 'FOREIGN KEY') return 'foreign'
  if (value === 'c' || value === 'C' || value === 'CHECK') return 'check'
  return null
}

async function loadConstraints(connection: ConnectionConfig, object: CatalogObject): Promise<ObjectConstraint[]> {
  if (object.kind === 'view' || connection.kind === 'doris') return []
  if (connection.kind === 'postgres') {
    const client = postgresClient(connection)
    await client.connect()
    try {
      const result = await client.query<{ name: string; type: string; column: string | null; position: number | null; definition: string }>([
        'SELECT c.conname AS name, c.contype AS type, a.attname AS column, keys.ordinality AS position,',
        'pg_get_constraintdef(c.oid, true) AS definition',
        'FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid',
        'JOIN pg_namespace n ON n.oid = t.relnamespace',
        'LEFT JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS keys(attnum, ordinality) ON true',
        'LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = keys.attnum',
        "WHERE n.nspname = $1 AND t.relname = $2 AND c.contype IN ('p','u','f','c')",
        'ORDER BY c.conname, keys.ordinality',
      ].join(' '), [object.schema ?? 'public', object.name])
      return groupConstraints(result.rows.flatMap(row => {
        const kind = constraintKind(row.type)
        return kind === null ? [] : [{ name: row.name, kind, column: row.column, position: row.position ?? 0, definition: row.definition }]
      }))
    } finally { await client.end() }
  }
  if (isMysqlConnection(connection)) {
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database })
    try {
      const [keyRows] = await client.query<RowDataPacket[]>([
        'SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, kcu.COLUMN_NAME, kcu.ORDINAL_POSITION,',
        'kcu.REFERENCED_TABLE_SCHEMA, kcu.REFERENCED_TABLE_NAME, kcu.REFERENCED_COLUMN_NAME',
        'FROM information_schema.TABLE_CONSTRAINTS tc LEFT JOIN information_schema.KEY_COLUMN_USAGE kcu',
        'ON kcu.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND kcu.CONSTRAINT_NAME = tc.CONSTRAINT_NAME',
        'AND kcu.TABLE_SCHEMA = tc.TABLE_SCHEMA AND kcu.TABLE_NAME = tc.TABLE_NAME',
        "WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE IN ('PRIMARY KEY','UNIQUE','FOREIGN KEY')",
        'ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION',
      ].join(' '), [object.database, object.name])
      const rows: Array<{ name: string; kind: ObjectConstraint['kind']; column: string | null; position: number; definition: string | null }> = keyRows.flatMap(row => {
        const kind = constraintKind(String(row.CONSTRAINT_TYPE))
        if (kind === null) return []
        const reference = row.REFERENCED_TABLE_NAME == null ? null : 'REFERENCES ' + String(row.REFERENCED_TABLE_SCHEMA) + '.' + String(row.REFERENCED_TABLE_NAME) + '(' + String(row.REFERENCED_COLUMN_NAME) + ')'
        return [{ name: String(row.CONSTRAINT_NAME), kind, column: row.COLUMN_NAME == null ? null : String(row.COLUMN_NAME), position: Number(row.ORDINAL_POSITION ?? 0), definition: reference }]
      })
      try {
        const [checkRows] = await client.query<RowDataPacket[]>([
          'SELECT tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM information_schema.TABLE_CONSTRAINTS tc',
          'JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME',
          "WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? AND tc.CONSTRAINT_TYPE = 'CHECK'",
        ].join(' '), [object.database, object.name])
        for (const row of checkRows) rows.push({ name: String(row.CONSTRAINT_NAME), kind: 'check', column: null, position: 0, definition: row.CHECK_CLAUSE == null ? null : String(row.CHECK_CLAUSE) })
      } catch {}
      return groupConstraints(rows)
    } finally { await client.end() }
  }
  if (connection.kind === 'oracle') {
    const client = await oracledb.getConnection({ user: connection.user, password: connection.password, connectString: connection.host + ':' + String(connection.port) + '/' + connection.serviceName })
    try {
      const result = await client.execute([
        'SELECT c.CONSTRAINT_NAME, c.CONSTRAINT_TYPE, cc.COLUMN_NAME, cc.POSITION, c.SEARCH_CONDITION_VC',
        'FROM ALL_CONSTRAINTS c LEFT JOIN ALL_CONS_COLUMNS cc',
        'ON cc.OWNER = c.OWNER AND cc.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND cc.TABLE_NAME = c.TABLE_NAME',
        "WHERE c.OWNER = :owner AND c.TABLE_NAME = :tableName AND c.CONSTRAINT_TYPE IN ('P','U','R','C')",
        'ORDER BY c.CONSTRAINT_NAME, cc.POSITION',
      ].join(' '), { owner: object.schema ?? connection.database.toUpperCase(), tableName: object.name }, { outFormat: oracledb.OUT_FORMAT_OBJECT })
      const rows = (result.rows ?? []) as Array<Record<string, unknown>>
      return groupConstraints(rows.flatMap(row => {
        const kind = constraintKind(String(row.CONSTRAINT_TYPE))
        return kind === null ? [] : [{ name: String(row.CONSTRAINT_NAME), kind, column: row.COLUMN_NAME == null ? null : String(row.COLUMN_NAME), position: Number(row.POSITION ?? 0), definition: row.SEARCH_CONDITION_VC == null ? null : String(row.SEARCH_CONDITION_VC) }]
      }))
    } finally { await client.close() }
  }
  const client = new DatabaseSync(connection.file)
  try {
    const rows: Array<{ name: string; kind: ObjectConstraint['kind']; column: string | null; position: number; definition: string | null }> = []
    const columns = client.prepare('PRAGMA table_info(' + quoteIdentifier('sqlite', object.name) + ')').all() as Array<{ name: string; pk: number }>
    for (const column of columns.filter(item => item.pk > 0)) rows.push({ name: 'PRIMARY KEY', kind: 'primary', column: column.name, position: column.pk, definition: null })
    const indexes = client.prepare('PRAGMA index_list(' + quoteIdentifier('sqlite', object.name) + ')').all() as Array<{ name: string; origin: string }>
    for (const index of indexes.filter(item => item.origin === 'u')) {
      const indexColumns = client.prepare('PRAGMA index_info(' + quoteIdentifier('sqlite', index.name) + ')').all() as Array<{ name: string; seqno: number }>
      for (const column of indexColumns) rows.push({ name: index.name, kind: 'unique', column: column.name, position: column.seqno + 1, definition: null })
    }
    const foreignKeys = client.prepare('PRAGMA foreign_key_list(' + quoteIdentifier('sqlite', object.name) + ')').all() as Array<{ id: number; seq: number; table: string; from: string; to: string }>
    for (const foreignKey of foreignKeys) rows.push({ name: 'FOREIGN KEY ' + String(foreignKey.id + 1), kind: 'foreign', column: foreignKey.from, position: foreignKey.seq + 1, definition: 'REFERENCES ' + quoteIdentifier('sqlite', foreignKey.table) + '(' + quoteIdentifier('sqlite', foreignKey.to) + ')' })
    return groupConstraints(rows)
  } finally { client.close() }
}

/** Strip one layer of SQL identifier quoting, as written by each driver's DDL. */
function unquoteIdentifier(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith('`') && trimmed.endsWith('`')))) {
    return trimmed.slice(1, -1).replaceAll('""', '"').replaceAll('``', '`')
  }
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1)
  return trimmed
}

/** Parse `REFERENCES table(columns)` out of a driver's foreign-key definition. */
function referenceOf(definition: string | null | undefined): { table: string; columns: string[] } | null {
  const match = /REFERENCES\s+([^\s(]+)\s*\(([^)]*)\)/iu.exec(definition ?? '')
  if (match === null) return null
  return {
    table: unquoteIdentifier(match[1] ?? ''),
    columns: (match[2] ?? '').split(',').map(part => unquoteIdentifier(part)).filter(name => name !== ''),
  }
}

/**
 * Flatten foreign-key constraints into the shape the inspector and the conversation
 * reference share. A driver that cannot report the referenced columns still contributes
 * the constraint definition, so the row names what it can rather than disappearing.
 */
function foreignKeysOf(constraints: ObjectConstraint[]): ObjectForeignKey[] {
  return constraints.filter(constraint => constraint.kind === 'foreign').map(constraint => {
    const reference = referenceOf(constraint.definition)
    return {
      name: constraint.name,
      columns: constraint.columns,
      referencedTable: reference?.table ?? '',
      referencedColumns: reference?.columns ?? [],
      definition: constraint.definition ?? null,
    }
  })
}

/**
 * Build DDL from the catalogue when the driver offers none.
 *
 * PostgreSQL has no `SHOW CREATE TABLE`, and a live Oracle call to `DBMS_METADATA`
 * can be denied by privileges. The inspector still has to show something actionable,
 * so the columns, primary key and unique constraints it already measured are rendered
 * as a CREATE TABLE and the UI labels the result as generated rather than native.
 */
export function generatedDdl(connection: ConnectionConfig, object: CatalogObject, indexes: ObjectIndex[], constraints: ObjectConstraint[]): string {
  const quote = (value: string): string => quoteIdentifier(connection.kind, value)
  const qualified = qualifiedObjectName(connection.kind, object)
  if (object.kind === 'view') {
    return '-- Native view DDL is unavailable from this driver.\nCREATE VIEW ' + qualified + ' AS\n  -- see the view definition in the editor\n  SELECT 1;'
  }
  const lines = object.columns.map(column => {
    const parts = ['  ' + quote(column.name) + ' ' + (column.dataType === '' ? 'TEXT' : column.dataType)]
    if (!column.nullable) parts.push('NOT NULL')
    if (column.defaultValue !== null && column.defaultValue !== '') parts.push('DEFAULT ' + column.defaultValue)
    return parts.join(' ')
  })
  const primary = constraints.find(constraint => constraint.kind === 'primary')?.columns
    ?? indexes.find(index => index.primary)?.columns
    ?? []
  if (primary.length > 0) lines.push('  PRIMARY KEY (' + primary.map(quote).join(', ') + ')')
  for (const constraint of constraints) {
    if (constraint.kind !== 'unique' || constraint.columns.length === 0) continue
    lines.push('  UNIQUE (' + constraint.columns.map(quote).join(', ') + ')')
  }
  return '-- Generated from the live catalogue; not the server\'s canonical DDL.\nCREATE TABLE ' + qualified + ' (\n' + lines.join(',\n') + '\n);'
}

/** Read native DDL when the driver exposes it; null asks the caller to generate it. */
async function loadNativeDdl(connection: ConnectionConfig, object: CatalogObject): Promise<string | null> {
  if (object.kind === 'view') {
    if (object.definition === null || object.definition.trim() === '') return null
    return 'CREATE VIEW ' + qualifiedObjectName(connection.kind, object) + ' AS\n' + object.definition.trim() + ';'
  }
  if (connection.kind === 'sqlite') {
    const client = new DatabaseSync(connection.file)
    try {
      const row = client.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(object.name) as { sql: string | null } | undefined
      return row?.sql ?? null
    } finally { client.close() }
  }
  if (isMysqlConnection(connection)) {
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database })
    try {
      const qualified = quoteIdentifier(connection.kind, object.database) + '.' + quoteIdentifier(connection.kind, object.name)
      const [rows] = await client.query('SHOW CREATE TABLE ' + qualified)
      const row = (rows as Array<Record<string, unknown>>)[0]
      if (row === undefined) return null
      const ddl = Object.values(row).find(value => typeof value === 'string' && /^CREATE\s/i.test(value))
      return typeof ddl === 'string' ? ddl : null
    } catch { return null } finally { await client.end() }
  }
  if (connection.kind === 'oracle') {
    const client = await oracledb.getConnection({ user: connection.user, password: connection.password, connectString: connection.host + ':' + String(connection.port) + '/' + connection.serviceName })
    try {
      const owner = (object.schema ?? connection.database).toUpperCase()
      const result = await client.execute(
        'SELECT DBMS_METADATA.GET_DDL(:objectType, :objectName, :owner) AS ddl FROM dual',
        { objectType: 'TABLE', objectName: object.name, owner },
        { outFormat: oracledb.OUT_FORMAT_OBJECT },
      )
      const row = (result.rows?.[0] ?? {}) as Record<string, unknown>
      const ddl = row.DDL
      if (typeof ddl === 'string') return ddl.trim()
      if (ddl !== null && typeof ddl === 'object' && 'getData' in ddl) {
        return String(await (ddl as { getData(): Promise<string> }).getData()).trim()
      }
      return null
    } catch { return null } finally { await client.close() }
  }
  return null
}

export async function loadObjectDetails(connection: ConnectionConfig, object: CatalogObject): Promise<ObjectDetails> {
  // Each block is independent: a privilege that hides indexes must not also hide the
  // columns or the DDL. The failed block travels back with its reason instead.
  const blockErrors: ObjectDetails['blockErrors'] = []
  const settle = async <T,>(block: 'indexes' | 'constraints' | 'ddl', action: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await action()
    } catch (error) {
      blockErrors.push({ block, message: error instanceof Error ? error.message : String(error) })
      return undefined
    }
  }
  const [indexes, constraints, nativeDdl] = await Promise.all([
    settle('indexes', () => loadIndexes(connection, object)),
    settle('constraints', () => loadConstraints(connection, object)),
    settle('ddl', () => loadNativeDdl(connection, object)),
  ])
  const indexList = indexes ?? []
  const constraintList = constraints ?? []
  const foreignKeys = foreignKeysOf(constraintList)
  const ddl = nativeDdl ?? (object.kind === 'view' ? null : generatedDdl(connection, object, indexList, constraintList))
  return {
    connectionId: connection.id,
    capabilities: driverCapabilities(connection.kind),
    object,
    qualifiedName: qualifiedObjectName(connection.kind, object),
    indexes: indexList,
    constraints: constraintList,
    foreignKeys,
    ddl,
    ddlSource: nativeDdl !== null ? 'native' : ddl !== null ? 'generated' : 'none',
    blockErrors,
  }
}

function pagedResult(
  connection: ConnectionConfig,
  request: ObjectPreviewRequest,
  sql: string,
  columns: string[],
  rows: JsonValue[][],
  totalRows: number,
  durationMs: number,
): PagedQueryResult {
  const pageSize = Math.min(500, Math.max(10, Math.trunc(request.pageSize || 50)))
  const page = Math.max(1, Math.trunc(request.page || 1))
  const totalPages = totalRows === 0 ? 0 : Math.ceil(totalRows / pageSize)
  return {
    connectionId: connection.id,
    sql,
    columns,
    rows,
    rowCount: rows.length,
    durationMs,
    page,
    pageSize,
    totalRows,
    totalPages,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
    sort: request.sorts?.[0] ?? request.sort ?? null,
    sorts: request.sorts ?? (request.sort === undefined || request.sort === null ? [] : [request.sort]),
    filters: request.filters ?? [],
    filterLogic: request.filterLogic === 'or' ? 'or' : 'and',
    object: request.object,
  }
}

/** Execute one server-side object preview page with parameterized filters. */
export async function previewObjectPage(connection: ConnectionConfig, request: ObjectPreviewRequest): Promise<PagedQueryResult> {
  const plan = buildPreviewSql(connection.kind, request)
  const started = performance.now()
  if (connection.kind === 'postgres') {
    const client = postgresClient(connection)
    await client.connect()
    try {
      const count = await client.query<Record<string, unknown>>(plan.countSql, plan.countParams)
      const data = await client.query<Record<string, unknown>>(plan.dataSql, plan.dataParams)
      const columns = data.fields.map(field => field.name)
      return pagedResult(connection, request, plan.dataSql, columns, data.rows.map(row => columns.map(column => wireValue(row[column]))), Number(Object.values(count.rows[0] ?? { total: 0 })[0]), Math.round(performance.now() - started))
    } finally {
      await client.end()
    }
  }
  if (isMysqlConnection(connection)) {
    const client = await mysql.createConnection({ host: connection.host, port: connection.port, user: connection.user, password: connection.password, database: connection.database })
    try {
      const [countRows] = await client.query({ sql: plan.countSql, values: plan.countParams, rowsAsArray: true })
      const [dataRows, fields] = await client.query({ sql: plan.dataSql, values: plan.dataParams, rowsAsArray: true })
      const total = Number(((countRows as unknown[][])[0] ?? [0])[0])
      const columns = (fields as FieldPacket[]).map(field => field.name)
      return pagedResult(connection, request, plan.dataSql, columns, (dataRows as unknown[][]).map(row => row.map(wireValue)), total, Math.round(performance.now() - started))
    } finally {
      await client.end()
    }
  }
  if (connection.kind === 'oracle') {
    const client = await oracledb.getConnection({ user: connection.user, password: connection.password, connectString: connection.host + ':' + String(connection.port) + '/' + connection.serviceName })
    try {
      const count = await client.execute(plan.countSql, plan.countParams, { outFormat: oracledb.OUT_FORMAT_ARRAY })
      const data = await client.execute(plan.dataSql, plan.dataParams, { outFormat: oracledb.OUT_FORMAT_ARRAY })
      const columns = (data.metaData ?? []).map(column => column.name)
      const rows = (data.rows ?? []) as unknown[][]
      const countRows = (count.rows ?? []) as unknown[][]
      return pagedResult(connection, request, plan.dataSql, columns, rows.map(row => row.map(wireValue)), Number((countRows[0] ?? [0])[0]), Math.round(performance.now() - started))
    } finally {
      await client.close()
    }
  }
  const client = new DatabaseSync(connection.file)
  try {
    const count = client.prepare(plan.countSql).get(...plan.countParams.map(sqliteValue)) as Record<string, unknown>
    const statement = client.prepare(plan.dataSql)
    const columns = statement.columns().map(column => column.name)
    const objects = statement.all(...plan.dataParams.map(sqliteValue)) as Array<Record<string, unknown>>
    return pagedResult(connection, request, plan.dataSql, columns, objects.map(row => columns.map(column => wireValue(row[column]))), Number(Object.values(count)[0] ?? 0), Math.round(performance.now() - started))
  } finally {
    client.close()
  }
}

/** Compatibility entry point for the first preview page. */
export async function previewObject(connection: ConnectionConfig, object: CatalogObject): Promise<QueryResult> {
  return previewObjectPage(connection, { object, page: 1, pageSize: 100, filters: [], sort: null })
}
