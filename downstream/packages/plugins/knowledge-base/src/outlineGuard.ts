/**
 * Grounding checks for model-written document summaries.
 *
 * Uploading and extraction never create prose. A summary only enters the index when the
 * knowledge-base summarize flow has read the original chunks and the model submits it through
 * `kb_outline_save`; this module is the gate between that submission and the database.
 *
 * The gate is deliberately mechanical. It does not judge whether a sentence is a good
 * summary, because that is the model's job. It refuses a submission whose numbers,
 * ratios, clause numbers or responsible bodies cannot be found in the source chunks the
 * summary claims to describe. Normalization is strict but language-aware: full-width
 * digits, Chinese numerals, `5万元`/`50000元`, `百分之三十`/`30%` and `第三条`/`第3条`
 * all collapse to one token before comparison.
 *
 * @module @sparkelf/dsh-knowledge-base/outlineGuard
 */

import type { OutlineKeyFact, OutlineSection } from './outlineText.ts'

/** How a document's current summary was produced. */
export type OutlineSummaryKind = 'none' | 'extractive' | 'llm'

/** One key fact as a model submits it. `value` is the source-grounded claim. */
export interface OutlineKeyFactSubmission {
  /** Article heading or label; defaults to the section title. */
  fact?: string
  /** Threshold/ratio/body/exception sentence copied from the source. */
  value: string
  /** Chunk the value came from; must belong to the document and the section. */
  chunkId?: number
}

/** One section summary as a model submits it. */
export interface OutlineSectionSubmission {
  sectionId: string
  /** Full heading path from `kb_outline`; a mismatch is refused rather than renamed. */
  headingPath?: string
  summary?: string
  keyFacts?: Array<string | OutlineKeyFactSubmission>
  /** Chunks the summary was written from; must be a subset of the section's chunks. */
  sourceChunkIds?: number[]
}

/** One refused field. The caller can show this to the model and retry. */
export interface OutlineSaveRejection {
  /** Dotted path within the submission, e.g. `sections[2].summary`. */
  field: string
  reason: string
  sectionId?: string
  /** Bounded copy of the offending value, when one exists. */
  value?: string
  /** Tokens/subjects that could not be found in the source chunks. */
  missing?: string[]
}

/** A named section, as stored in `kb_sections`. */
export type StoredOutlineSection = Pick<
  OutlineSection,
  'sectionId' | 'headingPath' | 'title' | 'level' | 'summary' | 'keyFacts' | 'chunkIds' | 'sourceChunkIds'
>

/** One chunk the gate may ground a claim against. */
export interface GroundingChunk {
  id: number
  content: string
}

/** The complete, validated row set to persist. */
export interface OutlineSavePlan {
  summary: string
  /** Source chunks behind the document summary. */
  docSourceChunkIds: number[]
  /** Every section row, with submitted summaries replacing the stored ones. */
  sections: StoredOutlineSection[]
  keyFactCount: number
}

/** Result of planning one save: either a plan, or the fields that were refused. */
export type OutlineSavePlanResult =
  | { ok: true; plan: OutlineSavePlan }
  | { ok: false; rejected: OutlineSaveRejection[] }

/** Maximum document summary length accepted from a model. */
export const MAX_DOC_SUMMARY_CHARS = 4_000

/** Maximum one section summary length accepted from a model. */
export const MAX_SECTION_SUMMARY_CHARS = 2_000

/** Maximum key facts one section may carry. */
export const MAX_KEY_FACTS_PER_SECTION = 20

/** Maximum sections one save may carry. */
export const MAX_SUBMITTED_SECTIONS = 500

const NUMBER_UNIT = '(亿元|万元|个工作日|个月|元|%|天|日|年|人|票|次|章|节|条|款|项|倍|分)'
const CHINESE_NUMBER = '[一二三四五六七八九十百千万亿零〇两]'
const CLAUSE_PATTERN = /第\s*([一二三四五六七八九十百千万亿零〇两\d]+)\s*([章节条款项])/gu
const PERCENT_PATTERN = new RegExp(`百分之\\s*(${CHINESE_NUMBER}+|\\d+(?:\\.\\d+)?)`, 'gu')
const RATIO_PATTERN = new RegExp(`(${CHINESE_NUMBER}+)\\s*分之\\s*(${CHINESE_NUMBER}+|\\d+(?:\\.\\d+)?)`, 'gu')
const CHINESE_UNIT_PATTERN = new RegExp(`(${CHINESE_NUMBER}+)\\s*${NUMBER_UNIT}`, 'gu')
const ARABIC_UNIT_PATTERN = new RegExp(`(\\d+(?:[.,]\\d+)*)\\s*${NUMBER_UNIT}?`, 'gu')
const ARABIC_FRACTION_PATTERN = /(\d+(?:\.\d+)?)\s*[/:：]\s*(\d+(?:\.\d+)?)/gu

const DIGIT: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5,
  六: 6, 七: 7, 八: 8, 九: 9,
}

const SMALL_UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 }
const BIG_UNIT: Record<string, number> = { 万: 10_000, 亿: 100_000_000 }

/**
 * Collapse presentation differences that do not change a claim.
 *
 * Used for source/claim comparison, never for display: the stored summary keeps the
 * model's original wording (including Chinese numerals and full-width punctuation).
 */
export function normalizeOutlineGrounding(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[，﹐]/gu, ',')
    .replace(/[％﹪]/gu, '%')
    .replace(/[／]/gu, '/')
    .replace(/[．]/gu, '.')
    .replace(/[\s\u3000]+/gu, '')
    .replace(/[\u201c\u201d\u2018\u2019"'`]/gu, '')
    .replace(/[。；;：:！？!?、,，]/gu, '')
    .replace(/[（）()【】\[\]《》<>]/gu, '')
    .toLowerCase()
}

/** Convert a Chinese numeral (or digit string) to a number. */
export function chineseNumberToArabic(raw: string): number | undefined {
  const value = raw.trim()
  if (value === '') return undefined
  if (/^\d+(?:\.\d+)?$/u.test(value)) return Number(value)
  if ([...value].every(character => DIGIT[character] !== undefined)) {
    const digits = [...value].map(character => String(DIGIT[character]!)).join('')
    return Number(digits)
  }
  let total = 0
  let section = 0
  let number = 0
  let sawAnything = false
  for (const character of value) {
    const digit = DIGIT[character]
    if (digit !== undefined) {
      number = digit
      sawAnything = true
      continue
    }
    const small = SMALL_UNIT[character]
    if (small !== undefined) {
      section += (number === 0 ? 1 : number) * small
      number = 0
      sawAnything = true
      continue
    }
    const big = BIG_UNIT[character]
    if (big !== undefined) {
      section += number
      total += (section === 0 ? 1 : section) * big
      section = 0
      number = 0
      sawAnything = true
      continue
    }
    return undefined
  }
  if (!sawAnything) return undefined
  return total + section + number
}

/** Render a number without floating-point noise or a trailing `.0`. */
function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  const rounded = Number(value.toFixed(6))
  return Number.isInteger(rounded) ? String(rounded) : String(rounded)
}

/** Canonical token for one amount/ratio/date count. */
function canonicalNumber(raw: string, unit: string | undefined): string {
  const normalized = raw.replace(/[,\s]/gu, '')
  const number = /^\d+(?:\.\d+)?$/u.test(normalized)
    ? Number(normalized)
    : chineseNumberToArabic(normalized)
  if (number === undefined || !Number.isFinite(number)) return `${normalized}${unit ?? ''}`
  if (unit === undefined || unit === '') return formatNumber(number)
  if (unit === '%') return `${formatNumber(number)}%`
  if (unit === '万元') return `${formatNumber(number * 10_000)}元`
  if (unit === '亿元') return `${formatNumber(number * 100_000_000)}元`
  return `${formatNumber(number)}${unit}`
}

/**
 * Extract the tokens a claim must share with its source.
 *
 * Tokens cover just the auditable classes: Arabic/Chinese numbers, percentages, Chinese
 * fractions, ratios, clause numbers and common amounts. Ordinary prose is deliberately
 * not tokenized, because a summary is allowed to paraphrase it.
 */
export function extractGroundingTokens(value: string): string[] {
  const text = value.normalize('NFKC')
  const tokens = new Set<string>()
  for (const match of text.matchAll(CLAUSE_PATTERN)) {
    const number = chineseNumberToArabic(match[1]!)
    if (number !== undefined) tokens.add(`第${formatNumber(number)}${match[2]!}`)
  }
  for (const match of text.matchAll(PERCENT_PATTERN)) {
    const number = /^\d/u.test(match[1]!) ? Number(match[1]) : chineseNumberToArabic(match[1]!)
    if (number !== undefined) tokens.add(`${formatNumber(number)}%`)
  }
  for (const match of text.matchAll(RATIO_PATTERN)) {
    const denominator = chineseNumberToArabic(match[1]!)
    const numerator = /^\d/u.test(match[2]!) ? Number(match[2]) : chineseNumberToArabic(match[2]!)
    if (denominator !== undefined && numerator !== undefined && denominator !== 0) {
      tokens.add(`${formatNumber(numerator)}/${formatNumber(denominator)}`)
    }
  }
  for (const match of text.matchAll(ARABIC_FRACTION_PATTERN)) {
    const numerator = Number(match[1])
    const denominator = Number(match[2])
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) {
      tokens.add(`${formatNumber(numerator)}/${formatNumber(denominator)}`)
    }
  }
  for (const match of text.matchAll(CHINESE_UNIT_PATTERN)) {
    tokens.add(canonicalNumber(match[1]!, match[2]))
  }
  for (const match of text.matchAll(ARABIC_UNIT_PATTERN)) {
    tokens.add(canonicalNumber(match[1]!, match[2]))
  }
  return [...tokens]
}

/**
 * Responsible bodies and actors that must not be invented.
 *
 * Kept as a finite vocabulary rather than a general NER pass: the gate only needs to
 * catch the failure mode an LLM summary actually has -- naming a board, committee,
 * department or role that the source never mentions.
 */
const SUBJECT_TERMS = [
  '股东大会', '董事会', '监事会', '党委会', '经营班子', '管理层', '委员会',
  '总经理', '副总经理', '董事长', '副董事长', '监事长', '负责人', '上级主管部门',
  '监管机构', '监管局', '税务局', '工商局', '人民法院', '仲裁机构', '人民政府',
  '职工代表大会', '工会', '纪委', '派驻纪检组', '办公室', '财务部', '人力资源部',
  '审计部', '法务部', '合规部', '信息部', '科技部', '业务部', '战略部', '市场部',
  '运营部', '采购部', '销售部', '分公司', '子公司', '公司', '集团', '部门',
  '董事', '监事', '员工', '客户', '供应商',
] as const

const SUBJECT_PATTERN = new RegExp(SUBJECT_TERMS.join('|'), 'gu')

/** Extract responsible-body terms from one claim. */
export function extractSubjectTerms(value: string): string[] {
  const found = new Set<string>()
  for (const match of value.normalize('NFKC').matchAll(SUBJECT_PATTERN)) found.add(match[0])
  return [...found]
}

/** Bounded display copy of an offending value. */
function preview(value: string): string {
  return value.length <= 160 ? value : `${value.slice(0, 159)}…`
}

function rejection(field: string, reason: string, extra: Partial<OutlineSaveRejection> = {}): OutlineSaveRejection {
  return { field, reason, ...extra }
}

function checkClaim(
  claim: string,
  groundingChunks: readonly GroundingChunk[],
  subjectChunks: readonly GroundingChunk[],
): { missingNumbers: string[]; missingSubjects: string[] } {
  const source = groundingChunks.map(chunk => chunk.content).join('\n')
  const sourceTokens = new Set(extractGroundingTokens(source))
  const missingNumbers = extractGroundingTokens(claim).filter(token => !sourceTokens.has(token))
  const subjectSource = normalizeOutlineGrounding(subjectChunks.map(chunk => chunk.content).join('\n'))
  const sourceSubjects = new Set(extractSubjectTerms(subjectSource))
  const missingSubjects = extractSubjectTerms(normalizeOutlineGrounding(claim))
    .filter(subject => !sourceSubjects.has(subject))
  return { missingNumbers, missingSubjects }
}

/** Validate one submitted field and append refusals. */
function checkField(
  field: string,
  value: string,
  groundingChunks: readonly GroundingChunk[],
  subjectChunks: readonly GroundingChunk[],
  rejected: OutlineSaveRejection[],
  sectionId?: string,
): void {
  if (value.trim() === '') return
  const { missingNumbers, missingSubjects } = checkClaim(value, groundingChunks, subjectChunks)
  if (missingNumbers.length > 0) {
    rejected.push(rejection(field, `数字/比例/条款号在 source chunks 中找不到：${missingNumbers.join('、')}`, {
      ...(sectionId === undefined ? {} : { sectionId }),
      value: preview(value),
      missing: missingNumbers,
    }))
  }
  if (missingSubjects.length > 0) {
    rejected.push(rejection(field, `主体在 source chunks 中找不到：${missingSubjects.join('、')}`, {
      ...(sectionId === undefined ? {} : { sectionId }),
      value: preview(value),
      missing: missingSubjects,
    }))
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizeHeadingPath(value: string): string {
  return value.split('>').map(part => part.trim()).filter(part => part !== '').join(' > ')
}

function numberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out: number[] = []
  for (const item of value) {
    const number = typeof item === 'number' ? item : Number(item)
    if (!Number.isInteger(number) || number <= 0) return undefined
    out.push(number)
  }
  return out
}

/** Parse one submitted key fact, or report why it is malformed. */
function keyFactOf(
  value: unknown,
  section: StoredOutlineSection,
  field: string,
  rejected: OutlineSaveRejection[],
): (OutlineKeyFactSubmission & { fact: string }) | undefined {
  if (typeof value === 'string') {
    const text = value.trim()
    if (text === '') {
      rejected.push(rejection(field, 'keyFact 不能为空', { sectionId: section.sectionId }))
      return undefined
    }
    return { fact: section.title, value: text }
  }
  if (!isRecord(value)) {
    rejected.push(rejection(field, 'keyFact 必须是字符串或 {fact,value,chunkId} 对象', { sectionId: section.sectionId }))
    return undefined
  }
  const text = typeof value.value === 'string' ? value.value.trim() : ''
  if (text === '') {
    rejected.push(rejection(`${field}.value`, 'keyFact.value 不能为空', { sectionId: section.sectionId }))
    return undefined
  }
  const fact = typeof value.fact === 'string' && value.fact.trim() !== '' ? value.fact.trim() : section.title
  if (value.chunkId !== undefined) {
    const chunkId = typeof value.chunkId === 'number' ? value.chunkId : Number(value.chunkId)
    if (!Number.isInteger(chunkId) || chunkId <= 0) {
      rejected.push(rejection(`${field}.chunkId`, 'chunkId 必须是正整数', { sectionId: section.sectionId, value: String(value.chunkId) }))
      return undefined
    }
    return { fact, value: text, chunkId }
  }
  return { fact, value: text }
}

/** One submitted save request, as the planner sees it. */
export interface OutlineSaveSubmission {
  docId: number
  summary: string
  sections: readonly OutlineSectionSubmission[]
}

/**
 * Validate and assemble the complete row set for one save.
 *
 * Nothing here touches SQLite or the filesystem. A refusal returns every rejected field
 * so the model can repair the whole submission in one retry; a success returns the rows
 * that will be written inside one transaction.
 */
export function planOutlineSave(input: {
  docId: number
  chunks: readonly GroundingChunk[]
  storedSections: readonly StoredOutlineSection[]
  submission: OutlineSaveSubmission
}): OutlineSavePlanResult {
  const rejected: OutlineSaveRejection[] = []
  const chunksById = new Map(input.chunks.map(chunk => [chunk.id, chunk]))
  const sectionsById = new Map(input.storedSections.map(section => [section.sectionId, section]))
  const summary = typeof input.submission.summary === 'string' ? input.submission.summary.trim() : ''
  const submittedSections = Array.isArray(input.submission.sections) ? input.submission.sections : []

  if (summary === '') {
    rejected.push(rejection('summary', '文档摘要不能为空；摘要应由 knowledge-base 技能的摘要流程（references/summarize.md）阅读原文后生成'))
  } else if (summary.length > MAX_DOC_SUMMARY_CHARS) {
    rejected.push(rejection('summary', `文档摘要超过 ${String(MAX_DOC_SUMMARY_CHARS)} 字符`, { value: preview(summary) }))
  } else if (input.chunks.length === 0) {
    rejected.push(rejection('summary', '文档没有可读 chunk，不能生成摘要'))
  }
  if (submittedSections.length > MAX_SUBMITTED_SECTIONS) {
    rejected.push(rejection('sections', `一次最多提交 ${String(MAX_SUBMITTED_SECTIONS)} 个章节`))
  }

  const updates = new Map<string, { summary: string; keyFacts: OutlineKeyFact[]; sourceChunkIds: number[] }>()
  let keyFactCount = 0

  for (const [index, raw] of submittedSections.entries()) {
    const field = `sections[${String(index)}]`
    if (!isRecord(raw)) {
      rejected.push(rejection(field, 'section 必须是对象'))
      continue
    }
    const sectionId = typeof raw.sectionId === 'string' ? raw.sectionId.trim() : ''
    if (sectionId === '') {
      rejected.push(rejection(`${field}.sectionId`, 'sectionId 不能为空'))
      continue
    }
    if (updates.has(sectionId)) {
      rejected.push(rejection(`${field}.sectionId`, '同一 sectionId 重复提交', { sectionId }))
      continue
    }
    const stored = sectionsById.get(sectionId)
    if (stored === undefined) {
      rejected.push(rejection(`${field}.sectionId`, 'sectionId 不属于该文档', { sectionId, value: sectionId }))
      continue
    }
    if (typeof raw.headingPath === 'string' && normalizeHeadingPath(raw.headingPath) !== normalizeHeadingPath(stored.headingPath)) {
      rejected.push(rejection(`${field}.headingPath`, 'headingPath 与文档目录不一致', {
        sectionId,
        value: preview(raw.headingPath),
      }))
      continue
    }

    const sectionSummary = typeof raw.summary === 'string' ? raw.summary.trim() : ''
    if (sectionSummary.length > MAX_SECTION_SUMMARY_CHARS) {
      rejected.push(rejection(`${field}.summary`, `章节摘要超过 ${String(MAX_SECTION_SUMMARY_CHARS)} 字符`, {
        sectionId,
        value: preview(sectionSummary),
      }))
      continue
    }

    let sourceChunkIds = stored.sourceChunkIds
    if (raw.sourceChunkIds !== undefined) {
      const parsed = numberArray(raw.sourceChunkIds)
      if (parsed === undefined) {
        rejected.push(rejection(`${field}.sourceChunkIds`, 'sourceChunkIds 必须是正整数数组', { sectionId }))
        continue
      }
      const notInDoc = parsed.filter(id => !chunksById.has(id))
      if (notInDoc.length > 0) {
        rejected.push(rejection(`${field}.sourceChunkIds`, `chunkId 不属于该文档：${notInDoc.join(', ')}`, {
          sectionId,
          missing: notInDoc.map(String),
        }))
        continue
      }
      const notInSection = parsed.filter(id => !stored.sourceChunkIds.includes(id))
      if (notInSection.length > 0) {
        rejected.push(rejection(`${field}.sourceChunkIds`, `chunkId 不属于该章节：${notInSection.join(', ')}`, {
          sectionId,
          missing: notInSection.map(String),
        }))
        continue
      }
      sourceChunkIds = parsed
    }
    const groundingChunks = sourceChunkIds
      .map(id => chunksById.get(id))
      .filter((chunk): chunk is GroundingChunk => chunk !== undefined)
    if (sectionSummary !== '' && groundingChunks.length === 0) {
      rejected.push(rejection(`${field}.summary`, '该章节没有可用于校验的 source chunk', { sectionId }))
      continue
    }
    checkField(`${field}.summary`, sectionSummary, groundingChunks, input.chunks, rejected, sectionId)

    const rawFacts = raw.keyFacts
    if (rawFacts !== undefined && !Array.isArray(rawFacts)) {
      rejected.push(rejection(`${field}.keyFacts`, 'keyFacts 必须是数组', { sectionId }))
      continue
    }
    const facts = Array.isArray(rawFacts) ? rawFacts : []
    if (facts.length > MAX_KEY_FACTS_PER_SECTION) {
      rejected.push(rejection(`${field}.keyFacts`, `每节最多 ${String(MAX_KEY_FACTS_PER_SECTION)} 条 keyFacts`, { sectionId }))
      continue
    }
    const plannedFacts: OutlineKeyFact[] = []
    for (const [factIndex, rawFact] of facts.entries()) {
      const factField = `${field}.keyFacts[${String(factIndex)}]`
      const parsed = keyFactOf(rawFact, stored, factField, rejected)
      if (parsed === undefined) continue
      let grounding: GroundingChunk[]
      if (parsed.chunkId !== undefined) {
        if (!chunksById.has(parsed.chunkId)) {
          rejected.push(rejection(`${factField}.chunkId`, 'chunkId 不属于该文档', {
            sectionId,
            value: String(parsed.chunkId),
          }))
          continue
        }
        if (!sourceChunkIds.includes(parsed.chunkId)) {
          rejected.push(rejection(`${factField}.chunkId`, 'chunkId 不属于该章节', {
            sectionId,
            value: String(parsed.chunkId),
          }))
          continue
        }
        grounding = [chunksById.get(parsed.chunkId)!]
      } else {
        grounding = groundingChunks
      }
      checkField(`${factField}.value`, parsed.value, grounding, input.chunks, rejected, sectionId)
      // The fact label is navigation (an article marker or the section title), so it may
      // live anywhere in the document; the value is the claim that must be grounded in
      // the chunk it cites.
      checkField(`${factField}.fact`, parsed.fact, input.chunks, input.chunks, rejected, sectionId)
      // A key fact always records one concrete chunk. Prefer the submitted/declared one,
      // otherwise the first chunk that contains every auditable token of the value.
      const valueTokens = extractGroundingTokens(parsed.value)
      const preferred = parsed.chunkId ?? sourceChunkIds.find(id => {
        const content = chunksById.get(id)?.content ?? ''
        const available = new Set(extractGroundingTokens(content))
        return valueTokens.every(token => available.has(token))
      }) ?? sourceChunkIds[0]
      if (preferred === undefined) {
        rejected.push(rejection(`${factField}.value`, '该章节没有可用于标注来源的 chunk', { sectionId }))
        continue
      }
      plannedFacts.push({ fact: parsed.fact, value: parsed.value, chunkId: preferred })
    }
    keyFactCount += plannedFacts.length
    updates.set(sectionId, { summary: sectionSummary, keyFacts: plannedFacts, sourceChunkIds })
  }

  checkField('summary', summary, input.chunks, input.chunks, rejected)

  if (rejected.length > 0) return { ok: false, rejected }

  // Sections the model did not mention keep their heading structure but lose any old
  // summary: one explicit save makes the whole document's summary kind `llm`, so a stale
  // extractive paragraph must not survive underneath it.
  const sections: StoredOutlineSection[] = input.storedSections.map(section => {
    const update = updates.get(section.sectionId)
    return update === undefined
      ? { ...section, summary: '', keyFacts: [], sourceChunkIds: [...section.sourceChunkIds] }
      : { ...section, summary: update.summary, keyFacts: update.keyFacts, sourceChunkIds: update.sourceChunkIds }
  })
  const docSourceChunkIds = [...new Set(
    sections
      .filter(section => updates.has(section.sectionId))
      .flatMap(section => section.sourceChunkIds),
  )].sort((left, right) => left - right)
  return {
    ok: true,
    plan: {
      summary,
      docSourceChunkIds: docSourceChunkIds.length > 0 ? docSourceChunkIds : input.chunks.map(chunk => chunk.id),
      sections,
      keyFactCount,
    },
  }
}
