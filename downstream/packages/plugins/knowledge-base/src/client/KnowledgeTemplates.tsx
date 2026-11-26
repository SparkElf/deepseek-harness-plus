/**
 * The template library: a card grid in an official dialog, with a maintenance side.
 *
 * A template is a document plus the few facts that describe it -- name, one-line
 * description, category, optional tags. That is the whole model, and it is why the
 * store is a directory of documents next to one JSON index rather than a table: the
 * file IS the template, and the index only says what to call it.
 *
 * Two jobs live here, because they are two readings of the same list:
 *
 * - USING a template. A card's primary action copies the template's document into a
 *   directory the reader picks, through the same upload route any new document uses,
 *   then opens it. Nothing about a template is special enough to need its own write
 *   path.
 * - MAINTAINING the list. Adding a template is "choose a document, fill in the
 *   metadata"; editing is the same form with the file already stored; taking one
 *   offline removes the record and its document.
 *
 * The empty states are the honest ones: "nothing stored yet" and "could not read the
 * store" are different facts and say so separately, because a reader told the library
 * is empty will believe it.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  FileTypeIcon,
  Input,
  Modal,
  Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { SegmentedTabs } from './ui/SegmentedTabs'
import {
  KB_API,
  kbApiPath,
  readKnowledgeJson,
  type KnowledgeTemplateSaveInput,
  type KnowledgeTemplateView,
} from '../api.ts'
import styles from './KnowledgeTemplates.module.css'

/** How long the template read may take before the surface gives up. */
const TEMPLATE_TIMEOUT_MS = 8_000

/** Which side of the dialog is showing. */
type TemplateTab = 'library' | 'manage'

/** The metadata form's state, shared by "add" and "edit". */
interface TemplateDraft {
  /** Set when editing an existing template. */
  id?: string
  title: string
  description: string
  category: string
  tags: string
  fileName: string
  /** The document text, for an added template. */
  content: string
}

/** An empty form, for "add". */
const EMPTY_DRAFT: TemplateDraft = {
  title: '', description: '', category: '', tags: '', fileName: '', content: '',
}

/** A stored template plus the built-in rows the library ships with. */
type TemplateItem = KnowledgeTemplateView & {
  /** Built-ins are bundled, read-only, and never enter the user's template store. */
  readonly builtin?: boolean
  /** Built-in document text, copied through the normal upload route when used. */
  readonly content?: string
  /** Optional engagement count shown on the cover card. */
  readonly usage?: number
}

const builtinContent = (title: string, body: string): string => `# ${title}\n\n${body}\n`
const BUILTIN_TEMPLATES: readonly TemplateItem[] = [
  {
    id: 'builtin:meeting-notes', title: '会议纪要', description: '结论、待办、责任人和时间点，一页收口。',
    category: '协作', tags: ['会议', '待办'], fileName: '会议纪要.md', extension: 'md',
    bytes: 0, updatedAt: '2026-01-01T00:00:00.000Z', relPath: '', builtin: true,
    usage: 16100,
    content: builtinContent('会议纪要', '## 会议信息\n- 时间：\n- 参与人：\n\n## 结论\n\n## 待办\n| 事项 | 负责人 | 截止时间 |\n| --- | --- | --- |\n'),
  },
  {
    id: 'builtin:weekly-report', title: '项目周报', description: '本周进展、风险、下周计划，适合例会同步。',
    category: '汇报', tags: ['周报', '项目'], fileName: '项目周报.md', extension: 'md',
    bytes: 0, updatedAt: '2026-01-01T00:00:00.000Z', relPath: '', builtin: true,
    usage: 1391,
    content: builtinContent('项目周报', '## 本周进展\n\n## 风险与阻塞\n\n## 下周计划\n'),
  },
  {
    id: 'builtin:project-plan', title: '项目方案', description: '背景、目标、范围、里程碑和资源需求。',
    category: '方案', tags: ['立项', '方案'], fileName: '项目方案.md', extension: 'md',
    bytes: 0, updatedAt: '2026-01-01T00:00:00.000Z', relPath: '', builtin: true,
    usage: 2881,
    content: builtinContent('项目方案', '## 背景\n\n## 目标\n\n## 范围\n\n## 里程碑\n\n## 资源需求\n'),
  },
  {
    id: 'builtin:research-report', title: '调研报告', description: '问题、方法、发现、建议，带证据链。',
    category: '研究', tags: ['调研', '分析'], fileName: '调研报告.md', extension: 'md',
    bytes: 0, updatedAt: '2026-01-01T00:00:00.000Z', relPath: '', builtin: true,
    usage: 3196,
    content: builtinContent('调研报告', '## 调研问题\n\n## 方法\n\n## 关键发现\n\n## 建议\n'),
  },
  {
    id: 'builtin:retrospective', title: '复盘总结', description: '做对了什么、哪里不足、下一步怎么改。',
    category: '复盘', tags: ['复盘', '改进'], fileName: '复盘总结.md', extension: 'md',
    bytes: 0, updatedAt: '2026-01-01T00:00:00.000Z', relPath: '', builtin: true,
    usage: 2087,
    content: builtinContent('复盘总结', '## 目标回顾\n\n## 做对了什么\n\n## 不足\n\n## 改进行动\n'),
  },
  {
    id: 'builtin:governance', title: '数据治理规范', description: '口径、质量、权限和留档要求的统一模板。',
    category: '治理', tags: ['数据治理', '规范'], fileName: '数据治理规范.md', extension: 'md',
    bytes: 0, updatedAt: '2026-01-01T00:00:00.000Z', relPath: '', builtin: true,
    usage: 1011000,
    content: builtinContent('数据治理规范', '## 适用范围\n\n## 口径定义\n\n## 质量要求\n\n## 权限与留档\n'),
  },
].map(template => ({ ...template, bytes: template.content?.length ?? 0 }))

/** Props for the template library. */
export interface KnowledgeTemplatesProps {
  /** Locale-bound copy resolver. */
  t: (key: string) => string
  /** Close the dialog. */
  onClose: () => void
  /** The knowledge root, for the "use this template" destination default. */
  mountPoint?: string
  /** The caller's id, so the destination default prefers their own folder. */
  callerId?: string
  /** Authoritative storage root, where a materialized template is readable by the agent. */
  actualRoot?: string
  /** Open a document once it has been created from a template. */
  onOpen?: (relPath: string) => void
  /** Start a conversation that references the materialized template file. */
  onStartSession?: (prompt: string) => void
}

/** A byte count in the reader's units. */
function sizeText(bytes: number): string {
  if (bytes < 1024) return String(bytes) + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** Engagement text for a built-in template card. */
function formatUsage(usage: number | undefined): string {
  if (usage === undefined || usage <= 0) return '尚未使用'
  if (usage >= 10_000) return (usage / 10_000).toFixed(1).replace(/\.0$/u, '') + ' 万人已使用'
  return usage.toLocaleString('zh-CN') + ' 人已使用'
}

/**
 * Split a tags field the way a reader types it.
 * @param raw - comma or space separated tags.
 * @returns Trimmed, de-duplicated tags.
 */
function splitTags(raw: string): string[] {
  return [...new Set(raw.split(/[,，\s]+/u).map(tag => tag.trim()).filter(tag => tag !== ''))]
}

/**
 * Read the template library.
 *
 * The deadline is enforced by a RACE, not by the abort alone. Measured earlier on this
 * surface: a fetch that never settles and ignores its signal kept the dialog reading
 * "Loading templates..." past seven seconds, because the abort was requested and the
 * transport did not care. The race makes the deadline authoritative whatever the
 * transport does, which is the whole reason the bound exists.
 * @returns The templates, or the literal `'timeout'` when the deadline won.
 */
async function loadTemplates(): Promise<
  { templates: KnowledgeTemplateView[]; error?: string } | 'timeout'
> {
  const controller = new AbortController()
  const deadline = new Promise<'timeout'>(resolve => {
    setTimeout(() => { controller.abort(); resolve('timeout') }, TEMPLATE_TIMEOUT_MS)
  })
  const read = (async (): Promise<{ templates: KnowledgeTemplateView[]; error?: string }> => {
    const response = await fetch(kbApiPath(KB_API.templates), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('HTTP ' + String(response.status))
    const body = await readKnowledgeJson<{ templates?: KnowledgeTemplateView[]; error?: string }>(response)
    return {
      templates: body.templates ?? [],
      ...(body.error === undefined ? {} : { error: body.error }),
    }
  })()
  try {
    return await Promise.race([read, deadline])
  } finally {
    // The losing branch must not keep a socket or a timer alive.
    controller.abort()
  }
}

/**
 * Render the template library.
 * @param props - copy resolver, the knowledge root, and the close handler.
 * @returns The dialog.
 */
export function KnowledgeTemplates(props: KnowledgeTemplatesProps) {
  const c = props.t
  const [tab, setTab] = useState<TemplateTab>('library')
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading')
  const [rows, setRows] = useState<TemplateItem[]>([])
  const [quickFilter, setQuickFilter] = useState<'all' | 'favorite' | 'recent'>('all')
  const [categoryFilter, setCategoryFilter] = useState('')
  const [favorites, setFavorites] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('kb-template-favorites') ?? '[]') as string[]) } catch { return new Set() }
  })
  const [recent, setRecent] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('kb-template-recent') ?? '[]') as string[] } catch { return [] }
  })
  const [readError, setReadError] = useState<string | undefined>(undefined)
  const [term, setTerm] = useState('')

  /** The form when it is open, undefined when it is closed. */
  const [draft, setDraft] = useState<TemplateDraft | undefined>(undefined)
  /** The template awaiting a remove confirmation. */
  const [confirming, setConfirming] = useState<KnowledgeTemplateView | undefined>(undefined)
  /** A busy flag covering save, remove and use. */
  const [busy, setBusy] = useState(false)
  /** A sentence reporting the last outcome, or a refusal. */
  const [notice, setNotice] = useState<string | undefined>(undefined)
  /** The template being copied, so its own card can show progress. */
  const [usingId, setUsingId] = useState<string | undefined>(undefined)
  /** The template whose content is shown in the preview dialog. */
  const [previewing, setPreviewing] = useState<{ template: TemplateItem; content: string } | undefined>(undefined)

  /** Set on unmount so a read that lands later cannot write to a dead component. */
  const live = useRef(true)

  /** Read the list, tolerating an unreachable Host as "unavailable". */
  const reload = useCallback(async (): Promise<void> => {
    setState('loading')
    try {
      const result = await loadTemplates()
      if (!live.current) return
      if (result === 'timeout') {
        // A timeout is "could not ask", not "there are none": an empty grid would
        // claim the source holds nothing, which this read never learned.
        setState('unavailable')
        return
      }
      setRows(result.templates)
      setReadError(result.error)
      // A store that reported a problem says so; the grid still renders what it
      // could read, because hiding rows that exist would be a second lie.
      setState(result.error === undefined ? 'ready' : 'unavailable')
    } catch {
      if (!live.current) return
      setRows([])
      setState('unavailable')
    }
  }, [])

  useEffect(() => {
    live.current = true
    void reload()
    return () => { live.current = false }
  }, [reload])

  /** Built-ins plus stored rows, before search and quick filters. */
  const allTemplates = useMemo<readonly TemplateItem[]>(() => [...BUILTIN_TEMPLATES, ...rows], [rows])

  /** The rows the search and quick filters leave. */
  const visible = useMemo(() => {
    const needle = term.trim().toLowerCase()
    const filtered = allTemplates.filter((row) => {
      if (quickFilter === 'favorite' && !favorites.has(row.id)) return false
      if (quickFilter === 'recent' && !recent.includes(row.id)) return false
      if (categoryFilter !== '' && row.category !== categoryFilter) return false
      if (needle === '') return true
      const haystack = [row.title, row.description, row.category, ...row.tags].join(' ').toLowerCase()
      return haystack.includes(needle)
    })
    if (quickFilter !== 'all') return filtered
    return [...filtered].sort((left, right) => {
      const favoriteDelta = Number(favorites.has(right.id)) - Number(favorites.has(left.id))
      if (favoriteDelta !== 0) return favoriteDelta
      return recent.indexOf(right.id) - recent.indexOf(left.id)
    })
  }, [allTemplates, categoryFilter, favorites, quickFilter, recent, term])

  const categories = useMemo(
    () => [...new Set(allTemplates.map(template => template.category).filter(category => category !== ''))],
    [allTemplates],
  )

  const toggleFavorite = useCallback((id: string): void => {
    setFavorites(current => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      localStorage.setItem('kb-template-favorites', JSON.stringify([...next]))
      return next
    })
  }, [])

  /** Open the form for a new template. */
  const startAdd = useCallback((): void => {
    setNotice(undefined)
    setDraft({ ...EMPTY_DRAFT })
  }, [])

  /** Open the form for an existing template, with its file already stored. */
  const startEdit = useCallback((template: KnowledgeTemplateView): void => {
    setNotice(undefined)
    setDraft({
      id: template.id,
      title: template.title,
      description: template.description,
      category: template.category,
      tags: template.tags.join(', '),
      fileName: template.fileName,
      // Editing metadata does not re-send the document; the route keeps the stored
      // file when no content is supplied.
      content: '',
    })
  }, [])

  /** Read a chosen document into the draft. */
  const chooseFile = useCallback((event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (file === undefined) return
    void (async () => {
      try {
        const content = await file.text()
        setDraft((current) => {
          if (current === undefined) return current
          return {
            ...current,
            content,
            fileName: file.name,
            // A title is still the reader's to write, but an empty one is filled from
            // the file name: it is the only name the system already knows.
            title: current.title.trim() === '' ? file.name.replace(/\.[^.]+$/u, '') : current.title,
          }
        })
      } catch {
        setNotice(c('templateFileUnreadable'))
      }
    })()
  }, [c])

  /** Write the draft through the save route. */
  const saveDraft = useCallback((): void => {
    if (draft === undefined || busy) return
    if (draft.title.trim() === '') {
      setNotice(c('templateNeedTitle'))
      return
    }
    if (draft.fileName.trim() === '') {
      setNotice(c('templateNeedFile'))
      return
    }
    setBusy(true)
    setNotice(undefined)
    void (async () => {
      try {
        const input: KnowledgeTemplateSaveInput = {
          title: draft.title.trim(),
          description: draft.description.trim(),
          category: draft.category.trim(),
          tags: splitTags(draft.tags),
          fileName: draft.fileName.trim(),
          ...(draft.content === '' ? {} : { content: draft.content }),
          ...(draft.id === undefined ? {} : { id: draft.id }),
        }
        const response = await fetch(kbApiPath(KB_API.templateSave), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(input),
          cache: 'no-store',
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok) {
          setNotice(body.error ?? c('templateSaveFailed'))
          return
        }
        setDraft(undefined)
        setNotice(c('templateSaved'))
        await reload()
      } catch {
        setNotice(c('templateSaveFailed'))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, c, draft, reload])

  /** Take one template offline. */
  const removeConfirmed = useCallback((): void => {
    if (confirming === undefined || busy) return
    setBusy(true)
    void (async () => {
      try {
        const response = await fetch(kbApiPath(KB_API.templateRemove), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: confirming.id }),
          cache: 'no-store',
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string; removed?: boolean }
        if (!response.ok) {
          setNotice(body.error ?? c('templateRemoveFailed'))
          return
        }
        setConfirming(undefined)
        setNotice(c('templateRemoved'))
        await reload()
      } catch {
        setNotice(c('templateRemoveFailed'))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, c, confirming, reload])

  /**
   * Materialize a built-in template into the fixed template directory.
   *
   * Stored templates already live there; a built-in exists only in this bundle, so
   * the conversation would have no file to read unless it is written once, on use.
   */
  const materializeTemplate = useCallback(async (template: TemplateItem): Promise<string | undefined> => {
    if (template.builtin !== true) return template.relPath
    if (template.content === undefined) return undefined
    const slug = template.id.replace(/^builtin:/u, 'builtin-').replace(/[^a-z0-9-]+/giu, '-')
    // The content hash keeps a revised built-in from colliding with an older copy
    // that was materialized by a previous build.
    let hash = 0
    for (let index = 0; index < template.content.length; index += 1) {
      hash = (hash * 31 + template.content.charCodeAt(index)) >>> 0
    }
    const relPath = '.kb-templates/_builtin/' + slug + '-' + hash.toString(16) + '.md'
    const response = await fetch(kbApiPath(KB_API.upload), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ relPath, content: template.content }),
      cache: 'no-store',
    })
    if (response.ok) return relPath
    // `.kb-templates` is intentionally hidden from the browse view, so the read
    // route cannot verify it. A 409 means this build already wrote the same
    // content-addressed file; that is a success for the fixed template path.
    if (response.status === 409) return relPath
    return undefined
  }, [])

  /** Which artefact the template describes, for the conversation prompt. */
  const templateKind = (template: TemplateItem): '文档' | '表格' | 'PPT' => {
    const extension = template.extension.toLowerCase()
    if (['xls', 'xlsx', 'csv', 'ods'].includes(extension)) return '表格'
    if (['ppt', 'pptx', 'odp'].includes(extension)) return 'PPT'
    return '文档'
  }

  /** Open a preview of the stored or materialized template document. */
  const previewTemplate = useCallback((template: TemplateItem): void => {
    setBusy(true)
    setUsingId(template.id)
    void (async () => {
      try {
        const relPath = await materializeTemplate(template)
        if (relPath === undefined) {
          setNotice(c('templateUseFailed'))
          return
        }
        let content = template.content
        if (content === undefined) {
          const response = await fetch(kbApiPath(KB_API.read), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: relPath }),
            cache: 'no-store',
          })
          if (!response.ok) {
            setNotice(c('templateUseFailed'))
            return
          }
          const body = await readKnowledgeJson<{ content?: string }>(response)
          content = typeof body.content === 'string' ? body.content : undefined
        }
        if (content === undefined) {
          setNotice(c('templateUseFailed'))
          return
        }
        setPreviewing({ template, content })
      } finally {
        setBusy(false)
        setUsingId(undefined)
      }
    })()
  }, [c, materializeTemplate])

  /**
   * Start a conversation from a template.
   *
   * The template is a real file the agent can read; the prompt names its absolute
   * path rather than pasting the template body into the composer. That keeps the
   * conversation able to re-read the original, and follows the product rule that
   * files are referenced, not duplicated.
   */
  const useTemplate = useCallback((template: TemplateItem): void => {
    if (busy) return
    setBusy(true)
    setUsingId(template.id)
    setNotice(undefined)
    void (async () => {
      try {
        const relPath = await materializeTemplate(template)
        if (relPath === undefined) {
          setNotice(c('templateUseFailed'))
          return
        }
        if (props.onStartSession === undefined) {
          setNotice(c('templateUseFailed'))
          return
        }
        const root = props.actualRoot !== undefined && props.actualRoot !== ''
          ? props.actualRoot
          : props.mountPoint
        const absolute = root === undefined || root === ''
          ? '/' + relPath
          : root.replace(/\/+$/u, '') + '/' + relPath
        const prompt = `帮我根据模板《${template.title}》创建一份${templateKind(template)}。\n模板文件：${absolute}\n请先读取模板文件，按模板结构生成新文档。`
        setRecent(current => {
          const next = [template.id, ...current.filter(id => id !== template.id)].slice(0, 8)
          localStorage.setItem('kb-template-recent', JSON.stringify(next))
          return next
        })
        props.onStartSession(prompt)
        props.onClose()
      } catch {
        setNotice(c('templateUseFailed'))
      } finally {
        setBusy(false)
        setUsingId(undefined)
      }
    })()
  }, [busy, c, materializeTemplate, props])

  /** Update one field of the open draft. */
  const setField = useCallback(<K extends keyof TemplateDraft>(key: K, value: TemplateDraft[K]): void => {
    setDraft(current => (current === undefined ? current : { ...current, [key]: value }))
  }, [])

  return (
    <Modal
      open
      onClose={props.onClose}
      title={c('templateTitle')}
      closeLabel={c('templateClose')}
      className={styles.modal}
      footer={(
        <div className={styles.footer}>
          <Button variant="ghost" onClick={props.onClose}>{c('templateClose')}</Button>
        </div>
      )}
    >
      <div className={styles.dialog}>
        <div className={styles.toolbar}>
          <SegmentedTabs
            value={tab}
            // `id`/`panelId` pair each tab with the pane below it, which is what makes
            // the control a tab list rather than a pair of buttons.
            items={[
              { value: 'library', id: 'kb-template-tab-library', panelId: 'kb-template-panel', label: c('templateTabLibrary') },
              { value: 'manage', id: 'kb-template-tab-manage', panelId: 'kb-template-panel', label: c('templateTabManage') },
            ]}
            label={c('templateTitle')}
            onChange={(next) => { setTab(next); setDraft(undefined); setNotice(undefined) }}
          />
          <Input
            value={term}
            placeholder={c('templateSearch')}
            aria-label={c('templateSearch')}
            onChange={(event) => { setTerm(event.target.value) }}
          />
        </div>

        <div className={styles.filterRow}>
          <div className={styles.quickFilters} role="group" aria-label="模板筛选">
            {([
              ['all', '全部模板'],
              ['favorite', '收藏'],
              ['recent', '最近使用'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={styles.quickFilter}
                data-active={quickFilter === value ? 'true' : 'false'}
                onClick={() => { setQuickFilter(value) }}
              >
                {label}
              </button>
            ))}
          </div>
          <span className={styles.filterDivider} aria-hidden="true" />
          <div className={styles.categoryFilters} role="group" aria-label="模板分类">
            <button
              type="button"
              className={styles.categoryChip}
              data-active={categoryFilter === '' ? 'true' : 'false'}
              onClick={() => { setCategoryFilter('') }}
            >全部分类</button>
            {categories.map(category => (
              <button
                key={category}
                type="button"
                className={styles.categoryChip}
                data-active={categoryFilter === category ? 'true' : 'false'}
                onClick={() => { setCategoryFilter(category) }}
              >{category}</button>
            ))}
          </div>
        </div>

        {notice !== undefined && <p className={styles.notice} role="status">{notice}</p>}

        {tab === 'library' && (
          <div className={styles.library}>
            {state === 'loading' && <p className={styles.muted}>{c('templateLoading')}</p>}
            {state === 'unavailable' && (
              <p className={styles.muted}>
                {readError === undefined
                  ? c('templateUnavailable')
                  : c('templateUnavailableReason').replace('{reason}', readError)}
              </p>
            )}
            {visible.length === 0 && state !== 'loading' && (
              <p className={styles.muted}>{term.trim() === '' && quickFilter === 'all' ? c('templateEmpty') : c('templateNoMatch')}</p>
            )}
            {visible.length > 0 && (
              <ul className={styles.grid}>
                {visible.map(template => (
                  <li key={template.id} className={styles.card} data-builtin={template.builtin === true ? 'true' : 'false'}>
                    <div className={styles.cardHead}>
                      <FileTypeIcon path={template.fileName} size={16} />
                      <span className={styles.cardTitle}>{template.title}</span>
                      <button
                        type="button"
                        className={styles.favorite}
                        aria-label={favorites.has(template.id) ? '取消收藏' : '收藏模板'}
                        aria-pressed={favorites.has(template.id)}
                        onClick={() => { toggleFavorite(template.id) }}
                      >
                        {favorites.has(template.id) ? '★' : '☆'}
                      </button>
                    </div>
                    <div className={styles.cover} data-template-kind={templateKind(template)}>
                      <div className={styles.coverPage}>
                        {templateKind(template) === '表格' ? (
                          <div className={styles.sheetGrid} aria-hidden="true">
                            {Array.from({ length: 12 }, (_, index) => <i key={index} />)}
                          </div>
                        ) : templateKind(template) === 'PPT' ? (
                          <div className={styles.slidePage} aria-hidden="true">
                            <b />
                            <i />
                            <i />
                          </div>
                        ) : (
                          <div className={styles.documentPage} aria-hidden="true">
                            <b />
                            <i className={styles.lineWide} />
                            <i />
                            <i className={styles.lineShort} />
                            <i />
                          </div>
                        )}
                      </div>
                    </div>
                    <div className={styles.cardFoot}>
                      <span>{formatUsage(template.usage)}</span>
                      <span>{template.builtin === true ? '系统模板' : '团队模板'}</span>
                    </div>
                    <div className={styles.cardActions}>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { previewTemplate(template) }}>
                        预览
                      </Button>
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => { useTemplate(template) }}>
                        {usingId === template.id ? c('templateUsing') : '使用'}
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'manage' && (
          <div className={styles.manage}>
            {draft === undefined && (
              <>
                <div className={styles.manageBar}>
                  <Button variant="primary" onClick={startAdd}>{c('templateAdd')}</Button>
                </div>
                {rows.length === 0
                  ? <p className={styles.muted}>{c('templateManageEmpty')}</p>
                  : (
                    <ul className={styles.manageList}>
                      {rows.map(template => (
                        <li key={template.id} className={styles.manageRow}>
                          <span className={styles.manageName}>{template.title}</span>
                          <span className={styles.cardMeta}>{template.fileName} · {sizeText(template.bytes)}</span>
                          <span className={styles.manageActions}>
                            <Button variant="ghost" size="sm" onClick={() => { startEdit(template) }}>
                              {c('templateEdit')}
                            </Button>
                            <Button variant="ghost" size="sm" onClick={() => { setConfirming(template) }}>
                              {c('templateRemove')}
                            </Button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
              </>
            )}

            {draft !== undefined && (
              <div className={styles.form}>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateName')}</span>
                  <Input
                    value={draft.title}
                    placeholder={c('templateNamePlaceholder')}
                    aria-label={c('templateName')}
                    onChange={(event) => { setField('title', event.target.value) }}
                    data-modal-autofocus
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateDescription')}</span>
                  <Input
                    value={draft.description}
                    placeholder={c('templateDescriptionPlaceholder')}
                    aria-label={c('templateDescription')}
                    onChange={(event) => { setField('description', event.target.value) }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateCategory')}</span>
                  <Input
                    value={draft.category}
                    placeholder={c('templateCategoryPlaceholder')}
                    aria-label={c('templateCategory')}
                    onChange={(event) => { setField('category', event.target.value) }}
                  />
                </label>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateTags')}</span>
                  <Input
                    value={draft.tags}
                    placeholder={c('templateTagsPlaceholder')}
                    aria-label={c('templateTags')}
                    onChange={(event) => { setField('tags', event.target.value) }}
                  />
                </label>
                <div className={styles.field}>
                  <span className={styles.fieldLabel}>{c('templateDocument')}</span>
                  <input
                    type="file"
                    accept=".md,.markdown,.txt,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.rtf,.odt,.ods,.odp"
                    className={styles.fileInput}
                    onChange={chooseFile}
                  />
                  {draft.fileName !== '' && (
                    <span className={styles.fieldHint}>
                      {draft.id === undefined
                        ? c('templateFileChosen').replace('{name}', draft.fileName)
                        : c('templateFileKept').replace('{name}', draft.fileName)}
                    </span>
                  )}
                </div>
                <div className={styles.formActions}>
                  <Button variant="ghost" onClick={() => { setDraft(undefined) }}>{c('cancel')}</Button>
                  <Button variant="primary" disabled={busy} onClick={saveDraft}>
                    {busy ? c('templateSaving') : c('templateSave')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <Modal
        open={previewing !== undefined}
        onClose={() => { setPreviewing(undefined) }}
        title={previewing?.template.title ?? ''}
        closeLabel={c('templateClose')}
        className={styles.previewModal}
        footer={(
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => { setPreviewing(undefined) }}>{c('templateClose')}</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (previewing !== undefined) {
                  const template = previewing.template
                  setPreviewing(undefined)
                  useTemplate(template)
                }
              }}
            >使用</Button>
          </div>
        )}
      >
        <pre className={styles.previewContent}>{previewing?.content}</pre>
      </Modal>

      {/* Removing is destructive and irreversible from this surface, so it asks. */}
      <Modal
        open={confirming !== undefined}
        onClose={() => { setConfirming(undefined) }}
        title={c('templateRemoveTitle')}
        closeLabel={c('cancel')}
        description={c('templateRemoveBody').replace('{name}', confirming?.title ?? '')}
        footer={(
          <div className={styles.footer}>
            <Button variant="ghost" onClick={() => { setConfirming(undefined) }}>{c('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={removeConfirmed}>{c('templateRemove')}</Button>
          </div>
        )}
      >
        <span />
      </Modal>
    </Modal>
  )
}
