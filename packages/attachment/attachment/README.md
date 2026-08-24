# @deepseek-ai/dsh-attachment

English | [中文](README.zh.md)

The durable attachment seam. `ctx.attachments` owns one content-addressed immutable-object namespace for raster images, supported human documents, and parser artifacts. Consumers persist opaque references in session events rather than browser paths, object URLs, provider URLs, or base64 payloads.

Images keep their format-specific path. `validateImage` applies the deployment policy without writing, `saveImages` validates a complete ordered batch before publishing any member, `saveImage` commits one accepted raster, and `readImage` verifies digest plus recorded image metadata. `admitEncodedImages(attachments, images)` is the canonical browser-wire entry and rejects non-canonical base64 before delegating count, aggregate-byte, media-type, decode, dimension, and pixel limits to the store.

Generic documents are additive. Version one admits PDF, DOCX, PPTX, and XLSX through `admitEncodedDocuments(documents, attachments)`. It validates the whole decoded batch before persistence, enforces deployment `DocumentAttachmentLimits`, normalizes the display filename, checks filename extension against the declared media type, and performs a minimal container-signature check (PDF header or OOXML ZIP container). It then stores the original bytes through `saveFile`, producing a durable `DocumentAttachmentRef`. `readFile` verifies the content-addressed digest and recorded byte length. These generic file primitives also provide the storage surface for later parser outputs without introducing a parser-specific object store.

The service intentionally does not parse document bodies. Provider projection, parser orchestration, browser presentation, and session authorization belong to their consumers. The generic document lifecycle therefore establishes durable originals and references first; an optional parser can later add parsed artifacts without changing the storage contract.

`AttachmentError.code` remains the stable failure vocabulary. `ImageAdmissionErrorCode` / `isImageAdmissionError` and `DocumentAdmissionErrorCode` / `isDocumentAdmissionError` distinguish caller-correctable admission failures from storage faults so each protocol boundary can map them into its own wire errors.

## Model Experience

Indirectly, through role-neutral core `ImageBlock` and `DocumentBlock` content. This package stores and verifies bytes; model-facing projection is owned by the LLM/provider consumer. Generic documents without a parser are represented explicitly by those consumers rather than silently disappearing.

#### KV Cache effect

Adding an image or document changes the provider request suffix and therefore invalidates that affected suffix. The attachment store itself performs no model call and consumes no tokens.

## Known Limitations and Deferred Work

- Raster image intake accepts PNG, JPEG, WebP, and GIF; generic document intake accepts PDF, DOCX, PPTX, and XLSX only.
- OOXML admission verifies the ZIP container and filename/media-type agreement, not the complete internal Office package structure. A document parser remains the authority for extracting usable body content.
- Retention and garbage collection are deferred because resumed and forked sessions may share immutable objects.
- Document parsing, long-document retrieval/search, audio, video, arbitrary binaries, and persistent unsent drafts require separate capabilities or lifecycle contracts.
