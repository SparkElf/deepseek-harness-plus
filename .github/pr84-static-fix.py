from pathlib import Path


def replace_one(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{path}: expected one match, found {count}: {old!r}')
    p.write_text(text.replace(old, new, 1))


# Build failures shared by snapshots, Node 22, Wine, and release-shaped exe.
replace_one(
    'packages/host/apiproxy/tests/api-proxy-document-parsing.spec.ts',
    "import AttachmentStore, {\n  AttachmentId,\n  type FileAttachmentRef,\n  type ImageAttachmentRef,\n  type SaveFileAttachment,\n} from '@deepseek-ai/dsh-attachment'",
    "import {\n  AttachmentId,\n  type FileAttachmentRef,\n  type ImageAttachmentRef,\n  type SaveFileAttachment,\n} from '@deepseek-ai/dsh-attachment'",
)
replace_one(
    'packages/host/apiproxy/tests/api-proxy-document-parsing.spec.ts',
    'const parse = options.parse ?? (data => Promise.resolve({',
    'const parse = options.parse ?? (() => Promise.resolve({',
)
replace_one(
    'packages/host/apiproxy/tests/api-proxy-document-parsing.spec.ts',
    "      mediaTypes: ['image/png'],",
    "      mediaTypes: ['image/png'] as const,",
)
replace_one(
    'packages/host/apiproxy/tests/api-proxy-document-parsing.spec.ts',
    "      mediaTypes: ['application/pdf'],",
    "      mediaTypes: ['application/pdf'] as const,",
)
replace_one(
    'packages/host/apiproxy/tests/api-proxy-document-parsing.spec.ts',
    "    saveImages(inputs: readonly { data: Uint8Array; mediaType: 'image/png'; name?: string }[]) {\n      return AttachmentStore.prototype.saveImages.call(attachments, inputs)\n    },",
    "    async saveImages(inputs: readonly { data: Uint8Array; mediaType: 'image/png'; name?: string }[]): Promise<readonly ImageAttachmentRef[]> {\n      const refs: ImageAttachmentRef[] = []\n      for (const input of inputs) refs.push(await saveImage(input))\n      return refs\n    },",
)

# Export JSDoc completeness.
replace_one(
    'packages/attachment/document-parser-mineru/src/provider.ts',
    '/** Select exactly one v1 Markdown and content-list output plus every extracted raster image. */\nexport function parseArchive(entries: Readonly<Record<string, Uint8Array>>): DocumentParseResult {',
    '/**\n * Select exactly one v1 Markdown and content-list output plus every extracted raster image.\n * @param entries - decompressed ZIP entries keyed by archive path.\n * @returns complete validated parser outputs with transient bytes.\n */\nexport function parseArchive(entries: Readonly<Record<string, Uint8Array>>): DocumentParseResult {',
)
replace_one(
    'packages/host/apiproxy/src/document-parsing.ts',
    ' * attachment retention policy; no user event is appended by the caller.\n */\nexport async function parseDocumentRefs(',
    ' * attachment retention policy; no user event is appended by the caller.\n * @param ctx - Host context carrying the attachment store and optional parser runtime.\n * @param refs - durable original-document references in submitted order.\n * @returns immutable document references carrying durable parser artifacts when parsing is composed.\n */\nexport async function parseDocumentRefs(',
)
replace_one(
    'packages/llm/llm/src/content.ts',
    '/** True when content contains a document whose complete Markdown is stored durably. */\nexport function contentHasParsedDocument(content: readonly ContentBlock[]): boolean {',
    '/**\n * Test whether typed content contains a durable parsed-document reference.\n * @param content - provider-neutral content blocks, including nested tool results.\n * @returns whether any document carries complete durable parsed Markdown.\n */\nexport function contentHasParsedDocument(content: readonly ContentBlock[]): boolean {',
)
replace_one(
    'packages/llm/llm/src/content.ts',
    ' * while this provider request is assembled. A fresh mutable message array is\n * returned because provider GenerateOptions owns a mutable request snapshot.\n */\nexport async function projectRequestDocumentsWithAttachments(',
    ' * while this provider request is assembled. A fresh mutable message array is\n * returned because provider GenerateOptions owns a mutable request snapshot.\n * @param messages - durable provider-neutral messages in request order.\n * @param attachments - durable resolver for parser Markdown references.\n * @param signal - optional cancellation for attachment reads.\n * @returns a mutable transient request snapshot with every document projected to text.\n */\nexport async function projectRequestDocumentsWithAttachments(',
)

# Catalog ownership and type links.
replace_one(
    'scripts/gen-cordis-catalog.ts',
    "  attachments: 'attachment.md',\n  shell: 'shell.md',",
    "  attachments: 'attachment.md',\n  documentParser: 'attachment.md',\n  shell: 'shell.md',",
)
replace_one(
    'scripts/gen-cordis-catalog.ts',
    "  EncodedImageAttachment: 'attachment.md',\n  ImageAttachmentRef: 'attachment.md',\n  SaveImageAttachment: 'attachment.md',\n  StoredImageAttachment: 'attachment.md',",
    "  EncodedImageAttachment: 'attachment.md',\n  FileAttachmentRef: 'attachment.md',\n  ImageAttachmentRef: 'attachment.md',\n  SaveFileAttachment: 'attachment.md',\n  SaveImageAttachment: 'attachment.md',\n  StoredFileAttachment: 'attachment.md',\n  StoredImageAttachment: 'attachment.md',\n  DocumentParserProvider: 'attachment.md',\n  DocumentParseRequest: 'attachment.md',\n  DocumentParseResult: 'attachment.md',",
)

# Capability graph role classification.
attachments_role = """  {
    key: 'attachments',
    pkg: 'attachment',
    title: 'Durable binary attachment storage',
    mode: 'seam',
    implementations: ['attachment-local'],
    consumers: ['host-runtime', 'llm-pi-ai'],
    note: 'The host commits accepted images before session events; provider adapters resolve authorized durable references into provider-native content.',
  },
"""
parser_role = attachments_role + """  {
    key: 'documentParser',
    pkg: 'document-parser',
    title: 'External document parser registry',
    mode: 'seam',
    implementations: ['document-parser-mineru'],
    consumers: ['apiproxy'],
    note: 'Parser providers convert already-durable document originals into transient final artifacts; Host admission persists those artifacts and owns the aggregate direct-context budget before publishing the user message.',
  },
"""
replace_one('scripts/gen-doc-graphs.ts', attachments_role, parser_role)

# Model Experience short-form audit for indirect packages.
replace_one(
    'scripts/verify-package-readme-model-experience.ts',
    "  'packages/attachment/attachment-local': { kind: 'indirect', reason: 'The local backend delegates model request rendering to provider adapters.' },",
    "  'packages/attachment/attachment-local': { kind: 'indirect', reason: 'The local backend delegates model request rendering to provider adapters.' },\n  'packages/attachment/document-parser': { kind: 'indirect', reason: 'The parser seam supplies durable parser outputs; Host admission and LLM projection own model rendering.' },\n  'packages/attachment/document-parser-mineru': { kind: 'indirect', reason: 'The MinerU backend supplies parser output bytes; the parser seam, Host admission, and LLM projection own model rendering.' },",
)
replace_one(
    'packages/attachment/document-parser/README.md',
    'Indirectly through Host document admission and LLM request projection. Accepted parsed documents reach text-capable providers as complete UTF-8 Markdown between explicit document delimiters; session history retains only the originals and parser-artifact references. A submitted document batch whose aggregate parsed Markdown exceeds the configured direct-context budget is rejected rather than truncated.',
    'Indirectly, through Host document admission and LLM request projection.',
)
replace_one(
    'packages/attachment/document-parser-mineru/README.md',
    "Indirectly through the document parser seam. MinerU's complete Markdown is the version-one provider-neutral representation sent to text-capable models after durable resolution. `content_list` and extracted images remain durable for later block/page/search tooling but are not automatically injected into every model request.",
    'Indirectly, through the document-parser seam and Host-owned durable Markdown projection.',
)

# Translation pairing requires identical link destinations and literal fenced blocks.
replace_one(
    'packages/attachment/document-parser/README.zh.md',
    '[`@deepseek-ai/dsh-attachment`](../attachment/README.zh.md)',
    '[`@deepseek-ai/dsh-attachment`](../attachment/README.md)',
)
replace_one(
    'packages/attachment/document-parser-mineru/README.zh.md',
    '[`documentParser`](../document-parser/README.zh.md)',
    '[`documentParser`](../document-parser/README.md)',
)
zh_block = """```text
校验文档批次
  -> 持久化原始文档字节
  -> 读取已持久化原文件
  -> 通过 ctx.documentParser 逐个解析
  -> 校验并持久化 Markdown/content_list/提取图像
  -> 检查本次提交的完整 Markdown 合计字节预算
  -> 构建携带持久解析引用的 DocumentBlock
  -> 追加/排队用户消息
```"""
en_block = """```text
validate document batch
  -> persist original document bytes
  -> read the persisted originals
  -> parse each document through ctx.documentParser
  -> validate and persist Markdown/content_list/extracted images
  -> check aggregate complete Markdown byte budget for the submitted message
  -> build DocumentBlock values carrying durable parsed refs
  -> append/queue the user message
```"""
replace_one(
    '.agents/notes/implemented/feature/2026-08-24-mineru-document-parsing.zh.md',
    zh_block,
    en_block,
)

# Inherited #82 contextual type-equiv source fixes.
replace_one(
    'docs/subsystems/llm-streaming.md',
    'interface LlmModelContext {\n  /** Maximum combined request and response context, when disclosed. */\n  contextWindow: number\n}',
    'interface LlmModelContext {\n  /** Maximum combined request and response context in tokens. */\n  contextWindow: number\n}',
)
replace_one(
    'docs/subsystems/llm-streaming.zh.md',
    'interface LlmModelInfo {\n  /** Provider route that owns this model entry. */\n  provider: string\n  /** Model id passed to {@link GenerateOptions.model}. */\n  id: string\n  /** Human-readable model name for selectors and diagnostics. */\n  name: string',
    'interface LlmModelInfo {\n  /** Provider route that owns this model entry. */\n  provider: string\n  /** Model id passed to {@link GenerateOptions.model}. */\n  id: string\n  /** Human-readable model name for selectors. */\n  name: string',
)
