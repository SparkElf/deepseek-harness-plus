---
description: "Durable document intake, MinerU parsing, bounded model projection, and composer, Chat, and Trajectory cards."
kind: "package-reference"
---

# @sparkelf/dsh-plugin-document-attachments

English | [中文](README.zh.md)

## Summary

This complete Host and Client plugin owns document wire admission, the provider-neutral parser Service and MinerU HTTP provider, browser transport and localized validation, deterministic model delimiters, and cards for the composer, Chat, and Trajectory. With its independently retireable official-source patch, Plus accepts PDF, DOCX, PPTX, and XLSX files, persists originals and parsed artifacts, records document blocks, projects bounded Markdown, and opens the parsed Markdown from each durable card in Better Sidebar.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Set `DSH_MINERU_ENDPOINT` to an absolute synchronous MinerU `/file_parse` URL. The Plus profile mounts a 1 MiB direct-Markdown budget and the MinerU provider with a 120-second timeout and 64 MiB response limit; without the endpoint, both rows stay disabled and no incomplete capability is advertised.

Chat and Trajectory cards use the parsed-Markdown attachment id as the hidden Better Sidebar tab's content address. Better Sidebar opens and reveals the tab; the Document plugin resolves the address through the Session-authorized attachment read operation and renders the Markdown without exposing the attachment store's physical path.

-----

<a id="model-experience"></a>
## Model Experience

### Durable document content

#### What the model sees

Each accepted document contributes only `parsed.modelText`, wrapped with the original name and media type in deterministic delimiters. Parser paths, raw Office archives, content-list JSON, and extracted images remain out of model context.

#### Token effect

The document adds the bounded UTF-8 model-text length plus fixed delimiter text to its user message. Aggregate rendered bytes are checked before admission.

#### KV Cache effect

One durable parser result produces deterministic model text. Later turns can reuse the unchanged user-message prefix containing that document.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Temporary official integration patch**: the selected official revision exposes only image attachment integration; `@sparkelf/dsh-patch-document-attachments` supplies generic storage, durable content, model projection, mixed draft intake, Host limits, file selection, authorized reads, and presentation slots until official DSH publishes equivalent points.
- **Semantic preview**: the sidebar shows parser-produced Markdown for every supported Document format; it does not reproduce the original PDF pagination or Office layout.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- `src/index.ts` and `src/mineru.ts` own admission and parsing; `src/client` owns intake, cards, and sidebar preview. The [preview Agent Note](../../../.agents/notes/implemented/feature/2026-08-31-session-authorized-document-preview.md) owns the content-address decision, and the [distribution Agent Note](../../../.agents/notes/proposed/architecture/2026-08-29-ranged-plus-patchset-distribution.md) owns the patch retirement rule.

</details>
