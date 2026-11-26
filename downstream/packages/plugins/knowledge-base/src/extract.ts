/**
 * Convert an uploaded document into Markdown so its text becomes greppable.
 *
 * The knowledge tree doubles as a document store and as what an agent greps. A
 * `.docx` on disk is neither: its bytes answer no query. Every upload therefore
 * lands twice — the original, byte for byte, plus a `.md` sibling holding the
 * extracted text — so a reader can still open the real file while a search sees
 * the words inside it.
 *
 * Extraction is delegated rather than implemented here. Three authorities
 * already exist in this deployment and each owns one format family:
 *
 * - MinerU (`/file_parse`) parses PDF and office documents with layout models.
 *   It is the best answer for a scanned PDF and the one authority that can
 *   recognise tables inside one.
 * - LibreOffice converts the legacy binary formats (`.doc`, `.xls`, `.ppt`) that
 *   MinerU and the Python readers refuse.
 * - `python-docx` / `openpyxl` / `python-pptx` / `pypdf` read the modern formats
 *   directly, without a service round trip.
 *
 * None of them is reimplemented in TypeScript: a `.docx` is a ZIP of XML and a
 * second parser would only disagree with the first. This module decides WHICH
 * authority to ask and what to do when it cannot answer, which is the part that
 * is specific to this plugin.
 *
 * A failed extraction never fails the upload. The original is already written and
 * remains the source of truth; the caller learns that no `.md` was produced, and
 * the file stays readable through the original.
 *
 * @module @sparkelf/dsh-knowledge-base/extract
 */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, extname, join } from 'node:path'

/** Formats whose text this module knows how to extract. */
export const EXTRACTABLE_EXTENSIONS = [
  '.pdf',
  '.doc', '.docx',
  '.xls', '.xlsx',
  '.ppt', '.pptx',
  '.odt', '.ods', '.odp',
  '.rtf',
] as const

/** One extractable extension. */
export type ExtractableExtension = typeof EXTRACTABLE_EXTENSIONS[number]

/**
 * Formats that are already plain text, so there is nothing to extract.
 *
 * A `.md` document IS the Markdown an extraction would produce. Asking for one to be
 * extracted is not a failure and not an unsupported format: the honest answer is that no
 * work is needed. Without this list such a request fell through to "this type has no
 * extractor", which told a reader their own Markdown file was unreadable.
 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'] as const

/**
 * Whether this path is already Markdown.
 * @param relPath - the document's path.
 * @returns Whether no extraction is needed.
 */
export function isAlreadyMarkdown(relPath: string): boolean {
  return (MARKDOWN_EXTENSIONS as readonly string[]).includes(extname(relPath).toLowerCase())
}

/** One MinerU layout block, normalized for the SQLite provenance tables. */
export interface MineruBlock {
  page: number
  bbox: [number, number, number, number]
  text: string
  type: string
  blockIndex: number
  occurrence: number
  confidence?: number
  pageWidth?: number
  pageHeight?: number
  coordSpace: 'normalized' | 'points'
}

/** How one request to the extraction authorities ended. */
export interface ExtractResult {
  /** Markdown text, when extraction produced any. */
  markdown?: string
  /**
   * Which authority answered. Reported so a bad conversion can be traced.
   *
   * `mineru-ocr` means the first pass classified the document as text and came back
   * too thin to search, so the same parser was asked again with OCR forced. It is a
   * separate value because the two passes can disagree, and a reader debugging a
   * missing line needs to know which one produced the file.
   */
  via?: 'mineru' | 'mineru-ocr' | 'libreoffice' | 'python' | 'native'
  /** Why no markdown was produced. Present whenever {@link markdown} is absent. */
  reason?: string
  /** Layout blocks from MinerU (`middle_json`), used only for provenance metadata. */
  blocks?: MineruBlock[]
}

/** Time one extraction may take before it is abandoned. */
const EXTRACT_TIMEOUT_MS = 180_000

/**
 * Whether this path names a document worth extracting.
 *
 * Compared case-insensitively because a browser reports the extension as the
 * user typed it, and a `.PDF` is the same format as a `.pdf`.
 *
 * @param relPath - the uploaded path, relative to the knowledge root.
 * @returns true when {@link extractDocument} has an authority for it.
 */
export function isExtractable(relPath: string): boolean {
  const ext = extname(relPath).toLowerCase()
  return (EXTRACTABLE_EXTENSIONS as readonly string[]).includes(ext)
}

/**
 * The Markdown sibling an extracted document lands beside.
 *
 * Appending rather than replacing the extension keeps two same-named uploads
 * from colliding: `报告.docx` becomes `报告.docx.md`, so it cannot overwrite a
 * `报告.md` the user wrote by hand.
 *
 * @param relPath - the uploaded document's path.
 * @returns the markdown path to write.
 */
export function markdownSiblingOf(relPath: string): string {
  return relPath + '.md'
}

/**
 * Whether MinerU should be asked before the local readers.
 *
 * PDF only: a PDF carries no recoverable structure beyond its layout, which is
 * exactly what MinerU models. An office document still has its XML, and the
 * direct readers keep more of it (a spreadsheet's cell grid survives
 * `openpyxl` and is flattened by a layout parser).
 *
 * @param ext - lowercased extension including the dot.
 * @returns true when the remote parser is the better authority.
 */
export function prefersRemoteParser(ext: string): boolean {
  return ext === '.pdf'
}

/** Run one command and collect its stdout. */
function run(command: string, args: readonly string[], timeoutMs = EXTRACT_TIMEOUT_MS): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: 'spawn failed' }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
  })
}

/** Trim trailing blank lines so a trailing newline is not counted as content. */
function tidy(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\n{3,}/gu, '\n\n').trim()
}

/** Wrap a converted document body in a heading that names its origin. */
function withHeader(title: string, body: string, via: ExtractResult['via']): string {
  const source = via === undefined ? '' : `\n\n<!-- extracted via ${via} -->`
  return `# ${title}\n\n${body}${source}\n`
}

/**
 * Ask MinerU to parse one file and return its Markdown.
 *
 * The service answers with a task handle for large files and the body directly
 * for small ones, so both shapes are accepted. A non-200 answer is a miss, not
 * a failure of the upload.
 *
 * @param baseUrl - MinerU service base URL, without a trailing slash.
 * @param fullPath - absolute path of the document on this host.
 * @param fileName - name to report to the service.
 * @returns the Markdown, or undefined when the service could not parse it.
 */
/**
 * Whether an extraction came back too small to be worth searching.
 *
 * Not a judgement about document quality: a 200-character memo is a real document,
 * and treating it as a failure would re-run OCR over something already correct. The
 * test targets the specific shape of a mis-classified scan -- pages of content that
 * came back as a title and a page number -- so it counts what is left after markup
 * rather than trusting a single threshold on the whole answer.
 *
 * @param markdown - what the parser returned.
 * @returns true when the answer is short enough that a classifier mistake is likely.
 */
export function looksTooThinToSearch(markdown: string): boolean {
  // Strip the constructs that survive OCR of a blank page: headings, table rules,
  // image placeholders and comments all render without carrying words.
  const text = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\|[^\n]*\|/g, ' ')
    .replace(/^[#\-*\s]+/gm, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // What separates a scanned page from a short real one is not its length but
  // whether it contains a SENTENCE. A mis-classified scan yields a title, a page
  // number and nothing else -- fragments. A two-clause notice is short but reads as
  // prose, and re-running OCR over it would cost a parse for nothing.
  //
  // Sentence punctuation is the signal because it is what a document uses and what
  // a page header does not. Content words alone would not do: "合同 - 1 -" is three
  // tokens and tells the reader nothing.
  const sentenceMarks = text.match(/[。！？；.!?;]/g)
  if (sentenceMarks !== null && sentenceMarks.length > 0) return false

  // No sentence punctuation: accept only when there is enough prose that a
  // punctuation-free paragraph is the likelier explanation than a failed parse.
  return text.length < 40
}

/** Quality tier the extractor asks MinerU for. */
const MINERU_TIER = 'basic'

/**
 * Where the 4.x synchronous parse lives.
 *
 * MinerU 4.x mounts its routes under `/v1` (`APIRouter(prefix="/v1")`), so the
 * synchronous parse is `/v1/file_parse`. 3.4.x served `/file_parse` at the root and
 * cannot answer the query-parameter contract this function sends, so pointing at the
 * version this deployment installs (`mineru>=4.0,<5`) is the honest choice rather
 * than carrying two request shapes.
 *
 * A 3.4.x server therefore does not work through this path: it has no `/v1` route, so
 * the request fails here and the extractor falls through to LibreOffice or Python.
 * That degradation is intended — upgrading the service is the fix, not teaching the
 * client a second contract.
 */
const MINERU_PARSE_PATH = '/v1/file_parse'

/** Parse MinerU's middle_json pages/blocks into provenance rows. */
export function parseMineruBlocks(value: unknown): MineruBlock[] {
  if (typeof value !== 'object' || value === null) return []
  const root = value as Record<string, unknown>
  const pages = root.pages
  if (!Array.isArray(pages)) return []
  const layoutPages = (((root.extensions as Record<string, unknown> | undefined)?.docvortex_layout as Record<string, unknown> | undefined)?.pages) as unknown
  const dimensions = new Map<number, { width?: number; height?: number }>()
  if (Array.isArray(layoutPages)) {
    for (const page of layoutPages) {
      if (typeof page !== 'object' || page === null) continue
      const row = page as Record<string, unknown>
      const index = typeof row.page_idx === 'number' ? row.page_idx : undefined
      if (index === undefined) continue
      dimensions.set(index, {
        ...(typeof row.width_pt === 'number' ? { width: row.width_pt } : {}),
        ...(typeof row.height_pt === 'number' ? { height: row.height_pt } : {}),
      })
    }
  }
  const out: MineruBlock[] = []
  for (const page of pages) {
    if (typeof page !== 'object' || page === null) continue
    const pageRow = page as Record<string, unknown>
    const pageIndex = typeof pageRow.page_idx === 'number' ? pageRow.page_idx : 0
    const blocks = Array.isArray(pageRow.blocks) ? pageRow.blocks : []
    const seen = new Map<string, number>()
    for (const [fallbackIndex, raw] of blocks.entries()) {
      if (typeof raw !== 'object' || raw === null) continue
      const block = raw as Record<string, unknown>
      const bbox = Array.isArray(block.bbox)
        ? block.bbox.filter((value): value is number => typeof value === 'number')
        : []
      if (bbox.length !== 4) continue
      const textParts: string[] = []
      if (Array.isArray(block.content)) {
        for (const item of block.content) {
          if (typeof item !== 'object' || item === null) continue
          const content = (item as Record<string, unknown>).content
          if (typeof content === 'string') textParts.push(content)
        }
      }
      if (typeof block.text === 'string') textParts.push(block.text)
      const text = textParts.join(' ').replace(/\s+/gu, ' ').trim()
      if (text === '') continue
      const max = Math.max(...bbox)
      const coordinate: MineruBlock['coordSpace'] = max <= 1.01 ? 'normalized' : max <= 1000 ? 'normalized' : 'points'
      const normalized = coordinate === 'normalized' && max > 1.01
        ? bbox.map(value => value / 1000) as [number, number, number, number]
        : bbox as [number, number, number, number]
      const occurrence = (seen.get(text) ?? 0) + 1
      seen.set(text, occurrence)
      const dimensionsForPage = dimensions.get(pageIndex)
      out.push({
        page: pageIndex + 1,
        bbox: normalized,
        text,
        type: typeof block.type === 'string' ? block.type : 'text',
        blockIndex: typeof block.index === 'number' ? block.index : fallbackIndex,
        occurrence,
        coordSpace: coordinate,
        ...(typeof dimensionsForPage?.width === 'number' ? { pageWidth: dimensionsForPage.width } : {}),
        ...(typeof dimensionsForPage?.height === 'number' ? { pageHeight: dimensionsForPage.height } : {}),
        ...(typeof block.confidence === 'number' ? { confidence: block.confidence } : {}),
      })
    }
  }
  return out
}

async function viaMineru(
  baseUrl: string,
  fullPath: string,
  fileName: string,
  mode: 'auto' | 'ocr' = 'auto',
): Promise<{ markdown: string; blocks?: MineruBlock[] } | undefined> {
  try {
    const bytes = await readFile(fullPath)
    const url = new URL(MINERU_PARSE_PATH, baseUrl)
    // MinerU 4.x reads every parse option from the QUERY STRING and accepts exactly
    // one multipart field, `files`. Sending options as form fields is rejected with
    // `Too many fields. Maximum number of fields is 0.` -- the body parser runs with
    // `max_fields=0`. `output_formats` has no default and is required; `tier` is
    // named because the server otherwise resolves it to `standard`, which measured
    // 17.8 s against 2.0 s for `basic` on the same one-page PDF.
    url.searchParams.set('tier', MINERU_TIER)
    url.searchParams.append('output_formats', 'markdown')
    // `middle_json` is the supported layout artifact (content_list is not an output
    // format in MinerU 4.x). It carries page_idx + normalized bbox + block index.
    url.searchParams.append('output_formats', 'middle_json')
    // `auto` lets the parser classify the document itself: it samples pages and
    // switches to OCR when a page carries too little extractable text, which is what
    // a scan looks like. Forcing `ocr` everywhere would run OCR over born-digital
    // PDFs too -- slower, and worse on text that was already perfect.
    url.searchParams.set('ocr_mode', mode === 'ocr' ? 'ocr' : 'auto')
    const form = new FormData()
    form.append('files', new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }), fileName)
    const response = await fetch(url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(EXTRACT_TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    const body = await response.json() as Record<string, unknown>
    // A 4.x task result carries the text inline per file: files[0].content.markdown.
    const files = body.files
    if (Array.isArray(files)) {
      for (const entry of files) {
        if (typeof entry !== 'object' || entry === null) continue
        const content = (entry as { content?: unknown }).content
        if (typeof content !== 'object' || content === null) continue
        const markdown = (content as { markdown?: unknown }).markdown
        if (typeof markdown === 'string' && markdown.trim() !== '') {
          const middle = (content as { middle_json?: unknown }).middle_json
          const blocks = parseMineruBlocks(middle)
          return { markdown, ...(blocks.length === 0 ? {} : { blocks }) }
        }
      }
      // The task answered but produced no Markdown: not a parser-shaped reply, so
      // there is nothing to poll for either.
      return undefined
    }
    // Tolerate the shapes an older deployment answered with, so a server that was
    // not upgraded degrades to "no text" rather than to a thrown request.
    for (const key of ['markdown', 'md_content', 'mdContent']) {
      const value = body[key]
      if (typeof value === 'string' && value.trim() !== '') {
        const blocks = parseMineruBlocks(body.middle_json ?? body.middleJson)
        return { markdown: value, ...(blocks.length === 0 ? {} : { blocks }) }
      }
    }
    // Task answer without inline content: poll the result route.
    const taskId = typeof body.task_id === 'string' ? body.task_id
      : (typeof body.taskId === 'string' ? body.taskId : undefined)
    if (taskId === undefined) return undefined
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      const poll = await fetch(new URL('/v1/tasks/' + encodeURIComponent(taskId) + '/result', baseUrl), {
        signal: AbortSignal.timeout(30_000),
      })
      if (!poll.ok) continue
      const result = await poll.json() as Record<string, unknown>
      for (const key of ['markdown', 'md_content', 'mdContent', 'content']) {
        const value = result[key]
        if (typeof value === 'string' && value.trim() !== '') {
          const blocks = parseMineruBlocks(result.middle_json ?? result.middleJson)
          return { markdown: value, ...(blocks.length === 0 ? {} : { blocks }) }
        }
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Convert an office document to text with LibreOffice, for the legacy formats. */
async function viaLibreOffice(fullPath: string, ext: string, scratch: string): Promise<string | undefined> {
  // `--convert-to txt` covers writer/calc/impress documents; the filter name is
  // version-dependent, so the plain format word is what is asked for.
  const converted = await run('soffice', [
    '--headless', '--norestore', '--invisible',
    '--convert-to', 'txt:Text (encoded):UTF8',
    '--outdir', scratch, fullPath,
  ])
  if (converted.code !== 0) {
    // Calc and Impress need their own filter; retry with the generic name.
    const retry = await run('soffice', ['--headless', '--norestore', '--convert-to', 'txt', '--outdir', scratch, fullPath])
    if (retry.code !== 0) return undefined
  }
  const produced = basename(fullPath, ext) + '.txt'
  try {
    const text = await readFile(join(scratch, produced), 'utf8')
    return text.trim() === '' ? undefined : text
  } catch {
    // LibreOffice sometimes writes a different extension; take the only file.
    const entries = await readdir(scratch).catch(() => [] as string[])
    if (entries.length !== 1) return undefined
    const text = await readFile(join(scratch, entries[0] as string), 'utf8').catch(() => '')
    return text.trim() === '' ? undefined : text
  }
}

/** Legacy formats LibreOffice can convert into a format a Python reader understands. */
const LEGACY_CONVERSION_TARGETS: Readonly<Record<string, string>> = {
  '.doc': '.docx',
  '.xls': '.xlsx',
  '.ppt': '.pptx',
  '.rtf': '.docx',
  '.odt': '.docx',
  '.ods': '.xlsx',
  '.odp': '.pptx',
}

/**
 * Convert a legacy binary to its modern container, then read it with the
 * matching Python reader.
 *
 * The plain-text filter in {@link viaLibreOffice} is lossy for complex Word,
 * Excel and PowerPoint files. This fallback preserves the source structure
 * instead of flattening it to a single text stream.
 */
async function viaLibreOfficeConversion(fullPath: string, ext: string, scratch: string): Promise<string | undefined> {
  const target = LEGACY_CONVERSION_TARGETS[ext]
  if (target === undefined) return undefined
  const converted = await run('soffice', [
    '--headless', '--norestore', '--invisible',
    '--convert-to', target.slice(1),
    '--outdir', scratch, fullPath,
  ])
  if (converted.code !== 0) return undefined
  const entries = await readdir(scratch).catch(() => [] as string[])
  const produced = entries.find(name => name.toLowerCase().endsWith(target))
  if (produced === undefined) return undefined
  return viaPython(join(scratch, produced), target)
}

/** Read the modern formats directly, without a service round trip. */
async function viaPython(fullPath: string, ext: string): Promise<string | undefined> {
  const script = PYTHON_READERS[ext]
  if (script === undefined) return undefined
  const result = await run('python3', ['-c', script, fullPath])
  if (result.code !== 0) return undefined
  const text = result.stdout.trim()
  return text === '' ? undefined : text
}

/**
 * One reader per modern format, as a `python3 -c` program.
 *
 * Each takes the file path as argv[1] and prints Markdown. They are kept tiny and
 * separate so a missing library only disables its own format.
 */
const PYTHON_READERS: Readonly<Record<string, string>> = {
  '.doc': `import sys, re
b = open(sys.argv[1], 'rb').read()
# Word 97-2003 stores its text as UTF-16LE in the WordDocument stream. A
# small number of WPS-generated files cannot be opened by older LibreOffice
# builds, so this read-only fallback keeps their text searchable.
def good(ch):
    return ('\\u4e00' <= ch <= '\\u9fff') or (ch.isascii() and ch.isprintable()) or ch in '，。；：、！？（）《》“”‘’—…%．,.;:()!?-/'
text = b.decode('utf-16le', errors='ignore')
text = ''.join(ch if ch in '\\r\\n\\t' or good(ch) else ' ' for ch in text)
text = re.sub(r'[ \\t]{3,}', ' ', text).replace('\\r', '\\n')
# The stream starts with OLE metadata before the first real run of Chinese
# prose; anchor there so no binary debris is emitted as a heading.
anchor = re.search(r'[\\u4e00-\\u9fff]{6,}', text)
if anchor:
    text = text[anchor.start():]
lines = [line.strip() for line in text.splitlines()]
# OLE metadata and binary debris survive the UTF-16 decode as short lines
# with a low ratio of printable CJK/ASCII characters. Keep only prose lines.
lines = [line for line in lines
         if len(re.findall(r'[\\u4e00-\\u9fff]', line)) >= 4
         and sum(good(ch) for ch in line) / max(len(line), 1) >= 0.75
         and not re.search(r'Root Entry|SummaryInformation|WordDocument|WPS|KSO|ICV|Normal|Windows 用户|Microsoft|Times New Roman|Calibri|宋体|仿宋', line)]
print('\\n'.join(lines))`,
  '.docx': `import sys, docx
d = docx.Document(sys.argv[1])
out = []
for p in d.paragraphs:
    t = p.text.strip()
    if t:
        style = (p.style.name or '').lower()
        if style.startswith('heading'):
            level = ''.join(ch for ch in style if ch.isdigit()) or '2'
            out.append('#' * min(int(level) + 1, 6) + ' ' + t)
        else:
            out.append(t)
for i, table in enumerate(d.tables):
    out.append('')
    for row in table.rows:
        cells = [c.text.strip().replace('\\n', ' ') for c in row.cells]
        out.append('| ' + ' | '.join(cells) + ' |')
        if row is table.rows[0]:
            out.append('|' + '---|' * len(cells))
print('\\n'.join(out))`,
  '.xlsx': `import sys, openpyxl
wb = openpyxl.load_workbook(sys.argv[1], data_only=True)
out = []
for ws in wb.worksheets:
    out.append('## ' + ws.title)
    out.append('')
    for row in ws.iter_rows(values_only=True):
        cells = ['' if c is None else str(c) for c in row]
        if any(c.strip() for c in cells):
            out.append('| ' + ' | '.join(cells) + ' |')
    out.append('')
print('\\n'.join(out))`,
  '.pptx': `import sys
from pptx import Presentation
prs = Presentation(sys.argv[1])
out = []
for i, slide in enumerate(prs.slides, 1):
    out.append('## Slide ' + str(i))
    out.append('')
    for shape in slide.shapes:
        if shape.has_text_frame:
            t = shape.text_frame.text.strip()
            if t:
                out.append(t)
    out.append('')
print('\\n'.join(out))`,
  '.pdf': `import sys
from pypdf import PdfReader
reader = PdfReader(sys.argv[1])
out = []
for i, page in enumerate(reader.pages, 1):
    t = (page.extract_text() or '').strip()
    if t:
        out.append('<!-- page ' + str(i) + ' -->')
        out.append(t)
        out.append('')
print('\\n'.join(out))`,
}

/** Services and commands extraction may use, as configured for this deployment. */
export interface ExtractOptions {
  /** MinerU base URL. Empty disables the remote parser. */
  mineruUrl?: string
}

/**
 * Extract one document to Markdown.
 *
 * Authorities are tried in an order that puts the best answer first for each
 * format, and every step degrades to the next rather than failing: a PDF whose
 * MinerU call times out still gets `pypdf`'s text layer.
 *
 * @param fullPath - absolute path of the written document.
 * @param relPath - the same document's knowledge-relative path, for the title.
 * @param options - services this deployment exposes.
 * @returns the Markdown and the authority that produced it, or the reason none did.
 */
export async function extractDocument(fullPath: string, relPath: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const ext = extname(relPath).toLowerCase()
  if (!isExtractable(relPath)) return { reason: 'unsupported-extension' }
  const attempts: string[] = []
  const title = basename(relPath)

  // The remote parser first where it is the better authority, but only when a
  // service is configured: an unreachable one must not delay every upload.
  if (prefersRemoteParser(ext) && options.mineruUrl !== undefined && options.mineruUrl !== '') {
    const remote = await viaMineru(options.mineruUrl, fullPath, title)
    // A scan whose first page happens to carry a header can classify as text and
    // come back nearly empty. The answer is not "no text in this document" -- it is
    // "the classifier guessed text and was wrong" -- so an answer that is too thin
    // to search is retried with OCR forced, once. A real one-page text PDF loses
    // nothing by being retried; a scanned contract stops being invisible to grep,
    // which is the whole point of extracting it.
    if (remote !== undefined && !looksTooThinToSearch(remote.markdown)) {
      return {
        markdown: withHeader(title, tidy(remote.markdown), 'mineru'),
        via: 'mineru',
        ...(remote.blocks === undefined ? {} : { blocks: remote.blocks }),
      }
    }
    if (remote !== undefined) {
      attempts.push('mineru-thin')
      const forced = await viaMineru(options.mineruUrl, fullPath, title, 'ocr')
      if (forced !== undefined) {
        return {
          markdown: withHeader(title, tidy(forced.markdown), 'mineru-ocr'),
          via: 'mineru',
          ...(forced.blocks === undefined ? {} : { blocks: forced.blocks }),
        }
      }
      // The retry produced nothing, so the thin first answer is what exists. Keeping
      // it beats returning nothing: whatever text it held is still searchable.
      return {
        markdown: withHeader(title, tidy(remote.markdown), 'mineru'),
        via: 'mineru',
        ...(remote.blocks === undefined ? {} : { blocks: remote.blocks }),
      }
    }
    attempts.push('mineru')
  }

  // The legacy binary formats have no Python reader, and a text converter is the
  // only thing that understands them.
  if (LEGACY_EXTENSIONS.has(ext)) {
    const scratch = await mkdtemp(join(tmpdir(), 'kb-extract-'))
    try {
      const text = await viaLibreOffice(fullPath, ext, scratch)
      if (text !== undefined) return { markdown: withHeader(title, tidy(text), 'libreoffice'), via: 'libreoffice' }
      attempts.push('libreoffice')
      // `.doc`/`.xls`/`.ppt` do not always survive the plain-text filter (old
      // Word documents, charts and embedded tables are common failures). Convert
      // to the modern container and let the direct Python readers keep structure.
      const converted = await viaLibreOfficeConversion(fullPath, ext, scratch)
      if (converted !== undefined) return { markdown: withHeader(title, tidy(converted), 'libreoffice'), via: 'libreoffice' }
      attempts.push('libreoffice-convert')
      // Older LibreOffice versions (and some WPS-written `.doc` files) fail to
      // load the binary container at all. The UTF-16LE WordDocument stream is
      // still readable and keeps the document searchable instead of invisible.
      const legacyDirect = await viaPython(fullPath, ext)
      if (legacyDirect !== undefined) return { markdown: withHeader(title, tidy(legacyDirect), 'python'), via: 'python' }
      attempts.push('python-legacy')
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  } else {
    const direct = await viaPython(fullPath, ext)
    if (direct !== undefined) return { markdown: withHeader(title, tidy(direct), 'python'), via: 'python' }
    attempts.push('python')
    // A modern format the direct reader could not open still has LibreOffice as a
    // fallback: a corrupt-but-openable file is better read than skipped.
    const scratch = await mkdtemp(join(tmpdir(), 'kb-extract-'))
    try {
      const text = await viaLibreOffice(fullPath, ext, scratch)
      if (text !== undefined) return { markdown: withHeader(title, tidy(text), 'libreoffice'), via: 'libreoffice' }
      attempts.push('libreoffice')
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  return { reason: 'no-extractor-succeeded: ' + attempts.join(',') }
}

/** Formats with no modern reader, which LibreOffice is the only authority for. */
const LEGACY_EXTENSIONS = new Set(['.doc', '.xls', '.ppt', '.rtf', '.odt', '.ods', '.odp'])

/**
 * Whether a file exists and is a regular file.
 *
 * @param path - absolute path to test.
 * @returns true when it is there.
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Write extracted markdown beside its document.
 *
 * Kept separate from {@link extractDocument} so the write is testable without an
 * extraction service.
 *
 * @param markdownPath - absolute path of the `.md` sibling.
 * @param markdown - the text to write.
 */
export async function writeExtractedMarkdown(markdownPath: string, markdown: string): Promise<void> {
  await writeFile(markdownPath, markdown, 'utf8')
}
