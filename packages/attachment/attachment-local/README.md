# @deepseek-ai/dsh-attachment-local

English | [中文](README.zh.md)

The private local implementation of [`@deepseek-ai/dsh-attachment`](../attachment). Images, supported document originals, and generic parser artifacts share one content-addressed namespace at `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>` and are addressed by opaque `sha256:` ids. Original filenames remain reference metadata only and never participate in storage paths.

Each process proves a home durable once by syncing every ancestor entry to the filesystem root, so a directory another process created but has not yet synced is never mistaken for a safe boundary. Writes use a private staging directory, owner-only files, a synced temporary file, an atomic exclusive hard-link publish, and publication-directory syncs (POSIX; Windows relies on filesystem metadata journaling) before an attachment reference is returned. Concurrent deduplicating writers re-verify the already-published object and repeat the durability syncs before reporting success.

Image operations retain format-specific validation. `validateImage` / `saveImage` enforce encoded bytes, decoded media type, pixel count, and per-side dimension policy; `readImage` verifies the digest plus logged image metadata. The default 2000px per-side limit stays below the strictest deployed request bound for image-heavy model calls, because an admitted image can ride every later request in its session.

Generic files use `saveFile` / `readFile`. The local service exposes independent `documentLimits` for PDF, DOCX, PPTX, and XLSX admission, while the generic object primitive itself stores already-admitted bytes without parsing them. `readFile` verifies the content-addressed digest and recorded byte length, which is also the integrity path used when session export reads original documents or a future parser reads immutable artifacts.

`DSH_HOME` resolves through the shared path policy: explicit config, `$DSH_HOME`, then `~/.dsh`. Session logs contain only durable references and verified metadata, never this host path. Both image and generic reads preserve optional cancellation rather than translating an abort into a storage failure.

## Model Experience

Indirectly, by keeping durable image and document references reconstructable after restart and fork. The local store performs no model call and does not decide how a document is projected to a provider.

#### KV Cache effect

None beyond the content blocks assembled by the requesting provider adapter.

## Known Limitations and Deferred Work

- Objects are retained indefinitely; reference-aware garbage collection is deferred.
- The local backend assumes the Host and consumers resolving attachments share this filesystem service.
- Generic document storage validates durability and integrity only; document parsing and extracted-content semantics belong to a parser consumer.
- Animated GIF metadata is validated from the logical screen; frame-level decoding policy is provider-owned.
