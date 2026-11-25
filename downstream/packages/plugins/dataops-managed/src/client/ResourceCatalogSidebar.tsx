/**
 * The tab's own data-catalog tree (168px).
 *
 * 全部 / 收藏 / 置顶 stay as they were. The catalog section mirrors the portal's folder tree:
 * multi-root (数据中台 / 交投), expandable folders, counts and a recursive filter. Data comes
 * from GET /resources/folder-tree through the Host bridge; the right-hand portal iframe only
 * receives the resulting resource ids, so the portal page itself never renders its own sidebar
 * in embed mode.
 *
 * @module client/ResourceCatalogSidebar
 */

import { useCallback, useEffect, useState } from 'react'

export interface ResourceFilter {
  scope: 'all' | 'favorites' | 'pinned' | 'catalogNode'
  nodeId?: number
  ids?: number[]
}

interface FolderNode {
  id: number
  name: string
  label: string
  count: number
  children: FolderNode[]
}

interface FolderTreeResponse {
  nodes?: Array<Record<string, unknown>>
  total?: number
  assignedTotal?: number
  ungrouped?: { name?: string; resourceCount?: number }
}

interface ListResponse { items?: Array<{ id: number }>; total?: number }
interface PreferencePage { items?: Array<{ resourceId?: number; resource?: { id?: number } }>; total?: number }

const DOMAIN_LABELS: Record<string, string> = { 'data-platform': '数据中台', jiaotou: '交投' }

const CSS = `
.dsh-cat{flex:0 0 168px;width:168px;min-width:0;border-right:1px solid var(--dsw-alias-border-l1,#2a2c33);padding:8px 6px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-primary,#e6e8ee)}
.dsh-cat__head{display:flex;align-items:center;gap:6px;height:34px;padding:0 6px 0 8px;flex:0 0 auto}
.dsh-cat__head .ico{width:16px;height:16px;flex:0 0 auto;color:var(--dsw-alias-label-secondary,#aab2c2)}
.dsh-cat__head .tt{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e8ee);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-cat__head .sp{flex:1}
.dsh-cat__head .collapse{width:22px;height:22px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-caption,#8b93a4);cursor:pointer;display:grid;place-items:center}
.dsh-cat__head .collapse:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-cat__search{margin:2px 8px 8px;height:28px;display:flex;align-items:center;gap:6px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2,#2c2f38);background:var(--dsw-alias-bg-layer-1,#1a1c21)}
.dsh-cat__search input{flex:1;min-width:0;border:0;outline:0;background:transparent;color:var(--dsw-alias-label-primary,#e6e8ee);font-size:12px}
.dsh-cat__search input::placeholder{color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-cat__title{margin:8px 6px 3px;font-size:10px;letter-spacing:.04em;color:var(--dsw-alias-label-caption,#8b93a4)}
.dsh-cat__item{display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#aab2c2);font-size:12px;text-align:left;cursor:pointer}
.dsh-cat__item:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-cat__item.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.10));color:var(--dsw-alias-label-primary,#fff)}
.dsh-cat__item .n{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption,#8b93a4);font-variant-numeric:tabular-nums}
.dsh-cat__item .ico{width:14px;text-align:center;font-size:11px;flex:0 0 auto}
.dsh-cat__tree{display:flex;flex-direction:column;gap:1px;padding:0 2px 6px}
.dsh-cat__node{display:flex;flex-direction:column}
.dsh-cat__row{display:flex;align-items:center;gap:5px;width:100%;height:28px;padding:0 6px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary,#aab2c2);font-size:12px;text-align:left;cursor:pointer}
.dsh-cat__row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.06))}
.dsh-cat__row.is-active{background:var(--dsw-alias-interactive-bg-active,rgba(255,255,255,.10));color:var(--dsw-alias-label-primary,#fff)}
.dsh-cat__tw{width:12px;height:12px;flex:0 0 auto;display:grid;place-items:center;color:var(--dsw-alias-label-caption,#8b93a4);transition:transform .15s ease}
.dsh-cat__row.is-open .dsh-cat__tw{transform:rotate(90deg)}
.dsh-cat__folder{width:14px;height:14px;flex:0 0 auto;color:var(--dsw-alias-state-business-primary,#5b9dff)}
.dsh-cat__row.is-active .dsh-cat__folder{color:inherit}
.dsh-cat__nm{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-cat__cnt{margin-left:auto;font-size:10px;color:var(--dsw-alias-label-caption,#8b93a4);font-variant-numeric:tabular-nums}
.dsh-cat__kids{display:none;flex-direction:column;gap:1px;margin-left:13px;padding-left:4px;border-left:1px solid var(--dsw-alias-border-l1,#2a2c33)}
.dsh-cat__kids.is-open{display:flex}
`

const folderIcon = (open: boolean): JSX.Element => (
  <svg className="dsh-cat__folder" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
    {open
      ? <path d="M1.9 5.2h4.2l1.1 1.5h6.9l-1.5 6.1H2.6z" strokeLinejoin="round" />
      : <path d="M1.9 4.2h4l1.1 1.6h7.1v7.1a1 1 0 0 1-1 1H2.9a1 1 0 0 1-1-1z" strokeLinejoin="round" />}
  </svg>
)

const normalizeNode = (node: Record<string, unknown>): FolderNode => {
  const id = Number(node.id)
  const name = String(node.name ?? node.key ?? id)
  const children = Array.isArray(node.children)
    ? node.children.map((child) => normalizeNode(child as Record<string, unknown>))
    : []
  return {
    id,
    name,
    label: String(node.chineseName ?? DOMAIN_LABELS[name] ?? node.name ?? node.key ?? id),
    count: Number(node.recursiveResourceCount ?? node.resourceCount ?? 0),
    children,
  }
}

export function ResourceCatalogSidebar({ onFilter }: { onFilter: (filter: ResourceFilter) => void }) {
  const [folders, setFolders] = useState<FolderNode[]>([])
  const [total, setTotal] = useState(0)
  const [favorites, setFavorites] = useState<number[]>([])
  const [pinned, setPinned] = useState<number[]>([])
  const [favoriteTotal, setFavoriteTotal] = useState(0)
  const [pinnedTotal, setPinnedTotal] = useState(0)
  const [active, setActive] = useState('all')
  const [query, setQuery] = useState('')
  const [openKeys, setOpenKeys] = useState<Set<number>>(() => new Set())
  const [expandedOnce, setExpandedOnce] = useState(false)

  useEffect(() => {
    const style = document.createElement('style')
    style.dataset.dataopsCatalogTree = 'true'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => style.remove()
  }, [])

  useEffect(() => {
    let live = true
    let timer: number | undefined
    const load = async (): Promise<boolean> => {
      try {
        const [treeResponse, listResponse, favoriteResponse, pinnedResponse] = await Promise.all([
          fetch('/integrations/dataops/resources/folder-tree', { headers: { accept: 'application/json' } }),
          fetch('/integrations/dataops/resources?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
          fetch('/integrations/dataops/resources/favorites?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
          fetch('/integrations/dataops/resources/pinned?page=1&pageSize=100', { headers: { accept: 'application/json' } }),
        ])
        if (!live) return false
        if (!treeResponse.ok) throw new Error('HTTP ' + String(treeResponse.status))
        const tree = await treeResponse.json() as FolderTreeResponse
        const roots = (tree.nodes ?? []).map(normalizeNode)
        // The tree counts include system/platform resources while the plain list endpoint
        // defaults to non-system rows. Keep one universe: use the tree total and show the
        // resources that are not attached to any folder as an explicit bucket.
        const accounted = roots.reduce((sum, node) => sum + node.count, 0)
        const treeTotal = typeof tree.total === 'number' ? tree.total : accounted
        if (treeTotal > accounted) {
          roots.push({ id: -1, name: '未纳入目录', label: '未纳入目录', count: treeTotal - accounted, children: [] })
        }
        setFolders(roots)
        if (!expandedOnce) {
          setOpenKeys(new Set(roots.filter((node) => node.children.length > 0).map((node) => node.id)))
          setExpandedOnce(true)
        }
        if (listResponse.ok) {
          const list = await listResponse.json() as ListResponse
          setTotal(typeof tree.total === 'number' ? tree.total : (typeof list.total === 'number' ? list.total : (list.items ?? []).length))
        }
        if (favoriteResponse.ok) {
          const page = await favoriteResponse.json() as PreferencePage
          setFavorites((page.items ?? []).map((item) => item.resourceId ?? item.resource?.id).filter((id): id is number => typeof id === 'number'))
          setFavoriteTotal(typeof page.total === 'number' ? page.total : (page.items ?? []).length)
        }
        if (pinnedResponse.ok) {
          const page = await pinnedResponse.json() as PreferencePage
          setPinned((page.items ?? []).map((item) => item.resourceId ?? item.resource?.id).filter((id): id is number => typeof id === 'number'))
          setPinnedTotal(typeof page.total === 'number' ? page.total : (page.items ?? []).length)
        }
        return true
      } catch {
        /* retry until the workspace credential is ready */
        return false
      }
    }
    const run = async (): Promise<void> => {
      const ok = await load()
      if (!live) return
      if (!ok) timer = window.setTimeout(() => { void run() }, 2500)
    }
    void run()
    return () => { live = false; if (timer !== undefined) window.clearTimeout(timer) }
  }, [expandedOnce])

  const item = (key: string, icon: string, label: string, count: number) => (
    <button
      key={key}
      type="button"
      className={'dsh-cat__item' + (active === key ? ' is-active' : '')}
      onClick={() => { setActive(key); if (key === 'all') onFilter({ scope: 'all' }); else if (key === 'favorites') onFilter({ scope: 'favorites', ids: favorites }); else onFilter({ scope: 'pinned', ids: pinned }) }}
      data-catalog-key={key}
    >
      <span className="ico" aria-hidden="true">{icon}</span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      <span className="n">{count}</span>
    </button>
  )

  const selectNode = useCallback(async (node: FolderNode): Promise<void> => {
    setActive('node:' + String(node.id))
    // Selecting a folder always expands it; the chevron alone collapses/expands without
    // changing the active filter.
    setOpenKeys((previous) => new Set(previous).add(node.id))
    try {
      const response = await fetch('/integrations/dataops/resources?catalogNodeId=' + String(node.id) + '&page=1&pageSize=100', { headers: { accept: 'application/json' } })
      if (!response.ok) return
      const page = await response.json() as ListResponse
      onFilter({ scope: 'catalogNode', nodeId: node.id, ids: (page.items ?? []).map((row) => row.id) })
    } catch {
      /* leave the current filter when the read fails */
    }
  }, [onFilter])

  const matches = (node: FolderNode): boolean => {
    const q = query.trim().toLowerCase()
    if (q === '') return true
    return node.label.toLowerCase().includes(q) || node.children.some(matches)
  }

  const nodeHtml = (node: FolderNode): JSX.Element => {
    const open = openKeys.has(node.id)
    const activeNode = active === 'node:' + String(node.id)
    return (
      <div className="dsh-cat__node" key={node.id}>
        <button
          type="button"
          className={'dsh-cat__row' + (open ? ' is-open' : '') + (activeNode ? ' is-active' : '')}
          onClick={() => { void selectNode(node) }}
          title={node.label}
          data-catalog-key={'node:' + String(node.id)}
        >
          <span
            className="dsh-cat__tw"
            role={node.children.length > 0 ? 'button' : undefined}
            aria-label={node.children.length > 0 ? (open ? '收起目录' : '展开目录') : undefined}
            onClick={(event) => {
              if (node.children.length === 0) return
              event.stopPropagation()
              setOpenKeys((previous) => {
                const next = new Set(previous)
                if (next.has(node.id)) next.delete(node.id)
                else next.add(node.id)
                return next
              })
            }}
          >
            {node.children.length > 0
              ? <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
              : null}
          </span>
          {folderIcon(open)}
          <span className="dsh-cat__nm">{node.label}</span>
          <span className="dsh-cat__cnt">{node.count}</span>
        </button>
        {node.children.length > 0 && matches(node) ? (
          <div className={'dsh-cat__kids' + (open ? ' is-open' : '')}>
            {node.children.filter(matches).map(nodeHtml)}
          </div>
        ) : null}
      </div>
    )
  }

  const visibleFolders = folders.filter(matches)

  return (
    <aside className="dsh-cat" aria-label="数据目录">
      <div className="dsh-cat__head">
        <svg className="ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
          <path d="M1.8 4.2h4l1.2 1.6h7.2v7.2a1 1 0 0 1-1 1H2.8a1 1 0 0 1-1-1z" />
        </svg>
        <span className="tt">数据资源</span>
        <span className="sp" />
        <button className="collapse" type="button" aria-label="收起目录" title="收起目录">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6" />
            <path d="M6 2.8v10.4" />
          </svg>
        </button>
      </div>
      <label className="dsh-cat__search">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true" style={{ opacity: 0.7 }}>
          <circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2 13.5 13.5" />
        </svg>
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按目录名搜索…" aria-label="按目录名搜索" />
      </label>
      {item('all', '▤', '全部', total)}
      {item('favorites', '★', '收藏', favoriteTotal)}
      {item('pinned', '📌', '置顶', pinnedTotal)}
      <div className="dsh-cat__title">数据目录</div>
      <div className="dsh-cat__tree">
        {visibleFolders.length === 0
          ? <div style={{ padding: '4px 8px', fontSize: 10.5, opacity: 0.7 }}>暂无目录</div>
          : visibleFolders.map(nodeHtml)}
      </div>
    </aside>
  )
}
