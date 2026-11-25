import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { generatedDdl, loadCatalog, loadObjectDetails, previewObjectPage } from '../src/drivers.ts'
import type { SqliteConnection } from '../src/types.ts'

test('SQLite adapter returns product metadata, indexes, and paged filtered rows', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-sql-driver-'))
  const file = join(directory, 'catalog.sqlite')
  const database = new DatabaseSync(file)
  database.exec('PRAGMA foreign_keys=ON; CREATE TABLE accounts (id INTEGER PRIMARY KEY); CREATE TABLE orders (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES accounts(id), customer TEXT NOT NULL UNIQUE); CREATE INDEX orders_customer_idx ON orders(customer); CREATE VIEW order_names AS SELECT customer FROM orders;')
  const insert = database.prepare('INSERT INTO orders (id, customer) VALUES (?, ?)')
  for (let id = 1; id <= 35; id++) insert.run(id, id % 5 === 0 ? 'Acme ' + id : 'Other ' + id)
  database.close()

  const connection: SqliteConnection = { id: 'sqlite-test', name: 'SQLite', kind: 'sqlite', file }
  const catalog = await loadCatalog(connection)
  assert.equal(catalog.capabilities?.kind, 'sqlite')
  assert.equal(catalog.databases[0]?.product, 'SQLite')
  assert.match(catalog.databases[0]?.version ?? '', /^3[.]/)
  const objects = catalog.databases.flatMap(item => item.schemas).flatMap(schema => schema.objects)
  const table = objects.find(object => object.name === 'orders')
  assert.ok(table !== undefined)
  assert.equal(objects.some(object => object.name === 'order_names' && object.kind === 'view'), true)

  const details = await loadObjectDetails(connection, table)
  assert.equal(details.indexes.some(index => index.name === 'orders_customer_idx' && index.columns[0] === 'customer'), true)
  assert.equal(details.constraints.some(constraint => constraint.kind === 'primary' && constraint.columns.includes('id')), true)
  assert.equal(details.constraints.some(constraint => constraint.kind === 'unique' && constraint.columns.includes('customer')), true)
  assert.equal(details.constraints.some(constraint => constraint.kind === 'foreign' && constraint.columns.includes('account_id') && constraint.definition?.includes('accounts')), true)
  // The inspector and the conversation reference read the flattened view: a foreign key
  // names both sides, and SQLite's column comments stay null so the UI can print 「—」.
  assert.equal(details.foreignKeys.some(key => key.columns.includes('account_id') && key.referencedTable === 'accounts' && key.referencedColumns.includes('id')), true)
  assert.equal(table.columns.every(column => column.comment === null || column.comment === undefined), true)
  assert.equal(details.ddlSource, 'native')
  assert.match(details.ddl ?? '', /CREATE TABLE orders/u)
  assert.equal(details.blockErrors.length, 0)

  const preview = await previewObjectPage(connection, { object: table, page: 2, pageSize: 10, sort: { column: 'id', direction: 'desc' }, filters: [{ column: 'customer', operator: 'contains', value: 'Other' }] })
  assert.equal(preview.totalRows, 28)
  assert.equal(preview.page, 2)
  assert.equal(preview.rows.length, 10)
  assert.equal(preview.rows[0]?.[0], 22)
})

test('catalog-generated DDL marks the primary key and identifiers per dialect', () => {
  // PostgreSQL has no SHOW CREATE TABLE; the inspector must still have copyable DDL.
  const ddl = generatedDdl(
    { id: 'pg', name: 'PG', kind: 'postgres', host: '127.0.0.1', port: 5432, user: 'u', database: 'db' },
    {
      kind: 'table', database: 'db', schema: 'public', name: 'orders', definition: null,
      columns: [
        { name: 'id', dataType: 'integer', nullable: false, defaultValue: null, ordinal: 1, comment: null },
        { name: 'name', dataType: 'text', nullable: true, defaultValue: null, ordinal: 2, comment: null },
      ],
    },
    [],
    [
      { name: 'orders_pkey', kind: 'primary', columns: ['id'] },
      { name: 'orders_name_key', kind: 'unique', columns: ['name'] },
    ],
  )
  assert.match(ddl, /CREATE TABLE "public"[.]"orders"/u)
  assert.match(ddl, /"id" integer NOT NULL/u)
  assert.match(ddl, /PRIMARY KEY \("id"\)/u)
  assert.match(ddl, /UNIQUE \("name"\)/u)
  assert.match(ddl, /Generated from the live catalogue/u)
})
