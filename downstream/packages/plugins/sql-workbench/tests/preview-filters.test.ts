import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultPreviewOperator, previewFilterType, previewFilterValue, previewOperators } from '../src/client/previewFilters.ts'
import type { CatalogColumn } from '../src/types.ts'

function column(dataType: string): CatalogColumn { return { name: 'value', dataType, nullable: true, ordinal: 1, defaultValue: null } }

test('preview filters select typed operators and convert values', () => {
  assert.equal(previewFilterType(column('varchar(255)')), 'text')
  assert.equal(previewFilterType(column('numeric(12,2)')), 'number')
  assert.equal(previewFilterType(column('timestamp with time zone')), 'date')
  assert.equal(previewFilterType(column('boolean')), 'boolean')
  assert.equal(defaultPreviewOperator(column('text')), 'contains')
  assert.equal(defaultPreviewOperator(column('integer')), 'eq')
  assert.deepEqual(previewOperators(column('integer')), ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isNull', 'isNotNull'])
  assert.equal(previewFilterValue(column('integer'), '42'), 42)
  assert.equal(previewFilterValue(column('boolean'), 'false'), false)
  assert.equal(previewFilterValue(column('date'), '2026-09-03'), '2026-09-03')
})
