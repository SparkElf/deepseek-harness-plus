import { useCallback, useMemo, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  applyBulkBindings,
  previewBulkBindings,
  BulkBindError,
  type BulkBindResult,
  type BulkBindRow,
  type BulkBindRowStatus,
} from './bulk-api.ts'

/** 主题无关的基础样式；与 ImBotsSection 一致，颜色一律继承。 */
const styles = {
  root: {
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 8,
    padding: '12px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  } as const,
  header: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } as const,
  title: { fontSize: 14, fontWeight: 600, margin: 0 } as const,
  hint: { opacity: 0.68, margin: 0, lineHeight: 1.55, fontSize: 12 } as const,
  tabs: { display: 'flex', gap: 6 } as const,
  tab: {
    padding: '4px 10px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.35)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
    fontSize: 12,
  } as const,
  tabActive: {
    borderColor: 'rgba(80,140,220,0.8)',
    background: 'rgba(80,140,220,0.12)',
  } as const,
  textarea: {
    width: '100%',
    minHeight: 132,
    padding: '8px 10px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.45)',
    background: 'transparent',
    color: 'inherit',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.5,
    boxSizing: 'border-box',
    resize: 'vertical',
  } as const,
  input: {
    padding: '6px 8px',
    borderRadius: 6,
    border: '1px solid rgba(128,128,128,0.45)',
    background: 'transparent',
    color: 'inherit',
    fontSize: 12,
  } as const,
  actions: { display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' } as const,
  notice: { fontSize: 12, lineHeight: 1.5 } as const,
  chips: { display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 12 } as const,
  chip: {
    border: '1px solid rgba(128,128,128,0.35)',
    borderRadius: 999,
    padding: '2px 9px',
  } as const,
  tableWrap: {
    maxHeight: 360,
    overflow: 'auto',
    border: '1px solid rgba(128,128,128,0.3)',
    borderRadius: 6,
  } as const,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } as const,
  th: {
    textAlign: 'left',
    padding: '6px 8px',
    position: 'sticky',
    top: 0,
    background: 'var(--dsh-settings-bg, rgba(127,127,127,0.12))',
    borderBottom: '1px solid rgba(128,128,128,0.3)',
    whiteSpace: 'nowrap',
  } as const,
  td: {
    padding: '6px 8px',
    borderBottom: '1px solid rgba(128,128,128,0.18)',
    verticalAlign: 'top',
  } as const,
} as const

/** 状态 → 文案与颜色。只做展示，不参与授权或写入判断。 */
const STATUS_TEXT: Record<BulkBindRowStatus, { label: string; color: string }> = {
  matched: { label: '可绑定', color: '#3fa46a' },
  applied: { label: '已绑定', color: '#3fa46a' },
  conflict: { label: '冲突', color: '#d0554d' },
  unmatched: { label: '未匹配', color: '#b0823a' },
  invalid: { label: '格式错误', color: '#d0554d' },
}

/** 后端 reason → 中文短标签。未知 reason 原样显示，便于排查。 */
const REASON_TEXT: Record<string, string> = {
  USER_NOT_FOUND: '未找到用户',
  MULTIPLE_MATCH: '一个字段命中多个用户',
  CONFLICTING_MATCH: '多个字段指向不同用户',
  IDENTIFIER_MISMATCH: '标识字段不一致',
  USER_DISABLED: '用户已停用',
  SERVICE_ACCOUNT: '机器人服务账号',
  USER_ALREADY_BOUND: '已绑定该企微 userid',
  USER_ALREADY_BOUND_OTHER: '已绑定其他企微 userid',
  WECOM_ID_TAKEN: '企微 userid 已被占用',
  DUPLICATE_WECOM_ID_IN_BATCH: '批内企微 userid 重复',
  DUPLICATE_USER_IN_BATCH: '批内用户重复',
  WECOM_USER_ID_REQUIRED: '缺少企微 userid',
  INVALID_WECOM_USER_ID: '企微 userid 格式非法',
  IDENTIFIER_REQUIRED: '缺少用户标识',
  INVALID_ROW: '行格式错误',
}

/** 示例 JSON，方便管理员先跑通预览。 */
const SAMPLE_JSON = `[
  {"wecomUserId": "wx-zhangsan", "username": "zhangsan"},
  {"wecomUserId": "wx-lisi", "email": "lisi@example.com"},
  {"wecomUserId": "wx-wangwu", "mobile": "13800000003", "employeeId": "E003"}
]`

/** 结果下载的 CSV 表头。 */
const RESULT_HEADER = [
  'index',
  'wecomUserId',
  'identifiers',
  'status',
  'reason',
  'message',
  'matchedUserId',
  'matchedUsername',
  'matchedDisplayName',
  'auditId',
]

/** CSV 转义；同时消掉 Excel 公式注入（用户可控字段以 = + - @ 开头时加单引号）。 */
const csvCell = (value: unknown): string => {
  const raw = value === null || value === undefined ? '' : String(value)
  const text = /^[=+\-@\t\r]/u.test(raw) ? `'${raw}` : raw
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text
}

/** 把行结果拼成带 BOM 的 CSV，Excel 打开中文不乱码。 */
const rowsToCsv = (rows: readonly BulkBindRow[]): string => {
  const lines = [RESULT_HEADER.join(',')]
  for (const row of rows) {
    lines.push([
      row.index,
      row.wecomUserId ?? '',
      row.identifiers.map((item) => `${item.field}=${item.value}`).join('; '),
      row.status,
      row.reason ?? '',
      row.message,
      row.user?.id ?? '',
      row.user?.username ?? '',
      row.user?.displayName ?? '',
      row.auditId ?? '',
    ].map(csvCell).join(','))
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}

/** 触发浏览器下载。 */
function downloadText(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** 单行标识摘要。 */
const identifierText = (row: BulkBindRow): string =>
  row.identifiers.length === 0
    ? '—'
    : row.identifiers.map((item) => `${item.field}=${item.value}`).join('；')

/** 可下载的结果文件名。 */
const resultFilename = (dryRun: boolean): string => {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
  return `wecom-identity-${dryRun ? 'preview' : 'apply'}-${stamp}.csv`
}

/** 批量绑定面板的属性。 */
export interface ImBulkBindingSectionProps {
  /** apply 成功后通知父面板刷新单条绑定列表。 */
  onApplied?: () => void
}

/**
 * 企微身份绑定 →「批量绑定」。
 *
 * 支持粘贴 JSON 或上传/粘贴 CSV；先 dryRun 预览匹配、冲突、未匹配与格式错误，
 * 只有全部行可绑定且管理员确认后才 apply。apply 的原子性与逐条审计由后端保证，
 * 本组件只负责展示与下载结果，不自行推断匹配关系。
 *
 * @param props - 成功后回调。
 */
export function ImBulkBindingSection({ onApplied }: ImBulkBindingSectionProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'json' | 'csv'>('json')
  const [jsonText, setJsonText] = useState('')
  const [csvText, setCsvText] = useState('')
  const [csvName, setCsvName] = useState<string | null>(null)
  const [result, setResult] = useState<BulkBindResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)

  const blockedCount = useMemo(() => {
    if (result === null) return 0
    return result.summary.conflicts + result.summary.unmatched + result.summary.invalid
  }, [result])

  const canApply = result !== null
    && result.dryRun
    && result.summary.matched > 0
    && blockedCount === 0
    && busy === null

  /** 把当前输入折成请求体；JSON 先在浏览器侧校验，避免把语法错误发到后端。 */
  const payload = useCallback((): { rows: unknown[] } | { csv: string } => {
    if (mode === 'csv') {
      if (csvText.trim() === '') throw new Error('请先上传或粘贴 CSV 内容')
      return { csv: csvText }
    }
    if (jsonText.trim() === '') throw new Error('请先粘贴 JSON 数组')
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (parseError) {
      throw new Error(`JSON 解析失败：${parseError instanceof Error ? parseError.message : String(parseError)}`)
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
        ? (parsed as { rows: unknown[] }).rows
        : null)
    if (rows === null) throw new Error('JSON 必须是数组，或包含 rows 数组的对象')
    if (rows.length === 0) throw new Error('JSON 数组为空')
    return { rows }
  }, [csvText, jsonText, mode])

  const runPreview = async (): Promise<void> => {
    setBusy('preview')
    setError(null)
    setNotice(null)
    setResult(null)
    try {
      const value = await previewBulkBindings(payload())
      setResult(value)
      if (value.summary.matched === 0) setNotice('没有可绑定的行，请检查标识字段是否与万相用户一致。')
    } catch (previewError) {
      if (previewError instanceof BulkBindError && (previewError.body?.details?.rows ?? previewError.body?.rows)) {
        const rejected = previewError.body.details ?? previewError.body
        const rejectedRows = rejected.rows ?? []
        setResult({
          dryRun: true,
          applied: 0,
          total: rejected.total ?? rejectedRows.length,
          summary: rejected.summary ?? {
            total: rejectedRows.length,
            matched: 0,
            applied: 0,
            conflicts: 0,
            unmatched: 0,
            invalid: 0,
          },
          rows: rejectedRows,
        })
      }
      setError(previewError instanceof Error ? previewError.message : String(previewError))
    } finally {
      setBusy(null)
    }
  }

  const runApply = async (): Promise<void> => {
    if (result === null) return
    const confirmed = window.confirm(
      `确认绑定 ${result.summary.matched} 个企微 userid？\n\n该操作在一个事务内写入 users.wecom_user_id，并为每条绑定写审计；任一行冲突会整批拒绝。`,
    )
    if (!confirmed) return
    setBusy('apply')
    setError(null)
    setNotice(null)
    try {
      const value = await applyBulkBindings(payload())
      setResult(value)
      setNotice(`已成功绑定 ${value.applied} 个用户。`)
      onApplied?.()
    } catch (applyError) {
      if (applyError instanceof BulkBindError && (applyError.body?.details?.rows ?? applyError.body?.rows)) {
        const rejected = applyError.body.details ?? applyError.body
        const rejectedRows = rejected.rows ?? []
        setResult({
          dryRun: false,
          applied: 0,
          total: rejected.total ?? rejectedRows.length,
          summary: rejected.summary ?? {
            total: rejectedRows.length,
            matched: 0,
            applied: 0,
            conflicts: 0,
            unmatched: 0,
            invalid: 0,
          },
          rows: rejectedRows,
        })
      }
      setError(applyError instanceof Error ? applyError.message : String(applyError))
    } finally {
      setBusy(null)
    }
  }

  const readFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return
    try {
      const text = await file.text()
      setCsvText(text)
      setCsvName(file.name)
      setResult(null)
      setError(null)
      setNotice(null)
    } catch (readError) {
      setError(readError instanceof Error ? readError.message : String(readError))
    }
  }

  const clearAll = (): void => {
    setJsonText('')
    setCsvText('')
    setCsvName(null)
    setResult(null)
    setError(null)
    setNotice(null)
  }

  return (
    <div style={styles.root} data-im-bulk-binding="root">
      <div style={styles.header}>
        <h3 style={styles.title}>批量绑定</h3>
        <span style={{ ...styles.hint, flex: 1 }}>
          按 username / email / mobile / employeeId 精确匹配万相用户；先预览，再确认写入。
        </span>
        <Button size="sm" onClick={() => setOpen((value) => !value)}>
          {open ? '收起' : '展开批量绑定'}
        </Button>
      </div>

      {!open ? null : (
        <>
          <p style={styles.hint}>
            支持 JSON 数组或 CSV（表头至少含 <code>wecomUserId</code>，可选
            {' '}<code>username</code>、<code>email</code>、<code>mobile</code>、
            {' '}<code>employeeId</code>）。默认只预览；确认后才写入。
            同一个企微 userid 或同一个万相用户在一批里出现多次、字段多匹配、用户已绑定，
            都会被拒绝；不会按显示名或昵称猜测。
          </p>

          <div style={styles.tabs}>
            <button
              type="button"
              style={{ ...styles.tab, ...(mode === 'json' ? styles.tabActive : {}) }}
              onClick={() => { setMode('json'); setResult(null); setError(null); setNotice(null) }}
            >
              粘贴 JSON
            </button>
            <button
              type="button"
              style={{ ...styles.tab, ...(mode === 'csv' ? styles.tabActive : {}) }}
              onClick={() => { setMode('csv'); setResult(null); setError(null); setNotice(null) }}
            >
              上传 / 粘贴 CSV
            </button>
          </div>

          {mode === 'json' ? (
            <>
              <textarea
                style={styles.textarea}
                value={jsonText}
                onChange={(event) => { setJsonText(event.target.value); setResult(null); setNotice(null) }}
                placeholder={'[{"wecomUserId":"wx-zhangsan","username":"zhangsan"}]'}
                data-im-bulk-json="true"
              />
              <div style={styles.actions}>
                <Button size="sm" onClick={() => { setJsonText(SAMPLE_JSON); setResult(null); setNotice(null) }}>
                  填入示例
                </Button>
              </div>
            </>
          ) : (
            <>
              <div style={styles.actions}>
                <input
                  style={styles.input}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(event) => {
                    void readFile(event.target.files?.[0])
                    event.target.value = ''
                  }}
                  data-im-bulk-file="true"
                />
                {csvName !== null && <span style={styles.hint}>已读取：{csvName}</span>}
                <Button
                  size="sm"
                  onClick={() => {
                    downloadText(
                      'wecom-identity-template.csv',
                      '\uFEFFwecomUserId,username,email,mobile,employeeId\r\n',
                      'text/csv;charset=utf-8',
                    )
                  }}
                >
                  下载 CSV 模板
                </Button>
              </div>
              <textarea
                style={styles.textarea}
                value={csvText}
                onChange={(event) => { setCsvText(event.target.value); setCsvName(null); setResult(null); setNotice(null) }}
                placeholder={'wecomUserId,username,email,mobile,employeeId\r\nwx-zhangsan,zhangsan,,,'}
                data-im-bulk-csv="true"
              />
            </>
          )}

          <div style={styles.actions}>
            <Button
              size="sm"
              variant="primary"
              disabled={busy !== null}
              onClick={() => void runPreview()}
            >
              {busy === 'preview' ? '预览中…' : '预览匹配'}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!canApply}
              onClick={() => void runApply()}
            >
              {busy === 'apply' ? '提交中…' : '确认绑定'}
            </Button>
            {result !== null && (
              <Button
                size="sm"
                onClick={() => downloadText(
                  resultFilename(result.dryRun),
                  rowsToCsv(result.rows),
                  'text/csv;charset=utf-8',
                )}
              >
                下载结果 CSV
              </Button>
            )}
            <Button size="sm" disabled={busy !== null} onClick={clearAll}>清空</Button>
          </div>

          {error !== null && (
            <div style={{ ...styles.notice, color: '#d0554d' }} role="alert">{error}</div>
          )}
          {notice !== null && (
            <div style={{ ...styles.notice, color: '#3fa46a' }}>{notice}</div>
          )}

          {result !== null && (
            <>
              <div style={styles.chips} data-im-bulk-summary="true">
                <span style={styles.chip}>总计 <strong>{result.summary.total}</strong></span>
                <span style={styles.chip}>可绑定 <strong>{result.summary.matched}</strong></span>
                <span style={styles.chip}>已绑定 <strong>{result.summary.applied}</strong></span>
                <span style={styles.chip}>冲突 <strong>{result.summary.conflicts}</strong></span>
                <span style={styles.chip}>未匹配 <strong>{result.summary.unmatched}</strong></span>
                <span style={styles.chip}>格式错误 <strong>{result.summary.invalid}</strong></span>
              </div>
              <div style={styles.tableWrap}>
                <table style={styles.table}>
                  <thead>
                    <tr>
                      <th style={styles.th}>#</th>
                      <th style={styles.th}>企微 userid</th>
                      <th style={styles.th}>匹配标识</th>
                      <th style={styles.th}>状态</th>
                      <th style={styles.th}>万相用户</th>
                      <th style={styles.th}>原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.rows.map((row) => {
                      const status = STATUS_TEXT[row.status]
                      return (
                        <tr key={`${row.index}-${row.wecomUserId ?? ''}`} data-im-bulk-row={row.index}>
                          <td style={styles.td}>{row.index}</td>
                          <td style={styles.td}><code>{row.wecomUserId ?? '—'}</code></td>
                          <td style={styles.td}>{identifierText(row)}</td>
                          <td style={{ ...styles.td, color: status.color, whiteSpace: 'nowrap' }}>{status.label}</td>
                          <td style={styles.td}>
                            {row.user === null
                              ? '—'
                              : (
                                <span>
                                  {row.user.displayName || row.user.username}
                                  <span style={{ opacity: 0.65 }}>（{row.user.username}）</span>
                                </span>
                              )}
                          </td>
                          <td style={styles.td}>
                            {row.reason === null ? '—' : (
                              <span>
                                {REASON_TEXT[row.reason] ?? row.reason}
                                {row.candidates.length > 0 && (
                                  <span style={{ opacity: 0.7 }}>
                                    {' '}候选：{row.candidates.map((item) => item.username).join('、')}
                                  </span>
                                )}
                                {row.message !== '' && row.reason !== null && (
                                  <div style={{ opacity: 0.6 }}>{row.message}</div>
                                )}
                              </span>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}