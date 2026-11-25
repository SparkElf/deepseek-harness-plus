/** Model-facing MinerU PDF parser. */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { unzipSync } from 'fflate'

interface MinerUResult {
  sourcePath: string
  markdown: string
  contentList: string
  images: string[]
}

/**
 * MinerU quality tier requested for one parse.
 *
 * MinerU 4.x recognises exactly these four (`mineru/types.py`: `TIERS`) and validates the
 * `tier` query parameter against them. A quality tier is not a deployment tier: `basic` and
 * `standard` name which model weights a server downloaded, `flash` parses the formats that
 * need no local weights, and `advanced` is the highest quality.
 */
export type MineruTier = 'flash' | 'basic' | 'standard' | 'advanced'

/** MinerU HTTP endpoint selected by the deployment. */
export interface Config {
  endpoint: string
  /** Quality tier to request; `apply` supplies `basic` when the deployment names none. */
  tier?: MineruTier
}

/** The tier requested when the deployment names none. */
const DEFAULT_TIER: MineruTier = 'basic'

/** MinerU configuration schema. */
export const Config: z<Config> = z.object({
  // 普通必填字段用 z.string()：新版 cordis 把 .required() 的取值包装成 Volatile 引用，
  // 会让这里的 Config 不再满足 z<Config> 的取值合同。与 dataops-integration 的 callbackOrigin 保持一致。
  endpoint: z.string(),
  // The union rejects a tier MinerU 4.x does not know. It carries no `.default('basic')`: under
  // the schemastery this package resolves (3.18.2) that default widens the field to
  // `MineruTier | Volatile<MineruTier>`, which no longer satisfies the `z<Config>` contract —
  // the same Volatile interaction that keeps `endpoint` a plain `z.string()`. `apply` supplies
  // the default instead.
  tier: z.union([
    z.const('flash'),
    z.const('basic'),
    z.const('standard'),
    z.const('advanced'),
  ]),
})

/** Cordis plugin name. */
export const name = 'mineru'
/** The tool registry must exist before MinerU registers. */
export const inject = ['tools']

/**
 * Artifacts named in the `output_formats` query parameter.
 *
 * `markdown` carries the text this tool returns and `structured_content` is the 4.x successor
 * of the `content_list` output. Both are sent as repeated query parameters: the server reads
 * `output_formats` as a list, so one comma-joined value is rejected as an unknown format.
 */
const OUTPUT_FORMATS = ['markdown', 'structured_content'] as const

/** Per-file `content` object of a 4.x result. */
interface MinerUFileContent {
  markdown?: unknown
  structured_content?: unknown
}

/** One entry of a 4.x result's `files` array. */
interface MinerUFileResult {
  name?: string
  status?: string
  error?: { code?: string; message?: string } | null
  content?: MinerUFileContent
}

/** 3.4.x inline result, kept readable so an older deployment still answers. */
interface MinerULegacyFileResult {
  md_content?: unknown
  content_list?: unknown
}

/** Body of either lineage's synchronous `/file_parse` response. */
interface MinerUPayload {
  status?: string
  files?: MinerUFileResult[]
  error?: { code?: string; message?: string } | null
  results?: Record<string, MinerULegacyFileResult>
}

function parseArchive(sourcePath: string, archive: Uint8Array): MinerUResult {
  const entries = Object.entries(unzipSync(archive)).filter(([entry]) => !entry.endsWith('/'))
  const markdown = entries.find(([entry]) => entry.toLowerCase().endsWith('.md'))
  if (markdown === undefined) {
    throw new Error('MinerU response does not contain Markdown output')
  }
  // 4.x renamed the content list to `structured_content`; accept both names so an archive from
  // either lineage yields the same field. A parse that returns Markdown but no content list is
  // still a successful parse, so this stays a missing optional rather than a hard failure.
  const contentList = entries.find(([entry]) => {
    const name = entry.toLowerCase()
    return name.endsWith('_content_list.json') || name.endsWith('structured_content.json')
  })
  return {
    sourcePath,
    markdown: new TextDecoder().decode(markdown[1]),
    contentList: contentList === undefined ? '' : new TextDecoder().decode(contentList[1]),
    images: entries
      .filter(([entry]) => entry.split('/').includes('images'))
      .map(([entry]) => entry),
  }
}

/** Render a content list the way `contentList` has always been shaped: a JSON string. */
function asJsonString(value: unknown): string {
  if (value === undefined || value === null) return ''
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function parseJsonResult(sourcePath: string, payload: unknown): MinerUResult {
  const body = payload as MinerUPayload
  if (body.error) {
    throw new Error(`MinerU refused the request (${body.error.code ?? 'error'}): ${body.error.message ?? 'no message'}`)
  }
  if (body.status !== undefined && body.status !== 'completed') {
    const detail = body.files?.find(file => file.error?.message)?.error?.message
    throw new Error(`MinerU parse did not complete (status ${body.status})${detail === undefined ? '' : `: ${detail}`}`)
  }
  const file = body.files?.[0]
  if (body.files !== undefined && file === undefined) {
    throw new Error('MinerU returned no file result')
  }
  if (file !== undefined) {
    if (file.status !== 'completed') {
      throw new Error(`MinerU could not parse the file (status ${file.status ?? 'unknown'})${file.error?.message === undefined ? '' : `: ${file.error.message}`}`)
    }
    const markdown = file.content?.markdown
    if (typeof markdown !== 'string') {
      throw new Error('MinerU response does not contain Markdown output')
    }
    return {
      sourcePath,
      markdown,
      contentList: asJsonString(file.content?.structured_content),
      // The 4.x JSON response inlines only markdown and structured content; bitmaps travel in
      // the zip artifact, which a JSON parse does not download.
      images: [],
    }
  }
  const legacy = body.results === undefined ? undefined : Object.values(body.results)[0]
  if (legacy !== undefined && typeof legacy.md_content === 'string') {
    return {
      sourcePath,
      markdown: legacy.md_content,
      contentList: asJsonString(legacy.content_list),
      images: [],
    }
  }
  throw new Error('MinerU returned a response this tool does not recognise')
}

/** Read the server's own explanation out of a rejected response. */
async function describeHttpFailure(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  try {
    const body = JSON.parse(text) as {
      error?: { code?: string; message?: string }
      detail?: unknown
      message?: unknown
    }
    const message = body.error?.message
      ?? (typeof body.detail === 'string' ? body.detail : undefined)
      ?? (typeof body.message === 'string' ? body.message : undefined)
    if (message !== undefined) return `MinerU returned HTTP ${String(response.status)}: ${message}`
  } catch {
    // Not JSON; the raw body below is the best evidence left.
  }
  const suffix = text.trim() === '' ? '' : `: ${text.trim().slice(0, 200)}`
  return `MinerU returned HTTP ${String(response.status)}${suffix}`
}

async function parsePdf(
  endpoint: string,
  tier: MineruTier,
  filePath: string,
  signal: AbortSignal,
): Promise<MinerUResult> {
  const data = await readFile(filePath, { signal })
  const url = new URL(endpoint)
  // Both values must be named explicitly. MinerU 4.x takes the parse options from the query
  // string only: the multipart body accepts a single `files` field and rejects anything else
  // with `Too many fields. Maximum number of fields is 0.`, so options sent as form fields
  // never reach the parser.
  url.searchParams.set('tier', tier)
  url.searchParams.delete('output_formats')
  for (const format of OUTPUT_FORMATS) url.searchParams.append('output_formats', format)
  const form = new FormData()
  form.append('files', new Blob([new Uint8Array(data)], { type: 'application/pdf' }), basename(filePath))
  const response = await fetch(url, { method: 'POST', body: form, signal })
  const contentType = response.headers.get('content-type') ?? ''
  if (!response.ok) throw new Error(await describeHttpFailure(response))
  if (contentType.includes('zip')) {
    return parseArchive(filePath, new Uint8Array(await response.arrayBuffer()))
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('MinerU returned a response that is neither JSON nor an archive')
  }
  return parseJsonResult(filePath, payload)
}

/** Register the direct MinerU PDF parsing tool. */
export function apply(ctx: Context, config: Config): void {
  const tier = config.tier ?? DEFAULT_TIER
  ctx.tools.register(defineTool({
    name: 'mineru_parse_pdf',
    description: 'Parse a PDF with MinerU. Pass the exact read-only file path shown in the uploaded-file message. Use this for PDF text, tables, reading order, and OCR; use OfficeCLI for DOCX, XLSX, and PPTX files.',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Exact PDF path from the uploaded-file message.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sourcePath: { type: 'string', required: true },
          markdown: { type: 'string', required: true },
          contentList: { type: 'string', required: true },
          images: {
            type: 'array',
            items: { type: 'string' },
            required: true,
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `MinerU parsed ${value.sourcePath}.\n\n${value.markdown}`,
      }],
    },
    isConcurrencySafe: () => true,
    execute: (args: { file_path: string }, exec: ToolRunContext) =>
      parsePdf(config.endpoint, tier, args.file_path, exec.signal),
    presentCall: args => ({
      card: 'generic',
      title: `Parse ${basename(args.file_path)}`,
      kind: 'read',
      locations: [{ path: args.file_path }],
    }),
  }))
}
