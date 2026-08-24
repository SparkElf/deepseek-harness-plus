# Agent Note: MinerU parsing over durable document attachments

Status: implemented

English | [中文](2026-08-24-mineru-document-parsing.zh.md)

## Problem

The generic document attachment layer made PDF, DOCX, PPTX, and XLSX originals durable and reconstructable, but intentionally exposed only an explicit unparsed marker to models. A parser integration must make document bodies useful without putting parser temporary paths, external task ids, giant Markdown strings, or a second object store into the session lifecycle.

The integration also cannot be a DeepSeek-only file feature. Parsed content must remain provider-neutral, survive reload/fork from the session log plus attachment objects, and fail before a user event is appended when parsing or direct-context admission fails.

## Decision

The parser feature adds an optional `ctx.documentParser` Service Definition and a separate MinerU provider package. The service owns registration-order-independent provider selection and a required `maxDirectMarkdownBytes` policy. The MinerU package registers provider id `mineru` and communicates with an externally managed synchronous `/file_parse` endpoint; Harness does not embed MinerU's Python/model/GPU runtime.

A parsed `DocumentAttachmentRef` keeps the original immutable document identity and adds a `ParsedDocumentRef` containing durable references to complete Markdown, complete `content_list` JSON, and extracted raster images. Session content therefore remains reference-only. Parser response entry names and extracted byte buffers exist only during the admission operation.

## Admission lifecycle

Host prompt admission keeps one commit boundary:

```text
validate document batch
  -> persist original document bytes
  -> read the persisted originals
  -> parse each document through ctx.documentParser
  -> validate and persist Markdown/content_list/extracted images
  -> check complete Markdown byte budget
  -> build DocumentBlock values carrying durable parsed refs
  -> append/queue the user message
```

The content-addressed store does not roll back already published objects. A later parser, persistence, or budget failure may therefore leave unreachable immutable objects, matching the existing attachment-store policy, but no user event is appended from the failed prompt.

The direct-context check uses the complete persisted Markdown byte length. Version one does not silently truncate a document or accept only an initial page range. Documents over `maxDirectMarkdownBytes` fail with an explicit parser admission error before the message commit point.

## MinerU transport

`@deepseek-ai/dsh-document-parser-mineru` sends one original document per multipart `POST /file_parse`. It requests final Markdown, `content_list`, extracted images, and ZIP output while explicitly disabling `middle.json`, raw model output, and original-file return.

`endpoint`, `timeoutMs`, and `maxResponseBytes` are required deployment config; the package invents no production endpoint, timeout, or size defaults. The byte bound applies to the HTTP response and to aggregate extracted ZIP output. A valid response contains exactly one Markdown artifact and one version-one content-list artifact; missing or ambiguous final outputs fail instead of being guessed from filenames. Extracted images are retained only when their bytes are an attachment-supported raster type.

MinerU `/tasks` is not Harness durable job state. Version one stays synchronous; if real workloads require background ownership, `ctx.jobs` is the future user-visible lifecycle and MinerU task APIs may remain an internal provider detail.

## Provider-neutral model projection

The durable session log never stores parsed Markdown inline. Before DeepSeek or pi-ai serializes a request containing a parsed document, the adapter resolves the durable Markdown reference through the attachment service and replaces the `DocumentBlock` in the transient request snapshot with a delimited text block containing the complete UTF-8 Markdown.

The same projection helper is shared by both adapter paths so document semantics cannot drift by provider. Generic unparsed documents retain their earlier explicit unparsed marker. Extracted images are not automatically injected into each request; their durable references and `content_list` structure are retained for future selective page/block/image tooling.

## Alternatives considered

**Embed Markdown directly in the session event.** Rejected because large parser output would duplicate immutable attachment data into every replayable log and make the session artifact the object store. Durable references keep model-visible data reconstructable without that duplication.

**Teach every LLM adapter to upload PDF/Office bytes natively.** Rejected because provider file APIs and format support are inconsistent. Complete parsed Markdown gives every text-capable route one provider-neutral representation while preserving the original file for future optimized adapters.

**Persist MinerU task ids and parse asynchronously in version one.** Rejected because an external service process's task table is not a durable Harness lifecycle. Background parsing should be introduced only with Harness-owned job semantics.

**Add RAG/vector search with the parser.** Rejected because the first capability needed is correct durable parsing and direct-context reasoning. `content_list` is retained specifically so later page/block reads or search can be added without reparsing, while embeddings, vector databases, chunk orchestration, and reranking remain separate product choices.

## Consequences

Small and medium supported documents can now become complete model-readable text while preserving durable originals and parse artifacts across replay and fork. Parser failures and over-budget Markdown are explicit prompt-admission failures rather than silent model degradation.

The trade-off is synchronous submit latency and an explicit size ceiling for direct context. This implementation intentionally establishes the durable parser surface first; long-document retrieval, background parsing, parser tuning UX, and selective extracted-image inspection remain follow-up capabilities rather than hidden behavior in version one.
