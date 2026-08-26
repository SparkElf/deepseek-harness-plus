# 持久附件

[English](attachment.md) | 中文

附件 seam 将图片与文档二进制所有权从会话日志中分离。生产方把已准入字节交给 [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam)；只有对象完成持久化后，该服务才会发布不可变内容寻址引用。会话事件与模型可见内容只记录引用及元数据，不记录浏览器对象 URL、宿主临时路径、提供方 URL 或 base64 数据。

未发送的浏览器草稿可以保留在内存中，原生客户端也可以将其暂存于操作系统临时存储。宿主在追加用户事件前持久保存图片原件；文档还必须完成原件、完整 Markdown、content-list 与提取图片的持久化，并通过直接上下文预算。失败不会产生用户事件。

来源：[`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## 标识与经过校验的元数据

`AttachmentId` 是带类型标记的不透明字符串。本地后端目前生成 `sha256:<digest>`，但消费方既不能解析这种表示，也不能据此派生文件系统路径。

```ts type-equiv
/** Raster image formats accepted by the version-one image attachment path. */
type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
```

```ts type-equiv
/** Durable, serializable metadata for one immutable image object. */
interface ImageAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Media type verified from the stored bytes. */
  mediaType: ImageMediaType
  /** Exact encoded byte length. */
  bytes: number
  /** Intrinsic encoded width in pixels. */
  width: number
  /** Intrinsic encoded height in pixels. */
  height: number
  /** Optional display name stripped of local path information. */
  name?: string
}
```

```ts type-equiv
/** Human-document formats accepted by the first durable document path. */
type DocumentMediaType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
```

```ts type-equiv
/** Generic immutable file-object metadata for document/parser artifacts. */
interface FileAttachmentRef {
  /** Opaque storage identifier; never a filesystem path or bearer URL. */
  attachmentId: AttachmentId
  /** Caller-owned media type for this generic file object. */
  mediaType: string
  /** Exact encoded byte length. */
  bytes: number
  /** Optional display name stripped of local path information. */
  name?: string
}
```

```ts type-equiv
/**
 * Durable parser outputs associated with one original document. The session
 * records only immutable attachment references; parser response paths and
 * transient extracted bytes never become session state.
 */
interface ParsedDocumentRef {
  /** Provider id that produced this immutable parse bundle. */
  parser: string
  /** Complete parsed Markdown used for direct model projection. */
  markdown: FileAttachmentRef
  /** Complete parser structural block list retained for future document tools. */
  contentList: FileAttachmentRef
  /** Extracted raster images in parser output order. */
  images: ImageAttachmentRef[]
}
```

```ts type-equiv
/** Durable metadata for one supported user-authored document. */
interface DocumentAttachmentRef extends Omit<FileAttachmentRef, 'mediaType' | 'name'> {
  /** Exact supported document media type admitted with the original bytes. */
  mediaType: DocumentMediaType
  /** Browser/provider display name after path stripping and control-character cleanup. */
  name: string
}
```

```ts type-equiv
/** Deployment-resolved limits used by image upload admission and request buffering. */
interface ImageAttachmentLimits {
  maxImageBytes: number
  maxImagesPerMessage: number
  maxMessageImageBytes: number
  maxImagePixels: number
  /** Maximum intrinsic width and maximum intrinsic height in pixels for one image. */
  maxImageDimension: number
  mediaTypes: readonly ImageMediaType[]
}
```

```ts type-equiv
/** Deployment-resolved limits used by document upload admission and request buffering. */
interface DocumentAttachmentLimits {
  /** Maximum encoded bytes admitted for one supported document. */
  maxDocumentBytes: number
  /** Maximum number of supported documents admitted in one submitted message. */
  maxDocumentsPerMessage: number
  /** Maximum aggregate encoded document bytes admitted in one submitted message. */
  maxMessageDocumentBytes: number
  /** Exact document media types accepted by this deployment. */
  mediaTypes: readonly DocumentMediaType[]
}
```

引用记录固有尺寸和编码长度，使客户端无需先解码即可排布历史记录；每次权威读取仍会根据对象重新校验摘要、媒体签名、尺寸和元数据。

## 提交与经校验读取的数据

```ts type-equiv
/** Base64-encoded image upload accompanying one wire request. */
interface EncodedImageAttachment {
  /** Declared media type, verified against the decoded bytes during admission. */
  mediaType: ImageMediaType
  /** Canonical base64 encoding of the image bytes. */
  data: string
  /** Optional display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Base64-encoded supported document accompanying one wire request. */
interface EncodedDocumentAttachment {
  /** Declared document media type admitted before persistence. */
  mediaType: DocumentMediaType
  /** Canonical base64 encoding of the document bytes. */
  data: string
  /** Required display name; it is never interpreted as a storage path. */
  name: string
}
```

```ts type-equiv
/** Generic immutable bytes to commit to the shared content-addressed object store. */
interface SaveFileAttachment {
  /** Already-admitted immutable bytes to persist. */
  data: Uint8Array
  /** Caller-owned media type recorded beside the immutable object reference. */
  mediaType: string
  /** Optional display name; storage providers must never treat it as a path. */
  name?: string
}
```

```ts type-equiv
/** Request to validate and durably commit one image. */
interface SaveImageAttachment {
  data: Uint8Array
  /** Caller-declared media type, checked against fully decoded bytes. */
  mediaType: ImageMediaType
  /** Optional browser/provider display name; it is never interpreted as a path. */
  name?: string
}
```

```ts type-equiv
/** Stored generic file bytes returned after reference and digest verification. */
interface StoredFileAttachment {
  /** Canonical durable reference verified against the returned bytes. */
  ref: FileAttachmentRef
  /** Immutable stored bytes after digest and byte-length verification. */
  data: Uint8Array
}
```

```ts type-equiv
/** Stored image bytes returned after reference and digest verification. */
interface StoredImageAttachment {
  ref: ImageAttachmentRef
  data: Uint8Array
}
```

`saveImage()` 校验字节并以原子方式提交一个对象，之后才返回其引用。`validateImage()` 执行相同的准入检查，但不持久化任何内容；批量调用方会在保存任何成员前通过它校验所有成员，因此校验拒绝不会留下部分对象。`admitEncodedImages()` 是面向 base64 上传的 wire 入口：强制执行规范 base64，随后把批量准入委托给 `saveImages()`，由后者负责张数与聚合字节上限以及先全量校验再保存的顺序。`readImage()` 接受来自已授权会话路径的引用，只在完整性校验通过后返回字节。该服务刻意不规定保留策略：恢复和 fork 后的会话可能共享对象，因此基于引用的垃圾回收会延期实现，而不是与任何一个会话的删除绑定。

`saveFile()` 与 `readFile()` 持有文档原件和解析产物使用的不可变通用对象。仅支持图片的提供方声明空文档媒体类型集合，因此 Host 不提供文档入口，直接调用通用文件方法也会明确失败。

## 文档解析器输入与输出

源码：[`packages/attachment/document-parser/src/types.ts`](../../packages/attachment/document-parser/src/types.ts)

解析提供方接收一份已持久化原件，并返回完整的临时 Markdown/content-list/图片 bundle。Host 持久保存该 bundle，并且只有完整渲染文档通过准入后才记录其引用。

```ts type-equiv
/** Stable parser failure codes used by Host admission and provider diagnostics. */
type DocumentParserErrorCode =
  | 'DOCUMENT_PARSER_DUPLICATE_PROVIDER'
  | 'DOCUMENT_PARSER_CONFIGURED_MISSING'
  | 'DOCUMENT_PARSER_UNAVAILABLE'
  | 'DOCUMENT_PARSER_AMBIGUOUS'
  | 'DOCUMENT_PARSE_FAILED'
  | 'DOCUMENT_PARSE_INVALID_OUTPUT'
  | 'DOCUMENT_PARSE_RESPONSE_TOO_LARGE'
  | 'DOCUMENT_PARSE_TIMEOUT'
  | 'DOCUMENT_PARSE_ABORTED'
  | 'DOCUMENT_PARSE_CONTEXT_TOO_LARGE'
```

```ts type-equiv
/** One already-persisted original document supplied to a parser provider. */
interface DocumentParseRequest {
  /** Durable original-document metadata. */
  attachment: DocumentAttachmentRef
  /** Exact original bytes resolved from the durable attachment store. */
  data: Uint8Array
}
```

```ts type-equiv
/** One extracted raster image returned by a parser before durable persistence. */
interface ParsedDocumentImage {
  /** Parser-relative display name only; never a host storage path. */
  name: string
  /** Declared raster media type validated again by the attachment store on persistence. */
  mediaType: ImageMediaType
  /** Exact extracted image bytes. */
  data: Uint8Array
}
```

```ts type-equiv
/** Complete parser output required by the version-one durable document path. */
interface DocumentParseResult {
  /** Complete UTF-8 Markdown bytes used for direct model projection. */
  markdown: Uint8Array
  /** Complete UTF-8 JSON bytes for the parser's reading-order content list. */
  contentList: Uint8Array
  /** Extracted raster images in parser output order. */
  images: readonly ParsedDocumentImage[]
}
```

```ts type-equiv
/** External parser implementation registered into {@link DocumentParserRuntime}. */
interface DocumentParserProvider {
  /** Stable provider id used by explicit deployment selection and durable parse provenance. */
  readonly id: string
  /**
   * Parse one original document into the complete version-one output bundle.
   * @param request - original durable metadata and verified bytes.
   * @param signal - optional caller cancellation.
   * @returns complete Markdown, content-list JSON, and extracted images.
   */
  parse(request: DocumentParseRequest, signal?: AbortSignal): Promise<DocumentParseResult>
}
```

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — this section is byte-identical in both language sides of the page. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxattachments--attachmentstore-abstract-seam"></a>

### `ctx.attachments` — `AttachmentStore` (abstract seam)

Immutable binary attachment service. Implementations validate format-specific bytes before publishing references.

```ts cordis-catalog
/**
 * Persist one format-agnostic immutable object after its caller has completed domain-specific admission.
 * @param input - immutable bytes plus caller-owned media/display metadata.
 * @returns a durable content-addressed reference.
 */
saveFile(input: SaveFileAttachment): Promise<FileAttachmentRef>

/**
 * Read one generic file object and verify that its bytes still match the content-addressed reference.
 * @param ref - durable generic-file reference to resolve.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified file bytes.
 */
readFile(ref: FileAttachmentRef, signal?: AbortSignal): Promise<StoredFileAttachment>

/**
 * Validate one image without persisting it.
 * Batch callers validate every member before saving any member.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns completion after the encoded raster has been fully decoded.
 */
abstract validateImage(input: SaveImageAttachment): Promise<void>

/**
 * Validate one ordered image batch before committing any member.
 * Validation failures start no writes; storage failures return no partial
 * references, although already published content-addressed objects may stay
 * unreachable until a future retention policy collects them.
 * @param inputs - encoded images in their owning message order.
 * @returns durable references in the exact input order.
 */
async saveImages(inputs: readonly SaveImageAttachment[]): Promise<readonly ImageAttachmentRef[]>

/**
 * Validate and durably commit one image before its owning session event is appended.
 * @param input - encoded bytes, declared media type, and optional display name.
 * @returns a durable content-addressed reference.
 */
abstract saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef>

/**
 * Read one image and verify that bytes still match the recorded reference.
 * @param ref - durable reference from the session log.
 * @param signal - optional cancellation for backend read and verification work.
 * @returns the verified bytes and canonical reference.
 * @throws the signal reason when aborted, or a storage error when verification fails.
 */
abstract readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<StoredImageAttachment>
```

Source: [`packages/attachment/attachment/src/index.ts:53`](../../packages/attachment/attachment/src/index.ts)

<a id="ctxdocumentparser--documentparserruntime"></a>

### `ctx.documentParser` — `DocumentParserRuntime`

Provider-neutral parser registry and direct-context policy owner.

```ts cordis-catalog
/**
 * Register one parser provider until the owning Cordis fiber disposes.
 * @param provider - provider implementation keyed by its non-empty id.
 * @returns disposer that withdraws exactly this registration.
 */
registerProvider(provider: DocumentParserProvider): () => void

/**
 * Report whether current registry state resolves the configured provider selection.
 * This does not probe provider health or external endpoint availability.
 * @returns true only when a parse call can select exactly one registered provider.
 */
isSelectionResolvable(): boolean

/**
 * Parse one already-persisted document through the deployment-selected provider.
 * @param request - verified original bytes and their durable metadata.
 * @param signal - optional cancellation forwarded to the provider.
 * @returns provider id together with the complete transient parse bundle.
 */
async parse( request: DocumentParseRequest, signal?: AbortSignal, ): Promise<{ parser: string; result: DocumentParseResult }>
```

Source: [`packages/attachment/document-parser/src/index.ts:38`](../../packages/attachment/document-parser/src/index.ts)
<!-- END GENERATED cordis-surface -->
