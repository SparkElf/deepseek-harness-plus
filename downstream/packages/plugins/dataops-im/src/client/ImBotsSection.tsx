import { useCallback, useEffect, useState } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  bindIdentityUser,
  createBot,
  deleteBot,
  fetchBots,
  fetchIdentityUsers,
  fetchImFeatures,
  fetchOptions,
  fetchPendingSenders,
  testBot,
  updateBot,
  type ImBotDraft,
  type ImBotOptions,
  type ImBotView,
  type ImCapability,
  type ImIdentityUser,
  type ImPendingSender,
  type ImPendingStatus,
} from './api.ts'
import { ImBulkBindingSection } from './ImBulkBindingSection.tsx'
import { probeImBotSettings } from './visibility.ts'

/** 主题无关的基础样式：颜色一律继承，边框用半透明灰，深浅主题都能读。 */
const styles = {
  root: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0 24px', fontSize: 13 } as const,
  header: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' } as const,
  title: { fontSize: 15, fontWeight: 600, margin: 0 } as const,
  hint: { opacity: 0.65, margin: 0, lineHeight: 1.5 } as const,
  banner: {
    border: '1px solid rgba(220,120,60,0.55)',
    borderRadius: 6,
    padding: '8px 10px',
    lineHeight: 1.5,
  } as const,
  list: { display: 'flex', flexDirection: 'column', gap: 8 } as const,
  card: {
    border: '1px solid rgba(128,128,128,0.3)',
    borderRadius: 8,
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  } as const,
  cardHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } as const,
  cardName: { fontWeight: 600, fontSize: 13 } as const,
  meta: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, opacity: 0.8 } as const,
  metaItem: { display: 'inline-flex', gap: 4, alignItems: 'baseline' } as const,
  metaKey: { opacity: 0.6 } as const,
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap' } as const,
  form: {
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 8,
    padding: 12,
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
    gap: 10,
  } as const,
  field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } as const,
  label: { fontSize: 12, opacity: 0.7 } as const,
  input: {
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.45)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 13,
    minWidth: 0,
  } as const,
  result: { fontSize: 12, lineHeight: 1.5, marginTop: 4 } as const,
} as const

/** 状态 → 中文标签与颜色。只做展示，不参与授权。 */
const STATUS_TEXT: Record<ImBotView['status'], { label: string; color: string }> = {
  CONNECTED: { label: '在线', color: '#3fa46a' },
  DISCONNECTED: { label: '离线', color: '#b0823a' },
  ERROR: { label: '错误', color: '#d0554d' },
  DISABLED: { label: '已停用', color: '#8a8a8a' },
  UNKNOWN: { label: '未探测', color: '#8a8a8a' },
}

/** 平台 → 中文标签。 */
const PROVIDER_TEXT: Record<ImBotView['provider'], string> = { WECOM: '企业微信', DINGTALK: '钉钉' }

/** 待绑定发送者状态 → 中文标签与颜色。只做展示，不参与授权。 */
const PENDING_STATUS_TEXT: Record<ImPendingStatus, { label: string; color: string }> = {
  resolving: { label: '解析中', color: '#b0823a' },
  unmapped: { label: '未绑定', color: '#d0554d' },
  bound: { label: '已绑定', color: '#3fa46a' },
  unavailable: { label: '身份服务不可用', color: '#8a8a8a' },
}

/** 管理面时间显示；服务端使用 epoch 毫秒。 */
function formatUpdatedAt(value: number): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('zh-CN', { hour12: false })
}

/** 表单草稿：编辑时 Bot ID / Secret 可留空表示不改。 */
interface Draft {
  name: string
  provider: ImBotView['provider']
  botId: string
  secret: string
  workspaceId: string
  serviceAccountId: string
  enabled: boolean
}

const emptyDraft = (): Draft => ({
  name: '',
  provider: 'WECOM',
  botId: '',
  secret: '',
  workspaceId: '',
  serviceAccountId: '',
  enabled: true,
})

/** 一行一次测试/保存的结果提示。 */
interface RowNotice {
  tone: 'ok' | 'error'
  text: string
}

/**
 * DSH 设置 →「IM 机器人」。
 *
 * 薄管理页：列表、新建、编辑、启停、测试、删除。所有数据来自 DataOps `/api/im/bots`，
 * 由本插件的同源代理转发；页面本身不读、不缓存 Secret，只显示「已配置 / 未配置」。
 * @returns 设置页内容。
 */
export function ImBotsSection() {
  const [bots, setBots] = useState<ImBotView[]>([])
  const [options, setOptions] = useState<ImBotOptions>({ workspaces: [], serviceAccounts: [] })
  const [optionsError, setOptionsError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [notices, setNotices] = useState<Record<string, RowNotice>>({})
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(emptyDraft())
  const [saving, setSaving] = useState(false)
  const [identityUsers, setIdentityUsers] = useState<ImIdentityUser[]>([])
  const [identityQuery, setIdentityQuery] = useState('')
  const [identityLoading, setIdentityLoading] = useState(true)
  const [identityBusy, setIdentityBusy] = useState<string | null>(null)
  const [identityDrafts, setIdentityDrafts] = useState<Record<string, string>>({})
  const [identityNotice, setIdentityNotice] = useState<RowNotice | null>(null)
  const [showPending, setShowPending] = useState(false)
  const [pendingSenders, setPendingSenders] = useState<ImPendingSender[]>([])
  const [pendingLoading, setPendingLoading] = useState(true)
  const [pendingNotice, setPendingNotice] = useState<RowNotice | null>(null)
  const [pendingHint, setPendingHint] = useState<string | null>(null)
  const [pendingBusy, setPendingBusy] = useState<string | null>(null)
  const [pendingTargets, setPendingTargets] = useState<Record<string, string>>({})
  const [capability, setCapability] = useState<ImCapability | null>(null)
  const [capabilityLoading, setCapabilityLoading] = useState(true)

  const loadIdentity = useCallback(async (query = '') => {
    setIdentityLoading(true)
    try {
      const value = await fetchIdentityUsers(query)
      setIdentityUsers(value.items)
      setIdentityNotice(null)
    } catch (error) {
      setIdentityNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setIdentityLoading(false)
    }
  }, [])

  const loadPending = useCallback(async () => {
    setPendingLoading(true)
    try {
      const value = await fetchPendingSenders()
      setPendingSenders(value.items)
      setPendingHint(value.message ?? null)
      setPendingNotice(null)
    } catch (error) {
      setPendingNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setPendingLoading(false)
    }
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      setBots(await fetchBots())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void probeImBotSettings()
      .then((value) => { if (!cancelled) setCapability(value) })
      .catch(() => {
        if (!cancelled) setCapability({ available: false, allowed: false, reason: 'capability probe failed' })
      })
      .finally(() => { if (!cancelled) setCapabilityLoading(false) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    // 入口注册时已经探测过一次；这里再确认一次，防止部署在页面打开后降级。
    // 不可用时不再发 bots/identity/options 请求，避免空表和错误横幅。
    if (capability?.available !== true || capability.allowed !== true) return
    void reload()
    void loadIdentity()
    // 待绑定发送者仅作内部诊断：默认不渲染、不请求；只有显式打开功能开关才加载。
    void fetchImFeatures().then((features) => {
      setShowPending(features.showPendingSenders)
      if (features.showPendingSenders) void loadPending()
    })
    void fetchOptions()
      .then((value) => { setOptions(value); setOptionsError(null) })
      .catch((error: unknown) => setOptionsError(error instanceof Error ? error.message : String(error)))
  }, [capability, reload, loadIdentity, loadPending])

  const setNotice = (id: string, notice: RowNotice | null): void => {
    setNotices((current) => {
      const next = { ...current }
      if (notice === null) delete next[id]
      else next[id] = notice
      return next
    })
  }

  const toggleEnabled = async (bot: ImBotView, next: boolean): Promise<void> => {
    setBusyId(bot.id)
    try {
      const updated = await updateBot(bot.id, { enabled: next })
      setBots((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setNotice(bot.id, { tone: 'ok', text: next ? '已启用' : '已停用' })
    } catch (error) {
      setNotice(bot.id, { tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }

  const runTest = async (bot: ImBotView): Promise<void> => {
    setBusyId(bot.id)
    try {
      const { result, bot: updated } = await testBot(bot.id)
      setBots((current) => current.map((item) => (item.id === updated.id ? updated : item)))
      setNotice(bot.id, {
        tone: result.ok ? 'ok' : 'error',
        text: `${result.code} · ${result.message}（${result.latencyMs} ms）`,
      })
    } catch (error) {
      setNotice(bot.id, { tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }

  const beginEdit = (bot: ImBotView): void => {
    setEditing(bot.id)
    setDraft({
      name: bot.name,
      provider: bot.provider,
      botId: '',
      secret: '',
      workspaceId: bot.workspaceId === null ? '' : String(bot.workspaceId),
      serviceAccountId: bot.serviceAccountId ?? '',
      enabled: bot.enabled,
    })
  }

  const beginCreate = (): void => {
    setEditing('new')
    setDraft(emptyDraft())
  }

  const submit = async (): Promise<void> => {
    const workspaceId = draft.workspaceId.trim() === '' ? null : Number(draft.workspaceId)
    if (workspaceId !== null && (!Number.isInteger(workspaceId) || workspaceId <= 0)) {
      setLoadError('工作区 ID 必须是正整数')
      return
    }
    const payload: ImBotDraft = {
      name: draft.name.trim(),
      provider: draft.provider,
      ...(draft.botId.trim() === '' ? {} : { botId: draft.botId.trim() }),
      ...(draft.secret.trim() === '' ? {} : { secret: draft.secret }),
      workspaceId,
      serviceAccountId: draft.serviceAccountId.trim() === '' ? null : draft.serviceAccountId.trim(),
      enabled: draft.enabled,
    }
    setSaving(true)
    try {
      if (editing === 'new') {
        if (payload.name === '' || payload.botId === undefined) throw new Error('名称与 Bot ID 必填')
        await createBot(payload)
      } else if (typeof editing === 'string') {
        await updateBot(editing, payload)
      }
      setEditing(null)
      setDraft(emptyDraft())
      setLoadError(null)
      await reload()
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (bot: ImBotView): Promise<void> => {
    if (!window.confirm(`删除登记「${bot.name}」？工作区与会话不受影响，但该机器人不再出现在管理列表。`)) return
    setBusyId(bot.id)
    try {
      await deleteBot(bot.id)
      await reload()
    } catch (error) {
      setNotice(bot.id, { tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusyId(null)
    }
  }

  const editingBot = typeof editing === 'string' ? bots.find((bot) => bot.id === editing) ?? null : null

  // 连接器不知道管理员刚在别的页面完成了绑定，因此这里再用用户列表过滤一次：
  // 已经出现在某个账号 wecomUserId 上的 sender 不再显示为“待绑定”。
  const boundWecomIds = new Set(
    identityUsers.map((user) => user.wecomUserId).filter((value): value is string => value !== null && value !== ''),
  )
  const visiblePending = pendingSenders.filter(
    (item) => item.status !== 'bound' && !boundWecomIds.has(item.senderId),
  )

  const bindSender = async (item: ImPendingSender): Promise<void> => {
    const userId = pendingTargets[item.senderId] ?? ''
    if (userId === '') return
    setPendingBusy(item.senderId)
    try {
      const updated = await bindIdentityUser(userId, item.senderId)
      setIdentityUsers((current) => current.map((user) => (user.id === updated.id ? updated : user)))
      setPendingTargets((current) => {
        const next = { ...current }
        delete next[item.senderId]
        return next
      })
      await loadPending()
      setPendingNotice({ tone: 'ok', text: `已绑定 ${updated.username} → ${item.senderIdMasked}` })
    } catch (error) {
      setPendingNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setPendingBusy(null)
    }
  }

  if (capabilityLoading) {
    return (
      <div style={styles.root} data-im-capability="loading">
        <h3 style={styles.title}>IM 机器人</h3>
        <p style={styles.hint}>正在检查 IM 管理能力…</p>
      </div>
    )
  }
  if (capability === null || !capability.available) {
    return (
      <div style={styles.root} data-im-capability="unavailable">
        <h3 style={styles.title}>IM 机器人</h3>
        <p style={styles.hint}>IM 管理未启用。</p>
        <p style={styles.hint}>当前部署没有 IM 管理接口，本页不会显示机器人列表或报错。</p>
        {capability?.reason !== undefined && capability.reason !== '' && (
          <p style={styles.hint}>原因：{capability.reason}</p>
        )}
      </div>
    )
  }
  if (!capability.allowed) {
    return (
      <div style={styles.root} data-im-capability="forbidden">
        <h3 style={styles.title}>IM 机器人</h3>
        <p style={styles.hint}>当前账号没有 IM 机器人管理权限。</p>
      </div>
    )
  }

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <h3 style={styles.title}>IM 机器人</h3>
        <Button size="sm" onClick={() => void reload()} disabled={loading}>刷新</Button>
        <Button size="sm" variant="primary" onClick={beginCreate} disabled={editing === 'new'}>新建机器人</Button>
      </div>
      <p style={styles.hint}>
        集中管理企业微信/钉钉机器人：登记 Bot、绑定专用工作区、启停与测试连接。Secret 只写不读，
        列表只显示「已配置」。真正的通道运行在绑定的专用工作区里，本页不会启动或重启它。
      </p>
      {loadError !== null && <div style={styles.banner}>{loadError}</div>}
      {optionsError !== null && (
        <p style={styles.hint}>工作区选项加载失败：{optionsError}（仍可直接填工作区 ID）</p>
      )}

      {loading ? (
        <p style={styles.hint}>正在读取…</p>
      ) : bots.length === 0 ? (
        <p style={styles.hint}>还没有登记任何机器人。</p>
      ) : (
        <div style={styles.list}>
          {bots.map((bot) => {
            const status = STATUS_TEXT[bot.status]
            const notice = notices[bot.id]
            const busy = busyId === bot.id
            return (
              <div key={bot.id} data-im-bot={bot.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{bot.name}</span>
                  <span style={{ color: status.color, fontSize: 12 }}>● {status.label}</span>
                  <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 12, opacity: 0.7 }}>{bot.enabled ? '已启用' : '已停用'}</span>
                    <Switch
                      checked={bot.enabled}
                      label={`启用 ${bot.name}`}
                      disabled={busy}
                      onChange={(next) => void toggleEnabled(bot, next)}
                    />
                  </span>
                </div>
                <div style={styles.meta}>
                  <span style={styles.metaItem}><span style={styles.metaKey}>平台</span>{PROVIDER_TEXT[bot.provider]}</span>
                  <span style={styles.metaItem}><span style={styles.metaKey}>Bot ID</span><code>{bot.botIdMasked}</code></span>
                  <span style={styles.metaItem}><span style={styles.metaKey}>工作区</span>{bot.workspaceName ?? '未绑定'}</span>
                  <span style={styles.metaItem}><span style={styles.metaKey}>Secret</span>{bot.secretConfigured ? '已配置' : '未配置'}</span>
                </div>
                {bot.lastError !== null && (
                  <div style={{ ...styles.result, color: '#d0554d' }}>{bot.lastError}</div>
                )}
                {notice !== undefined && (
                  <div style={{ ...styles.result, color: notice.tone === 'ok' ? '#3fa46a' : '#d0554d' }}>
                    {notice.text}
                  </div>
                )}
                <div style={styles.actions}>
                  <Button size="sm" disabled={busy} onClick={() => void runTest(bot)}>测试</Button>
                  <Button size="sm" disabled={busy} onClick={() => beginEdit(bot)}>编辑</Button>
                  <Button size="sm" disabled={busy} onClick={() => void remove(bot)}>删除</Button>
                </div>
              </div>
            )
          })}
        </div>
      )}


      <div style={{ ...styles.header, marginTop: 8 }}>
        <h3 style={styles.title}>企微身份绑定</h3>
        <input
          style={{ ...styles.input, maxWidth: 220 }}
          value={identityQuery}
          onChange={(event) => setIdentityQuery(event.target.value)}
          placeholder="搜索用户名 / 姓名 / 企微 userid"
        />
        <Button size="sm" disabled={identityLoading} onClick={() => void loadIdentity(identityQuery)}>搜索</Button>
      </div>
      <p style={styles.hint}>
        把企业微信通讯录 userid 绑定到万相账号后，机器人收到该用户的消息时会以该用户身份执行工具；
        未绑定的发送者会被拒绝，不会回落为机器人服务账号权限。一个用户只能绑定一个企微 userid。
      </p>

      {showPending && (
        <>
      <div style={{ ...styles.header, marginTop: 8 }}>
        <h3 style={styles.title}>待绑定发送者（内部诊断）</h3>
        <Button size="sm" disabled={pendingLoading} onClick={() => void loadPending()}>刷新</Button>
      </div>
      <p style={styles.hint}>
        用户在企微给机器人发消息后，连接器会在这里留下 senderId 和状态（最多 50 条，保留 7 天）。
        选择右侧账号即可把该 senderId 绑定到本人；列表只展示脱敏 ID，绑定时使用完整值。
      </p>
      {pendingHint !== null && <p style={styles.hint}>{pendingHint}</p>}
      {pendingNotice !== null && (
        <div style={{ ...styles.result, color: pendingNotice.tone === 'ok' ? '#3fa46a' : '#d0554d' }}>
          {pendingNotice.text}
        </div>
      )}
      {pendingLoading ? (
        <p style={styles.hint}>正在读取待绑定发送者…</p>
      ) : visiblePending.length === 0 ? (
        <p style={styles.hint}>暂无待绑定发送者。让用户在企微给机器人发一条消息后点「刷新」。</p>
      ) : (
        <div style={styles.list}>
          {visiblePending.map((item) => {
            const status = PENDING_STATUS_TEXT[item.status]
            const busy = pendingBusy === item.senderId
            const target = pendingTargets[item.senderId] ?? ''
            return (
              <div key={`${item.botId}:${item.senderId}`} data-im-pending={item.senderIdMasked} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{item.senderName ?? '未命名发送者'}</span>
                  <span style={{ color: status.color, fontSize: 12 }}>● {status.label}</span>
                  <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>{formatUpdatedAt(item.updatedAt)}</span>
                </div>
                <div style={styles.meta}>
                  <span style={styles.metaItem}><span style={styles.metaKey}>企微 userid</span><code>{item.senderIdMasked}</code></span>
                  <span style={styles.metaItem}><span style={styles.metaKey}>Bot</span><code>{item.remoteBotId ?? item.botId}</code></span>
                  <span style={styles.metaItem}><span style={styles.metaKey}>Session</span><code>{item.sessionId}</code></span>
                </div>
                {item.reason !== undefined && (
                  <div style={{ ...styles.result, opacity: 0.75 }}>
                    {item.reason}{item.message === undefined ? '' : ` · ${item.message}`}
                  </div>
                )}
                <div style={styles.actions}>
                  <select
                    style={{ ...styles.input, maxWidth: 260 }}
                    value={target}
                    disabled={busy}
                    onChange={(event) => setPendingTargets((current) => ({ ...current, [item.senderId]: event.target.value }))}
                  >
                    <option value="">选择要绑定的用户</option>
                    {identityUsers.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName || user.username}
                        {user.wecomUserId === null ? '' : `（已绑定 ${user.wecomUserId}）`}
                      </option>
                    ))}
                  </select>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || target === ''}
                    onClick={() => void bindSender(item)}
                  >
                    {busy ? '绑定中…' : '绑定到用户'}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
        </>
      )}

      {identityNotice !== null && (
        <div style={{ ...styles.result, color: identityNotice.tone === 'ok' ? '#3fa46a' : '#d0554d' }}>
          {identityNotice.text}
        </div>
      )}
      {identityLoading ? (
        <p style={styles.hint}>正在读取用户…</p>
      ) : (
        <div style={styles.list}>
          {identityUsers.map((user) => {
            const draft = identityDrafts[user.id] ?? ''
            const busy = identityBusy === user.id
            return (
              <div key={user.id} data-im-identity={user.id} style={styles.card}>
                <div style={styles.cardHead}>
                  <span style={styles.cardName}>{user.displayName || user.username}</span>
                  <code style={{ fontSize: 12, opacity: 0.7 }}>{user.username}</code>
                  {user.wecomUserId !== null
                    ? <span style={{ marginLeft: 'auto', fontSize: 12, color: '#3fa46a' }}>已绑定：<code>{user.wecomUserId}</code></span>
                    : <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.7 }}>未绑定</span>}
                </div>
                <div style={styles.actions}>
                  <input
                    style={{ ...styles.input, maxWidth: 260 }}
                    value={draft}
                    onChange={(event) => setIdentityDrafts((current) => ({ ...current, [user.id]: event.target.value }))}
                    placeholder={user.wecomUserId ?? '企微通讯录 userid'}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy || draft.trim() === ''}
                    onClick={() => {
                      const value = draft.trim()
                      if (value === '') return
                      setIdentityBusy(user.id)
                      void bindIdentityUser(user.id, value)
                        .then((updated) => {
                          setIdentityUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)))
                          setIdentityDrafts((current) => ({ ...current, [user.id]: '' }))
                          setIdentityNotice({ tone: 'ok', text: `已绑定 ${updated.username} → ${updated.wecomUserId ?? ''}` })
                        })
                        .catch((error: unknown) => setIdentityNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }))
                        .finally(() => setIdentityBusy(null))
                    }}
                  >
                    绑定
                  </Button>
                  {user.wecomUserId !== null && (
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setIdentityBusy(user.id)
                        void bindIdentityUser(user.id, null)
                          .then((updated) => {
                            setIdentityUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)))
                            setIdentityNotice({ tone: 'ok', text: `已解绑 ${updated.username}` })
                          })
                          .catch((error: unknown) => setIdentityNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) }))
                          .finally(() => setIdentityBusy(null))
                      }}
                    >
                      解绑
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      <ImBulkBindingSection onApplied={() => { void loadIdentity(identityQuery) }} />

      {editing !== null && (
        <div style={styles.form}>
          <label style={styles.field}>
            <span style={styles.label}>名称</span>
            <input
              style={styles.input}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              placeholder="例如：企业微信客服机器人"
            />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>平台</span>
            <select
              style={styles.input}
              value={draft.provider}
              disabled={editing !== 'new'}
              onChange={(event) => setDraft({ ...draft, provider: event.target.value as Draft['provider'] })}
            >
              <option value="WECOM">企业微信</option>
              <option value="DINGTALK">钉钉</option>
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>Bot ID{editing === 'new' ? '' : '（留空不改）'}</span>
            <input
              style={styles.input}
              value={draft.botId}
              onChange={(event) => setDraft({ ...draft, botId: event.target.value })}
              placeholder={editingBot === null ? '' : `当前 ${editingBot.botIdMasked}`}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>Secret{editing === 'new' ? '（可后补）' : '（留空不改）'}</span>
            <input
              style={styles.input}
              type="password"
              autoComplete="new-password"
              value={draft.secret}
              onChange={(event) => setDraft({ ...draft, secret: event.target.value })}
              placeholder={editingBot?.secretConfigured === true ? '已配置' : '未配置'}
            />
          </label>
          <label style={styles.field}>
            <span style={styles.label}>绑定工作区</span>
            <select
              style={styles.input}
              value={draft.workspaceId}
              onChange={(event) => setDraft({ ...draft, workspaceId: event.target.value })}
            >
              <option value="">不绑定</option>
              {options.workspaces.map((workspace) => (
                <option key={workspace.id} value={String(workspace.id)}>
                  #{workspace.id} {workspace.name}{workspace.imConnectorEnabled ? '（IM profile）' : ''}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.field}>
            <span style={styles.label}>服务账号</span>
            <select
              style={styles.input}
              value={draft.serviceAccountId}
              onChange={(event) => setDraft({ ...draft, serviceAccountId: event.target.value })}
            >
              <option value="">不指定</option>
              {options.serviceAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </select>
          </label>
          <div style={{ ...styles.field, justifyContent: 'flex-end' }}>
            <span style={styles.label}>启用</span>
            <Switch
              checked={draft.enabled}
              label="启用该机器人"
              onChange={(next) => setDraft({ ...draft, enabled: next })}
            />
          </div>
          <div style={{ ...styles.actions, gridColumn: '1 / -1' }}>
            <Button size="sm" variant="primary" disabled={saving} onClick={() => void submit()}>
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button size="sm" disabled={saving} onClick={() => { setEditing(null); setLoadError(null) }}>取消</Button>
          </div>
        </div>
      )}
    </div>
  )
}