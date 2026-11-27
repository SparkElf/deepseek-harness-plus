/**
 * The Task Center surface in the frame-wide overlay.
 *
 * The button is global because a task can arrive while the reader is in any
 * session. The panel only renders cards returned by the Host bridge; it never
 * talks to DataOps directly and never derives a second approval status.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import {
  Button,
  IconCloseOutlineRegular,
  Modal,
  SegmentedTabs,
  Tag,
  type SegmentedTab,
  type TagTone,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { colors } from './theme.ts'

export const inject = ['slots', 'locale', 'uiWorkspace', 'sessions', 'sidebarRight']

interface TaskItem {
  id: string
  sourceType: 'dataops_approval' | 'task_bus'
  title: string
  code?: string
  description?: string | null
  status: string
  statusLabel: string
  priority?: string | null
  tags?: string[]
  source: {
    type: string
    id?: string | null
    label?: string | null
    workflowCode?: string | null
    deepLink?: string | null
  }
  assignee?: { type: string; id: string } | null
  creator?: { type: string; id: string } | null
  actions?: string[]
  dueAt?: string | null
  updatedAt: string
  /** Connector that produced the row, when the Host carries it. */
  connectorId?: string
  /** Capability that produced the row, when the Host carries it. */
  capabilityId?: string
}

const ROUTE = '/dsh-task-bus/api'

const TASK_BUS_MODAL_CLASS = 'task-bus-center-modal'
const TASK_BUS_HISTORY_CLASS = 'task-bus-history-modal'
const TASK_BUS_STYLE_ID = 'task-bus-center-modal-style'
const TASK_BUS_MODAL_CSS = `
.${TASK_BUS_MODAL_CLASS} {
  width: min(960px, calc(100vw - 64px)) !important;
  height: min(760px, calc(100vh - 64px)) !important;
  gap: 0 !important;
  padding: 0 !important;
}
@media (max-width: 700px) {
  .${TASK_BUS_MODAL_CLASS} {
    width: calc(100vw - 24px) !important;
    height: calc(100vh - 24px) !important;
  }
}
.${TASK_BUS_HISTORY_CLASS} {
  width: min(960px, 92vw) !important;
  max-width: calc(100vw - 32px) !important;
  height: auto !important;
  max-height: min(780px, calc(100vh - 48px)) !important;
}
@media (max-width: 700px) {
  .${TASK_BUS_HISTORY_CLASS} {
    width: calc(100vw - 24px) !important;
    max-width: calc(100vw - 24px) !important;
    max-height: calc(100vh - 24px) !important;
  }
}
`

const HISTORY_NS = 'task-bus.history'
const HISTORY_COPY = {
  zh: {
    title: '消息记录',
    open: '消息记录',
    close: '关闭',
    searchPlaceholder: '搜索消息或发送人…',
    searchLabel: '搜索消息记录',
    clear: '清空搜索',
    initial: '输入关键词搜索消息或发送人',
    initialHint: '可按消息正文或发送人筛选，点结果跳到原消息。',
    loading: '正在加载消息记录…',
    error: '消息记录加载失败',
    empty: '暂无消息记录',
    noResults: '没有匹配的消息',
    jump: '跳到该消息',
    me: '我',
    assistant: '助手',
    dateLocale: 'zh-CN',
  },
  en: {
    title: 'Message history',
    open: 'Message history',
    close: 'Close',
    searchPlaceholder: 'Search messages or senders…',
    searchLabel: 'Search message history',
    clear: 'Clear search',
    initial: 'Search messages or senders to begin',
    initialHint: 'Filter by message text or sender, then click a result to jump to it.',
    loading: 'Loading message history…',
    error: 'Could not load message history',
    empty: 'No message history',
    noResults: 'No matching messages',
    jump: 'Jump to message',
    me: 'Me',
    assistant: 'Assistant',
    dateLocale: 'en-US',
  },
} as const

type HistoryCopyKey = keyof typeof HISTORY_COPY.zh
type HistoryTranslate = (key: HistoryCopyKey) => string

const buttonStyle: CSSProperties = {
  border: '1px solid ' + colors.line,
  background: colors.panel,
  color: colors.text,
  borderRadius: 8,
  padding: '7px 11px',
  fontSize: 12,
  cursor: 'pointer',
}

const statusTagTone = (status: string): TagTone => {
  if (status === 'completed') return 'success'
  if (status === 'cancelled') return 'neutral'
  if (status === 'blocked') return 'danger'
  if (status === 'pending_confirm' || status === 'returned' || status === 'pending_accept') return 'warning'
  return 'info'
}

const relativeTime = (value: string) => {
  const time = Date.parse(value)
  if (!Number.isFinite(time)) return ''
  const minutes = Math.max(0, Math.round((Date.now() - time) / 60_000))
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return String(minutes) + ' 分钟前'
  const hours = Math.round(minutes / 60)
  if (hours < 24) return String(hours) + ' 小时前'
  return String(Math.round(hours / 24)) + ' 天前'
}

const fetchJson = async <T,>(path: string, options: { signal?: AbortSignal } = {}): Promise<T> => {
  const attempt = async () => {
    const response = await fetch(ROUTE + path, { headers: { accept: 'application/json' }, signal: options.signal })
    // Read the body as text first: a 502 from the flow service may carry a JSON
    // error object, plain text, or an empty body, and `response.json()` turns the
    // last two into a parse error that hides the status from the caller.
    let text = ''
    let bodyFailure = false
    try { text = await response.text() } catch { bodyFailure = true }
    let payload: unknown = null
    if (text.trim() !== '') {
      try { payload = JSON.parse(text) as unknown } catch { payload = null }
    }
    return { response, status: response.status, payload, text, bodyFailure }
  }
  // One retry covers a connection reset that drops the response body: the host
  // proxy can lose the upstream 502 on the first connection while the next
  // request reads the very same error. An abort from the caller never retries.
  const request = async () => {
    try {
      const first = await attempt()
      if (!first.bodyFailure) return first
      await new Promise((resolve) => setTimeout(resolve, 250))
      return await attempt()
    } catch (cause) {
      if (options.signal?.aborted) throw cause
      await new Promise((resolve) => setTimeout(resolve, 250))
      return await attempt()
    }
  }
  let result = await request()
  // The managed session handshake runs in parallel with the panel mount; a 401
  // here is usually "the cookie is not set yet", not an authorization failure.
  if (result.status === 401) {
    await new Promise((resolve) => setTimeout(resolve, 900))
    result = await request()
  }
  if (!result.response.ok) {
    const serverMessage = result.payload !== null && typeof result.payload === 'object'
      ? (typeof (result.payload as { error?: unknown }).error === 'string' ? (result.payload as { error: string }).error
        : typeof (result.payload as { message?: unknown }).message === 'string' ? (result.payload as { message: string }).message
          : '')
      : ''
    // A server answer that carries readable text always wins over the status
    // fallback, so an explicit {"error":"…"} stays exactly as the server sent it.
    const message = serverMessage !== ''
      ? serverMessage
      : result.bodyFailure
        ? 'HTTP ' + result.status + '（响应体读取失败）'
        : result.text.trim() !== ''
          ? result.text.trim().slice(0, 200)
          : 'HTTP ' + result.status
    throw new Error(message)
  }
  if (result.bodyFailure) throw new Error('HTTP ' + result.status + '（响应体读取失败）')
  return result.payload as T
}


const approvalHref = (raw: string | null): string | null => {
  if (raw === null) return null
  try {
    const target = new URL(raw)
    const referrer = document.referrer ? new URL(document.referrer) : null
    if (referrer !== null && referrer.origin !== target.origin) {
      return referrer.origin + target.pathname + target.search + target.hash
    }
    return target.href
  } catch {
    return raw
  }
}

const TaskCard = ({
  task,
  busy,
  aiBusy,
  onTransition,
  onAiAccept,
  onOpen,
}: {
  task: TaskItem
  busy: boolean
  aiBusy: boolean
  onTransition: (task: TaskItem, action: string) => void
  onAiAccept: (task: TaskItem) => void
  onOpen: (task: TaskItem) => void
}) => {
  const isApproval = task.sourceType === 'dataops_approval'
  const deepLink = approvalHref(task.source.deepLink ?? null)
  return (
    <article
      style={{
        border: '1px solid ' + colors.line,
        borderRadius: 10,
        background: colors.panel,
        padding: '12px 13px',
        display: 'grid',
        gap: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 4 }}>
            <Tag tone={isApproval ? 'info' : 'neutral'}>
              {isApproval ? (task.source.label ?? 'DataOps 审批') : '任务总线'}
            </Tag>
            {task.tags?.map((tag) => (
              <Tag key={tag} tone="quiet">{tag}</Tag>
            ))}
          </div>
          <div style={{ fontSize: 13, fontWeight: 650, color: colors.text, lineHeight: 1.45 }}>
            {task.title}
          </div>
          {task.description ? (
            <div style={{ fontSize: 11, color: colors.muted, marginTop: 4, lineHeight: 1.5 }}>
              {task.description}
            </div>
          ) : null}
        </div>
        <span style={{ flex: 'none' }}><Tag tone={statusTagTone(task.status)}>{task.statusLabel}</Tag></span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10, color: colors.muted }}>
        <span>{isApproval ? '审批任务' : '任务'}</span>
        {task.assignee?.id ? <span>受理人：{task.assignee.id}</span> : null}
        <span style={{ marginLeft: 'auto' }}>{relativeTime(task.updatedAt)}</span>
      </div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {isApproval && deepLink ? (
          <Button size="sm" variant="primary" onClick={() => window.open(deepLink, '_blank', 'noopener,noreferrer')}>
            办理
          </Button>
        ) : null}
        {task.status !== 'completed' && task.status !== 'cancelled' ? (
          <Button size="sm" variant="outline" disabled={aiBusy || busy} onClick={() => onAiAccept(task)}>
            {aiBusy ? '受理中…' : 'AI受理'}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={() => onOpen(task)}>详情</Button>
        {!isApproval && task.status === 'pending_accept' ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onTransition(task, 'accept')}>受理</Button>
        ) : null}
        {!isApproval && task.status === 'in_progress' ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => onTransition(task, 'submit')}>提交确认</Button>
        ) : null}
        {!isApproval && task.status === 'pending_confirm' ? (
          <Button size="sm" variant="primary" disabled={busy} onClick={() => onTransition(task, 'complete')}>完成</Button>
        ) : null}
        {!isApproval && task.status !== 'completed' && task.status !== 'cancelled' ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onTransition(task, 'cancel')}>取消</Button>
        ) : null}
      </div>
    </article>
  )
}


interface TaskAttachmentRecord {
  id: string
  originalName: string
  contentType: string
  sizeBytes: number
  kind: string
}

interface FormFieldData {
  key: string
  label: string
  value: unknown
  type?: 'multiline' | 'resources'
  span?: 1 | 2
}

interface FormSectionData {
  title: string
  fields: FormFieldData[]
}

interface TaskDetailPayload {
  id?: number | string
  payload?: {
    form?: Record<string, unknown>
    selectedItems?: Array<Record<string, unknown>>
    resourceAccessRequest?: {
      form?: Record<string, unknown>
      selectedItems?: Array<Record<string, unknown>>
    }
  }
  form?: { sections?: FormSectionData[] }
  attachments?: TaskAttachmentRecord[]
}

const FORM_LABELS: Record<string, string> = {
  applicationMode: '申请方式',
  requestKind: '申请类型',
  requestedPermissions: '申请权限',
  requesterDepartment: '申请人部门',
  requesterPhone: '申请人电话',
  validFrom: '授权开始时间',
  expiresAt: '授权结束时间',
  selectionSummary: '资源摘要',
  code: '应用编码',
  name: '应用名称',
  reason: '申请理由',
  description: '应用说明',
  departmentName: '归属部门',
  departmentCode: '归属部门编码',
  ownerName: '归属负责人',
  ownerPhone: '归属负责人电话',
  constructionUnit: '建设单位',
  constructionOwner: '建设单位负责人',
  constructionOwnerPhone: '建设单位负责人电话',
  operationsUnit: '运维单位',
  operationsOwner: '运维单位负责人',
  operationsOwnerPhone: '运维单位负责人电话',
  requestTime: '申请时间',
  resourceName: '资源名称',
  resourceType: '资源类型',
  accessType: '访问方式',
  accessScope: '访问范围',
  applicationName: '所属应用',
  applicationCode: '应用编码',
  environment: '环境',
  accountCount: '账号数量',
}

const SKIP_FORM_KEYS = new Set([
  'ownerUserId',
  'requesterUserId',
  'requesterDept',
  'existingApplicationId',
  'applicationId',
  'taskType',
])

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes < 0) return ''
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

const humanizeField = (key: string) => key
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/[_-]+/g, ' ')
  .trim()

const formatFormValue = (key: string, value: unknown): string => {
  if (key === 'applicationMode') {
    if (value === 'EXISTING') return '使用已有应用'
    if (value === 'NEW') return '新建应用'
  }
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => String(item)).join('、')
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.name === 'string') return record.name
    return JSON.stringify(value)
  }
  return String(value)
}

const toFormField = (key: string, value: unknown): FormFieldData => ({
  key,
  label: FORM_LABELS[key] ?? humanizeField(key),
  value,
  ...(key === 'reason' || key === 'description' || key === 'accessScope'
    ? { type: 'multiline' as const, span: 2 as const }
    : {}),
})

const formFields = (form: Record<string, unknown> | undefined): FormFieldData[] => (
  form === undefined
    ? []
    : Object.entries(form)
      .filter(([key, value]) => !SKIP_FORM_KEYS.has(key) && value !== null && value !== undefined && value !== '')
      .map(([key, value]) => toFormField(key, value))
)

const approvalFormSections = (detail: TaskDetailPayload | null): FormSectionData[] => {
  if (detail === null) return []
  const sections: FormSectionData[] = []
  const applicationFields = formFields(detail.payload?.form)
  if (applicationFields.length > 0) sections.push({ title: '申请信息', fields: applicationFields })
  const resourceFields = formFields(detail.payload?.resourceAccessRequest?.form)
  if (resourceFields.length > 0) sections.push({ title: '资源申请', fields: resourceFields })
  const resources = [
    ...(detail.payload?.selectedItems ?? []),
    ...(detail.payload?.resourceAccessRequest?.selectedItems ?? []),
  ]
  if (resources.length > 0) {
    sections.push({
      title: '申请资源',
      fields: [{ key: 'resources', label: '资源', value: resources, type: 'resources', span: 2 }],
    })
  }
  return sections
}

const ResourceValue = ({ items }: { items: Array<Record<string, unknown>> }) => (
  <div style={{ display: 'grid', gap: 5 }}>
    {items.map((item, index) => {
      const label = typeof item.title === 'string' ? item.title : typeof item.name === 'string' ? item.name : `资源 ${index + 1}`
      const detail = [item.scope, item.urn, item.id].filter((value) => typeof value === 'string' || typeof value === 'number').join(' · ')
      return (
        <div key={String(item.urn ?? item.id ?? index)} style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 12, color: colors.text }}>{label}</span>
          {detail ? <span style={{ fontSize: 10, color: colors.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{detail}</span> : null}
        </div>
      )
    })}
  </div>
)

const FormDescriptions = ({ sections }: { sections: FormSectionData[] }) => {
  if (sections.length === 0) return null
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {sections.map((section, sectionIndex) => (
        <section key={section.title + sectionIndex} style={{ border: '1px solid ' + colors.line, borderRadius: 10, background: colors.panel, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: colors.text, marginBottom: 9 }}>{section.title}</div>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '9px 24px' }}>
            {section.fields.map((field) => (
              <div
                key={field.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '94px minmax(0, 1fr)',
                  alignItems: 'start',
                  gap: 8,
                  minWidth: 0,
                  gridColumn: field.span === 2 ? '1 / -1' : undefined,
                }}
              >
                <dt style={{ fontSize: 10, lineHeight: 1.6, color: colors.muted }}>{field.label}</dt>
                <dd style={{ margin: 0, fontSize: 12, lineHeight: 1.6, color: colors.text, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {field.type === 'resources' && Array.isArray(field.value)
                    ? <ResourceValue items={field.value as Array<Record<string, unknown>>} />
                    : field.value === null || field.value === undefined || field.value === ''
                      ? '—'
                      : formatFormValue(field.key, field.value)}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  )
}

/** Detail requests fail after this long instead of leaving the panel waiting forever. */
const DETAIL_TIMEOUT_MS = 15_000
/** Show a secondary hint once the flow service is slow, so the panel never looks frozen. */
const DETAIL_SLOW_HINT_MS = 5_000

/** Turn a detail failure into the message the panel shows; the server text stays verbatim. */
const describeDetailFailure = (cause: unknown, timedOut: boolean): string => {
  if (timedOut) return '请求超时（15 秒无响应），流程服务可能暂时不可用，请重试。'
  const raw = cause instanceof Error ? cause.message : String(cause)
  if (/^(fetch failed|Failed to fetch|NetworkError|Load failed)/iu.test(raw)) {
    return '无法连接服务（网络错误），请检查网络或稍后重试。'
  }
  return raw
}

const TaskDetail = ({ task, onBack }: { task: TaskItem; onBack: () => void }) => {
  const isApproval = task.sourceType === 'dataops_approval'
  const [detail, setDetail] = useState<TaskDetailPayload | null>(null)
  const [detailLoading, setDetailLoading] = useState(true)
  const [detailError, setDetailError] = useState<string | null>(null)
  const [detailSlow, setDetailSlow] = useState(false)
  const [detailAttempt, setDetailAttempt] = useState(0)

  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    let timedOut = false
    const timeout = window.setTimeout(() => { timedOut = true; controller.abort() }, DETAIL_TIMEOUT_MS)
    const slowHint = window.setTimeout(() => { if (alive) setDetailSlow(true) }, DETAIL_SLOW_HINT_MS)
    setDetail(null)
    setDetailLoading(true)
    setDetailError(null)
    setDetailSlow(false)
    void fetchJson<{ detail?: TaskDetailPayload }>('/items/' + encodeURIComponent(task.id), { signal: controller.signal })
      .then((payload) => { if (alive) setDetail(payload.detail ?? null) })
      .catch((cause) => { if (alive) setDetailError(describeDetailFailure(cause, timedOut)) })
      .finally(() => {
        window.clearTimeout(timeout)
        window.clearTimeout(slowHint)
        if (alive) {
          setDetailLoading(false)
          setDetailSlow(false)
        }
      })
    return () => {
      alive = false
      controller.abort()
      window.clearTimeout(timeout)
      window.clearTimeout(slowHint)
    }
  }, [task.id, detailAttempt])

  const sections = isApproval ? approvalFormSections(detail) : detail?.form?.sections ?? []
  const attachments = detail?.attachments ?? []
  const approvalTaskId = isApproval && typeof detail?.id === 'number' ? detail.id : null
  const attachmentHref = (attachment: TaskAttachmentRecord) => approvalTaskId === null
    ? null
    : ROUTE + '/attachment?taskId=' + encodeURIComponent(String(approvalTaskId))
      + '&attachmentId=' + encodeURIComponent(attachment.id)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1, minHeight: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: colors.text, lineHeight: 1.45 }}>{task.title}</div>
          <div style={{ marginTop: 3, fontSize: 10, color: colors.muted }}>
            {task.source.label ?? (isApproval ? 'DataOps 审批' : '任务总线')} · {relativeTime(task.updatedAt)}
          </div>
        </div>
        <Tag tone={statusTagTone(task.status)}>{task.statusLabel}</Tag>
      </div>

      {detailLoading ? (
        <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12, display: 'grid', gap: 4 }}>
          <span>正在加载表单…</span>
          {detailSlow ? <span style={{ fontSize: 10 }}>流程服务响应较慢，正在继续等待…</span> : null}
        </div>
      ) : null}
      {detailError ? (
        <div role="alert" style={{ padding: '8px 10px', borderRadius: 8, background: '#fef2f2', color: colors.danger, fontSize: 11, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 1, minWidth: 0, lineHeight: 1.6 }}>{detailError}</span>
          <Button size="sm" variant="outline" onClick={() => setDetailAttempt((value) => value + 1)}>重试</Button>
        </div>
      ) : null}
      {!detailLoading && detailError === null && sections.length > 0 ? <FormDescriptions sections={sections} /> : null}
      {!detailLoading && detailError === null && sections.length === 0 && !isApproval && task.description ? (
        <div style={{ border: '1px solid ' + colors.line, borderRadius: 10, background: colors.panel, padding: 14, fontSize: 12, lineHeight: 1.6, color: colors.text, whiteSpace: 'pre-wrap' }}>{task.description}</div>
      ) : null}
      {!detailLoading && detailError === null && sections.length === 0 && (isApproval || !task.description) ? (
        <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无表单信息</div>
      ) : null}

      {isApproval || attachments.length > 0 ? (
        <section style={{ border: '1px solid ' + colors.line, borderRadius: 10, background: colors.panel, padding: 14 }}>
          <div style={{ fontSize: 12, fontWeight: 650, color: colors.text, marginBottom: 8 }}>附件</div>
          {attachments.length === 0 ? <div style={{ fontSize: 11, color: colors.muted }}>暂无附件</div> : (
            <div style={{ display: 'grid', gap: 6 }}>
              {attachments.map((attachment) => {
                const href = attachmentHref(attachment)
                return (
                  <div key={attachment.id} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: colors.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{attachment.originalName}</span>
                    <span style={{ flex: 'none', fontSize: 10, color: colors.muted }}>{formatBytes(attachment.sizeBytes)}</span>
                    {href !== null ? <Button size="sm" variant="ghost" onClick={() => window.open(href, '_blank', 'noopener,noreferrer')}>下载</Button> : null}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap', marginTop: 'auto', paddingTop: 2 }}>
        <Button size="sm" variant="ghost" onClick={onBack}>← 返回列表</Button>
        {isApproval && task.source.deepLink ? (
          <Button size="sm" variant="outline" onClick={() => window.open(approvalHref(task.source.deepLink ?? null) ?? '#', '_blank', 'noopener,noreferrer')}>
            打开 DataOps 审批详情
          </Button>
        ) : null}
      </div>
    </div>
  )
}

type TaskTab = 'all' | 'mine' | 'personal' | 'group' | 'notifications'

/** One KB task record, as the knowledge-base plugin persists it. */
interface KbTaskRecord {
  id: string
  fileName: string
  kind: 'upload' | 'extract'
  stage: 'uploading' | 'uploaded' | 'extracting' | 'done' | 'failed'
  progress?: number
  startedAt: number
  finishedAt?: number
  error?: string
}

const KB_TASK_QUEUE_KEY = 'dataops-kb-task-queue-v1'
const KB_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000
const KB_TASK_MAX = 200
const KB_STAGE_LABEL: Record<KbTaskRecord['stage'], string> = {
  uploading: '上传中',
  uploaded: '上传完成',
  extracting: '提取中',
  done: '提取完成',
  failed: '失败',
}

/** Read the KB task queue from the shared localStorage key. */
function readKbTasks(now: number = Date.now()): KbTaskRecord[] {
  try {
    const raw = window.localStorage.getItem(KB_TASK_QUEUE_KEY)
    if (raw === null || raw === '') return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const records: KbTaskRecord[] = []
    for (const entry of parsed) {
      if (entry === null || typeof entry !== 'object') continue
      const row = entry as Record<string, unknown>
      if (typeof row.id !== 'string' || row.id === '') continue
      if (typeof row.fileName !== 'string' || row.fileName === '') continue
      if (row.kind !== 'upload' && row.kind !== 'extract') continue
      if (typeof row.stage !== 'string' || !(row.stage in KB_STAGE_LABEL)) continue
      if (typeof row.startedAt !== 'number' || !Number.isFinite(row.startedAt)) continue
      if (now - row.startedAt > KB_TASK_TTL_MS) continue
      records.push({
        id: row.id,
        fileName: row.fileName,
        kind: row.kind,
        stage: row.stage as KbTaskRecord['stage'],
        ...(typeof row.progress === 'number' && Number.isFinite(row.progress) ? { progress: row.progress } : {}),
        startedAt: row.startedAt,
        ...(typeof row.finishedAt === 'number' && Number.isFinite(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
        ...(typeof row.error === 'string' && row.error !== '' ? { error: row.error } : {}),
      })
    }
    return records.sort((a, b) => b.startedAt - a.startedAt).slice(0, KB_TASK_MAX)
  } catch {
    return []
  }
}

/** One plaza record as the skill-center integration serves it. */
interface SkillPlazaRow {
  name: string
  reviewStatus?: 'pending' | 'approved' | 'rejected'
}

/**
 * Pending skill-review count for the task center.
 *
 * The skill-center package computes its `reviewCounts` in the browser from the list +
 * plaza records; there is no server-side unread/pending endpoint. We read the same two
 * sources here: the plaza rows carry `reviewStatus`, the list rows carry the model flag
 * that stands in for "disabled". A row missing `reviewStatus` counts as pending, which
 * matches `reviewStatusOf` in the package.
 */
async function readSkillPlazaRows(): Promise<string[]> {
  try {
    const [listResponse, plazaResponse] = await Promise.all([
      fetch('api/dsh-skill-center/list', { cache: 'no-store' }),
      fetch('integrations/dataops/skill-plaza?mine=1', { cache: 'no-store' }),
    ])
    // Only an explicit `modelInvocable: false` marks a skill as disabled. A plaza row
    // that has no local list entry is still pending review and must be listed.
    const disabled = new Set<string>()
    if (listResponse.ok) {
      const body = await listResponse.json() as { groups?: Array<{ skills?: Array<{ name?: unknown; modelInvocable?: unknown }> }> }
      for (const group of body.groups ?? []) {
        for (const skill of group.skills ?? []) {
          if (typeof skill.name === 'string' && skill.modelInvocable === false) disabled.add(skill.name)
        }
      }
    }
    if (!plazaResponse.ok) return []
    const plaza = await plazaResponse.json() as { skills?: Array<Record<string, unknown>> }
    const names: string[] = []
    for (const row of plaza.skills ?? []) {
      if (typeof row.name !== 'string' || row.name === '') continue
      if (row.reviewStatus === 'approved') continue
      if (disabled.has(row.name)) continue
      names.push(row.name)
    }
    return names
  } catch {
    return []
  }
}

/** One review inbox row as the DataOps integration serves it. */
interface ReviewInboxItem {
  id: string
  type: string
  title: string
  body?: string
  createdAt: string
  read: boolean
}

/**
 * The same review inbox the plaza bell used to show, now rendered inside the task center's
 * notification tab so every notification lives in one list.
 */
async function readReviewInbox(): Promise<ReviewInboxItem[]> {
  try {
    const response = await fetch('integrations/dataops/review-notifications', { cache: 'no-store' })
    if (!response.ok) return []
    const body = await response.json() as { items?: Array<Record<string, unknown>> }
    const rows: ReviewInboxItem[] = []
    for (const raw of body.items ?? []) {
      if (typeof raw.id !== 'string' || typeof raw.title !== 'string') continue
      rows.push({
        id: raw.id,
        type: typeof raw.type === 'string' ? raw.type : 'info',
        title: raw.title,
        ...(typeof raw.body === 'string' && raw.body !== '' ? { body: raw.body } : {}),
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
        read: raw.read === true,
      })
    }
    return rows.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, 20)
  } catch {
    return []
  }
}

/** One notification card shared by every source in the notification tab. */
function NotificationCard({ title, body, time, unread, onClick }: {
  title: string
  body?: string
  time?: string
  unread?: boolean
  onClick?: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%', padding: '10px 12px',
        border: '1px solid ' + colors.line, borderRadius: 8, background: colors.panelAlt,
        color: colors.text, fontSize: 12, textAlign: 'left',
        cursor: onClick === undefined ? 'default' : 'pointer',
      }}
    >
      <span style={{
        flex: '0 0 auto', width: 6, height: 6, marginTop: 6, borderRadius: 99,
        background: unread === true ? colors.accent : 'transparent',
      }} />
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{title}</span>
        {body === undefined ? null : <span style={{ display: 'block', marginTop: 2, fontSize: 11, color: colors.muted }}>{body}</span>}
      </span>
      {time === undefined ? null : <span style={{ fontSize: 10, color: colors.muted, whiteSpace: 'nowrap' }}>{time}</span>}
    </button>
  )
}

/** How many rows one notification group shows before it pages. */
const NOTIFICATION_PAGE_SIZE = 10
/** Names the reader hid from the review group; clearing is recoverable, so it outlives a reload. */
const HIDDEN_SKILLS_KEY = 'dataops-task-bus-hidden-skills-v1'
/** Ids the reader cleared from the audit group, so a reload does not bring them back. */
const CLEARED_NOTIFICATIONS_KEY = 'dataops-task-bus-cleared-notifications-v1'

/** Read a string set the browser persisted; an unreadable value is an empty set. */
function readStoredSet(key: string): ReadonlySet<string> {
  try {
    const raw = window.localStorage.getItem(key)
    if (raw === null || raw === '') return new Set()
    const parsed: unknown = JSON.parse(raw)
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Persist one string set; storage failures leave the in-memory set authoritative. */
function writeStoredSet(key: string, values: Iterable<string>): void {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values]))
  } catch {
    /* private mode */
  }
}

/** Slice one page out of a list and report the page count a pager needs. */
function pageOf<T>(items: readonly T[], page: number): { rows: readonly T[]; pages: number; page: number } {
  const pages = Math.max(1, Math.ceil(items.length / NOTIFICATION_PAGE_SIZE))
  const current = Math.min(Math.max(0, page), pages - 1)
  return { rows: items.slice(current * NOTIFICATION_PAGE_SIZE, (current + 1) * NOTIFICATION_PAGE_SIZE), pages, page: current }
}

/** `上一页 / 第 x/y 页 / 下一页`, hidden while a group fits on one page. */
function NotificationPager({ page, pages, onChange }: {
  page: number
  pages: number
  onChange: (page: number) => void
}) {
  if (pages <= 1) return null
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
      <Button size="sm" variant="ghost" disabled={page <= 0} onClick={() => onChange(page - 1)}>上一页</Button>
      <span style={{ fontSize: 12, color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>第 {page + 1}/{pages} 页</span>
      <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>下一页</Button>
    </div>
  )
}

/** The header every group shares: title, total, current page, and its own clear action. */
function NotificationGroupHeader({ title, total, pages, page, clearLabel, onClear, restore, testId }: {
  title: string
  total: number
  pages: number
  page: number
  clearLabel?: string
  onClear?: () => void
  restore?: { label: string; onClick: () => void }
  testId?: string
}) {
  return (
    <div data-testid={testId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{title}</span>
        {total > 0 ? (
          <span style={{ fontSize: 12, color: '#8ea6c6', fontVariantNumeric: 'tabular-nums' }}>
            {total} 条{pages > 1 ? ` · 第 ${page + 1}/${pages} 页` : ''}
          </span>
        ) : null}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {restore === undefined ? null : (
          <Button size="sm" variant="ghost" onClick={restore.onClick}>{restore.label}</Button>
        )}
        {clearLabel === undefined || onClear === undefined ? null : (
          <Button size="sm" variant="ghost" data-testid={testId === undefined ? undefined : testId + '-clear'} disabled={total === 0} onClick={onClear}>{clearLabel}</Button>
        )}
      </div>
    </div>
  )
}

/** The "notifications" tab: every source rendered as the same notification card, paged per source. */
function KbNotificationPanel({ tasks, skillRows, reviewItems, onOpenSkill, onClear }: {
  tasks: readonly KbTaskRecord[]
  skillRows: readonly string[]
  reviewItems: readonly ReviewInboxItem[]
  onOpenSkill: () => void
  onClear: () => void
}) {
  const [auditPage, setAuditPage] = useState(0)
  const [skillPage, setSkillPage] = useState(0)
  const [kbPage, setKbPage] = useState(0)
  const [hiddenSkills, setHiddenSkills] = useState<ReadonlySet<string>>(() => readStoredSet(HIDDEN_SKILLS_KEY))
  const [clearedIds, setClearedIds] = useState<ReadonlySet<string>>(() => readStoredSet(CLEARED_NOTIFICATIONS_KEY))

  const audits = reviewItems.filter(item => !clearedIds.has(item.id))
  const skills = skillRows.filter(name => !hiddenSkills.has(name))
  const audit = pageOf(audits, auditPage)
  const skill = pageOf(skills, skillPage)
  const kb = pageOf(tasks, kbPage)

  const done = tasks.filter(task => task.stage === 'done' || task.stage === 'uploaded').length
  const timeOf = (value: string): string => {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  /** Mark every audit row read on the host, then keep them out of the list so clearing is visible. */
  const clearAudits = (): void => {
    const ids = new Set(clearedIds)
    for (const item of reviewItems) ids.add(item.id)
    setClearedIds(ids)
    writeStoredSet(CLEARED_NOTIFICATIONS_KEY, ids)
    // The host route accepts the read action on the collection path and forwards it to
    // `/api/ai/review-notifications/read`; the `/read` suffix is not a browser-reachable route.
    void fetch('integrations/dataops/review-notifications', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ all: true }),
    }).catch(() => { /* the local clear stands even when the host call fails */ })
  }

  /** Hide the pending skills; the header keeps a 恢复 entry so nothing is lost. */
  const clearSkills = (): void => {
    const names = new Set(hiddenSkills)
    for (const name of skillRows) names.add(name)
    setHiddenSkills(names)
    writeStoredSet(HIDDEN_SKILLS_KEY, names)
  }

  const restoreSkills = (): void => {
    setHiddenSkills(new Set())
    writeStoredSet(HIDDEN_SKILLS_KEY, [])
    setSkillPage(0)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <NotificationGroupHeader
          title="审核通知"
          testId="notify-audit"
          total={audits.length}
          pages={audit.pages}
          page={audit.page}
          clearLabel="清空"
          onClear={clearAudits}
        />
        {audits.length === 0 ? (
          <div style={{ padding: 14, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无审核通知</div>
        ) : audit.rows.map(item => (
          <NotificationCard
            key={item.id}
            title={item.title}
            body={item.body}
            time={timeOf(item.createdAt)}
            unread={!item.read}
            onClick={onOpenSkill}
          />
        ))}
        <NotificationPager page={audit.page} pages={audit.pages} onChange={setAuditPage} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <NotificationGroupHeader
          title="技能广场待审核"
          testId="notify-skills"
          total={skills.length}
          pages={skill.pages}
          page={skill.page}
          clearLabel="清空"
          onClear={clearSkills}
          {...hiddenSkills.size > 0 ? { restore: { label: `恢复隐藏的 ${hiddenSkills.size} 条`, onClick: restoreSkills } } : {}}
        />
        {skills.length === 0 ? (
          <div style={{ padding: 14, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无待审核技能</div>
        ) : skill.rows.map(name => (
          <NotificationCard
            key={name}
            title={'技能「' + name + '」等待审核'}
            body="提交到技能广场，等待管理员审核"
            unread
            onClick={onOpenSkill}
          />
        ))}
        <NotificationPager page={skill.page} pages={skill.pages} onChange={setSkillPage} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <NotificationGroupHeader
          title="知识库任务"
          testId="notify-kb"
          total={tasks.length}
          pages={kb.pages}
          page={kb.page}
          clearLabel="清空记录"
          onClear={onClear}
        />
        {tasks.length > 0 ? (
          <div style={{ fontSize: 12, color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>已完成 {done}/{tasks.length}</div>
        ) : null}
        {tasks.length === 0 ? (
          <div style={{ padding: 14, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无提取任务</div>
        ) : kb.rows.map(task => {
          const percent = Math.max(0, Math.min(100, Math.round(task.progress ?? (task.stage === 'done' ? 100 : task.stage === 'uploaded' ? 100 : 0))))
          const tone = task.stage === 'failed' ? colors.danger
            : task.stage === 'done' || task.stage === 'uploaded' ? colors.success : colors.accent
          return (
            <div key={task.id} style={{ padding: '10px 12px', border: '1px solid ' + colors.line, borderRadius: 8, background: colors.panelAlt }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12, fontWeight: 600, color: colors.text }}>{task.fileName}</span>
                <span style={{ fontSize: 10, color: colors.muted }}>{new Date(task.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
                <span style={{ fontSize: 10, color: tone, whiteSpace: 'nowrap' }}>{KB_STAGE_LABEL[task.stage]}</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={{ flex: 1, height: 6, borderRadius: 999, background: 'rgba(255,255,255,.08)', overflow: 'hidden' }}>
                  <div style={{ width: String(percent) + '%', height: '100%', borderRadius: 999, background: tone, transition: 'width 120ms ease' }} />
                </div>
                <span style={{ minWidth: 34, textAlign: 'right', fontSize: 11, color: colors.muted, fontVariantNumeric: 'tabular-nums' }}>{String(percent) + '%'}</span>
              </div>
              {task.error !== undefined ? <div style={{ fontSize: 11, color: colors.danger }}>{task.error}</div> : null}
            </div>
          )
        })}
        <NotificationPager page={kb.page} pages={kb.pages} onChange={setKbPage} />
      </div>
    </div>
  )
}

const TaskCenterButton = ({ openSession }: {
  openSession: (sessionId: string) => void
}) => {
  const [open, setOpen] = useState(false)
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<TaskTab>('all')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [aiBusyId, setAiBusyId] = useState<string | null>(null)
  const [selected, setSelected] = useState<TaskItem | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null)
  const [pendingCount, setPendingCount] = useState(0)
  const [kbTasks, setKbTasks] = useState<KbTaskRecord[]>(() => readKbTasks())
  const [skillRows, setSkillRows] = useState<string[]>([])
  const [reviewInbox, setReviewInbox] = useState<ReviewInboxItem[]>([])

  useEffect(() => {
    if (document.getElementById(TASK_BUS_STYLE_ID) !== null) return
    const style = document.createElement('style')
    style.id = TASK_BUS_STYLE_ID
    style.textContent = TASK_BUS_MODAL_CSS
    document.head.append(style)
    return () => { style.remove() }
  }, [])

  useEffect(() => {
    const update = () => {
      const collapsed = document.querySelector('[data-sidebar-collapsed="true"]') !== null
      if (collapsed) {
        setAnchor((current) => (current === null ? current : null))
        return
      }
      const buttons = Array.from(document.querySelectorAll('button'))
      const toggle = buttons.find((button) => /收起侧边栏|Collapse sidebar/i.test((button.getAttribute('aria-label') ?? '').trim()))
      if (!toggle) {
        setAnchor((current) => (current === null ? current : null))
        return
      }
      const label = (toggle.getAttribute('aria-label') ?? '').trim()
      if (/展开侧边栏|Expand sidebar/i.test(label)) {
        setAnchor((current) => (current === null ? current : null))
        return
      }
      const rect = toggle.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) return
      const next = { left: Math.max(8, rect.left - 36), top: rect.top + (rect.height - 28) / 2 }
      setAnchor((current) => (
        current !== null && Math.abs(current.left - next.left) < 0.5 && Math.abs(current.top - next.top) < 0.5
          ? current
          : next
      ))
    }
    update()
    const timer = window.setInterval(update, 400)
    window.addEventListener('resize', update)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('resize', update)
    }
  }, [])

  const load = async (silent = false) => {
    if (!silent) setLoading(true)
    setError(null)
    try {
      const overview = await fetchJson<{ items: TaskItem[] }>('/overview')
      setTasks([...overview.items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void load()
    const timer = window.setInterval(() => { void load(true) }, 60_000)
    return () => { window.clearInterval(timer) }
  }, [open])

  useEffect(() => {
    let alive = true
    const refresh = async () => {
      try {
        const result = await fetchJson<{ count?: number }>('/count')
        if (alive) setPendingCount(Math.max(0, Math.trunc(Number(result.count) || 0)))
      } catch {
        // The panel's overview error is the visible connection state; the badge keeps its last value.
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 300_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    let alive = true
    const sync = (): void => { if (alive) setKbTasks(readKbTasks()) }
    const timer = window.setInterval(sync, 1000)
    const onStorage = (event: StorageEvent): void => { if (event.key === KB_TASK_QUEUE_KEY) sync() }
    window.addEventListener('storage', onStorage)
    return () => {
      alive = false
      window.clearInterval(timer)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const sync = (): void => {
      void readSkillPlazaRows().then((rows) => { if (alive) setSkillRows(rows) })
      void readReviewInbox().then((items) => { if (alive) setReviewInbox(items) })
    }
    sync()
    const timer = window.setInterval(sync, 60_000)
    return () => { alive = false; window.clearInterval(timer) }
  }, [])

  /**
   * Jump to the Skill Center page.
   *
   * TODO(mention-provider wave): the sidebar menu has no stable data id; this finds the
   * button by its visible label. Replace with a route/command once the base exposes one.
   */
  const openSkillCenter = (): void => {
    setOpen(false)
    window.setTimeout(() => {
      const button = [...document.querySelectorAll('button')].find((candidate) => {
        const label = (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim()
        return /Skill Center|技能中心/i.test(label)
      })
      button?.click()
    }, 80)
  }

  const clearKbTasks = (): void => {
    try { window.localStorage.removeItem(KB_TASK_QUEUE_KEY) } catch { /* private mode */ }
    setKbTasks([])
  }

  const filtered = useMemo(() => {
    if (tab === 'group') return tasks.filter((task) => task.sourceType === 'task_bus' && task.source.type.includes('group'))
    if (tab === 'mine') return tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled')
    if (tab === 'personal') return tasks.filter((task) => task.sourceType === 'task_bus' && !task.source.type.includes('group'))
    return tasks
  }, [tasks, tab])

  const actionable = tasks.filter((task) => task.status !== 'completed' && task.status !== 'cancelled').length
  const kbPending = kbTasks.filter(task => task.stage === 'uploading' || task.stage === 'extracting').length
  const tabItems: [SegmentedTab<TaskTab>, ...SegmentedTab<TaskTab>[]] = [
    { value: 'all', id: 'task-bus-tab-all', panelId: 'task-bus-panel-all', label: <span>全部 <span style={{ opacity: 0.55 }}>{tasks.length}</span></span> },
    { value: 'mine', id: 'task-bus-tab-mine', panelId: 'task-bus-panel-mine', label: <span>待我处理 <span style={{ opacity: 0.55 }}>{actionable}</span></span> },
    { value: 'personal', id: 'task-bus-tab-personal', panelId: 'task-bus-panel-personal', label: <span>个人 <span style={{ opacity: 0.55 }}>{tasks.filter((task) => task.sourceType === 'task_bus' && !task.source.type.includes('group')).length}</span></span> },
    { value: 'group', id: 'task-bus-tab-group', panelId: 'task-bus-panel-group', label: <span>群聊 <span style={{ opacity: 0.55 }}>{tasks.filter((task) => task.sourceType === 'task_bus' && task.source.type.includes('group')).length}</span></span> },
    { value: 'notifications', id: 'task-bus-tab-notifications', panelId: 'task-bus-panel-notifications', label: <span>通知 <span style={{ opacity: 0.55 }}>{kbPending}</span></span> },
  ]

  const transition = async (task: TaskItem, action: string) => {
    setBusyId(task.id)
    setError(null)
    try {
      await fetch(ROUTE + '/generic/' + encodeURIComponent(task.id.slice(5)) + '/transition', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      }).then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { error?: string } | null
          throw new Error(payload?.error ?? '任务操作失败')
        }
      })
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusyId(null)
    }
  }

  const aiAccept = async (task: TaskItem) => {
    setAiBusyId(task.id)
    setError(null)
    try {
      const response = await fetch(ROUTE + '/ai-accept', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: task.id }),
      })
      const payload = await response.json() as { sessionId?: string; error?: string }
      if (!response.ok || typeof payload.sessionId !== 'string') {
        throw new Error(payload.error ?? 'AI 受理会话创建失败')
      }
      openSession(payload.sessionId)
      setOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAiBusyId(null)
    }
  }

  return (
    <>
      {anchor !== null ? (
        <button
          type="button"
          aria-label="任务中心"
          title="任务中心"
          onClick={() => setOpen((value) => !value)}
          style={{
            position: 'fixed',
            left: anchor.left,
            top: anchor.top,
            zIndex: 45,
            width: 28,
            height: 28,
            padding: 0,
            border: 'none',
            borderRadius: 8,
            background: 'transparent',
            color: actionable > 0 ? colors.accent : colors.muted,
            cursor: 'pointer',
            pointerEvents: 'auto',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {pendingCount + kbPending + skillRows.length + reviewInbox.filter(item => !item.read).length > 0 ? (
            <span style={{ position: 'absolute', bottom: -2, right: -2, minWidth: 14, height: 14, padding: '0 3px', boxSizing: 'border-box', borderRadius: 999, background: '#2563eb', color: '#fff', fontSize: 9, lineHeight: '14px', textAlign: 'center' }}>
              {pendingCount + kbPending + skillRows.length + reviewInbox.filter(item => !item.read).length > 99 ? '99+' : pendingCount + kbPending + skillRows.length + reviewInbox.filter(item => !item.read).length}
            </span>
          ) : null}
        </button>
      ) : null}

      <Modal open={open} onClose={() => setOpen(false)} title="任务中心" headless className={TASK_BUS_MODAL_CLASS}>
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
          <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '22px 24px 12px' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h2 style={{ margin: 0, fontSize: 16, lineHeight: '24px', fontWeight: 500, color: colors.text }}>任务中心</h2>
            </div>
            <Button size="sm" variant="ghost" onClick={() => void load()}>刷新</Button>
            <Button size="sm" variant="ghost" aria-label="关闭" title="关闭" onClick={() => setOpen(false)} icon={<IconCloseOutlineRegular size={14} />} style={{ width: 28, padding: 0 }} />
          </header>
          <div style={{ padding: '0 24px 14px', borderBottom: '1px solid ' + colors.line }}>
            <SegmentedTabs items={tabItems} value={tab} onChange={setTab} label="任务中心分类" />
          </div>
          {error ? <div style={{ padding: '8px 10px', borderRadius: 8, background: '#fef2f2', color: colors.danger, fontSize: 11, margin: '0 24px 12px' }}>{error}</div> : null}
          <div id={'task-bus-panel-' + tab} role="tabpanel" aria-labelledby={'task-bus-tab-' + tab} style={{ padding: '16px 24px 24px', display: 'flex', flexDirection: 'column', gap: 10, overflowY: 'auto', flex: 1 }}>
            {tab === 'notifications' ? (
              <KbNotificationPanel tasks={kbTasks} skillRows={skillRows} reviewItems={reviewInbox} onOpenSkill={openSkillCenter} onClear={clearKbTasks} />
            ) : selected !== null ? (
              <TaskDetail task={selected} onBack={() => setSelected(null)} />
            ) : (
              <>
                {loading ? <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>正在加载…</div> : null}
                {!loading && filtered.length === 0 ? <div style={{ padding: 18, textAlign: 'center', color: colors.muted, fontSize: 12 }}>暂无任务</div> : null}
                {!loading && filtered.map((task) => (
                  <TaskCard key={task.id} task={task} busy={busyId === task.id} aiBusy={aiBusyId === task.id} onTransition={(item, action) => void transition(item, action)} onAiAccept={(item) => void aiAccept(item)} onOpen={setSelected} />
                ))}
              </>
            )}
          </div>
        </div>
      </Modal>
    </>
  )
}



interface HistoryEntry {
  key: string
  role: 'user' | 'assistant'
  author: string
  time: number | undefined
  text: string
  jumpId?: string
}

const HISTORY_CONTENT_TYPES = new Set(['user/message', 'assistant/message'])

const historyText = (content: unknown): string => {
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (block === null || typeof block !== 'object') return ''
    const record = block as Record<string, unknown>
    return record.type === 'text' && typeof record.text === 'string' ? record.text : ''
  }).filter(Boolean).join('\n').trim()
}

const historyRole = (event: Record<string, unknown>): 'user' | 'assistant' => {
  const data = event.data as Record<string, unknown> | undefined
  return data?.role === 'user' || event.type === 'user/message' ? 'user' : 'assistant'
}

const historyAuthor = (event: Record<string, unknown>, role: 'user' | 'assistant', t: HistoryTranslate): string => {
  const data = event.data as Record<string, unknown> | undefined
  const source = data?.source as Record<string, unknown> | undefined
  const memberName = typeof source?.memberName === 'string' ? source.memberName.trim() : ''
  if (memberName !== '') return memberName
  return role === 'user' ? t('me') : t('assistant')
}

const groupHistory = async (roomId: string, t: HistoryTranslate): Promise<HistoryEntry[]> => {
  const entries: HistoryEntry[] = []
  let cursor: string | null = null
  for (let page = 0; page < 20; page += 1) {
    const suffix = cursor === null ? '' : '?cursor=' + encodeURIComponent(cursor)
    const response = await fetch('/dsh-group-chat/api/rooms/' + encodeURIComponent(roomId) + '/events' + suffix)
    if (!response.ok) throw new Error(t('error'))
    const payload = await response.json() as { events?: Array<{ id?: string; event?: Record<string, unknown>; createdAt?: string }>; nextCursor?: string | null; hasMore?: boolean }
    for (const record of payload.events ?? []) {
      const event = record.event
      if (event === undefined || typeof event.type !== 'string' || !HISTORY_CONTENT_TYPES.has(event.type)) continue
      const data = event.data as Record<string, unknown> | undefined
      const role = historyRole(event)
      const text = historyText(data?.content)
      if (text === '') continue
      entries.push({ key: record.id ?? String(event.seq ?? entries.length), role, author: historyAuthor(event, role, t), time: typeof event.time === 'number' ? event.time : undefined, text, jumpId: record.id })
    }
    if (payload.hasMore !== true || payload.nextCursor === null || payload.nextCursor === undefined) break
    cursor = payload.nextCursor
  }
  return entries.sort((left, right) => (right.time ?? 0) - (left.time ?? 0))
}

const sessionHistory = async (sessionId: string, sessions: unknown, t: HistoryTranslate): Promise<HistoryEntry[]> => {
  const service = sessions as {
    retain?: (id: string, options: { source: string }) => {
      ready?: Promise<unknown>
      binding?: {
        eventSource?: { getSnapshot(): { entries?: Array<{ type?: string; event?: Record<string, unknown> }> } }
        session?: { loadOlder?: () => Promise<void> }
      }
      release?: () => void
    }
  }
  if (service.retain === undefined) return []
  const reference = service.retain(sessionId, { source: 'gateway' })
  try {
    await reference.ready
    const binding = reference.binding
    if (binding === undefined) return []
    await binding.session?.loadOlder?.().catch(() => undefined)
    const entries = binding.eventSource?.getSnapshot().entries ?? []
    return entries
      .filter((entry): entry is { type: 'event'; event: Record<string, unknown> } => entry.type === 'event' && entry.event !== undefined)
      .filter((entry) => typeof entry.event.type === 'string' && HISTORY_CONTENT_TYPES.has(entry.event.type))
      .map((entry) => {
        const event = entry.event
        const data = event.data as Record<string, unknown> | undefined
        const role = historyRole(event)
        return {
          key: String(event.seq ?? entries.indexOf(entry)),
          role,
          author: historyAuthor(event, role, t),
          time: typeof event.time === 'number' ? event.time : undefined,
          text: historyText(data?.content),
        }
      })
      .filter((entry) => entry.text !== '')
      .sort((left, right) => (right.time ?? 0) - (left.time ?? 0))
  } finally {
    reference.release?.()
  }
}



interface FileAttachmentRef {
  attachmentId: string
  name: string
  bytes: number
}

const fileAttachmentIn = (content: unknown, name: string): FileAttachmentRef | undefined => {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type !== 'file') continue
    const attachment = record.attachment as Record<string, unknown> | undefined
    if (attachment?.name === name && typeof attachment.attachmentId === 'string' && typeof attachment.bytes === 'number') {
      return { attachmentId: attachment.attachmentId, name, bytes: attachment.bytes }
    }
  }
  return undefined
}

const sessionFileAttachment = async (sessionId: string, sessions: unknown, name: string): Promise<FileAttachmentRef | undefined> => {
  const service = sessions as {
    retain?: (id: string, options: { source: string }) => {
      ready?: Promise<unknown>
      binding?: {
        eventSource?: { getSnapshot(): { entries?: Array<{ type?: string; event?: Record<string, unknown> }> } }
        session?: { loadOlder?: () => Promise<void> }
      }
      release?: () => void
    }
  }
  if (service.retain === undefined) return undefined
  const reference = service.retain(sessionId, { source: 'gateway' })
  try {
    await reference.ready
    const binding = reference.binding
    if (binding === undefined) return undefined
    const find = (): FileAttachmentRef | undefined => {
      const entries = binding.eventSource?.getSnapshot().entries ?? []
      for (const entry of entries) {
        if (entry.type !== 'event' || entry.event === undefined) continue
        if (entry.event.type !== 'user/message') continue
        const data = entry.event.data as Record<string, unknown> | undefined
        const found = fileAttachmentIn(data?.content, name)
        if (found !== undefined) return found
      }
      return undefined
    }
    let found = find()
    for (let page = 0; page < 5 && found === undefined; page += 1) {
      await binding.session?.loadOlder?.().catch(() => undefined)
      found = find()
    }
    return found
  } finally {
    reference.release?.()
  }
}

/**
 * The design system's standard 16-unit clock glyph, drawn locally.
 *
 * The client primitives package this runtime serves (0.2.2-alpha.2) exports
 * `IconClockOutline`, `IconClockOutlineRegular`, and `IconClockOutlineMedium`,
 * not the newer `IconClockOutline16` name. A missing named export resolves to
 * `undefined`, so importing it crashed this header slot with React error #130
 * and removed the button entirely; the standard geometry is inlined instead.
 *
 * Weight is 1, matching the shell's own header glyphs: those render 16x16 with
 * `stroke-width="1"` on a `0 0 16 16` viewBox, so a 1.5 stroke read as a bold
 * clock beside them. The glyph must also stay square inside the 28px button,
 * hence its block display and disabled flex shrink.
 */
const MessageHistoryIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    strokeWidth="1"
    preserveAspectRatio="xMidYMid meet"
    style={{ display: 'block', flexShrink: 0 }}
  >
    <circle cx="8" cy="8" r="6.375" stroke="currentColor" />
    <path d="M8 4.4V8.3L10.7 9.85" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const HistoryButton = ({ sessionId, sessions, t }: { sessionId: string; sessions: unknown; t: HistoryTranslate }) => {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const isGroup = sessionId.startsWith('group-room-')

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setError('')
    setQuery('')
    setEntries([])
    const load = isGroup ? groupHistory(sessionId.slice('group-room-'.length), t) : sessionHistory(sessionId, sessions, t)
    void load.then((items) => { if (alive) setEntries(items) })
      .catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : String(cause)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [open, isGroup, sessionId, sessions, t])

  const needle = query.trim().toLocaleLowerCase()
  const results = useMemo(() => {
    if (needle === '') return []
    return entries.filter((entry) =>
      entry.text.toLocaleLowerCase().includes(needle) || entry.author.toLocaleLowerCase().includes(needle))
  }, [entries, needle])

  const jump = (entry: HistoryEntry) => {
    setOpen(false)
    window.setTimeout(() => {
      let target: HTMLElement | null = entry.jumpId === undefined
        ? null
        : document.querySelector<HTMLElement>('[data-group-chat-message="' + CSS.escape(entry.jumpId) + '"]')
      if (target === null) {
        const text = entry.text.slice(0, 80)
        target = [...document.querySelectorAll<HTMLElement>('[data-group-chat-message], [data-slot="conversation.user.text.node"]')]
          .find((element) => (element.innerText ?? '').includes(text)) ?? null
      }
      if (target === null && (window as unknown as { find: (...args: unknown[]) => boolean }).find(entry.text.slice(0, 80), false, false, true, false, false, false)) {
        const selection = window.getSelection()
        const node = selection?.anchorNode
        target = node instanceof HTMLElement ? node : node?.parentElement ?? null
      }
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      if (target !== null) {
        target.style.outline = '2px solid #2563eb'
        target.style.outlineOffset = '4px'
        window.setTimeout(() => { target!.style.outline = ''; target!.style.outlineOffset = '' }, 1800)
      }
    }, 80)
  }

  const searchInputStyle: CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    height: 36,
    padding: '0 34px 0 12px',
    borderRadius: 8,
    border: '1px solid ' + colors.line,
    background: colors.panel,
    color: colors.text,
    fontSize: 13,
    outline: 'none',
  }

  return (
    <>
      <button
        type="button"
        aria-label={t('open')}
        title={t('open')}
        data-session-id={sessionId}
        onClick={() => setOpen(true)}
        style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, border: 'none', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' }}
      >
        <MessageHistoryIcon size={16} />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title={t('title')} closeLabel={t('close')} className={TASK_BUS_HISTORY_CLASS}>
        <div style={{ width: '100%', maxHeight: 'min(68vh, 620px)', overflowY: 'auto', display: 'grid', gap: 10, padding: '4px 0 8px' }}>
          <div style={{ position: 'relative', width: '100%' }}>
            <input
              type="text"
              value={query}
              autoFocus
              spellCheck={false}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchLabel')}
              onChange={(event) => { setQuery(event.target.value) }}
              style={searchInputStyle}
            />
            {query !== '' ? (
              <button
                type="button"
                aria-label={t('clear')}
                title={t('clear')}
                onClick={() => { setQuery('') }}
                style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, border: 'none', borderRadius: 5, background: 'transparent', color: colors.muted, cursor: 'pointer' }}
              >
                <IconCloseOutlineRegular size={14} />
              </button>
            ) : null}
          </div>

          {loading ? <div style={{ padding: 28, textAlign: 'center', color: colors.muted, fontSize: 12 }}>{t('loading')}</div> : null}
          {!loading && error !== '' ? <div role="alert" style={{ padding: 12, color: colors.danger, fontSize: 12 }}>{error}</div> : null}
          {!loading && error === '' && needle === '' ? (
            <div style={{ display: 'grid', justifyItems: 'center', gap: 8, padding: '36px 20px 40px', color: colors.muted, textAlign: 'center' }}>
              <span style={{ display: 'inline-flex', width: 36, height: 36, alignItems: 'center', justifyContent: 'center', borderRadius: 18, background: colors.panelAlt, color: colors.muted }}>
                <MessageHistoryIcon size={16} />
              </span>
              <span style={{ fontSize: 13, fontWeight: 600, color: colors.text }}>{t('initial')}</span>
              <span style={{ fontSize: 12, lineHeight: 1.6 }}>{t('initialHint')}</span>
            </div>
          ) : null}
          {!loading && error === '' && needle !== '' && results.length === 0 ? (
            <div style={{ padding: 28, textAlign: 'center', color: colors.muted, fontSize: 12 }}>
              {entries.length === 0 ? t('empty') : t('noResults')}
            </div>
          ) : null}
          {!loading && error === '' && needle !== '' && results.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => jump(entry)}
              style={{ display: 'grid', gap: 6, width: '100%', minWidth: 0, textAlign: 'left', padding: '10px 12px', borderRadius: 8, border: '1px solid ' + colors.line, background: colors.panelAlt, color: colors.text, cursor: 'pointer' }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flexWrap: 'wrap', fontSize: 10, color: colors.muted }}>
                <span style={{ fontWeight: 650, color: entry.role === 'user' ? '#2563eb' : colors.text }}>{entry.author}</span>
                {entry.time === undefined ? null : <span>{new Date(entry.time).toLocaleString(t('dateLocale'))}</span>}
                <span style={{ marginLeft: 'auto' }}>{t('jump')}</span>
              </span>
              <span style={{ display: 'block', minWidth: 0, fontSize: 13, lineHeight: 1.65, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-word' }}>{entry.text}</span>
            </button>
          ))}
        </div>
      </Modal>
    </>
  )
}

export const apply = (ctx: Context) => {
  const locale = (ctx as unknown as {
    locale: {
      register(namespace: string, dictionaries: { zh: typeof HISTORY_COPY.zh; en: typeof HISTORY_COPY.en }): () => void
      bind(namespace: string): (key: HistoryCopyKey) => string
    }
  }).locale
  ctx.effect(() => locale.register(HISTORY_NS, { zh: HISTORY_COPY.zh, en: HISTORY_COPY.en }), 'task-bus: history copy')
  const t = locale.bind(HISTORY_NS)
  const surface = ctx as unknown as {
    slots: {
      inject(name: string, factory: () => () => void): () => void
      register(options: Record<string, unknown>, component: (props: never) => JSX.Element | null): () => void
    }
    uiWorkspace: { openSession(sessionId: string): void }
  }
  const surfaceWithServices = surface as unknown as {
    sidebarRight?: { openResource?(address: string): void }
    get?: (name: string) => unknown
  }
  const sidebarRight = (surfaceWithServices.sidebarRight ?? surfaceWithServices.get?.('sidebarRight')) as
    { openResource?(address: string): void } | undefined
  // Native file cards are spans owned by the official Chat renderer, so delegate from the
  // document. The active Session header carries its id; group rooms have their own handler.
  ctx.effect(() => {
    const onFileClick = (event: MouseEvent): void => {
      const target = event.target
      if (!(target instanceof Element)) return
      const card = target.closest('[data-message-attachments] > *')
      if (!(card instanceof HTMLElement)) return
      const header = document.querySelector<HTMLElement>('button[aria-label="消息记录"][data-session-id]')
      const sessionId = header?.getAttribute('data-session-id') ?? ''
      if (sessionId === '' || sessionId.startsWith('group-room-')) return
      const name = (card.getAttribute('title') ?? card.innerText.split('\n')[0] ?? '').trim()
      if (name === '') return
      void (async () => {
        const attachment = await sessionFileAttachment(sessionId, (ctx as unknown as { sessions: unknown }).sessions, name)
        if (attachment === undefined) return
        const sessionState = (ctx as unknown as {
          sessions?: { list?: { getSnapshot(): { byId?: Record<string, { cwd?: string }> } } }
        }).sessions?.list?.getSnapshot()
        const cwd = sessionState?.byId?.[sessionId]?.cwd ?? ''
        const query = 'attachmentId=' + encodeURIComponent(attachment.attachmentId)
          + '&name=' + encodeURIComponent(attachment.name)
          + '&bytes=' + encodeURIComponent(String(attachment.bytes))
          + (cwd === '' ? '' : '&cwd=' + encodeURIComponent(cwd))
        const response = await fetch(ROUTE + '/attachment-materialize?' + query)
        if (!response.ok) throw new Error('附件预览准备失败')
        const materialized = await response.json() as { path?: string }
        if (typeof materialized.path !== 'string') throw new Error('附件预览路径缺失')
        const address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId)
          + '/' + materialized.path.split('/').map((part) => encodeURIComponent(part)).join('/')
        const right = (ctx as unknown as { sidebarRight?: { openResource?(address: string): void } }).sidebarRight
        if (right?.openResource !== undefined) right.openResource(address)
        else window.open(new URL('/dsh-task-bus/api/attachment-materialize?' + query, window.location.origin).toString(), '_blank', 'noopener,noreferrer')
      })().catch((cause) => { console.error('[task-bus] file preview failed', cause) })
    }
    document.addEventListener('click', onFileClick, true)
    return () => { document.removeEventListener('click', onFileClick, true) }
  }, 'task-bus: native file card preview')
  const Surface = () => (
    <TaskCenterButton
      openSession={(sessionId) => surface.uiWorkspace.openSession(sessionId)}
    />
  )
  ctx.effect(() => surface.slots.inject('shell.overlay', () => surface.slots.register(
    { name: 'shell.overlay', id: 'task-bus.center' },
    Surface,
  )), 'task-bus: Task Center overlay')

  // The history seat replaces the host's open-in-app jump. That control is a split
  // group: `[data-open-target="directory"]` wraps the primary button and an optional
  // chevron. Hiding only the primary button left the wrapper's 1px left/right border
  // as a 2px-wide, 24px-tall rule beside this button, so the entry that owns the
  // split group is hidden instead.
  //
  // The slot renders every registered entry as one direct child of the
  // `[data-slot="conversation.session.header.utilities"]` wrapper; this button is a
  // sibling of that entry, so the selectors below never match its own container.
  // They are scoped to the utilities slot so the file and directory launchers
  // elsewhere in the shell keep working.
  ctx.effect(() => {
    const style = document.createElement('style')
    style.id = 'task-bus-history-replaces-file-manager'
    style.textContent = [
      '[data-slot="conversation.session.header.utilities"] > *:has([data-open-target]) { display: none !important; }',
      '[data-message-attachments] > * { cursor: pointer; }',
    ].join('\n')
    document.head.appendChild(style)
    return () => { style.remove() }
  }, 'task-bus: replace file manager header button')

  ctx.effect(() => surface.slots.inject('conversation.session.header.utilities', () => surface.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'task-bus.history',
    order: -4,
    inject: ((sessionId: string) => ({ sessionId, sessions: (ctx as unknown as { sessions: unknown }).sessions, t })) as never,
  } as never, HistoryButton as never)), 'task-bus: message history')
}