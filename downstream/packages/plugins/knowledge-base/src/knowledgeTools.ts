/**
 * Model-facing knowledge-base file tools (`kb_file_*`).
 *
 * The mounted tree is the one retrieval reads, but the plugin's write path is not
 * "put bytes on disk": it decides permissions through DataOps, records an audit entry,
 * keeps the caller's view in sync and records removals as tombstones. A shell write
 * bypasses all of that, so the model gets tools that go through the same host
 * operations as the HTTP routes.
 *
 * This module owns argument validation, path-level permission checks and the tool
 * result shape. Which tools exist is decided once per permission context by
 * `toolDisclosure.ts`; the path checks here decide which data a visible tool may
 * touch and are therefore kept. The host object is supplied by `index.ts`; it is the
 * seam that reuses the existing `canReadPath` / `canWritePath` /
 * `listDirectoryWithPermissions` / `readKnowledgeFile` / `createKnowledgeEntry` /
 * `moveEntry` implementations, and it is what tests replace without importing the
 * whole plugin.
 *
 * @module @sparkelf/dsh-knowledge-base/knowledgeTools
 */
import type { FtsIndexStats, FtsSearchHit, FtsSearchResult } from './ftsIndex.ts'
import { isIndexableTextPath } from './ftsIndex.ts'
import type { OutlineKeyFact, OutlineTocEntry } from './outlineText.ts'
import type { OutlineSectionSubmission, OutlineSummaryKind } from './outlineGuard.ts'
import type { OutlineSaveResult } from './ftsIndex.ts'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isContainedRelPath } from './views.ts'
import { resolveScopeAlias, scopeFromAlias, type CanonicalScope } from './scopeAliases.ts'
import type { KnowledgeAuditEntry } from './views.ts'

/** Error codes a tool may report to the model. */
export type KnowledgeToolErrorCode =
  // The four LocalPathRefusal codes, kept verbatim so a personal deployment reports
  // the same reason the HTTP routes do.
  | 'empty-path'
  | 'nul-byte'
  | 'absolute-path'
  | 'escapes-knowledge-root'
  // Permission / state, deliberately distinct so the model can tell "not yours" from
  // "not there" from "bad path".
  | 'forbidden'
  | 'not-found'
  | 'exists'
  | 'too-large'
  | 'binary'
  | 'not-a-directory'
  | 'not-a-file'
  | 'not-configured'
  | 'unauthorized'
  | 'unreachable'
  | 'bad-response'
  | 'write-failed'
  | 'invalid-regex'
  | 'invalid-citation'
  | 'invalid-summary'
  | 'invalid'

/** Structured, model-readable failure. Thrown; never returned as a silent `false`. */
export class KnowledgeToolError extends Error {
  readonly code: KnowledgeToolErrorCode
  readonly path?: string

  constructor(code: KnowledgeToolErrorCode, message: string, path?: string) {
    super(path === undefined ? message : `${message} (path: ${path})`)
    this.name = 'KnowledgeToolError'
    this.code = code
    this.path = path
  }
}

/** The identity a tool call acts as. */
export interface KnowledgeToolCaller {
  userId: string
  label?: string
}

/** One directory row, in view-relative coordinates. */
export interface KnowledgeFileEntry {
  relPath: string
  name: string
  isDir: boolean
  size?: number
  mtimeMs?: number
  canExtract?: boolean
  hasMarkdown?: boolean
}

/** One search hit, in view-relative coordinates. */
export interface KnowledgeFileHit {
  relPath: string
  name: string
  inContent: boolean
  line?: string
  lineNumber?: number
  mtimeMs?: number
}

/** One outline section as `kb_outline` returns it: navigation, never evidence. */
export interface KnowledgeOutlineSection {
  sectionId: string
  /** Full heading path (`第三章 > 第二十二条`). */
  sectionPath: string
  /** 1-based depth; 1 is a chapter/top-level heading. */
  level: number
  summary: string
  keyFacts: OutlineKeyFact[]
  /** Chunks whose own heading is this section. */
  chunkIds: number[]
  /** Every chunk under this section, including descendants. */
  sourceChunkIds: number[]
}

/** A document's INDEX.md outline. No chapter body is included. */
export interface KnowledgeOutline {
  docId: number
  /** Original source path (citable document). */
  path: string
  displayPath?: string
  summary: string
  /** How the current summary was produced. */
  summaryKind?: OutlineSummaryKind
  /** `missing` until the knowledge-base summarize flow saves a model-authored summary. */
  summaryStatus?: 'ready' | 'missing'
  /** Actionable next step when the summary is missing. */
  hint?: string
  summaryVersion?: string
  /** Source chunk ids behind the document summary. */
  sourceChunkIds?: number[]
  toc: OutlineTocEntry[]
  sections: KnowledgeOutlineSection[]
  /** Absolute path of the generated `/nas/kb/index/md/<docId>.INDEX.md`. */
  indexPath: string
}

/** What reading a file produced. */
export type KnowledgeFileRead =
  | { kind: 'text'; content: string; truncated: boolean; mtimeMs?: number }
  | { kind: 'binary'; size: number }

/** Audit outcome for a completed write: never turns a successful write into a failure. */
export type KnowledgeAuditOutcome =
  | { written: true }
  | { written: false; reason: string }

/** A view refresh that failed after the write itself succeeded. */
export type KnowledgeViewSync = { failure?: string }

/**
 * The host operations the tools compose.
 *
 * Every method is the SAME implementation an HTTP route uses. The host owns permission
 * policy and filesystem layout; this module never derives a root or a grant itself.
 */
export interface KnowledgeFileToolHost {
  /** Resolve the caller (team: DataOps `/auth/me`; personal: the local operator). */
  resolveCaller(): Promise<KnowledgeToolCaller>
  /** FTS5 search over the sidecar index, already scoped to the caller. */
  searchIndex?(input: { query: string; scope?: string; topK: number }): Promise<FtsSearchResult>
  /** Incremental index sync. */
  syncIndex?(): Promise<FtsIndexStats>
  /** Explicitly vectorize one document, a directory subtree, or all targets. */
  vectorize?(input: {
    docId?: number
    path?: string
    scope?: string
    rebuild?: boolean
    dryRun?: boolean
  }): Promise<Record<string, unknown>>
  /** Resolve a citation token to its original source + anchors. */
  chunkGet?(input: { docId: number; chunkId: number | string }): Promise<{
    docId: number
    chunkId: number
    chunkKey?: string
    citation?: string
    path: string
    quote?: string
    heading?: string
    paragraph?: number
    chunkOrdinal?: number
    paragraphText?: string
    sheet?: string
    cell?: string
    page?: number
    boxes: import('./ftsIndex.ts').FtsChunkBox[]
    snippet: string
  }>
  /** Read/build one document outline, already permission-checked by the host. */
  outline?(input: { docId: number }): Promise<KnowledgeOutline>
  /** Re-render INDEX.md from stored summaries; never regenerates summary text. */
  outlineRewrite?(input: { docId: number }): Promise<{ indexPath: string }>
  /** Persist one model-authored outline after the host checked read+write permission. */
  outlineSave?(input: {
    docId: number
    summary: string
    sections: readonly OutlineSectionSubmission[]
    summaryVersion?: string
  }): Promise<OutlineSaveResult | undefined>
  canRead(relPath: string): Promise<boolean>
  canWrite(relPath: string): Promise<boolean>
  /**
   * Default bucket for a path that names no scope at all.
   *
   * A team deployment answers `personal`: a bare relative path is the caller's
   * own tree, never the shared root that the view renders as `global`. A local
   * deployment omits this, keeping the legacy flat top-level path.
   */
  defaultScope?(): CanonicalScope | undefined
  /** One view directory level, already filtered by `canReadPath`. */
  list(relPath: string, caller: KnowledgeToolCaller): Promise<KnowledgeFileEntry[]>
  /** Search under one view-relative scope. */
  search(scope: string, query: string, limit: number): Promise<KnowledgeFileHit[]>
  /** Path boundary + `canReadPath` + `readKnowledgeFile`, shared with the read route. */
  readAuthorized(relPath: string): Promise<KnowledgeFileRead>
  statEntry(relPath: string): Promise<{ kind: 'file' | 'directory'; size?: number } | undefined>
  createEntry(
    relPath: string,
    options: { directory: boolean; content?: string; bytes?: Uint8Array },
  ): Promise<{ relPath: string; kind: 'file' | 'directory' }>
  /** Overwrite an existing file in place, preserving its inode/view hardlink. */
  overwriteFile(relPath: string, content: string): Promise<void>
  /**
   * Overwrite an existing BINARY file in place, preserving its inode/view hardlink.
   *
   * Separate from {@link overwriteFile} because a text body and a byte body are not
   * interchangeable: decoding bytes as UTF-8 replaces every non-text byte. Omitting it
   * makes a base64 overwrite fail with a clear error instead of writing a broken file.
   */
  overwriteFileBytes?(relPath: string, bytes: Uint8Array): Promise<void>
  moveEntry(from: string, to: string, caller: KnowledgeToolCaller): Promise<{ from: string; to: string }>
  /** Record a tombstone in the caller's trash; never unlinks bytes. */
  deleteToTrash(caller: KnowledgeToolCaller, relPath: string, kind: 'file' | 'directory'): Promise<void>
  refreshView(expectVisible?: string): Promise<KnowledgeViewSync>
  readSettings(caller: KnowledgeToolCaller): Promise<{ reviewRequired?: boolean; mineruBaseUrl?: string }>
  parkWrite(caller: KnowledgeToolCaller, relPath: string, content: string): Promise<void>
  /**
   * Index one document that was just written and report whether it is searchable.
   *
   * Called only for text formats, where indexing is the whole pipeline: a document
   * with a reader (PDF/DOCX/XLSX) goes through {@link enqueueExtraction} instead,
   * whose worker indexes the derived Markdown once it exists. Omitting the method
   * makes a tool report `skipped` rather than claiming a write was indexed.
   */
  indexAfterWrite?(relPath: string): Promise<{
    status: 'indexed' | 'indexing' | 'skipped' | 'failed'
    docId?: number
    chunks?: number
    indexedAt?: number
    reason?: string
  }>
  /** Enqueue one document; mirrors the manual extraction route's outcomes. */
  enqueueExtraction(
    relPath: string,
    caller: KnowledgeToolCaller,
    options?: {
      /**
       * Replace an existing derived `.md` sibling.
       *
       * Set when the source was overwritten: the sibling beside it describes the old
       * bytes, and the create-only extraction path would refuse to touch it.
       */
      replaceSibling?: boolean
    },
  ): Promise<{ outcome: 'already-markdown' | 'unsupported' | 'exists' | 'queued'; markdown?: string; task?: unknown }>
  /** Extractable files under the authoritative root that have no `.md` sibling yet. */
  listExtractCandidates(limit: number): Promise<string[]>
  viewDir(userId: string): string
  appendAudit(viewDir: string, entry: KnowledgeAuditEntry): Promise<void>
  isExtractable(relPath: string): boolean
  now?(): Date
}

const open = { type: 'object', additionalProperties: true } as const
const jsonOutput = {
  schema: open,
  render: (_args: unknown, value: unknown) => [{
    type: 'text' as const,
    text: JSON.stringify(value, null, 2),
  }],
}

/** The stable citation token every search hit and chunk response must carry. */
const citationFor = (docId: number, chunkKey: string | undefined, chunkId: number): string => (
  `kb://doc/${String(docId)}/chunk/${String(chunkKey === undefined || chunkKey === '' ? chunkId : chunkKey)}`
)

/** The sentence every tool carries: use these tools, not the shell. */
export const KB_FILE_TOOL_GUIDANCE =
  ' Knowledge-base files only. Use the kb_file_* tools; do NOT create, modify, move or delete knowledge files with shell commands — shell writes bypass DataOps permission checks and audit. '
  + 'Use kb_search for this mounted tree; the DataOps kb_read/kb_context tools are Resource-Wiki retrieval over docIds, not this tree. '
  + 'Knowledge-base citations use the stable token `kb://doc/<docId>/chunk/<key>` returned as `citation`; when citing, copy that token verbatim and never write a line number, `第N块`, a `path:line` pair, or a derived `.docx.md`/`.pdf.md` path.'

const TOOL_CODES = new Set<string>([
  'empty-path', 'nul-byte', 'absolute-path', 'escapes-knowledge-root',
  'forbidden', 'not-found', 'exists', 'too-large', 'binary', 'not-a-directory',
  'not-a-file', 'not-configured', 'unauthorized', 'unreachable', 'bad-response',
  'write-failed', 'invalid-summary',
])

const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
)

/** Map a host failure to a structured tool error without losing its code. */
export const asKnowledgeToolError = (error: unknown, path?: string): KnowledgeToolError => {
  if (error instanceof KnowledgeToolError) return error
  const code = (error as { code?: unknown }).code
  if (typeof code === 'string' && TOOL_CODES.has(code)) {
    return new KnowledgeToolError(code as KnowledgeToolErrorCode, messageOf(error), path)
  }
  // Filesystem errors are not part of the tool vocabulary; map the two a caller can
  // act on instead of reporting every missing file as a write failure.
  if (code === 'ENOENT') return new KnowledgeToolError('not-found', 'no such file or directory', path)
  if (code === 'EACCES' || code === 'EPERM') {
    return new KnowledgeToolError('forbidden', 'the filesystem refused access to this path', path)
  }
  return new KnowledgeToolError('write-failed', messageOf(error), path)
}

/**
 * Validate one model-supplied path in view coordinates.
 *
 * Empty is allowed only where the root itself is the argument (list/search/extract-all);
 * everything else is refused with the same four codes `checkLocalPath` uses.
 *
 * `defaultScope` decides what a path with NO bucket prefix means. When omitted
 * the legacy behaviour is kept (a bare top-level path). A team deployment passes
 * `personal`, so `个人记忆图谱/…` without a bucket resolves inside the caller's
 * own tree instead of becoming an unowned top-level path that the view shows as
 * `global`. Explicit `global/`, `department/` and `personal/` spellings (and
 * their localized aliases) are never rewritten.
 */
export const assertToolPath = (
  value: unknown,
  allowRoot = false,
  defaultScope?: CanonicalScope,
): string => {
  const relPath = typeof value === 'string' ? value.trim() : ''
  if (relPath === '' && allowRoot) return ''
  if (relPath === '') throw new KnowledgeToolError('empty-path', 'the path is empty')
  if (relPath.includes('\0')) throw new KnowledgeToolError('nul-byte', 'the path contains a NUL byte', relPath)
  if (relPath.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(relPath)) {
    throw new KnowledgeToolError('absolute-path', 'the path must be relative to the knowledge root', relPath)
  }
  if (!isContainedRelPath(relPath)) {
    throw new KnowledgeToolError(
      'escapes-knowledge-root',
      'the path leaves the knowledge root; "..", "." and empty segments are not allowed',
      relPath,
    )
  }
  // Every model entry accepts the localized virtual bucket names; ACL/index see canonical.
  const canonical = resolveScopeAlias(relPath)
  if (canonical === '' || defaultScope === undefined) return canonical
  const head = canonical.split('/')[0] ?? ''
  if (scopeFromAlias(head) !== undefined) return canonical
  return `${defaultScope}/${canonical}`
}

/** `assertToolPath` with the host's deployment-specific default bucket applied. */
const scopedToolPath = (
  host: KnowledgeFileToolHost,
  value: unknown,
  allowRoot = false,
): string => assertToolPath(value, allowRoot, host.defaultScope?.())

const requireRead = async (host: KnowledgeFileToolHost, relPath: string): Promise<void> => {
  if (!await host.canRead(relPath)) {
    throw new KnowledgeToolError('forbidden', 'read access is required for this path', relPath)
  }
}

const requireWrite = async (host: KnowledgeFileToolHost, relPath: string): Promise<void> => {
  if (!await host.canWrite(relPath)) {
    throw new KnowledgeToolError('forbidden', 'write access is required for this path', relPath)
  }
}

const auditWrite = async (
  host: KnowledgeFileToolHost,
  caller: KnowledgeToolCaller,
  action: KnowledgeAuditEntry['action'],
  relPath: string,
  toRelPath?: string,
): Promise<KnowledgeAuditOutcome> => {
  try {
    await host.appendAudit(host.viewDir(caller.userId), {
      at: (host.now?.() ?? new Date()).toISOString(),
      actor: caller.userId,
      ...(caller.label === undefined ? {} : { actorLabel: caller.label }),
      action,
      relPath,
      ...(toRelPath === undefined ? {} : { toRelPath }),
      outcome: 'applied',
    })
    return { written: true }
  } catch (error) {
    return { written: false, reason: messageOf(error) }
  }
}

const refreshResult = (refresh: KnowledgeViewSync): Record<string, unknown> => (
  refresh.failure === undefined
    ? {}
    : { viewSync: { warning: 'the change was saved, but the file tree could not be refreshed', reason: refresh.failure } }
)

const run = async (
  path: string | undefined,
  operation: () => Promise<Record<string, unknown>>,
): Promise<Record<string, any>> => {
  try {
    return await operation()
  } catch (error) {
    throw asKnowledgeToolError(error, path)
  }
}

/**
 * Decode a base64 payload written through {@link kb_file_write}.
 *
 * The tool writes binary documents (PDF/DOCX/XLSX) by decoding here rather than
 * accepting a string of bytes: the model produces base64, and an invalid payload must
 * fail the call instead of writing a file no reader can open. Whitespace is tolerated
 * because a model (or a shell here-doc) may wrap a long payload across lines.
 * @param content - the base64 text.
 * @returns the decoded bytes.
 */
const decodeBase64Payload = (content: string): Uint8Array => {
  const compact = content.replace(/\s+/gu, '')
  if (compact === '') return new Uint8Array()
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(compact) || compact.length % 4 !== 0) {
    throw new KnowledgeToolError('invalid', 'content is not valid base64; pass encoding:"base64" with a padded base64 payload')
  }
  return Buffer.from(compact, 'base64')
}

/**
 * Finish the pipeline for a document that was just written.
 *
 * A write is not finished when the bytes land: search reads the sidecar index, and a
 * document that is not in it is invisible to `kb_search` and to the knowledge page's
 * status column. The pipeline differs by format, and running both halves would index a
 * document twice:
 *
 * - A format with a reader (PDF/DOCX/XLSX/…): enqueue extraction. That queue already
 *   chunks and indexes the derived `.md` sibling when it finishes, so this reports the
 *   extraction handle and explicitly does NOT index the binary.
 * - A text format (Markdown/TXT/CSV/…): index it directly. There is nothing to extract.
 * - Anything else: report `skipped` with the reason.
 *
 * A failing index is a status on an already-successful write, never a write failure:
 * the bytes are durable and the next index pass retries.
 *
 * @param host - the file-tool host seam.
 * @param relPath - the view-relative path that was written.
 * @param caller - the caller the write acted as.
 * @param options.replaceSibling - set when the source was overwritten.
 * @returns the `extraction` and/or `index` fields the tool result carries.
 */
async function completeWritePipeline(
  host: KnowledgeFileToolHost,
  relPath: string,
  caller: KnowledgeToolCaller,
  options: { replaceSibling?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (host.isExtractable(relPath)) {
    const extraction = await host.enqueueExtraction(relPath, caller, options)
    return {
      extraction,
      index: {
        status: extraction.outcome === 'queued' ? 'pending-extraction' : 'skipped',
        message: extraction.outcome === 'queued'
          ? 'the .md sibling is produced asynchronously; chunking and indexing run when it is written'
          : 'this document was not queued for extraction',
      },
    }
  }
  if (!isIndexableTextPath(relPath)) {
    return {
      index: { status: 'skipped', reason: 'this file type is neither extractable nor plain text the index can read' },
    }
  }
  if (host.indexAfterWrite === undefined) {
    return { index: { status: 'skipped', reason: 'this deployment has no index' } }
  }
  try {
    return { index: await host.indexAfterWrite(relPath) }
  } catch (error) {
    return { index: { status: 'failed', reason: messageOf(error) } }
  }
}

/**
 * Build the knowledge-base model-facing tools.
 *
 * Returned definitions are registered by `apply` through the permission-based
 * disclosure coordinator; tests call the same definitions with a fake host to assert
 * path, audit and result behaviour without a live backend or a permission backend.
 */
export const createKnowledgeFileTools = (host: KnowledgeFileToolHost) => [
  defineTool({
    name: 'kb_file_write',
    description: 'Create or overwrite one knowledge file, with DataOps permission checks and audit. '
      + 'The write also completes the retrieval pipeline: a PDF/DOCX/XLSX/PPTX is queued for extraction and its '
      + 'derived Markdown is chunked and indexed when extraction finishes (read the returned extraction task with '
      + 'extract.status); Markdown/TXT/CSV is indexed immediately and the returned index row is the proof. '
      + 'For a binary document pass encoding:"base64" with the document bytes encoded as base64 rather than a text body. '
      + 'A shell copy into the mounted tree does NOT do any of this and can be deleted by the next view sync.'
      + KB_FILE_TOOL_GUIDANCE,
    parameters: {
      path: { type: 'string', required: true, description: 'View-relative destination path.' },
      content: {
        type: 'string',
        required: true,
        description: 'UTF-8 text content, or the base64 document bytes when encoding is "base64".',
      },
      encoding: {
        type: 'string',
        enum: ['utf8', 'base64'],
        description: 'How to decode content. "utf8" (default) writes text; "base64" writes binary documents such as PDF/DOCX/XLSX.',
      },
      overwrite: { type: 'boolean', description: 'Replace an existing file in place; default false (existing path is an error).' },
    },
    output: jsonOutput,
    execute: async (args: { path: string; content: string; encoding?: string; overwrite?: boolean }) => run(args.path, async () => {
      const relPath = scopedToolPath(host, args.path)
      const caller = await host.resolveCaller()
      const encoding = args.encoding === 'base64' ? 'base64' : 'utf8'
      const content = typeof args.content === 'string' ? args.content : ''
      const bytes = encoding === 'base64' ? decodeBase64Payload(content) : undefined
      const body = bytes === undefined ? content : undefined
      const byteLength = bytes === undefined ? Buffer.byteLength(content, 'utf8') : bytes.byteLength
      await requireWrite(host, relPath)
      const existing = await host.statEntry(relPath)
      if (existing !== undefined && existing.kind !== 'file') {
        throw new KnowledgeToolError('not-a-file', 'a directory exists at this path', relPath)
      }
      if (existing !== undefined && args.overwrite !== true) {
        throw new KnowledgeToolError('exists', 'a document already exists; pass overwrite:true to replace it', relPath)
      }

      if (existing === undefined) {
        const settings = await host.readSettings(caller)
        if (settings.reviewRequired === true) {
          // A parked write has no bytes on disk yet, so there is nothing to extract or
          // index. The pipeline runs when an approver applies the submission. The
          // parking format stores UTF-8 text; a binary body would be corrupted by that
          // round trip, so it is refused instead of silently mangled.
          if (bytes !== undefined) {
            throw new KnowledgeToolError(
              'invalid',
              'this path currently holds binary content that cannot be parked for review; use the knowledge page upload, or turn review off for this knowledge base',
              relPath,
            )
          }
          await host.parkWrite(caller, relPath, content)
          const audit = await auditWrite(host, caller, 'create', relPath)
          return { ok: true, path: relPath, pending: true, reviewRequired: true, audit }
        }
        await host.createEntry(relPath, {
          directory: false,
          ...(body === undefined ? { bytes } : { content: body }),
        })
        const refresh = await host.refreshView(relPath).catch((error: unknown) => ({ failure: messageOf(error) }))
        const audit = await auditWrite(host, caller, 'create', relPath)
        const pipeline = await completeWritePipeline(host, relPath, caller)
        return {
          ok: true,
          path: relPath,
          created: true,
          encoding,
          bytes: byteLength,
          audit,
          ...refreshResult(refresh),
          ...pipeline,
        }
      }

      if (bytes === undefined) {
        await host.overwriteFile(relPath, content)
      } else if (host.overwriteFileBytes !== undefined) {
        await host.overwriteFileBytes(relPath, bytes)
      } else {
        throw new KnowledgeToolError('invalid', 'this deployment cannot overwrite a binary document in place', relPath)
      }
      const refresh = await host.refreshView(relPath).catch((error: unknown) => ({ failure: messageOf(error) }))
      const audit = await auditWrite(host, caller, 'edit', relPath)
      // The source changed, so its derived `.md` describes the old bytes. Extraction is
      // allowed to replace that sibling; without this an overwritten DOCX would stay
      // searchable by its previous text.
      const pipeline = await completeWritePipeline(host, relPath, caller, { replaceSibling: true })
      return {
        ok: true,
        path: relPath,
        created: false,
        overwritten: true,
        encoding,
        bytes: byteLength,
        audit,
        ...refreshResult(refresh),
        ...pipeline,
      }
    }),
  }),

  defineTool({
    name: 'kb_file_move',
    description: 'Move or rename one knowledge file or folder. ' + KB_FILE_TOOL_GUIDANCE,
    parameters: {
      from: { type: 'string', required: true, description: 'View-relative source path.' },
      to: { type: 'string', required: true, description: 'Destination directory, or a full destination path when renaming.' },
    },
    output: jsonOutput,
    execute: async (args: { from: string; to: string }) => run(args.from, async () => {
      const from = scopedToolPath(host, args.from)
      const to = scopedToolPath(host, args.to, true)
      await requireWrite(host, from)
      const caller = await host.resolveCaller()
      const targetEntry = to === '' ? undefined : await host.statEntry(to)
      const toIsDirectory = to === '' || targetEntry?.kind === 'directory'
      const baseName = from.split('/').pop() ?? ''
      const target = toIsDirectory
        ? (to === '' ? baseName : `${to}/${baseName}`)
        : to
      if (!isContainedRelPath(target)) {
        throw new KnowledgeToolError('escapes-knowledge-root', 'the destination is not contained', target)
      }
      if (target === from) return { ok: true, from, to: target, unchanged: true }
      // Moving to the root has no destination parent to authorize; the source write
      // already covers removing it, matching the move route's existing rule.
      if (to !== '') await requireWrite(host, toIsDirectory ? to : target)
      const moved = await host.moveEntry(from, target, caller)
      const refresh = await host.refreshView(moved.to).catch((error: unknown) => ({ failure: messageOf(error) }))
      const audit = await auditWrite(host, caller, 'move', moved.from, moved.to)
      return { ok: true, ...moved, audit, ...refreshResult(refresh) }
    }),
  }),

  defineTool({
    name: 'kb_search',
    description: 'Search the knowledge base with the FTS5/BM25 index (main recall and ranking). Chinese and English are supported. '
      + 'Call this first for factual questions. Multi-word queries automatically relax to per-token search when the phrase has fewer than two hits; '
      + 'check relaxed/queries in the result. If evidence is still insufficient, run at most two more token/synonym searches or use rg inside /workspace/kb; '
      + 'do NOT walk directories with ls to hunt for an answer. '
      + 'Every hit carries a stable `citation` token whose body is `kb://doc/<docId>/chunk/<key>` (a `?terms=` suffix is only a viewer highlight hint). '
      + 'When you cite, write that token body verbatim as inline code and omit any `?terms=`/`&highlight=` suffix. Never write a line number (`:193`), `第N块`, a `path:line` pair, '
      + 'or a derived `.docx.md`/`.pdf.md` path — the viewer renders the token as `文件名:第N块` and opens the original file at that chunk’s bbox. '
      + 'PDF/scan hits also carry page/boxes; text/Markdown hits are addressed by the same chunk token. '
      + 'For broad, comparison or "difference/区别" questions, call kb_outline(docId) FIRST to see the document summary and chapter list, then search inside the relevant chapters. '
      + 'When the index has an outline, hits also carry sectionId/sectionPath/sectionSummary/docSummary; these summaries are navigation only and MUST NOT be cited. '
      + 'relatedSections lists summary chunks that matched but are never citation evidence. '
      + 'Read the original only to verify wording; the citation is still the token. Results are already filtered by the caller identity and scope.',
    parameters: {
      query: { type: 'string', required: true, description: 'Natural-language or keyword query.' },
      scope: { type: 'string', description: 'Optional narrowing: personal | department | global. It can never widen access.' },
      topK: { type: 'number', description: 'Maximum hits (1-50, default 10).' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    execute: async (args: { query: string; scope?: string; topK?: number }) => run(undefined, async () => {
      if (host.searchIndex === undefined) throw new KnowledgeToolError('not-configured', 'knowledge index is unavailable')
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (query === '') throw new KnowledgeToolError('empty-path', 'query must be non-empty')
      const result = await host.searchIndex({ query, ...(args.scope === undefined ? {} : { scope: args.scope }), topK: args.topK ?? 10 })
      // The model gets the original path + quote/anchor fields. The derived
      // Markdown path is an internal routing detail and would tempt the model to
      // cite a `.docx.md`/`.pdf.md` file that the user never created.
      // Whitelist the model-facing shape instead of spreading the host hit. The
      // derived markdownPath is an internal routing detail; spreading it (even
      // after destructuring) is too easy to regress and the model then cites
      // `docx.md:line`, which is not a user document.
      const hits = result.hits.map(hit => ({
        citation: hit.citation ?? citationFor(hit.docId, hit.chunkKey, hit.chunkId),
        path: hit.path,
        ...(hit.displayPath === undefined ? {} : { displayPath: hit.displayPath }),
        snippet: hit.snippet,
        score: hit.score,
        docId: hit.docId,
        chunkId: hit.chunkId,
        ...(hit.heading === undefined ? {} : { heading: hit.heading }),
        ...(hit.sectionId === undefined ? {} : { sectionId: hit.sectionId }),
        ...(hit.sectionPath === undefined ? {} : { sectionPath: hit.sectionPath }),
        ...(hit.sectionSummary === undefined ? {} : { sectionSummary: hit.sectionSummary }),
        ...(hit.sectionLevel === undefined ? {} : { sectionLevel: hit.sectionLevel }),
        ...(hit.docSummary === undefined ? {} : { docSummary: hit.docSummary }),
        ...(hit.paragraph === undefined ? {} : { paragraph: hit.paragraph }),
        ...(hit.chunkOrdinal === undefined ? {} : { chunkOrdinal: hit.chunkOrdinal }),
        ...(hit.chunkKey === undefined ? {} : { chunkKey: hit.chunkKey }),
        ...(hit.paragraphText === undefined ? {} : { paragraphText: hit.paragraphText }),
        ...(hit.quote === undefined ? {} : { quote: hit.quote }),
        ...(hit.matchedTerms === undefined ? {} : { matchedTerms: hit.matchedTerms }),
        ...(hit.highlightText === undefined ? {} : { highlightText: hit.highlightText }),
        ...(hit.highlightRanges === undefined ? {} : { highlightRanges: hit.highlightRanges }),
        ...(hit.sheet === undefined ? {} : { sheet: hit.sheet }),
        ...(hit.cell === undefined ? {} : { cell: hit.cell }),
        ...(hit.page === undefined ? {} : { page: hit.page }),
        ...(hit.bbox === undefined ? {} : { bbox: hit.bbox }),
        ...(hit.blockIndex === undefined ? {} : { blockIndex: hit.blockIndex }),
        ...(hit.occurrence === undefined ? {} : { occurrence: hit.occurrence }),
        ...(hit.approximate === undefined ? {} : { approximate: hit.approximate }),
        ...(hit.boxes === undefined ? {} : { boxes: hit.boxes }),
        ...(hit.retrieval === undefined ? {} : { retrieval: hit.retrieval }),
        ...(hit.ftsRank === undefined ? {} : { ftsRank: hit.ftsRank }),
        ...(hit.vectorRank === undefined ? {} : { vectorRank: hit.vectorRank }),
        ...(hit.rrfScore === undefined ? {} : { rrfScore: hit.rrfScore }),
        ...(hit.ftsScore === undefined ? {} : { ftsScore: hit.ftsScore }),
        ...(hit.vectorScore === undefined ? {} : { vectorScore: hit.vectorScore }),
        ...(hit.retrievalReason === undefined ? {} : { retrievalReason: hit.retrievalReason }),
      }))
      return {
        ok: true,
        query,
        count: hits.length,
        relaxed: result.relaxed,
        queries: result.queries,
        hits,
        ...(result.retrieval === undefined ? {} : { retrieval: result.retrieval }),
        ...(result.floorReplacements === undefined ? {} : { floorReplacements: result.floorReplacements }),
        ...(result.vectorWarning === undefined ? {} : { vectorWarning: result.vectorWarning }),
        ...(result.relatedSections === undefined || result.relatedSections.length === 0 ? {} : {
          relatedSections: result.relatedSections.map(section => ({ ...section, navigationOnly: true })),
        }),
      }
    }),
  }),

  defineTool({
    name: 'kb_vectorize',
    description: 'Explicitly build/refresh the optional vector index for ONE document or ONE directory subtree. '
      + 'Use only when the user asks to vectorize / 建向量索引 / 补向量 for a named document or directory; never run it on the whole library on your own. '
      + 'Requires read access to every target; unauthorized documents are skipped and reported. '
      + 'When vector retrieval is disabled or has no provider, the tool fails loudly instead of silently falling back. '
      + 'dryRun estimates without writing; rebuild refreshes current chunks, otherwise only missing/stale vectors are written. '
      + 'Vectors affect recall only: citations, chunk tokens, summaries and outlines do not change.',
    parameters: {
      docId: { type: 'number', description: 'One document id from kb_search/kb_file_list.' },
      path: { type: 'string', description: 'View-relative file or directory path. A directory is processed recursively.' },
      scope: { type: 'string', description: 'Optional personal|department|global narrowing.' },
      rebuild: { type: 'boolean', description: 'Re-embed current chunks even when their model/hash is current.' },
      dryRun: { type: 'boolean', description: 'Count what would be embedded without calling the provider or writing.' },
    },
    output: jsonOutput,
    execute: async (args: { docId?: number; path?: string; scope?: string; rebuild?: boolean; dryRun?: boolean }) => run(args.path, async () => {
      if (host.vectorize === undefined) throw new KnowledgeToolError('not-configured', 'vector indexing is unavailable')
      const hasDocId = args.docId !== undefined
      const hasPath = typeof args.path === 'string' && args.path.trim() !== ''
      if (hasDocId === hasPath) throw new KnowledgeToolError('invalid', 'provide exactly one of docId or path')
      if (args.scope !== undefined && !['personal', 'department', 'global'].includes(args.scope)) {
        throw new KnowledgeToolError('invalid', 'scope must be personal, department or global')
      }
      const targetPath = hasPath ? scopedToolPath(host, args.path) : undefined
      if (hasDocId && (!Number.isInteger(args.docId) || (args.docId as number) <= 0)) {
        throw new KnowledgeToolError('invalid', 'docId must be a positive integer')
      }
      return await host.vectorize({
        ...(hasDocId ? { docId: args.docId } : {}),
        ...(targetPath === undefined ? {} : { path: targetPath }),
        ...(args.scope === undefined ? {} : { scope: args.scope }),
        ...(args.rebuild === undefined ? {} : { rebuild: args.rebuild }),
        ...(args.dryRun === undefined ? {} : { dryRun: args.dryRun }),
      })
    }),
  }),

  defineTool({
    name: 'kb_chunk_get',
    description: 'Resolve a `kb://doc/<docId>/chunk/<key>` citation token to the original source path and anchors. '
      + 'Use this FIRST whenever the user gives a citation token or a previous hit’s `citation`. Accept either the full token '
      + '(`citation: "kb://doc/49/chunk/e63b7f9eda2d86cb"`) or `docId` plus `chunkId`; `chunkId` may be the numeric id or the '
      + 'stable 16-hex chunk_key. It returns `citation`, original `path`, `quote` (plain text for viewer search), `heading`/`paragraphText`, '
      + '`sheet`/`cell`, `page`/`boxes`, `chunkOrdinal` and `snippet`; it never returns internal Markdown/index paths. '
      + 'Copy the returned `citation` token verbatim when citing; do not turn it into a line or block number. '
      + 'Do NOT use shell, sqlite3, .dataops or kb-index.sqlite to resolve a token; if this tool is unavailable, say so plainly.',
    parameters: {
      citation: { type: 'string', description: 'Full `kb://doc/<docId>/chunk/<key>` token; alternative to docId+chunkId.' },
      docId: { type: 'number', description: 'Document id from the token.' },
      chunkId: {
        oneOf: [
          { type: 'number', description: 'Legacy numeric chunk id.' },
          { type: 'string', description: 'Stable 16-hex chunk_key or a numeric chunk id as text.' },
        ],
        description: 'Chunk key or numeric chunk id from the token.',
      },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    execute: async (args: { citation?: string; docId?: number; chunkId?: number | string }) => run(undefined, async () => {
      if (host.chunkGet === undefined) throw new KnowledgeToolError('not-configured', 'knowledge chunk resolver is unavailable')
      // The token is authoritative: it is what the model and viewer share. Accepting
      // docId+chunkId as well keeps the tool usable when a caller already split it.
      const fromToken = typeof args.citation === 'string'
        ? /^kb:\/\/doc\/([^/\s?#]+)\/chunk\/([^/\s?#]+)/i.exec(args.citation.trim())
        : null
      const docId = Number(fromToken?.[1] ?? args.docId)
      if (!Number.isInteger(docId) || docId <= 0) {
        throw new KnowledgeToolError('invalid-citation', 'docId must be a positive integer')
      }
      const rawChunk = fromToken?.[2] ?? args.chunkId
      if (rawChunk === undefined || rawChunk === null || String(rawChunk).trim() === '') {
        throw new KnowledgeToolError('invalid-citation', 'chunkId or a full citation token is required')
      }
      const chunkText = String(rawChunk).trim()
      if (!/^[A-Za-z0-9._~-]+$/u.test(chunkText)) {
        throw new KnowledgeToolError('invalid-citation', 'chunkId must be a numeric id or a stable chunk_key')
      }
      // A numeric key stays a JSON number for legacy indexes; a 16-hex key stays a
      // string so the resolver can look it up in `kb_chunks.chunk_key`.
      const chunkId = /^\d+$/u.test(chunkText) ? Number(chunkText) : chunkText
      const chunk = await host.chunkGet({ docId, chunkId })
      return {
        ok: true,
        ...chunk,
        citation: chunk.citation ?? citationFor(docId, chunk.chunkKey, chunk.chunkId),
      }
    }),
  }),

  defineTool({
    name: 'kb_outline',
    description: 'Read one document\'s navigation index: the summary (when one exists), table of contents (chapters/sections/articles), section summaries and key facts (thresholds, ratios, responsible bodies, exceptions). '
      + 'Call this FIRST for broad, comparison or difference questions (区别/对比/全面/是否), then use kb_search or kb_chunk_get to read the original clauses. '
      + 'Accepts `docId` or a full `kb://doc/<docId>/chunk/<key>` citation token (the chunk part is ignored). '
      + 'Returns `summaryKind` (none/extractive/llm), `summaryStatus` (missing/ready) and `indexPath`. '
      + '`summaryStatus: "missing"` means upload/extraction created only the TOC and section structure; it is NOT an old index and this tool never auto-generates a summary. '
      + 'When a summary is needed, follow the knowledge-base skill reference `references/summarize.md` to read the original chunks and persist it with `kb_outline_save`. '
      + 'It returns no chapter body and never substitutes for the source: summaries are navigation only and MUST NOT be cited. '
      + 'Citations still use the original chunk token from kb_search / kb_chunk_get. `indexPath` is the `/nas/kb/index/md/<docId>.INDEX.md` file you may read for the same content.',
    parameters: {
      docId: { type: 'number', description: 'Document id from a citation token or search hit.' },
      citation: { type: 'string', description: 'Full `kb://doc/<docId>/...` token; alternative to docId.' },
      citationToken: { type: 'string', description: 'Alias of `citation`; a full kb:// token.' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => true,
    execute: async (args: { docId?: number; citation?: string; citationToken?: string }) => run(undefined, async () => {
      if (host.outline === undefined) throw new KnowledgeToolError('not-configured', 'knowledge outline resolver is unavailable')
      // Accept the citation body and any chunk suffix; kb_outline is document-scoped.
      const rawToken = args.citation ?? args.citationToken ?? ''
      const fromToken = rawToken.trim() !== ''
        ? /^kb:\/\/doc\/([^/\s?#]+)(?:\/chunk\/[^/\s?#]+)?/iu.exec(rawToken.trim())
        : null
      const docId = Number(fromToken?.[1] ?? args.docId)
      if (!Number.isInteger(docId) || docId <= 0) {
        throw new KnowledgeToolError('invalid-citation', 'docId must be a positive integer, or pass a full kb://doc/<docId>/... token')
      }
      const outline = await host.outline({ docId })
      return { ok: true, navigationOnly: true, ...outline }
    }),
  }),

  defineTool({
    name: 'kb_outline_rewrite',
    description: 'Rewrite one document\'s generated INDEX.md from the summaries already stored in the knowledge index. '
      + 'This is a renderer-only operation: it never calls a model, never changes document/section summary text, and never changes citation tokens. '
      + 'Use it after an INDEX renderer upgrade when `kb_outline` still points at an older file (for example one missing `#### 第X条` article summaries). '
      + 'Requires read permission on the source document; summaries remain navigation only and MUST NOT be cited.',
    parameters: {
      docId: { type: 'number', required: true, description: 'Document id from kb_outline or a citation token.' },
    },
    output: jsonOutput,
    isConcurrencySafe: () => false,
    execute: async (args: { docId?: number }) => run(undefined, async () => {
      if (host.outlineRewrite === undefined) throw new KnowledgeToolError('not-configured', 'knowledge outline rewrite is unavailable')
      const docId = Number(args.docId)
      if (!Number.isInteger(docId) || docId <= 0) {
        throw new KnowledgeToolError('invalid-citation', 'docId must be a positive integer')
      }
      const rewritten = await host.outlineRewrite({ docId })
      return { ok: true, navigationOnly: true, ...rewritten }
    }),
  }),

  defineTool({
    name: 'kb_outline_save',
    description: 'Persist the summary you wrote after reading one document through the knowledge-base summarize flow. '
      + 'This is the ONLY path that creates document/section summaries; upload and extraction deliberately leave them empty. '
      + 'Pass the document summary, the section summaries keyed by the `sectionId` values returned by `kb_outline`, and key facts with the exact `chunkId` they came from. '
      + 'Every number, ratio, clause number and responsible body in `summary`/`keyFacts` is checked against the cited source chunks; a mismatch is refused and nothing is written. '
      + 'Sections you omit keep their heading structure but lose any previous summary. On success it updates `kb_docs.summary`, `kb_sections`, the summary FTS rows and the generated INDEX.md. '
      + 'Summaries are navigation only and MUST NOT be cited; citations still use the original `kb://doc/<docId>/chunk/<key>` token.',
    parameters: {
      docId: { type: 'number', required: true, description: 'Document id from kb_outline or a citation token.' },
      summary: { type: 'string', required: true, description: 'Document-level summary (<=4000 characters) written from the original chunks.' },
      summaryVersion: { type: 'string', description: 'Optional version label; derived from the document hash + summary content when omitted.' },
      sections: {
        type: 'array',
        description: 'Section summaries. Omit a section you cannot ground; do not invent prose.',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            sectionId: { type: 'string', required: true, description: '`sectionId` from kb_outline.' },
            headingPath: { type: 'string', description: 'Full heading path from kb_outline; a mismatch is refused.' },
            summary: { type: 'string', description: 'Section summary (<=2000 characters).' },
            keyFacts: {
              type: 'array',
              description: 'Verbatim threshold/ratio/body/exception sentences with their source chunk id.',
              items: {
                oneOf: [
                  { type: 'string' },
                  {
                    type: 'object',
                    additionalProperties: true,
                    properties: {
                      fact: { type: 'string', description: 'Article marker or label; defaults to the section title.' },
                      value: { type: 'string', required: true, description: 'Sentence copied from the cited chunk.' },
                      chunkId: { type: 'integer', description: 'Numeric chunk id from kb_outline/kb_chunk_get.' },
                    },
                  },
                ],
              },
            },
            sourceChunkIds: {
              type: 'array',
              description: 'Chunks the summary was written from; must belong to the document and the section.',
              items: { type: 'integer' },
            },
          },
        },
      },
    },
    output: jsonOutput,
    execute: async (args: {
      docId: number
      summary: string
      summaryVersion?: string
      sections?: OutlineSectionSubmission[]
    }) => run(undefined, async () => {
      if (host.outlineSave === undefined) throw new KnowledgeToolError('not-configured', 'knowledge outline saver is unavailable')
      const docId = Number(args.docId)
      if (!Number.isInteger(docId) || docId <= 0) {
        throw new KnowledgeToolError('invalid-summary', 'docId must be a positive integer')
      }
      if (typeof args.summary !== 'string') {
        throw new KnowledgeToolError('invalid-summary', 'summary must be a string')
      }
      const sections = Array.isArray(args.sections) ? args.sections : []
      const saved = await host.outlineSave({
        docId,
        summary: args.summary,
        sections,
        ...(typeof args.summaryVersion === 'string' ? { summaryVersion: args.summaryVersion } : {}),
      })
      if (saved === undefined) throw new KnowledgeToolError('not-found', 'no such document', String(docId))
      return { navigationOnly: false, ...saved }
    }),
  }),

  defineTool({
    name: 'kb_file_delete',
    description: 'Move one knowledge file or folder into YOUR recycle bin: it becomes invisible in your view, '
      + 'the bytes are NOT destroyed and other users keep their access. This is a tombstone, not a filesystem delete. '
      + KB_FILE_TOOL_GUIDANCE,
    parameters: {
      path: { type: 'string', required: true, description: 'View-relative path to remove from your view.' },
    },
    output: jsonOutput,
    execute: async (args: { path: string }) => run(args.path, async () => {
      const relPath = scopedToolPath(host, args.path)
      await requireWrite(host, relPath)
      const caller = await host.resolveCaller()
      const entry = await host.statEntry(relPath)
      if (entry === undefined) throw new KnowledgeToolError('not-found', 'no such file or folder', relPath)
      await host.deleteToTrash(caller, relPath, entry.kind)
      const refresh = await host.refreshView().catch((error: unknown) => ({ failure: messageOf(error) }))
      const audit = await auditWrite(host, caller, 'delete', relPath)
      return {
        ok: true,
        path: relPath,
        trash: true,
        scope: 'caller-view',
        bytesDestroyed: false,
        audit,
        ...refreshResult(refresh),
      }
    }),
  }),

  defineTool({
    name: 'kb_file_mkdir',
    description: 'Create one directory in the knowledge tree, with DataOps permission checks and audit. '
      + KB_FILE_TOOL_GUIDANCE,
    parameters: {
      path: { type: 'string', required: true, description: 'View-relative directory path.' },
    },
    output: jsonOutput,
    execute: async (args: { path: string }) => run(args.path, async () => {
      const relPath = scopedToolPath(host, args.path)
      await requireWrite(host, relPath)
      const caller = await host.resolveCaller()
      const created = await host.createEntry(relPath, { directory: true })
      const refresh = await host.refreshView(created.relPath).catch((error: unknown) => ({ failure: messageOf(error) }))
      const audit = await auditWrite(host, caller, 'create', created.relPath)
      return { ok: true, path: created.relPath, kind: 'directory', audit, ...refreshResult(refresh) }
    }),
  }),

  defineTool({
    name: 'kb_file_extract',
    description: 'Trigger Markdown extraction for one document, or for up to 20 pending documents when path is omitted. '
      + 'The .md sibling is produced asynchronously. ' + KB_FILE_TOOL_GUIDANCE,
    parameters: {
      path: { type: 'string', description: 'View-relative source document; omit to scan the tree.' },
    },
    output: jsonOutput,
    execute: async (args: { path?: string }) => run(args.path, async () => {
      const relPath = scopedToolPath(host, args.path ?? '', true)
      const caller = await host.resolveCaller()
      if (relPath === '') {
        const candidates = await host.listExtractCandidates(20)
        const queued: Array<{ path: string; task?: unknown }> = []
        let skipped = 0
        for (const candidate of candidates) {
          // Extraction spends the deployment's parser and writes a sibling, so the
          // scan must not turn a write-less caller into an extractor for every file.
          if (!await host.canWrite(candidate)) {
            skipped += 1
            continue
          }
          const result = await host.enqueueExtraction(candidate, caller)
          if (result.outcome === 'queued') queued.push({ path: candidate, ...(result.task === undefined ? {} : { task: result.task }) })
          else skipped += 1
        }
        return { ok: true, scanned: true, queued, skipped }
      }
      await requireWrite(host, relPath)
      if (!host.isExtractable(relPath)) {
        return { ok: true, path: relPath, outcome: 'unsupported', message: 'this file type has no extractor' }
      }
      const result = await host.enqueueExtraction(relPath, caller)
      return { ok: true, path: relPath, ...result }
    }),
  }),
]
