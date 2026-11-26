/**
 * Deterministic document outline extraction for the knowledge-base index.
 *
 * The outline is navigation, never evidence. `summary-v1` copied the first sentence of each
 * chapter, which made the INDEX.md read like a pile of raw paragraphs. `summary-v2` still
 * uses no language model: it ranks whole source sentences by legal cues (obligation, ratio,
 * amount, deadline, article opener), keeps 2–4 of them per chapter, and composes the
 * document summary from those chapter summaries instead of from the first paragraph.
 *
 * Two readability-only normalizations are applied: docx/PDF extraction spaces inside a
 * Chinese word are removed (`二分 之一` → `二分之一`), and the canonical `“以上”包括本数`
 * wording is compacted to `“以上含本数”`. Every number, subject and exception still comes
 * from a source sentence; key facts remain verbatim apart from the article-label prefix.
 *
 * `structure-v3` already keeps headings as hard chunk boundaries. This module reconstructs
 * the heading tree from the leading heading lines of each chunk and turns the chunks under a
 * node into an extractive summary plus the numeric/exception sentences (`key_facts`) an
 * operator looks for first.
 *
 * @module @sparkelf/dsh-knowledge-base/outlineText
 */

/** Version of the extraction rules; bump when the summary shape changes. */
export const SUMMARY_VERSION = 'summary-v2'

/** How many summary sections a document outline keeps in its table of contents. */
export const OUTLINE_MAX_SECTIONS = 500

/** One indexed chunk, already ordered by its zero-based ordinal. */
export interface OutlineChunk {
  id: number
  /** Stable citation key when the index has one. */
  chunkKey?: string
  ordinal: number
  /** First line of the chunk, as stored by the indexer. */
  heading?: string
  content: string
}

/** One verbatim sentence that carries a threshold, ratio, body or exception. */
export interface OutlineKeyFact {
  /** Article heading or nearest heading label; never generated prose. */
  fact: string
  /** The source sentence, verbatim (bounded). */
  value: string
  chunkId: number
}

/** One heading node and the chunks below it. */
export interface OutlineSection {
  /** Document-scoped stable id (`s<docId>-<n>`). */
  sectionId: string
  /** Full path: `第一章 总则 > 第一条 ...`. */
  headingPath: string
  /** This node's own heading text. */
  title: string
  /** 1-based depth; 1 is a chapter/top-level heading. */
  level: number
  /** Extractive summary; 80–200 characters for a chapter when the source allows it. */
  summary: string
  keyFacts: OutlineKeyFact[]
  /** Chunks whose own heading is this node. */
  chunkIds: number[]
  /** Every chunk under this node, including descendants. */
  sourceChunkIds: number[]
  parentId?: string
}

/** One table-of-contents row. `sections` carries the full heading path and summaries. */
export interface OutlineTocEntry {
  sectionId: string
  title: string
  level: number
  /** Chunks whose own heading is this node. */
  chunkIds: number[]
}

/** Everything one document outline produces. */
export interface BuiltOutline {
  /** `#` title when the text has one, otherwise the filename. */
  documentTitle: string
  /** Document-level summary, 200–300 characters when the source allows it. */
  summary: string
  /** Chunks whose sentences were used by the document summary. */
  sourceChunkIds: number[]
  toc: OutlineTocEntry[]
  sections: OutlineSection[]
}

/** Input for {@link buildDocumentOutline}. */
export interface BuildOutlineInput {
  docId: number
  /** Filename (or stored title), used when the text has no `#` title. */
  docTitle: string
  /** Original source path, shown in INDEX.md. */
  sourcePath: string
  chunks: readonly OutlineChunk[]
}

interface HeadingLine {
  title: string
  /** Heading depth before tree clamping. */
  rawLevel: number
  kind: 'markdown' | 'chapter' | 'section' | 'article' | 'chinese'
}

interface SectionNode {
  title: string
  level: number
  /** Heading depth before tree clamping; siblings compare their raw depth, not the clamped level. */
  rawLevel: number
  parent?: SectionNode
  children: SectionNode[]
  chunkIds: number[]
  sourceChunkIds: number[]
  index: number
}

interface Sentence {
  text: string
  chunkId: number
  ordinal: number
  position: number
  /** Article label inherited across continuation chunks (`第六条` followed by a body-only chunk). */
  article?: string
}

const MARKDOWN_HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/u
const CHAPTER_HEADING = /^第[一二三四五六七八九十百零〇\d]+章/u
const SECTION_HEADING = /^第[一二三四五六七八九十百零〇\d]+节/u
const ARTICLE_HEADING = /^第[一二三四五六七八九十百零〇\d]+条/u
const ARTICLE_LABEL = /^第[一二三四五六七八九十百零〇\d]+条/u
const ARTICLE_TITLE = /^第[一二三四五六七八九十百零〇\d]+条$/u
const CHINESE_HEADING = /^[一二三四五六七八九十百]+、/u
const TABLE_RULE = /^\|?[\s:|-]+\|[\s:|-]*$/u

/** Cues an operator scans for in a regulation: obligation, ratio, deadline, amount, exception. */
const SUMMARY_KEYWORD = /应当|不得|必须|负责|决定|审议|批准|超过|不足|三分之二|二分之一|过半数|半数以上|工作日|万元|亿元|%|％|以上|本数|回避|适用|通知|表决|通过/gu
const DEFINITION_PATTERN = /(?:所称|是指|指的是|系指|包括以下|分为|适用于|适用范围|职责|权限|程序|负责|行使职权)/u
const NUMERIC_PATTERN = /(?:\d+(?:\.\d+)?\s*(?:%|％|万元|亿元|元|天|日|个工作日|工作日|个月|年|人|票|次|倍)|[一二三四五六七八九十百千两]+(?:个)?(?:万元|亿元|元|天|日|个工作日|工作日|个月|年|人|票|次|倍)|三分之二|二分之一|过半数|半数以上)/u
const DUTY_PATTERN = /(?:董事会|监事会|经营班子会?|班子成员?|董事|监事|总经理|董事长|委员会|部门|负责人|综合管理部|财务部门|法务机构|经理层|分管领导)[^，。；]{0,40}(?:负责|决定|审议|批准|召集|主持|组织实施|解释|修订|承担|回避)/u
const KEY_FACT_PATTERN = /(?:以上.*本数|本数)/u
const KEY_FACT_MAX_LENGTH = 100

/** Classify one trimmed line as a heading, or return undefined. */
export function headingLineOf(line: string): HeadingLine | undefined {
  const value = line.trim()
  if (value === '') return undefined
  const markdown = MARKDOWN_HEADING.exec(value)
  if (markdown !== null) {
    return { title: markdown[2]!.trim(), rawLevel: markdown[1]!.length, kind: 'markdown' }
  }
  if (CHAPTER_HEADING.test(value)) return { title: value.slice(0, 120), rawLevel: 1, kind: 'chapter' }
  if (SECTION_HEADING.test(value)) return { title: value.slice(0, 120), rawLevel: 2, kind: 'section' }
  if (ARTICLE_HEADING.test(value)) {
    // `第X条` is the section label; the rest of the line is the article body and must not
    // become a heading in the table of contents.
    const marker = ARTICLE_LABEL.exec(value)?.[0]
    return { title: marker ?? value.slice(0, 120), rawLevel: 3, kind: 'article' }
  }
  if (CHINESE_HEADING.test(value)) return { title: value.slice(0, 120), rawLevel: 2, kind: 'chinese' }
  return undefined
}

/**
 * Remove the spaces docx/PDF extraction leaves inside Chinese words.
 *
 * `二分 之一` must rank and print as `二分之一`; a space between two Chinese characters is
 * never significant. Spaces between Latin words are preserved.
 */
function normalizeCjkSpacing(value: string): string {
  return value
    .replace(/(?<=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])\s+(?=[^\s])/gu, '')
    .replace(/(?<=[^\s])\s+(?=[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff])/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Collapse Markdown/table syntax into plain prose, keeping numbers and punctuation. */
export function plainOutlineText(value: string): string {
  return normalizeCjkSpacing(value
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/^\s*\|/gmu, '')
    .replace(/\|\s*$/gmu, '')
    .replace(/\|/gu, ' ')
    .replace(/[*_`~]/gu, '')
    .trim())
}

/** True for a chapter/section title, not a policy sentence. */
function isStructuralHeading(text: string): boolean {
  const compact = text.replace(/[\s。；，、：:]/gu, '')
  return (CHAPTER_HEADING.test(compact) || SECTION_HEADING.test(compact)) && compact.length <= 28
}

/** Split one chunk into non-heading, non-rule sentences. */
export function sentencesOfChunk(chunk: OutlineChunk): Sentence[] {
  const out: Sentence[] = []
  let position = 0
  let buffer: string[] = []
  const flush = (): void => {
    if (buffer.length === 0) return
    // PDF/docx extraction wraps one paragraph over several lines. Join the lines before
    // splitting on sentence punctuation, otherwise a wrap leaves halves like
    // `…对会议文件和会` + `议审议的内容…` in the summary.
    const plain = plainOutlineText(buffer.join(' '))
    buffer = []
    if (plain === '' || plain.length < 6) return
    for (const part of plain.split(/(?<=[。！？!?；;])\s*/u)) {
      const text = part.trim()
      if (text.length < 6) continue
      // A bare article heading ("第十五条") is structure, not a claim.
      if (text.length < 14 && ARTICLE_TITLE.test(text)) continue
      if (isStructuralHeading(text)) continue
      out.push({ text, chunkId: chunk.id, ordinal: chunk.ordinal, position })
      position += 1
    }
  }
  for (const rawLine of chunk.content.split('\n')) {
    const trimmed = rawLine.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('<!--')) {
      flush()
      continue
    }
    if (TABLE_RULE.test(trimmed)) {
      flush()
      continue
    }
    const heading = headingLineOf(trimmed)
    // Chapter/section titles are structure. An article heading line usually carries its
    // body too (`第十五条 会议审议事项…`), so it stays in the paragraph buffer.
    if (heading !== undefined && heading.kind !== 'article') {
      flush()
      continue
    }
    // Chunking drops blank lines between list items but keeps line wraps. A numbered item
    // or a new article starts a new sentence; other lines may be a wrapped continuation.
    if (heading !== undefined || /^[（(][一二三四五六七八九十百零〇\d]+[）)]/u.test(trimmed)) flush()
    buffer.push(trimmed)
    if (/[。！？；;：:][”’）)]?$/u.test(trimmed)) flush()
  }
  flush()
  return out
}

/** The article a chunk opens, if any; continuation chunks return undefined and inherit. */
function articleLabelForChunk(chunk: OutlineChunk): string | undefined {
  for (const rawLine of chunk.content.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue
    const article = ARTICLE_LABEL.exec(line)?.[0]
    if (article !== undefined) return article
    if (headingLineOf(line) !== undefined) continue
    break
  }
  return undefined
}

/** Sentences for a run of chunks, carrying the article label across continuation chunks. */
function sentencesForChunks(chunks: readonly OutlineChunk[]): Sentence[] {
  const out: Sentence[] = []
  let currentArticle: string | undefined
  for (const chunk of chunks) {
    const label = articleLabelForChunk(chunk)
    if (label !== undefined) currentArticle = label
    for (const sentence of sentencesOfChunk(chunk)) {
      out.push(currentArticle === undefined ? sentence : { ...sentence, article: currentArticle })
    }
  }
  return out
}

/** Normalize a sentence/heading for dedupe and heading comparison. */
function normalizeKey(value: string): string {
  return plainOutlineText(value).replace(/[。；，、：:\s]/gu, '')
}

/** Headings that must not be promoted to a summary sentence or key fact. */
function headingKeysFor(chunks: readonly OutlineChunk[], node: SectionNode): Set<string> {
  const keys = new Set<string>()
  const add = (value: string): void => {
    const key = normalizeKey(value)
    if (key !== '') keys.add(key)
  }
  add(node.title)
  for (const chunk of chunks) {
    for (const rawLine of chunk.content.split('\n')) {
      const heading = headingLineOf(rawLine.trim())
      if (heading !== undefined) add(heading.title)
    }
  }
  return keys
}

/** Strip the article number from a sentence so a chapter summary reads as prose. */
function displaySentence(sentence: Sentence): string {
  let text = sentence.text.trim()
  if (sentence.article !== undefined && text.startsWith(sentence.article)) {
    text = text.slice(sentence.article.length).trim()
  }
  return text
}

/** Count distinct legal cues; repeated words must not dominate the score. */
function keywordHits(text: string): number {
  const matches = text.match(SUMMARY_KEYWORD)
  return matches === null ? 0 : new Set(matches).size
}

/** Rank a sentence for an extractive summary; ties keep source order. */
function sentenceScore(sentence: Sentence, total: number, headingKeys: Set<string>): number {
  const display = displaySentence(sentence)
  if (display.length < 6) return Number.NEGATIVE_INFINITY
  if (headingKeys.has(normalizeKey(display))) return Number.NEGATIVE_INFINITY
  if (isStructuralHeading(display)) return Number.NEGATIVE_INFINITY
  let score = 0
  if (sentence.position === 0) score += 2
  const opener = sentence.article !== undefined && sentence.text.startsWith(sentence.article) && sentence.position === 0
  // A `第X条` opener names the subject of the article even when the rest is a long list.
  if (opener) score += 6
  if (DEFINITION_PATTERN.test(display)) score += 3
  score += Math.min(6, keywordHits(display) * 2)
  if (NUMERIC_PATTERN.test(display)) score += 3
  // Vote/attendance ratios are the first thing a reader opens a rules document for.
  if (/三分之二|二分之一|过半数|半数以上/u.test(display)) score += 4
  if (/以上.*本数|本数/u.test(display)) score += 2
  if (display.length >= 20 && display.length <= 80) score += 2
  else if (display.length <= 140) score += 1
  else if (display.length > 160) score -= 3
  // "事项如下：" is a lead-in, not a standalone summary sentence.
  if (/[：:]$/u.test(display)) score -= 4
  if (sentence.ordinal === 0) score += 1
  score += Math.max(0, 1 - sentence.position / Math.max(1, total))
  return score
}

/** Pick the best 2–4 sentences while avoiding four copies of the same article. */
function pickSummarySentences(sentences: readonly Sentence[], limit: number, headingKeys: Set<string>): Sentence[] {
  const scored = sentences
    .map((sentence, index) => ({ sentence, index, score: sentenceScore(sentence, sentences.length, headingKeys) }))
    .filter(candidate => Number.isFinite(candidate.score))
  // Prefer whole short sentences. A chapter with enough short candidates must not spend
  // its 200 characters on a 190-character purpose paragraph copied from article one.
  const short = scored.filter(candidate => displaySentence(candidate.sentence).length <= 150)
  const whole = short.length >= Math.min(2, limit) ? short : scored
  // "事项如下：" only introduces the list; its items carry the actual content.
  const substantive = whole.filter(candidate => !/[：:]$/u.test(displaySentence(candidate.sentence)))
  const pool = substantive.length >= Math.min(2, limit) ? substantive : whole
  const candidates = pool.sort((left, right) => right.score - left.score || left.index - right.index)
  const selected: typeof candidates = []
  const articleCounts = new Map<string, number>()
  const chunkCounts = new Map<number, number>()
  while (selected.length < limit && candidates.length > 0) {
    let bestIndex = -1
    let bestScore = Number.NEGATIVE_INFINITY
    for (const [index, candidate] of candidates.entries()) {
      const articleKey = candidate.sentence.article ?? `chunk:${String(candidate.sentence.chunkId)}`
      const articleCount = articleCounts.get(articleKey) ?? 0
      if (articleCount >= 2) continue
      const chunkCount = chunkCounts.get(candidate.sentence.chunkId) ?? 0
      const adjusted = candidate.score - articleCount * 1.5 - chunkCount * 0.5
      if (adjusted > bestScore) {
        bestScore = adjusted
        bestIndex = index
      }
    }
    if (bestIndex < 0) break
    const [chosen] = candidates.splice(bestIndex, 1)
    if (chosen === undefined) break
    selected.push(chosen)
    const articleKey = chosen.sentence.article ?? `chunk:${String(chosen.sentence.chunkId)}`
    articleCounts.set(articleKey, (articleCounts.get(articleKey) ?? 0) + 1)
    chunkCounts.set(chosen.sentence.chunkId, (chunkCounts.get(chosen.sentence.chunkId) ?? 0) + 1)
  }
  return selected
    .map(entry => entry.sentence)
    .sort((left, right) => left.ordinal - right.ordinal || left.position - right.position)
}

/** Bound a string without cutting a sentence when a punctuation boundary is close. */
function clipText(value: string, max: number): string {
  if (value.length <= max) return value
  const cut = value.slice(0, max)
  const at = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('；'), cut.lastIndexOf('！'), cut.lastIndexOf('？'))
  if (at >= max * 0.6) return cut.slice(0, at + 1)
  return cut.replace(/[，。；、\s]+$/u, '') + '…'
}

/** End a summary fragment exactly once. */
function terminalSentence(value: string): string {
  let text = value.trim().replace(/[；;]+$/u, '。')
  if (text.endsWith('…')) text = text.slice(0, -1)
  if (text === '') return ''
  return /[。！？]$/u.test(text) ? text : `${text}。`
}

/** Strip the separator punctuation so clauses can be joined with `；`. */
function clauseText(value: string): string {
  return value.trim().replace(/[。；;！？…]+$/u, '')
}

/** Join selected sentences as one readable paragraph. */
function joinSummaryParts(parts: readonly string[]): string {
  const cleaned = parts
    .map(part => part.trim().replace(/[；;]+$/u, '。').replace(/[：:]$/u, '。'))
    .filter(part => part !== '')
  let summary = cleaned.join('')
  if (summary === '') return ''
  if (summary.endsWith('…')) summary = summary.slice(0, -1) + '。'
  if (!/[。！？]$/u.test(summary)) summary += '。'
  return summary
}

/**
 * Compact the canonical definition wording without changing its meaning.
 *
 * The source of doc49 says `“以上”包括本数`; the INDEX uses the shorter legal phrasing
 * `“以上含本数”`. Key facts keep the verbatim sentence for citation checks.
 */
function compactLegalPhrases(value: string): string {
  return value
    .replace(
      /本规则所称[“"]?以上[”"]?\s*包括本数[，,]\s*[“"]?超过[”"]?\s*[“"]?过[”"]?\s*[“"]?不足[”"]?\s*均不包括本数/gu,
      '本规则规定“以上含本数”，“超过”“过”“不足”不含本数',
    )
    .replace(/[“"]?以上[”"]?\s*包括本数/gu, '“以上含本数”')
}

/** Heading label for a key fact: the article label first, then the chunk heading. */
function factLabel(sentence: Sentence, chunk: OutlineChunk, section: SectionNode): string {
  if (sentence.article !== undefined) return sentence.article
  const heading = chunk.heading?.replace(/^#{1,6}\s*/u, '').trim() ?? ''
  if (heading !== '' && !isStructuralHeading(heading)) return clipText(heading, 60)
  return section.title
}

/** A short sentence that carries a number, ratio, deadline or a named body's duty. */
function isKeyFactCandidate(sentence: Sentence, headingKeys: Set<string>): boolean {
  const text = displaySentence(sentence)
  if (text.length < 8 || text.length > KEY_FACT_MAX_LENGTH) return false
  if (headingKeys.has(normalizeKey(text))) return false
  if (isStructuralHeading(text)) return false
  if (/[：:]$/u.test(text)) return false
  return NUMERIC_PATTERN.test(text) || DUTY_PATTERN.test(text) || KEY_FACT_PATTERN.test(text)
}

/** Prefer concrete numbers, then named-body duties, then short sentences. */
function keyFactScore(text: string): number {
  let score = 0
  if (NUMERIC_PATTERN.test(text)) score += 4
  if (DUTY_PATTERN.test(text)) score += 2
  if (KEY_FACT_PATTERN.test(text)) score += 3
  if (/应当|不得|必须/u.test(text)) score += 2
  if (text.length <= 60) score += 2
  else if (text.length <= 90) score += 1
  return score
}

/** Extract short threshold/ratio/body/exception sentences, deduplicated and ranked. */
function keyFactsFor(chunks: readonly OutlineChunk[], section: SectionNode, max: number): OutlineKeyFact[] {
  const sentences = sentencesForChunks(chunks)
  const headingKeys = headingKeysFor(chunks, section)
  const candidates: Array<{ sentence: Sentence; index: number; score: number }> = []
  const seen = new Set<string>()
  for (const [index, sentence] of sentences.entries()) {
    if (!isKeyFactCandidate(sentence, headingKeys)) continue
    const key = normalizeKey(displaySentence(sentence))
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    candidates.push({ sentence, index, score: keyFactScore(displaySentence(sentence)) })
  }
  candidates.sort((left, right) => right.score - left.score || left.index - right.index)
  const facts: OutlineKeyFact[] = []
  for (const candidate of candidates.slice(0, max)) {
    const chunk = chunks.find(item => item.id === candidate.sentence.chunkId)
    if (chunk === undefined) continue
    facts.push({
      fact: factLabel(candidate.sentence, chunk, section),
      value: clipText(displaySentence(candidate.sentence), 180),
      chunkId: candidate.sentence.chunkId,
    })
  }
  return facts
}

/** Restore the article lead when a selected item is only one entry of a list. */
function summaryParts(picked: readonly Sentence[], sentences: readonly Sentence[]): string[] {
  const leads = new Map<string, { text: string; ordinal: number }>()
  for (const sentence of sentences) {
    if (sentence.article === undefined) continue
    const text = displaySentence(sentence)
    if (!/[：:]$/u.test(text) || leads.has(sentence.article)) continue
    leads.set(sentence.article, { text, ordinal: sentence.ordinal })
  }
  const used = new Set<string>()
  const parts: string[] = []
  for (const sentence of picked) {
    const text = displaySentence(sentence)
    const article = sentence.article
    const lead = article === undefined ? undefined : leads.get(article)
    // A later list entry needs its article's lead (`…事项：`) to make sense. The article's
    // own first sentence already supplies that context and must not get a second prefix.
    const isListEntry = sentence.position > 0 || /^[（(]/u.test(text) || (lead !== undefined && sentence.ordinal > lead.ordinal)
    if (lead !== undefined && article !== undefined && !used.has(article) && text !== lead.text && isListEntry) {
      used.add(article)
      parts.push(`${lead.text}${text}`)
      continue
    }
    parts.push(text)
  }
  return parts
}

/** Build one chapter/section summary and the sentences it used. */
function summarizeSection(node: SectionNode, sourceChunks: readonly OutlineChunk[]): { summary: string; picked: Sentence[] } {
  const sentences = sentencesForChunks(sourceChunks)
  const headingKeys = headingKeysFor(sourceChunks, node)
  const picked = pickSummarySentences(sentences, node.level === 1 ? 4 : 2, headingKeys)
  let summary = compactLegalPhrases(joinSummaryParts(summaryParts(picked, sentences)))
  if (summary === '') {
    const childTitles = node.children.slice(0, 8).map(child => child.title.replace(/[。；，、\s]+$/u, ''))
    summary = childTitles.length > 0 ? `本节包括：${childTitles.join('、')}。` : `${node.title}。`
  } else if (node.level === 1 && summary.length < 80) {
    const articleCount = new Set(sentences
      .map(sentence => sentence.article)
      .filter((article): article is string => article !== undefined)).size
    // A short chapter still gets enough context to be useful; the count is structural,
    // not an inferred policy fact.
    if (articleCount >= 2) summary = `本章共 ${String(articleCount)} 条。${summary}`
  }
  return { summary: clipText(summary, 200), picked }
}

/** `第六章  经营班子会记录及实施` → `记录及实施`, for a compact chapter list. */
function shortTopic(title: string): string {
  return title
    .replace(CHAPTER_HEADING, '')
    .replace(/^经营班子会(?:议的|会议的)?/u, '')
    .replace(/\s+/gu, '')
    .replace(/[。；，、]+$/u, '')
}

/** The title a reader expects; `foo.docx.md` becomes `foo`, a real `#` title stays as-is. */
function displayDocumentTitle(documentTitle: string, sourcePath: string): string {
  const title = documentTitle.trim()
  if (title !== '' && !/\.(?:md|markdown|docx?|pdf|pptx?|xlsx?|html?|txt)$/iu.test(title)) return title
  const base = sourcePath.slice(sourcePath.lastIndexOf('/') + 1)
  const candidate = base !== '' ? base : documentTitle
  const cleaned = candidate
    .replace(/(?:\.md|\.markdown)+$/iu, '')
    .replace(/\.(?:docx?|pdf|pptx?|xlsx?|html?|txt)$/iu, '')
    .trim()
  return cleaned !== '' ? cleaned : documentTitle
}

/** Score a sentence as the document's scope/remit sentence. */
function scopeScore(text: string): number {
  let score = 0
  if (/适用|适用范围/u.test(text)) score += 8
  if (/负责|组织实施|行使职权|职责|管理/u.test(text)) score += 5
  if (/决定|审议/u.test(text)) score += 2
  if (text.length <= 80) score += 1
  return score
}

/** The best scope/remit sentence among the chapter summaries. */
function pickScope(chapterSections: readonly OutlineSection[], picks: ReadonlyMap<string, readonly Sentence[]>): Sentence | undefined {
  let best: { sentence: Sentence; score: number } | undefined
  for (const section of chapterSections) {
    for (const sentence of picks.get(section.sectionId) ?? []) {
      const score = scopeScore(displaySentence(sentence))
      if (best === undefined || score > best.score) best = { sentence, score }
    }
  }
  return best?.sentence
}

/** Score a sentence as a key threshold or process step. */
function processScore(text: string): number {
  let score = 0
  if (/通过|表决|赞成|同意/u.test(text)) score += 6
  if (/出席|召开|到会/u.test(text)) score += 5
  if (/通知|工作日|提前|时限/u.test(text)) score += 5
  if (/以上.*本数|本数/u.test(text)) score += 7
  if (/超过|不足|三分之二|二分之一|过半数|半数以上/u.test(text)) score += 4
  if (/审议|批准|决定|负责/u.test(text)) score += 2
  if (NUMERIC_PATTERN.test(text)) score += 3
  return score
}

/** Which part of the meeting process a sentence describes. */
function thresholdCategory(text: string): 'voting' | 'closing' | 'notice' | 'attendance' | 'other' {
  if (/通过|表决|赞成|同意/u.test(text)) return 'voting'
  if (/以上.*本数|本数/u.test(text)) return 'closing'
  if (/通知|工作日|提前|时限/u.test(text)) return 'notice'
  if (/出席|召开|到会/u.test(text)) return 'attendance'
  return 'other'
}

/** Up to three threshold/process sentences: voting first, then closing, notice, attendance. */
function pickThresholds(
  chapterSections: readonly OutlineSection[],
  picks: ReadonlyMap<string, readonly Sentence[]>,
  exclude: Sentence | undefined,
): Sentence[] {
  const candidates: Array<{ section: OutlineSection; sentence: Sentence; score: number; category: ReturnType<typeof thresholdCategory> }> = []
  for (const section of chapterSections) {
    for (const sentence of picks.get(section.sectionId) ?? []) {
      if (sentence === exclude) continue
      const text = displaySentence(sentence)
      const score = processScore(text)
      if (score < 5) continue
      candidates.push({ section, sentence, score, category: thresholdCategory(text) })
    }
  }
  candidates.sort((left, right) => right.score - left.score)
  const selected: typeof candidates = []
  const seenText = new Set<string>()
  const take = (candidate: (typeof candidates)[number] | undefined): void => {
    if (candidate === undefined || selected.length >= 3) return
    const key = normalizeKey(displaySentence(candidate.sentence))
    if (key === '' || seenText.has(key)) return
    seenText.add(key)
    selected.push(candidate)
  }
  const bestOf = (category: (typeof candidates)[number]['category']): (typeof candidates)[number] | undefined =>
    candidates.find(candidate => candidate.category === category)

  // Voting thresholds are the most consulted values; keep both halves of the rule when
  // one sentence states 1/2 and another states 2/3.
  const voting = candidates.filter(candidate => candidate.category === 'voting')
  take(voting[0])
  const firstVoting = displaySentence(voting[0]?.sentence ?? { text: '', chunkId: 0, ordinal: 0, position: 0 })
  const needsTwoThirds = /二分之一|过半数|半数以上/u.test(firstVoting) && !/三分之二/u.test(firstVoting)
  const needsHalf = /三分之二/u.test(firstVoting) && !/二分之一|过半数|半数以上/u.test(firstVoting)
  if (needsTwoThirds || needsHalf) {
    take(voting.find(candidate => {
      const text = displaySentence(candidate.sentence)
      return needsTwoThirds ? /三分之二/u.test(text) : /二分之一|过半数|半数以上/u.test(text)
    }))
  }
  take(bestOf('closing'))
  take(bestOf('notice'))
  take(bestOf('attendance'))
  for (const candidate of candidates) {
    if (selected.length >= 3) break
    take(candidate)
  }
  return selected.map(candidate => candidate.sentence)
}

/** Compose the document summary from chapter summaries, not from the first paragraph. */
function buildDocumentSummary(input: {
  documentTitle: string
  sourcePath: string
  charCount: number
  totalSections: number
  sections: readonly OutlineSection[]
  picks: ReadonlyMap<string, readonly Sentence[]>
  allSentences: readonly Sentence[]
}): { summary: string; sourceChunkIds: number[] } {
  const chapterSections = input.sections.filter(section => section.level === 1 && section.title !== '正文')
  const displayTitle = displayDocumentTitle(input.documentTitle, input.sourcePath)
  const chapterCount = chapterSections.length
  const articleCount = input.sections.filter(section => ARTICLE_TITLE.test(section.title)).length
  const topics = chapterSections.map(section => shortTopic(section.title)).filter(topic => topic !== '').slice(0, 6)
  const frame = chapterCount > 0
    ? `文档主题：《${displayTitle}》共 ${String(chapterCount)} 章${articleCount > 0 ? ` ${String(articleCount)} 条` : ''}，约 ${String(input.charCount)} 字`
    : `文档主题：《${displayTitle}》全文约 ${String(input.charCount)} 字，包含 ${String(input.totalSections)} 个章节节点`
  const chapterList = topics.length > 0 ? `，章节包括：${topics.join('、')}` : ''
  let summary = `${frame}${chapterList}。`
  const scope = pickScope(chapterSections, input.picks)
  const thresholds = pickThresholds(chapterSections, input.picks, scope)
  let body = ''
  if (scope !== undefined) body += `适用范围与职责：${terminalSentence(clipText(displaySentence(scope), 70))}`
  if (thresholds.length > 0) {
    const clauses = thresholds.map(sentence => clauseText(clipText(displaySentence(sentence), 70)))
    body += `关键门槛与流程：${clauses.join('；')}。`
  }
  const fallback = scope === undefined && thresholds.length === 0
    ? pickSummarySentences(input.allSentences, 4, new Set<string>())
    : []
  if (body !== '') summary += body
  else if (fallback.length > 0) summary += `主要内容：${joinSummaryParts(fallback.map(displaySentence))}`
  summary = terminalSentence(clipText(compactLegalPhrases(summary), 300))
  const usedChunkIds = new Set<number>()
  if (scope !== undefined) usedChunkIds.add(scope.chunkId)
  for (const sentence of thresholds) usedChunkIds.add(sentence.chunkId)
  for (const sentence of fallback) usedChunkIds.add(sentence.chunkId)
  return {
    summary,
    sourceChunkIds: [...usedChunkIds].sort((left, right) => left - right),
  }
}

/** Build the heading tree from chunk contents. */
function buildTree(input: BuildOutlineInput): { roots: SectionNode[]; nodes: SectionNode[]; documentTitle: string } {
  const roots: SectionNode[] = []
  const nodes: SectionNode[] = []
  const stack: SectionNode[] = []
  let current: SectionNode | undefined
  let documentTitle = input.docTitle
  let sawFirstMarkdownTitle = false
  let nextIndex = 1
  let preamble: SectionNode | undefined

  const create = (title: string, rawLevel: number, parent: SectionNode | undefined): SectionNode => {
    const node: SectionNode = {
      title,
      level: parent === undefined ? 1 : parent.level + 1,
      rawLevel,
      ...(parent === undefined ? {} : { parent }),
      children: [],
      chunkIds: [],
      sourceChunkIds: [],
      index: nextIndex,
    }
    nextIndex += 1
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
    nodes.push(node)
    return node
  }

  for (const chunk of input.chunks) {
    const lines = chunk.content.split('\n')
    const headings: HeadingLine[] = []
    let consumed = 0
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed === '') { consumed += 1; continue }
      // Spreadsheet/PDF derivation may put a one-line metadata comment before the heading.
      if (trimmed.startsWith('<!--')) { consumed += 1; continue }
      const heading = headingLineOf(trimmed)
      if (heading === undefined) break
      headings.push(heading)
      consumed += 1
    }
    for (const heading of headings) {
      // The first level-1 Markdown heading is the document title, not a section.
      if (!sawFirstMarkdownTitle && heading.kind === 'markdown' && heading.rawLevel === 1) {
        sawFirstMarkdownTitle = true
        documentTitle = heading.title
        continue
      }
      sawFirstMarkdownTitle = true
      while (stack.length > 0 && stack[stack.length - 1]!.rawLevel >= heading.rawLevel) {
        stack.pop()
      }
      const parent = stack[stack.length - 1]
      const node = create(heading.title, heading.rawLevel, parent)
      stack.push(node)
      current = node
    }
    const body = lines.slice(consumed).some(line => line.trim() !== '' && !TABLE_RULE.test(line.trim()))
    if (current === undefined) {
      // A title-only chunk (the document's `#` heading) has no section to belong to.
      if (!body) continue
      preamble ??= create('正文', 1, undefined)
      current = preamble
    }
    // A `第X条 ...` chunk's heading line IS its body, so it belongs to this section even
    // though the heading parser consumed every line.
    current.chunkIds.push(chunk.id)
  }

  // Aggregate descendant chunks bottom-up, in reverse creation order.
  for (const node of [...nodes].reverse()) {
    node.sourceChunkIds = [...node.chunkIds]
    for (const child of node.children) {
      for (const id of child.sourceChunkIds) {
        if (!node.sourceChunkIds.includes(id)) node.sourceChunkIds.push(id)
      }
    }
  }
  return { roots, nodes, documentTitle }
}

/**
 * Build one document's extractive outline.
 *
 * Every sentence comes from a chunk; the only generated text is structural framing
 * ("共 N 章", "章节包括") and the legal-phrase compaction documented above. No number,
 * responsible body or exception is invented.
 */
export function buildDocumentOutline(input: BuildOutlineInput): BuiltOutline {
  const { roots, nodes, documentTitle } = buildTree(input)
  const chunkById = new Map(input.chunks.map(chunk => [chunk.id, chunk]))
  const allSentences = input.chunks.flatMap(chunk => sentencesOfChunk(chunk))
  const charCount = input.chunks.reduce((total, chunk) => total + plainOutlineText(chunk.content).length, 0)
  const totalSections = Math.min(nodes.length, OUTLINE_MAX_SECTIONS)
  const keptNodes = nodes.slice(0, OUTLINE_MAX_SECTIONS)

  const sections: OutlineSection[] = []
  const picks = new Map<string, Sentence[]>()
  for (const node of keptNodes) {
    const sourceChunks = node.sourceChunkIds
      .map(id => chunkById.get(id))
      .filter((chunk): chunk is OutlineChunk => chunk !== undefined)
    const sectionId = `s${String(input.docId)}-${String(node.index)}`
    const { summary, picked } = summarizeSection(node, sourceChunks)
    picks.set(sectionId, picked)
    sections.push({
      sectionId,
      headingPath: headingPathOf(node),
      title: node.title,
      level: node.level,
      summary,
      keyFacts: keyFactsFor(sourceChunks, node, node.level === 1 ? 6 : 3),
      chunkIds: [...node.chunkIds],
      sourceChunkIds: [...node.sourceChunkIds],
      ...(node.parent === undefined ? {} : { parentId: `s${String(input.docId)}-${String(node.parent.index)}` }),
    })
  }

  const document = buildDocumentSummary({
    documentTitle,
    sourcePath: input.sourcePath,
    charCount,
    totalSections,
    sections,
    picks,
    allSentences,
  })

  const toc: OutlineTocEntry[] = sections.map(section => ({
    sectionId: section.sectionId,
    title: section.title,
    level: section.level,
    chunkIds: [...section.chunkIds],
  }))

  return {
    documentTitle,
    summary: document.summary,
    sourceChunkIds: document.sourceChunkIds,
    toc,
    sections,
  }
}

/** Ancestor titles joined with ` > `. */
function headingPathOf(node: SectionNode): string {
  const titles: string[] = []
  let pointer: SectionNode | undefined = node
  while (pointer !== undefined) {
    titles.unshift(pointer.title)
    pointer = pointer.parent
  }
  return titles.join(' > ')
}

/** Input for {@link renderOutlineMarkdown}. */
export interface RenderOutlineInput {
  docId: number
  docTitle: string
  sourcePath: string
  summaryVersion: string
  /** How the summary was produced; omitted for legacy callers means `extractive`. */
  summaryKind?: 'none' | 'extractive' | 'llm'
  summary: string
  summarySourceChunkIds: readonly number[]
  toc: readonly OutlineTocEntry[]
  sections: readonly OutlineSection[]
}

/** Render the human/agent-readable INDEX.md for one document. */
export function renderOutlineMarkdown(input: RenderOutlineInput): string {
  const lines: string[] = []
  const summaryKind = input.summaryKind ?? 'extractive'
  const origin = summaryKind === 'llm'
    ? '摘要由 LLM 阅读原文后生成'
    : summaryKind === 'none'
      ? '尚未生成摘要，本文件只提供目录'
      : '摘要从原文结构抽取'
  lines.push(`# ${input.docTitle} — 知识库索引`, '')
  lines.push(`> 本文件是导航索引（${input.summaryVersion}）：${origin}，**不是引用来源**。`)
  lines.push(`> 引用请使用原文 chunk 的 \`kb://doc/${String(input.docId)}/chunk/<chunkKey>\` token（由 \`kb_search\` / \`kb_chunk_get\` 返回）。`)
  lines.push(`> 源文件：\`${input.sourcePath}\``, '')
  if (summaryKind === 'none') {
    lines.push('> 生成摘要：按 knowledge-base 技能的 `references/summarize.md` 阅读原文后，用 `kb_outline_save` 落库。', '')
  }
  lines.push('## 文档摘要', '')
  if (input.summary !== '') lines.push(input.summary)
  else if (summaryKind === 'none') lines.push('（尚未生成摘要：按 knowledge-base 技能的摘要流程生成）')
  else lines.push('（无正文）')
  lines.push('')
  lines.push(`来源 chunk：${input.summarySourceChunkIds.length === 0 ? '（无）' : input.summarySourceChunkIds.join(', ')}`, '')

  lines.push('## 目录', '')
  if (input.toc.length === 0) {
    lines.push('（无可识别标题）', '')
  } else {
    for (const entry of input.toc) {
      const indent = '  '.repeat(Math.max(0, entry.level - 1))
      const sources = entry.chunkIds.length === 0 ? '' : `，chunk ${entry.chunkIds.join(', ')}`
      lines.push(`${indent}- ${entry.title}（${entry.sectionId}${sources}）`)
    }
    lines.push('')
  }

  lines.push('## 章节摘要', '')
  const chapters = input.sections.filter(section => section.level === 1)
  if (chapters.length === 0) {
    lines.push('（无章节）', '')
  }
  for (const section of chapters) {
    lines.push(`### ${section.title}`, '')
    lines.push(`- 章节 ID：\`${section.sectionId}\``)
    lines.push(`- 章节路径：${section.headingPath}`)
    lines.push(`- 来源 chunk：${section.sourceChunkIds.length === 0 ? '（无）' : section.sourceChunkIds.join(', ')}`, '')
    lines.push(section.summary === ''
      ? (summaryKind === 'none' ? '（本节尚未生成摘要）' : '（本节无可抽取正文）')
      : section.summary, '')
    lines.push('**关键事实**', '')
    if (section.keyFacts.length === 0) {
      lines.push(summaryKind === 'none'
        ? '- （尚未生成关键事实）'
        : '- （未抽取到门槛/比例/主体/例外类事实）', '')
    } else {
      for (const fact of section.keyFacts) {
        lines.push(`- ${fact.fact}：${fact.value}（chunk ${String(fact.chunkId)}）`)
      }
      lines.push('')
    }
    // A chapter's articles are navigation units too. Keep their summaries in the same
    // file so a reader can see the section-level detail without opening every chunk.
    for (const child of input.sections.filter(candidate => candidate.level === 2
      && candidate.headingPath.startsWith(section.headingPath + ' > '))) {
      if (child.summary === '') continue
      lines.push(`#### ${child.title}`, '')
      lines.push(`- 章节 ID：\`${child.sectionId}\``)
      lines.push(`- 来源 chunk：${child.sourceChunkIds.length === 0 ? '（无）' : child.sourceChunkIds.join(', ')}`, '')
      lines.push(child.summary, '')
      for (const fact of child.keyFacts) {
        lines.push(`- ${fact.fact}：${fact.value}（chunk ${String(fact.chunkId)}）`)
      }
      if (child.keyFacts.length > 0) lines.push('')
    }
  }
  return lines.join('\n').trimEnd() + '\n'
}
