/**
 * Native resource page for the cross-origin right-sidebar tab.
 *
 * The card, badge and button geometry mirrors the portal's `/embed/resources` page
 * (`DataOpsResourcesEmbedPage.vue`) so the tab keeps the product's existing look; only the
 * data path changes (Host bridge instead of a portal iframe). The left column is the data
 * catalog the product asks for: 全部 / 收藏 / 置顶 plus one row per catalog.
 *
 * @module client/ResourceListPanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'

/** One resource row as `/api/resources` returns it. */
interface ResourceRow {
  id: number
  urn?: string
  resourceType?: string
  chineseName?: string
  sourceSystem?: string
  sourceTable?: string
  sourceDept?: string
  rowCount?: number | null
  columnCount?: number
  accessLevel?: string
  aiVisible?: boolean
  catalog?: string
  remark?: string
  tags?: string[]
  columns?: Array<{ name?: string; chineseName?: string; dataType?: string; type?: string }>
}

interface ResourceListResponse {
  items?: ResourceRow[]
  total?: number
  error?: string
}

interface PreferencePage {
  items?: Array<{ resourceId?: number; resource?: ResourceRow }>
  total?: number
}

/** Purple primary action from the DataOps theme (`--wx-violet`), not the DSH blue. */
const WX_VIOLET = '#7c3aed'

const PANEL_CSS = `
.dsh-res{display:flex;height:100%;min-height:0;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dsh-res__side{flex:0 0 168px;width:168px;min-width:0;border-right:1px solid var(--dsw-alias-border-l2,#2c2f38);padding:8px 6px;overflow-y:auto;display:flex;flex-direction:column;gap:2px}
.dsh-res__side-title{margin:8px 6px 3px;font-size:10px;letter-spacing:.04em;color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-res__side-item{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#aab2c2);font-size:12px;text-align:left;cursor:pointer}
.dsh-res__side-item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-res__side-item.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.10));color:var(--dsw-alias-label-primary,#fff)}
.dsh-res__side-item .n{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption,#8b93a4);font-variant-numeric:tabular-nums}
.dsh-res__side-item .ico{width:14px;text-align:center;font-size:11px;flex:0 0 auto}
.dsh-res__main{flex:1;min-width:0;display:flex;flex-direction:column}
.dsh-res__toolbar{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,#2c2f38)}
.dsh-res__search{flex:1;min-width:0;height:28px;padding:0 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l3,#3a3d47);background:var(--dsw-alias-bg-layer-1,#1a1c21);color:inherit;font-size:12px;outline:none}
.dsh-res__count{font-size:10.5px;color:var(--dsw-alias-label-caption,#8b93a4);white-space:nowrap}
.dsh-res__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:10px;overflow-y:auto;align-content:start}
.resource-card{min-width:0;margin:0;padding:12px;border:1px solid var(--dsw-alias-border-l2,#2c2f38);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1a1c21);transition:border-color 160ms ease,box-shadow 160ms ease;display:flex;flex-direction:column}
.resource-card__head{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.resource-card__title{margin:7px 0 2px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#f2f4f8);overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;min-height:2.6em}
.resource-card__table{overflow-wrap:anywhere;color:var(--dsw-alias-label-caption,#8b93a4);font-size:11px;font-variant-numeric:tabular-nums}
.resource-card__meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:7px;color:var(--dsw-alias-label-secondary,#aab2c2);font-size:11px}
.resource-card__actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:auto;padding-top:10px}
.type-badge,.access-badge,.ai-badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:500;background:var(--dsw-alias-state-business-tertiary,rgba(76,141,255,.16));color:var(--dsw-alias-label-primary,#e6e8ee)}
.access-badge{background:var(--dsw-alias-bg-layer-2,#22252b);color:var(--dsw-alias-label-secondary,#aab2c2)}
.ai-badge{background:var(--dsw-alias-bg-layer-2,#22252b);color:var(--dsw-alias-state-success-primary,#2fbf71)}
.pref-actions{display:inline-flex;align-items:center;gap:1px;margin-left:auto}
.pref-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-caption,#8b93a4);cursor:pointer}
.pref-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06));color:var(--dsw-alias-label-primary,#fff)}
.pref-btn.is-on{color:var(--dsw-static-amber-400,#f5b942)}
.embed-btn{appearance:none;height:26px;padding:0 9px;border:1px solid var(--dsw-alias-border-l3,#3a3d47);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#e6e8ee);font-size:11px;font-weight:500;cursor:pointer}
.embed-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.embed-btn.is-primary{border-color:${WX_VIOLET};background:${WX_VIOLET};color:#fff}
.embed-btn.is-primary:hover{background:#6d28d9;border-color:#6d28d9}
.dsh-res__state{padding:24px 12px;text-align:center;font-size:11px;color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-res__detail{padding:10px;overflow-y:auto;display:grid;gap:10px;align-content:start}
.dsh-res__detail-head{display:flex;align-items:center;gap:8px}
.dsh-res__back{border:0;background:transparent;color:var(--dsw-alias-label-secondary,#aab2c2);font-size:12px;cursor:pointer;padding:0}
.dsh-res__kv{display:grid;gap:6px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#2c2f38);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1a1c21)}
.dsh-res__kv-row{display:grid;grid-template-columns:62px minmax(0,1fr);gap:8px;font-size:11.5px;line-height:1.55}
.dsh-res__kv-row .k{color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-res__cols{display:grid;gap:4px;padding:10px;border:1px solid var(--dsw-alias-border-l2,#2c2f38);border-radius:8px;background:var(--dsw-alias-bg-layer-1,#1a1c21)}
.dsh-res__col{display:flex;gap:8px;font-size:11px;color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-res__col .c{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary,#e6e8ee)}
`

const typeLabel = (row: ResourceRow): string => {
  const type = (row.resourceType ?? '').toUpperCase()
  if (type === 'TABLE') return '表'
  if (type === 'API') return 'API'
  if (type === 'FILE') return '文件'
  return type || '资源'
}

const accessLabel = (row: ResourceRow): string => {
  const level = (row.accessLevel ?? '').toUpperCase()
  if (level === 'PUBLIC') return '公开'
  if (level === 'PROTECTED') return '受限'
  if (level === 'PRIVATE') return '私有'
  return level || '—'
}

const formatNumber = (value: number | null | undefined): string => (
  value === null || value === undefined ? '—' : value.toLocaleString('zh-CN')
)

/** Card grid + data catalog sidebar. */
export function ResourceListPanel({
  initialResourceId,
  portalBaseUrl,
  onInsertReference,
}: {
  initialResourceId?: number
  portalBaseUrl: string
  onInsertReference?: (resource: ResourceRow) => void
}) {
  const [items, setItems] = useState<ResourceRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState('all')
  const [favorites, setFavorites] = useState<Set<number>>(new Set())
  const [pinned, setPinned] = useState<Set<number>>(new Set())
  const [favoriteTotal, setFavoriteTotal] = useState(0)
  const [pinnedTotal, setPinnedTotal] = useState(0)
  const [selected, setSelected] = useState<ResourceRow | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.dataopsResourceCards = 'true'
    style.textContent = PANEL_CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: '1', pageSize: '60' })
      if (query.trim() !== '') params.set('keyword', query.trim())
      const [listResponse, favoriteResponse, pinnedResponse] = await Promise.all([
        fetch('/integrations/dataops/resources?' + params.toString(), { headers: { accept: 'application/json' } }),
        fetch('/integrations/dataops/resources/favorites?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
        fetch('/integrations/dataops/resources/pinned?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
      ])
      const listPayload = await listResponse.json() as ResourceListResponse
      if (!listResponse.ok) throw new Error(listPayload.error ?? 'HTTP ' + String(listResponse.status))
      setItems(listPayload.items ?? [])
      setTotal(typeof listPayload.total === 'number' ? listPayload.total : (listPayload.items ?? []).length)
      if (favoriteResponse.ok) {
        const payload = await favoriteResponse.json() as PreferencePage
        setFavorites(new Set((payload.items ?? []).map((item) => item.resourceId ?? item.resource?.id).filter((id): id is number => typeof id === 'number')))
        setFavoriteTotal(typeof payload.total === 'number' ? payload.total : (payload.items ?? []).length)
      }
      if (pinnedResponse.ok) {
        const payload = await pinnedResponse.json() as PreferencePage
        setPinned(new Set((payload.items ?? []).map((item) => item.resourceId ?? item.resource?.id).filter((id): id is number => typeof id === 'number')))
        setPinnedTotal(typeof payload.total === 'number' ? payload.total : (payload.items ?? []).length)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }, [query])

  useEffect(() => { void load() }, [load, attempt])

  const catalogs = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of items) {
      if (typeof row.catalog !== 'string' || row.catalog.trim() === '') continue
      counts.set(row.catalog, (counts.get(row.catalog) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], 'zh-CN'))
  }, [items])

  const visible = useMemo(() => {
    let rows = items
    if (scope === 'favorites') rows = rows.filter((row) => favorites.has(row.id))
    else if (scope === 'pinned') rows = rows.filter((row) => pinned.has(row.id))
    else if (scope.startsWith('catalog:')) rows = rows.filter((row) => row.catalog === scope.slice('catalog:'.length))
    return rows
  }, [items, scope, favorites, pinned])

  const togglePreference = useCallback(async (id: number, kind: 'favorite' | 'pin'): Promise<void> => {
    const current = kind === 'favorite' ? favorites.has(id) : pinned.has(id)
    try {
      const response = await fetch('/integrations/dataops/resources/' + String(id) + '/' + kind, {
        method: current ? 'DELETE' : 'PUT',
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error('HTTP ' + String(response.status))
      const payload = await response.json() as { favorited?: boolean; pinned?: boolean }
      setFavorites((previous) => {
        const next = new Set(previous)
        if (payload.favorited === true) next.add(id); else next.delete(id)
        return next
      })
      setPinned((previous) => {
        const next = new Set(previous)
        if (payload.pinned === true) next.add(id); else next.delete(id)
        return next
      })
    } catch {
      /* the card keeps its current flag when the write fails */
    }
  }, [favorites, pinned])

  const openDetail = useCallback(async (row: ResourceRow) => {
    setSelected(row)
    setDetailLoading(true)
    setDetailError(null)
    try {
      const response = await fetch('/integrations/dataops/resources/' + String(row.id), { headers: { accept: 'application/json' } })
      const payload = await response.json() as { resource?: ResourceRow; error?: string }
      if (!response.ok || payload.resource === undefined) throw new Error(payload.error ?? 'HTTP ' + String(response.status))
      setSelected(payload.resource)
    } catch (cause) {
      setDetailError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (initialResourceId === undefined || items.length === 0) return
    const row = items.find((item) => item.id === initialResourceId)
    if (row !== undefined && selected?.id !== row.id) void openDetail(row)
  }, [initialResourceId, items, openDetail, selected?.id])

  const openPortal = (row: ResourceRow, mode: 'grant' | 'audit' | 'overview'): void => {
    const base = portalBaseUrl.replace(/\/+$/u, '')
    window.open(base + '/embed/resources?resourceId=' + String(row.id) + '&mode=' + mode, '_blank', 'noopener,noreferrer')
  }

  const sideItem = (key: string, icon: string, label: string, count: number) => (
    <button
      key={key}
      type="button"
      className={'dsh-res__side-item' + (scope === key ? ' is-active' : '')}
      onClick={() => { setScope(key); setSelected(null) }}
      data-catalog-key={key}
    >
      <span className="ico" aria-hidden="true">{icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="n">{count}</span>
    </button>
  )

  const sidebar = (
    <aside className="dsh-res__side" aria-label="数据目录">
      {sideItem('all', '▤', '全部', total)}
      {sideItem('favorites', '★', '收藏', favoriteTotal)}
      {sideItem('pinned', '📌', '置顶', pinnedTotal)}
      <div className="dsh-res__side-title">数据目录</div>
      {catalogs.length === 0 ? <div style={{ padding: '4px 8px', fontSize: 10.5, opacity: 0.7 }}>暂无目录</div> : null}
      {catalogs.map(([name, count]) => sideItem('catalog:' + name, '▸', name, count))}
    </aside>
  )

  const detail = selected === null ? null : (
    <div className="dsh-res__detail">
      <div className="dsh-res__detail-head">
        <button type="button" className="dsh-res__back" onClick={() => setSelected(null)}>← 列表</button>
        <div style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected.chineseName ?? '资源 #' + String(selected.id)}</div>
        {onInsertReference === undefined ? null : (
          <button type="button" className="embed-btn" onClick={() => onInsertReference(selected)}>添加到对话</button>
        )}
        <button type="button" className="embed-btn is-primary" onClick={() => openPortal(selected, 'grant')}>授权</button>
      </div>
      {detailLoading ? <div className="dsh-res__state">正在加载资源详情…</div> : null}
      {detailError !== null ? (
        <div className="dsh-res__state" role="alert" style={{ color: '#ff6b81' }}>
          {detailError}
          <button type="button" className="embed-btn" style={{ marginLeft: 8 }} onClick={() => { void openDetail(selected) }}>重试</button>
        </div>
      ) : null}
      <section className="dsh-res__kv">
        {[
          ['类型', typeLabel(selected)],
          ['URN', selected.urn ?? '-'],
          ['来源', [selected.sourceSystem, selected.sourceTable].filter(Boolean).join(' · ') || '-'],
          ['所属部门', selected.sourceDept ?? '-'],
          ['行数', formatNumber(selected.rowCount)],
          ['字段数', selected.columnCount === undefined ? '-' : String(selected.columnCount)],
          ['访问级别', accessLabel(selected)],
          ['标签', (selected.tags ?? []).join(' / ') || '-'],
          ['备注', selected.remark ?? '-'],
        ].map(([key, value]) => (
          <div key={key} className="dsh-res__kv-row">
            <span className="k">{key}</span>
            <span style={{ overflowWrap: 'anywhere' }}>{String(value)}</span>
          </div>
        ))}
      </section>
      {selected.columns === undefined || selected.columns.length === 0 ? null : (
        <section className="dsh-res__cols">
          <div style={{ fontSize: 11.5, fontWeight: 600 }}>字段（{selected.columns.length}）</div>
          {selected.columns.slice(0, 40).map((column, index) => (
            <div key={String(column.name ?? index)} className="dsh-res__col">
              <span className="c">{column.chineseName ?? column.name}</span>
              <span>{column.dataType ?? column.type ?? ''}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  )

  return (
    <div className="dsh-res">
      {sidebar}
      <div className="dsh-res__main">
        {selected === null ? (
          <>
            <div className="dsh-res__toolbar">
              <input
                className="dsh-res__search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索资源名称"
                aria-label="搜索数据资源"
              />
              <span className="dsh-res__count">{visible.length} / {total} 个资源</span>
              <button type="button" className="embed-btn" onClick={() => setAttempt((value) => value + 1)}>刷新</button>
            </div>
            <div className="dsh-res__grid" data-view="grid">
              {loading ? <div className="dsh-res__state">正在加载数据资源…</div> : null}
              {error !== null ? (
                <div className="dsh-res__state" role="alert" style={{ color: '#ff6b81' }}>
                  {error}
                  <button type="button" className="embed-btn" style={{ marginLeft: 8 }} onClick={() => setAttempt((value) => value + 1)}>重试</button>
                </div>
              ) : null}
              {!loading && error === null && visible.length === 0 ? <div className="dsh-res__state">没有匹配的数据资源</div> : null}
              {visible.map((resource) => (
                <article key={resource.id} className="resource-card" data-resource-id={resource.id}>
                  <div className="resource-card__head">
                    <span className="type-badge">{typeLabel(resource)}</span>
                    <span className="access-badge">{accessLabel(resource)}</span>
                    {resource.aiVisible === true ? <span className="ai-badge">AI 可见</span> : null}
                    <span className="pref-actions">
                      <button
                        type="button"
                        className={'pref-btn' + (favorites.has(resource.id) ? ' is-on' : '')}
                        aria-label={favorites.has(resource.id) ? '取消收藏' : '收藏'}
                        title={favorites.has(resource.id) ? '取消收藏' : '收藏'}
                        onClick={() => { void togglePreference(resource.id, 'favorite') }}
                      >
                        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                          <path d="M8 1.8l1.86 3.77 4.16.6-3.01 2.94.71 4.15L8 11.3l-3.72 1.96.71-4.15L1.98 6.17l4.16-.6z" fill={favorites.has(resource.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={'pref-btn' + (pinned.has(resource.id) ? ' is-on' : '')}
                        aria-label={pinned.has(resource.id) ? '取消置顶' : '置顶'}
                        title={pinned.has(resource.id) ? '取消置顶' : '置顶'}
                        onClick={() => { void togglePreference(resource.id, 'pin') }}
                      >
                        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                          <path d="M9.2 1.8l5 5-1.6.5-2.1 2.1.4 2.6-1.4 1.4-2.3-2.3-3.6 3.6-.7-.7 3.6-3.6-2.3-2.3 1.4-1.4 2.6.4 2.1-2.1z" fill={pinned.has(resource.id) ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
                        </svg>
                      </button>
                    </span>
                  </div>
                  <h2 className="resource-card__title">{resource.chineseName ?? '资源 #' + String(resource.id)}</h2>
                  <div className="resource-card__table">{resource.sourceTable || resource.urn}</div>
                  <div className="resource-card__meta">
                    <span>{formatNumber(resource.rowCount)} 行</span>
                    <span>{resource.columnCount ?? '—'} 字段</span>
                    <span>{resource.sourceSystem || '—'}</span>
                  </div>
                  <div className="resource-card__actions">
                    <button type="button" className="embed-btn is-primary" onClick={() => openPortal(resource, 'grant')}>授权</button>
                    <button type="button" className="embed-btn" onClick={() => onInsertReference?.(resource)}>添加到对话</button>
                    <button type="button" className="embed-btn" onClick={() => { void openDetail(resource) }}>详情</button>
                    <button type="button" className="embed-btn" aria-label="查看操作记录" onClick={() => openPortal(resource, 'audit')}>操作记录</button>
                  </div>
                </article>
              ))}
            </div>
          </>
        ) : detail}
      </div>
    </div>
  )
}