# Agent Note: Durable document attachments with MinerU parsing

Status: proposed

English | [中文](2026-08-24-mineru-document-attachments.zh.md)

## Problem

The Web attachment capability is durable but intentionally image-only. Its storage, prompt admission, session references, history rendering, and provider projection solve the lifecycle problem for PNG/JPEG/WebP/GIF, while generic files, PDF, and file picking were explicitly left as follow-ups. Users therefore cannot attach a PDF, DOCX, PPTX, or XLSX file and ask Harness to reason over its contents.

Adding a file picker alone is insufficient. Office documents and PDFs are not useful model content until a parser turns them into text and structure, the original file and parse outputs must survive reload and fork, and a failed parse must not append a user message that the model cannot reconstruct. At the same time, Harness should not acquire a fixed document-RAG workflow, embedded Python ML runtime, or a second attachment store just to use MinerU.

MinerU's current public parse API accepts PDF, images, DOCX, PPTX, and XLSX and can return Markdown, `content_list`, extracted images, or a ZIP bundle. Its `content_list` is a flat reading-order representation with text, image, table, chart, equation, code, list, and page metadata, making it useful to Harness programs later without requiring the full parser-internal `middle.json`.

## Proposal

Extend the existing attachment capability additively with durable document files, then add an optional MinerU parser provider that converts a supported document into a durable parsed bundle before the owning user message is appended. Version one supports PDF, DOCX, PPTX, and XLSX through the document path; existing raster images continue to use the current native multimodal image path and are not rerouted through MinerU.

The implementation is intentionally split into two reviewable changes. The first adds generic document attachment intake, storage, wire representation, composer/history UI, and durable `DocumentAttachmentRef` semantics without a MinerU dependency. The second stacks on that capability and adds MinerU parsing plus parsed-document model projection. This keeps storage and UI reusable while allowing the parser integration to evolve independently.

### Durable document attachment

The existing image types and operations remain intact. Add a document reference with an opaque attachment identifier, exact supported media type, byte count, and display name. PDF and the OOXML DOCX/PPTX/XLSX media types are the initial accepted document set. Legacy DOC/PPT/XLS, ZIP, arbitrary binaries, and executable formats are outside version one.

Unsent browser documents remain `File` objects owned by the live composer, just like unsent images. The composer attachment union gains a document case rendered as a compact file chip with type, name, size, and remove action; mixed text, image, and document drafts share one attachment rail. On failed admission or parse, the complete in-flight draft is restored without overwriting edits made while the request was running.

The host validates the complete document batch before accepting the message, saves each original document into the same content-addressed attachment backend, and constructs immutable durable references. Document limits are separate deployment configuration from image byte/pixel limits because parser cost and file semantics differ. The design does not guess production byte/count defaults; implementation chooses explicit validated configuration and tests its admission behavior.

The existing `$DSH_HOME/attachments/v1/objects` content-addressed store remains the physical object store. In a DataOps-managed deployment this store belongs to the user's isolated DSH container and remains separate from the DataOps attachment center. The local provider gains the minimum generic byte-file primitives needed by documents and parser artifacts rather than creating a MinerU-specific directory tree. Original filenames are display metadata only and never become storage paths.

### Parsed document references

A successfully parsed document keeps both the original `DocumentAttachmentRef` and durable references to parser outputs. The implementation uses these fields:

```text
interface ParsedDocumentRef {
  parser: string
  markdown: FileAttachmentRef
  contentList: FileAttachmentRef
  images: readonly ImageAttachmentRef[]
}

interface DocumentBlock {
  type: 'document'
  attachment: DocumentAttachmentRef
  parsed: ParsedDocumentRef
}
```

Markdown and `content_list.json` are persisted as immutable attachment objects rather than embedded as giant strings in the session event. Extracted images are also persisted through the existing image attachment capability where their bytes are a supported raster format. The parser integration rewrites or records MinerU-relative image paths so no durable reference depends on a temporary ZIP extraction directory.

`DocumentBlock` joins the merge-extensible core content vocabulary and is role-neutral at the type level, while version-one product intake is user-authored documents. Any future assistant-produced document must satisfy the same persist-before-event rule.

### MinerU provider

MinerU runs as an external service, typically `mineru-api` or `mineru-router`; DSH does not embed Python, PyTorch, model weights, GPU lifecycle, or MinerU process management in the Node package. The parser plugin is an HTTP multipart client configured with an endpoint and deployment-owned timeout/size policy.

Version one uses synchronous `POST /file_parse`. MinerU's public API can also expose `/tasks`, but current task state is service-process state rather than a durable Harness job contract. DSH therefore does not persist MinerU task identifiers or build a second job lifecycle around them. If real documents later require background parsing, DSH `ctx.jobs` should own the durable/background user contract and may use MinerU task APIs only as an internal provider detail.

The request asks MinerU for the useful final bundle: Markdown, `content_list`, and extracted images, preferably as a ZIP response, while omitting parser-internal `middle.json`, raw model output, and the original file because DSH already owns the original durable object. Parser backend, effort, OCR strategy, formula handling, and table handling initially follow the configured MinerU deployment defaults unless a demonstrated product need requires DSH-owned options.

### Admission order

Document admission is atomic from the session's point of view:

```text
browser draft
  -> host validates the complete document batch
  -> host persists original documents
  -> MinerU parses each required document
  -> host validates and persists Markdown/content_list/images
  -> host proves the complete rendered document text, including delimiters and metadata, fits the configured version-one model projection budget
  -> host appends the user message with durable DocumentBlock references
```

If validation, parsing, output persistence, or parsed-content admission fails, no user event is appended and the browser draft is restored. As with the existing content-addressed image store, immutable original or parser-output objects already published before a later failure may remain unreferenced; version one does not add destructive rollback or reference-counted garbage collection solely for documents.

Parsing completes before message acceptance in version one. The UI may show a generic attachment-processing state while the submit is in flight, but it does not invent percentage progress that MinerU did not provide through the chosen synchronous API.

### Model projection

Version one uses parsed Markdown as the provider-neutral model representation for accepted documents. At the provider/request projection boundary, DSH resolves the durable Markdown reference and emits a clearly delimited text representation containing the original document name and parsed content. This works with ordinary text models and does not require each LLM adapter to understand PDF or OOXML bytes.

The version-one scope deliberately targets documents whose complete rendered text fits an explicit configurable direct-context budget. Admission counts the full Markdown plus document delimiters and metadata; if that result is larger than the budget, admission fails clearly before the user event is appended rather than truncating the document or pretending that partial content is complete.

Long-document retrieval is a later capability, not a hidden part of the first parser integration. The durable `content_list` leaves a direct path to future `read_document`/`search_document` tools, block/page reads, or semantic retrieval without re-parsing the original. Version one does not create embeddings, a vector database, automatic chunking/RAG orchestration, reranking, or a fixed LangGraph-style document workflow.

Extracted images are persisted for fidelity and later use but are not automatically injected as every image block into every model request in version one. The Markdown text and MinerU-generated captions/analysis remain the default model projection; `content_list` preserves the mapping needed for a later Harness tool to inspect a particular page, image, chart, or table through the existing multimodal image path.

### `content_list` as a Harness programming surface

Persisting `content_list.json` is deliberate even though direct Markdown is sufficient for the first model projection. Its reading-order blocks retain page indexes and structured content types, so future Harness code can inspect headings, locate tables, select page ranges, find image/chart blocks, or transform parsed table content without depending on MinerU's backend-specific internal tree.

This does not commit DSH to one retrieval strategy. A later document tool can expose blocks from this durable representation and Code Mode can compose those tools using the same typed-return model already used elsewhere in Harness.

### Product UI

The Web composer gains a normal file picker for the supported document types in addition to existing paste/drop image intake. Document chips show the user-facing filename, type/size where useful, and a remove control. History renders a compact document card associated with the user message; normal UI does not expose MinerU backend names, task identifiers, Markdown byte counts, OCR modes, ZIP paths, or parser-internal fields.

The original document remains durably available to the session. Version one may expose a session-authorized download/open action where the browser can handle the file, but it does not require an embedded Office viewer or PDF annotation interface to make parsing useful.

### Package and capability ownership

The generic attachment changes extend the existing attachment Service Definition and local provider rather than introducing another storage capability. MinerU parsing is an optional parser provider and consumer layered above those durable files. The exact package split should follow current package naming rules, with a likely dedicated first-party MinerU integration package so deployments without MinerU do not acquire its HTTP/configuration surface.

No change to `agent-loop` is required. Prompt admission, session logging, attachment persistence, provider projection, and Web rendering continue to use their existing extension points. Product-visible implementation changes include package READMEs, the implemented Agent Note rewrite, relevant subsystem documentation for new public types, and real Loader composition coverage.

### DataOps original-file backup extension

DSH remains the authoritative attachment store for model projection, session replay, resume, fork, and session export. A later optional DataOps-specific DSH plugin may copy user-uploaded original files into the DataOps attachment center after DSH persistence. The DataOps copy is a backup record only; DSH never reads it as fallback and no DSH attachment reference resolves through DataOps.

The backup plugin copies only original user files and the minimum source metadata needed by the DataOps attachment center. MinerU Markdown, `content_list`, and extracted images remain DSH-owned derived objects and are not backed up. Delivery timing, user-visible status, retry behavior, DataOps API authorization, and retention require a separate proposal before the backup plugin is implemented; they do not expand the document-attachment MVP.

## Alternatives considered

**Embed MinerU/Python inside DSH.** Rejected because model weights, GPU/CPU dependencies, Python environment management, and MinerU upgrades have a different deployment lifecycle from the Node Harness. An external HTTP provider keeps that complexity outside the core runtime.

**Send original document bytes directly to LLM providers.** Rejected as the generic design because provider file/PDF support is inconsistent and OOXML support is not a portable model contract. Durable parsed Markdown gives every text-capable route one representation while keeping the original file for future provider-specific optimizations.

**Store only Markdown and discard `content_list`/images.** Rejected because Markdown image paths would otherwise depend on transient parser output and the flattened structural blocks are cheap, useful information for later Harness code. Keeping the final parse bundle avoids reparsing when richer document tools arrive.

**Persist MinerU `/tasks` identifiers as document state.** Rejected because the external task identifier does not provide the durable lifecycle semantics a Harness session would imply. Background work, if needed, should be owned by DSH jobs rather than delegated to an opaque parser-process task table.

**Build RAG/vector search in version one.** Rejected because direct Markdown is enough to establish useful document attachments and Harness already supplies programmable tool composition. Retrieval should be added after real long-document workloads show what access pattern is required.

**Use separate parsers for PDF, DOCX, PPTX, and XLSX immediately.** Rejected because the first product goal is one coherent document-attachment path. MinerU already accepts these formats and emits one Markdown/content-list output family; format-specific native analyzers can be added later when they provide a demonstrated advantage, such as spreadsheet-scale data analysis.

**Treat XLSX as a database-scale data source through this path.** Rejected because a spreadsheet attached as a human document and a workbook used as a large analytical dataset are different products. MinerU handles the former; high-volume tabular analysis should use a data-query/import capability rather than document parsing.

**Use DataOps attachment storage as the DSH attachment authority.** Rejected because DSH session replay, fork, model projection, and export require durable local references and must not depend on a second system. A later DataOps plugin may copy originals for backup without changing DSH ownership.

**Back up the MinerU parse bundle to DataOps.** Rejected because Markdown, `content_list`, and extracted images are DSH implementation artifacts rather than user-uploaded attachments. Copying them would require a second derived-artifact data model and coordinated retention without improving current DSH replay.

## Acceptance criteria

- The existing image attachment behavior remains unchanged while the Web composer can submit PDF, DOCX, PPTX, and XLSX documents, including mixed text/image/document drafts.
- Original document bytes are persisted in the existing content-addressed attachment store before any owning user event is appended.
- A MinerU integration can synchronously parse a persisted supported document through `/file_parse` and persist Markdown, `content_list`, and extracted images without storing temporary parser paths in the session.
- Parse or persistence failure appends no user event and restores the browser draft; no automatic retry or speculative background queue is introduced.
- Accepted `DocumentBlock` content is reconstructable from the session log plus durable attachment objects across reload, resume, and fork.
- Small/medium accepted documents project their complete parsed Markdown to text-capable models; over-budget complete rendered document text fails explicitly rather than silently truncating.
- Extracted images remain durable and `content_list` preserves page/block structure for later Harness tools, while version one does not automatically inject every extracted image into every request.
- The implementation adds focused attachment/parser tests, Web composer/history behavior tests, session replay coverage, provider projection coverage, and a real Loader composition test for the product-visible plugin path.
- Version one adds no vector database, embeddings, automatic RAG pipeline, MinerU task persistence, embedded Python runtime, or second attachment store.
- DSH remains authoritative for all current attachment behavior. A later DataOps backup plugin may copy only user originals and cannot provide fallback reads or copy parser-derived objects.

## Risks

Synchronous parsing makes submit latency proportional to document complexity and MinerU deployment speed. Version one accepts that simple lifecycle; if real usage shows unacceptable latency, background ownership can move to `ctx.jobs` without changing durable document references.

MinerU output quality varies by document layout, backend, OCR language, tables, formulas, and Office conversion. DSH should preserve the returned Markdown and structural outputs faithfully rather than inventing a silent repair layer. Product evaluation should measure representative documents before exposing parser tuning as a large settings surface.

Persisting original files, Markdown, structured JSON, and extracted images increases attachment storage. The current attachment store already defers reference-aware garbage collection; document support continues that policy rather than adding an age-based cleanup that could break durable sessions.

The direct-context version-one limit means very large documents are rejected even though MinerU can parse them. This is an explicit scope trade-off to establish correct durable semantics before adding block retrieval or search; the retained `content_list` is the intended foundation for that follow-up.

A later DataOps backup plugin introduces a second physical copy with independent retention and failure reporting. Until its separate proposal defines those behaviors, the DataOps attachment center must not imply that every DSH upload has been backed up.
