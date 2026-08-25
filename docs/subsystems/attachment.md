# Durable Attachments

English | [中文](attachment.zh.md)

The attachment seam separates image and document binary ownership from the session log. A producer gives admitted bytes to [`ctx.attachments`](#ctxattachments--attachmentstore-abstract-seam); the service publishes an immutable content-addressed reference only after the object is durable. Session events and model-visible content retain references and metadata, never browser object URLs, host temporary paths, provider URLs, or base64 payloads.

Unsent browser drafts may stay in memory and native clients may stage them in operating-system temporary storage. Before appending a user event, the Host persists image originals; a document additionally requires durable original, complete Markdown, content-list, and extracted-image references plus the direct-context budget check. Failure appends no user event.

Source: [`packages/attachment/attachment/src/types.ts`](../../packages/attachment/attachment/src/types.ts)

## Identity and verified metadata

`AttachmentId` is a branded opaque string. The local backend currently emits `sha256:<digest>`, but consumers must neither parse that representation nor derive a filesystem path from it.

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

The reference records intrinsic dimensions and encoded length so clients can lay out history without decoding first, while every authoritative read still re-checks digest, media signature, dimensions, and metadata against the object.

## Commit and verified-read payloads

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

`saveImage()` validates bytes and atomically commits one object before returning its reference. `validateImage()` runs the same admission checks without persisting anything; batch callers validate every member through it before saving any member, so validation rejection leaves no partial objects behind. `admitEncodedImages()` is the wire entry for base64 uploads: it enforces canonical base64, then delegates batch admission to `saveImages()`, which owns the count and aggregate-byte limits and the validate-all-before-save order. `readImage()` accepts a reference from an authorized session path and returns bytes only after integrity verification. The service is deliberately retention-neutral: resumed and forked sessions may share objects, so reference-aware garbage collection is deferred rather than tied to any one session's deletion.

`saveFile()` and `readFile()` own immutable generic objects used by original documents and parser artifacts. Image-only providers declare an empty document media-type set, so Host document intake remains absent and direct generic-file calls fail explicitly.

## Document parser input and output

Source: [`packages/attachment/document-parser/src/types.ts`](../../packages/attachment/document-parser/src/types.ts)

Parser providers receive one already-persisted original and return a complete transient Markdown/content-list/image bundle. The Host persists the bundle and records its references only after complete rendered-document admission succeeds.

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
