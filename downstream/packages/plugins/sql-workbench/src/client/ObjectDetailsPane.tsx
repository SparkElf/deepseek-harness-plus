// @ts-nocheck
import { useEffect, useMemo, useState } from 'react'
import {
  VscChevronDown,
  VscComment,
  VscCopy,
  VscDownload,
  VscEllipsis,
  VscEye,
  VscKey,
  VscRefresh,
  VscTable,
} from 'react-icons/vsc'
import type { CatalogDatabase, CatalogObject, ConnectionConfig, ObjectDetails } from '../types.ts'
import { driverCapabilities } from '../dialects.ts'
import { CodeEditor } from './CodeEditor.tsx'
import { copyText } from './clipboard.ts'
import { useT } from './i18n.tsx'
import css from './SqlWorkbench.module.css'

export interface ObjectDetailsPaneProps {
  connection: ConnectionConfig | null
  database: CatalogDatabase | null
  object: CatalogObject | null
  details: ObjectDetails | null
  onPreview(object: CatalogObject): void
  onAdd(object: CatalogObject): void
  onRefresh(object: CatalogObject): void
}

type InspectorTab = 'overview' | 'columns' | 'indexes' | 'foreignKeys' | 'constraints' | 'ddl'
type ColumnSortKey = 'name' | 'type' | 'comment'

const CONSTRAINT_LABELS = {
  primary: 'details.primary',
  unique: 'details.unique',
  foreign: 'constraint.foreign',
  check: 'constraint.check',
} as const

const TAB_KEYS = [
  ['overview', 'inspector.overview'],
  ['columns', 'inspector.columns'],
  ['indexes', 'inspector.indexes'],
  ['foreignKeys', 'inspector.foreignKeys'],
  ['constraints', 'inspector.constraints'],
  ['ddl', 'inspector.ddl'],
] as const

function formatSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return String(bytes) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  return value.toFixed(value >= 10 ? 0 : 1) + ' ' + units[unit]
}

/**
 * The database object inspector.
 *
 * One fixed header carries the identity and every action, one tab strip switches the
 * detail blocks, and each block owns its empty state. The previous version was a flat
 * list of key/value rows followed by three tables, which hid the primary key, never
 * showed a column comment, and offered no way to copy the DDL or jump to the rows.
 */
export function ObjectDetailsPane({ connection, database, object, details, onPreview, onAdd, onRefresh }: ObjectDetailsPaneProps) {
  const t = useT()
  const [tab, setTab] = useState<InspectorTab>('overview')
  const [columnQuery, setColumnQuery] = useState('')
  const [sort, setSort] = useState<{ key: ColumnSortKey; direction: 1 | -1 }>({ key: 'name', direction: 1 })
  const [moreOpen, setMoreOpen] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => { setTab('overview'); setColumnQuery(''); setMoreOpen(false) }, [object?.name])
  useEffect(() => {
    if (notice === null) return
    const timer = window.setTimeout(() => { setNotice(null) }, 2200)
    return () => { window.clearTimeout(timer) }
  }, [notice])

  const capabilities = connection === null ? null : driverCapabilities(connection.kind)
  const qualifiedName = details?.qualifiedName ?? object?.name ?? ''

  const primaryColumns = useMemo(() => {
    const fromIndexes = details?.indexes.filter(index => index.primary).flatMap(index => index.columns) ?? []
    const fromConstraints = details?.constraints.filter(constraint => constraint.kind === 'primary').flatMap(constraint => constraint.columns) ?? []
    return new Set([...fromIndexes, ...fromConstraints])
  }, [details])

  const columns = useMemo(() => {
    const source = object?.columns ?? []
    const needle = columnQuery.trim().toLowerCase()
    const filtered = needle === ''
      ? source
      : source.filter(column => column.name.toLowerCase().includes(needle)
        || column.dataType.toLowerCase().includes(needle)
        || (column.comment ?? '').toLowerCase().includes(needle))
    return [...filtered].sort((left, right) => {
      const pick = (column: typeof left): string => sort.key === 'name'
        ? column.name
        : sort.key === 'type'
          ? column.dataType
          : column.comment ?? ''
      return pick(left).localeCompare(pick(right)) * sort.direction
    })
  }, [columnQuery, object, sort])

  const copy = async (text: string, message: string): Promise<void> => {
    setNotice(await copyText(text) ? message : t('inspector.copyFailed'))
  }

  if (connection === null) return <div className={css.workspaceEmpty}>{t('tree.selectConnection')}</div>

  if (object === null) {
    const schemaCount = database?.schemas.length ?? 0
    const objects = database?.schemas.flatMap(schema => schema.objects) ?? []
    const product = database?.product ?? capabilities?.label ?? connection.name
    const version = database?.version ?? connection.versionHint ?? capabilities?.versionRange ?? ''
    return <section className={css.detailsPane} data-sql-database-details>
      <header className={css.objectHeader}>
        <div className={css.objectHeaderIdentity}>
          <span className={css.objectIcon}><VscTable size={20} /></span>
          <div className={css.objectHeaderCopy}>
            <h2>{database?.name ?? connection.name}</h2>
            <span>{product}{version === '' ? '' : ' · ' + version}</span>
          </div>
        </div>
      </header>
      <div className={css.inspectorBody}>
        <dl className={css.overviewGrid}>
          <div><dt>{t('details.connection')}</dt><dd>{connection.name}</dd></div>
          <div><dt>{t('details.product')}</dt><dd>{product}</dd></div>
          <div><dt>{t('details.version')}</dt><dd>{version}</dd></div>
          {connection.kind === 'sqlite'
            ? <div><dt>{t('field.file')}</dt><dd title={connection.file}>{connection.file}</dd></div>
            : <>
              <div><dt>{t('field.host')}</dt><dd>{connection.host}:{connection.port}</dd></div>
              <div><dt>{t('field.user')}</dt><dd>{connection.user || '—'}</dd></div>
            </>}
          {database?.charset != null && <div><dt>{t('details.charset')}</dt><dd>{database.charset}</dd></div>}
          {database?.collation != null && <div><dt>{t('details.collation')}</dt><dd>{database.collation}</dd></div>}
          <div><dt>{t('details.schemas')}</dt><dd>{schemaCount}</dd></div>
          <div><dt>{t('details.tables')}</dt><dd>{objects.filter(item => item.kind === 'table').length}</dd></div>
          <div><dt>{t('details.views')}</dt><dd>{objects.filter(item => item.kind === 'view').length}</dd></div>
        </dl>
      </div>
    </section>
  }

  const value: CatalogObject = details?.object ?? object
  const comment = value.comment?.trim() ?? ''
  const ddl = details?.ddl ?? value.definition ?? null
  const blockErrors = details?.blockErrors ?? []
  const indexes = details?.indexes ?? []
  const foreignKeys = details?.foreignKeys ?? []
  const constraints = details?.constraints ?? []
  const isSqlite = connection.kind === 'sqlite'
  const commentHint = isSqlite ? t('inspector.sqliteNoComment') : t('inspector.noComment')

  const toggleSort = (key: ColumnSortKey): void => {
    setSort(current => current.key === key
      ? { key, direction: current.direction === 1 ? -1 : 1 }
      : { key, direction: 1 })
  }

  const downloadDdl = (): void => {
    if (ddl === null) return
    const blob = new Blob([ddl], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = value.name + '.sql'
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const empty = (label: string): JSX.Element => <div className={css.inspectorEmpty}>
    <span>{label}</span>
    <button onClick={() => { onRefresh(value) }}><VscRefresh />{t('inspector.refresh')}</button>
  </div>

  return <section className={css.detailsPane} data-sql-object-details>
    <header className={css.objectHeader}>
      <div className={css.objectHeaderIdentity}>
        <span className={css.objectIcon}>{value.kind === 'table' ? <VscTable size={20} /> : <VscEye size={20} />}</span>
        <div className={css.objectHeaderCopy}>
          <h2 title={value.name}>{value.name}</h2>
          <span>{qualifiedName} · {value.kind}</span>
        </div>
      </div>
      <div className={css.objectHeaderActions}>
        <button className={css.primaryButton} onClick={() => { onPreview(value) }}><VscEye />{t('inspector.preview')}</button>
        <button className={css.commandButton} onClick={() => { onAdd(value) }}><VscComment />{t('inspector.addToChat')}</button>
        <button className={css.commandButton} disabled={ddl === null} onClick={() => { void copy(ddl ?? '', t('inspector.copiedDdl')) }}><VscCopy />{t('inspector.copyDdl')}</button>
        <button className={css.iconButton} title={t('inspector.refresh')} onClick={() => { onRefresh(value) }}><VscRefresh /></button>
        <div className={css.moreWrap}>
          <button className={css.iconButton} title={t('inspector.more')} aria-expanded={moreOpen} onClick={() => { setMoreOpen(open => !open) }}><VscEllipsis /></button>
          {moreOpen && <div className={css.moreMenu}>
            <button onClick={() => { void copy(qualifiedName, t('inspector.copiedName')); setMoreOpen(false) }}><VscCopy />{t('inspector.copyQualified')}</button>
            <button onClick={() => { void copy('SELECT * FROM ' + qualifiedName + ';', t('inspector.copiedSelect')); setMoreOpen(false) }}><VscCopy />{t('inspector.copySelect')}</button>
            <button disabled={ddl === null} onClick={() => { downloadDdl(); setMoreOpen(false) }}><VscDownload />{t('inspector.downloadDdl')}</button>
          </div>}
        </div>
      </div>
    </header>

    <nav className={css.inspectorTabs} role="tablist" aria-label={t('inspector.tabs')}>
      {TAB_KEYS.map(([key, label]) => <button
        key={key}
        role="tab"
        aria-selected={tab === key}
        data-active={tab === key}
        onClick={() => { setTab(key) }}
      >{t(label)}{key === 'columns' ? ' · ' + String(value.columns.length) : ''}</button>)}
    </nav>

    <div className={css.inspectorBody}>
      {notice !== null && <div className={css.inspectorNotice} role="status">{notice}</div>}
      {blockErrors.length > 0 && <div className={css.inspectorWarning} role="status">
        {blockErrors.map(error => <span key={error.block}>{error.block}: {error.message}</span>)}
      </div>}

      {tab === 'overview' && <>
        <dl className={css.overviewGrid}>
          <div><dt>{t('details.database')}</dt><dd>{value.database}</dd></div>
          <div><dt>{t('details.schema')}</dt><dd>{value.schema ?? '—'}</dd></div>
          <div><dt>{t('details.type')}</dt><dd>{value.kind}</dd></div>
          <div><dt>{t('details.engine')}</dt><dd>{value.engine ?? '—'}</dd></div>
          <div><dt>{t('details.owner')}</dt><dd>{value.owner ?? '—'}</dd></div>
          <div><dt>{t('details.rows')}</dt><dd>{value.estimatedRows ?? '—'}</dd></div>
          <div><dt>{t('inspector.size')}</dt><dd>{formatSize(value.sizeBytes)}</dd></div>
          <div><dt>{t('inspector.qualifiedName')}</dt><dd title={qualifiedName}>{qualifiedName}</dd></div>
          <div><dt>{t('details.columns')}</dt><dd>{value.columns.length}</dd></div>
          <div><dt>{t('details.indexes')}</dt><dd>{indexes.length}</dd></div>
          <div><dt>{t('inspector.foreignKeys')}</dt><dd>{foreignKeys.length}</dd></div>
          <div><dt>{t('details.constraints')}</dt><dd>{constraints.length}</dd></div>
        </dl>
        <div className={css.inspectorSectionTitle}>{t('inspector.comment')}</div>
        <p className={css.inspectorComment}>{comment === '' ? '—' : comment}</p>
      </>}

      {tab === 'columns' && <>
        <div className={css.inspectorToolbar}>
          <label className={css.inspectorSearch}><input value={columnQuery} placeholder={t('inspector.searchColumns')} onChange={event => { setColumnQuery(event.target.value) }} /></label>
          <button className={css.commandButton} onClick={() => { void copy(value.columns.map(column => column.name).join(', '), t('inspector.copiedColumns')) }}><VscCopy />{t('inspector.copyColumns')}</button>
        </div>
        {columns.length === 0
          ? empty(t('inspector.emptyColumns'))
          : <div className={css.inspectorTableScroll}><table className={css.inspectorTable}>
            <thead><tr>
              <th>#</th>
              <th><button className={css.sortHeader} onClick={() => { toggleSort('name') }}>{t('details.name')}{sort.key === 'name' ? <VscChevronDown className={sort.direction === -1 ? css.sortDesc : undefined} /> : null}</button></th>
              <th><button className={css.sortHeader} onClick={() => { toggleSort('type') }}>{t('details.type')}{sort.key === 'type' ? <VscChevronDown className={sort.direction === -1 ? css.sortDesc : undefined} /> : null}</button></th>
              <th>{t('details.nullable')}</th>
              <th>{t('details.default')}</th>
              <th>PK</th>
              <th><button className={css.sortHeader} onClick={() => { toggleSort('comment') }}>{t('inspector.columnComment')}{sort.key === 'comment' ? <VscChevronDown className={sort.direction === -1 ? css.sortDesc : undefined} /> : null}</button></th>
              <th />
            </tr></thead>
            <tbody>{columns.map(column => {
              const isPrimary = primaryColumns.has(column.name)
              return <tr key={column.name} data-primary={isPrimary}>
                <td className={css.mutedCell}>{column.ordinal}</td>
                <td title={column.name}><span className={css.columnName}>{column.name}</span>{isPrimary && <VscKey className={css.keyGlyph} aria-hidden="true" />}</td>
                <td title={column.dataType}>{column.dataType}</td>
                <td>{column.nullable ? t('details.yes') : t('details.no')}</td>
                <td title={column.defaultValue ?? undefined}>{column.defaultValue ?? '—'}</td>
                <td>{isPrimary ? <span className={css.pkBadge}>PK</span> : '—'}</td>
                <td title={column.comment ?? commentHint} className={column.comment === null || column.comment === undefined || column.comment === '' ? css.mutedCell : undefined}>{column.comment === null || column.comment === undefined || column.comment === '' ? '—' : column.comment}</td>
                <td><button className={css.rowAction} title={t('inspector.copyColumn')} onClick={() => { void copy(column.name, t('inspector.copiedColumn')) }}><VscCopy /></button></td>
              </tr>
            })}</tbody>
          </table></div>}
      </>}

      {tab === 'indexes' && (indexes.length === 0
        ? empty(t('inspector.emptyIndexes'))
        : <div className={css.inspectorTableScroll}><table className={css.inspectorTable}>
          <thead><tr><th>{t('details.name')}</th><th>{t('details.columns')}</th><th>{t('details.type')}</th><th>{t('details.unique')}</th><th>{t('details.primary')}</th></tr></thead>
          <tbody>{indexes.map(index => <tr key={index.name}>
            <td title={index.name}>{index.name}</td>
            <td>{index.columns.join(', ') || '—'}</td>
            <td>{index.type ?? '—'}</td>
            <td>{index.unique ? t('details.yes') : t('details.no')}</td>
            <td>{index.primary ? <span className={css.pkBadge}>PK</span> : '—'}</td>
          </tr>)}</tbody>
        </table></div>)}

      {tab === 'foreignKeys' && (foreignKeys.length === 0
        ? empty(t('inspector.emptyForeignKeys'))
        : <div className={css.inspectorTableScroll}><table className={css.inspectorTable}>
          <thead><tr><th>{t('details.name')}</th><th>{t('inspector.localColumns')}</th><th>{t('inspector.referenced')}</th><th>{t('details.definition')}</th></tr></thead>
          <tbody>{foreignKeys.map(key => <tr key={key.name}>
            <td title={key.name}>{key.name}</td>
            <td>{key.columns.join(', ') || '—'}</td>
            <td>{key.referencedTable === ''
              ? '—'
              : key.referencedTable + (key.referencedColumns.length === 0 ? '' : '(' + key.referencedColumns.join(', ') + ')')}</td>
            <td title={key.definition ?? undefined}>{key.definition ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>)}

      {tab === 'constraints' && (constraints.length === 0
        ? empty(t('inspector.emptyConstraints'))
        : <div className={css.inspectorTableScroll}><table className={css.inspectorTable}>
          <thead><tr><th>{t('details.name')}</th><th>{t('details.type')}</th><th>{t('details.columns')}</th><th>{t('details.definition')}</th></tr></thead>
          <tbody>{constraints.map(constraint => <tr key={constraint.name}>
            <td title={constraint.name}>{constraint.name}</td>
            <td>{t(CONSTRAINT_LABELS[constraint.kind])}</td>
            <td>{constraint.columns.join(', ') || '—'}</td>
            <td title={constraint.definition ?? undefined}>{constraint.definition ?? '—'}</td>
          </tr>)}</tbody>
        </table></div>)}

      {tab === 'ddl' && (ddl === null
        ? empty(t('inspector.emptyDdl'))
        : <>
          <div className={css.inspectorToolbar}>
            <span className={css.ddlSource}>{details?.ddlSource === 'generated' ? t('inspector.ddlGenerated') : t('inspector.ddlNative')}</span>
            <button className={css.commandButton} onClick={() => { void copy(ddl, t('inspector.copiedDdl')) }}><VscCopy />{t('inspector.copy')}</button>
            <button className={css.commandButton} onClick={downloadDdl}><VscDownload />{t('inspector.download')}</button>
          </div>
          <div className={css.ddlPane}>
            <CodeEditor value={ddl} kind={connection.kind} onChange={() => {}} onCommit={() => {}} readOnly />
          </div>
        </>)}
    </div>
  </section>
}
