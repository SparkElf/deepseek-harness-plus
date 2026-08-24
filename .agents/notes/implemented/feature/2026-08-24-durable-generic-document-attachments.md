# Agent Note: Durable generic document attachment foundation

Status: implemented

English | [中文](2026-08-24-durable-generic-document-attachments.zh.md)

## Problem

The durable attachment capability was image-specific. Adding PDF or Office file picking only at the browser would have produced temporary bytes with no reconstructable session representation, while adding a parser first would have coupled storage, wire semantics, and UI ownership to one parser implementation. Generic documents also could not safely join the merge-extensible content vocabulary while provider adapters silently ignored unknown blocks.

## Decision

The shipped generic document layer extends the existing attachment capability before any parser integration. PDF, DOCX, PPTX, and XLSX originals use the same content-addressed object namespace as images through generic `saveFile` / `readFile` primitives. Browser and Host admission persist an immutable `DocumentAttachmentRef` before a user message can be accepted, and core content records that reference in a role-neutral `DocumentBlock`.

This note owns only the generic foundation. The broader MinerU proposal remains in [Durable document attachments with MinerU parsing](../../proposed/feature/2026-08-24-mineru-document-attachments.md); parsing, parsed bundles, and direct parsed-body projection are still future work.

## Admission and storage

Document limits are separate from image limits: maximum document bytes, document count, aggregate document bytes, and accepted media types are deployment-resolved policy. `admitEncodedDocuments` decodes canonical base64 for the complete batch, normalizes display names, checks extension/media-type agreement, performs the minimum format check needed to reject obvious mismatches (PDF signature or OOXML ZIP container), validates count and byte limits, and only then starts content-addressed writes.

The original filename is display metadata only and never a storage path. `readFile` verifies both the content digest encoded by the attachment id and the recorded byte length. The generic file primitive deliberately performs no parser-specific interpretation so later Markdown, content-list, or other immutable parser outputs can share the same store.

## Session and provider semantics

`session.prompt` accepts ordered text, image, and document wire parts. Image and document batches are admitted by their own policies, then the Host reconstructs `ContentBlock[]` in the browser's original mixed order. Only after all admission succeeds is the user message handed to the Agent, preserving the persist-before-event boundary.

Generic `DocumentBlock` values are never silently discarded by the shipped DeepSeek or pi-ai request projections. Before a parser exists, adapters insert an explicit text marker naming the durable document and stating that its body has not been parsed. This is intentionally less capable than pretending to read the file, but it preserves semantic honesty and makes an unparsed document visible to the model.

Images retain their existing native multimodal path and model-capability checks. Generic documents do not claim a provider-native file modality, and slash-command attachment submission remains image-only; a document id in that envelope is rejected rather than coerced.

## Browser and durable history

The browser keeps unsent `File` objects in the conversation runtime and stores only opaque draft ids in the existing input machine list. The runtime registry discriminates image and document records, so one ordered id list can preserve mixed attachment order without placing browser objects into input state or session data.

The composer renders image thumbnails and compact document cards in one attachment rail. Drop and picker intake route image and document files to their respective validation paths. History renders durable document references as compact file chips instead of unknown JSON blocks. Reload, replay, and fork retain the `DocumentBlock` because it is ordinary durable session content rather than presentation metadata.

Session ZIP export scans the same durable content carriers for document references and includes each referenced original under `documents/<attachmentId>.<ext>`. Export reads through `readFile`, so an unavailable or corrupt original fails loudly instead of producing a log archive whose document references cannot be reconstructed.

## Alternatives considered

**Create a separate document or MinerU object store.** Rejected because the existing content-addressed store already provides the immutability and crash-durability boundary required by originals and parser artifacts. A parser-specific store would duplicate lifecycle ownership and make parser replacement harder.

**Add `DocumentBlock` and let unsupported adapters ignore it.** Rejected because merge-extensible switches intentionally allow future block types, so a default branch that silently drops document content would turn a durable user attachment into invisible model input. The generic placeholder makes unsupported semantics explicit until parsed projection exists.

**Send PDF/OOXML bytes directly to every provider.** Rejected because provider file support is inconsistent and would turn provider-native file APIs into the generic Harness contract. The durable original remains available for future optimized adapters, while the generic path stays provider-neutral.

**Build parsing or long-document retrieval into this foundation.** Rejected because storage/wire/session correctness is independently useful and reusable. Parser choice, parsed-body budgets, retrieval, and background execution have separate deployment and product contracts and remain in the MinerU follow-up.

## Consequences

Harness now has reconstructable non-image document originals, ordered mixed attachment intake, durable session references, honest provider behavior, browser presentation, fork/replay preservation, and export coverage without introducing a parser dependency.

The immediate model experience is intentionally limited: the generic layer exposes document identity but not document body content. Useful document reasoning therefore still requires the parser follow-up. Minimal OOXML admission also proves only that the input is the expected ZIP container family; a parser remains responsible for validating and extracting actual Office structure.

One historical naming artifact remains in the browser input machine: the opaque mixed attachment list is still called `imageIds`. Runtime semantics no longer assume every id is an image, and changing that internal state vocabulary is deferred because it would create a broad migration with no user-visible benefit.
