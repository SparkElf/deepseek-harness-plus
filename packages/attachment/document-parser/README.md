# @deepseek-ai/dsh-document-parser

English | [中文](README.zh.md)

Provider-neutral external document parsing capability for DeepSeek Harness. This package owns `ctx.documentParser`: a provider registry plus the version-one direct-context Markdown byte budget. It does not parse PDF or Office files itself; implementations register `DocumentParserProvider` instances and the Host calls the selected provider only after the original document is already durable in [`@deepseek-ai/dsh-attachment`](../attachment/README.md).

## Config

| Key | Default | Meaning |
|---|---|---|
| `provider` | auto-select | Parser provider id. When omitted, exactly one usable registered provider must exist. |
| `maxDirectMarkdownBytes` | required | Positive safe-integer bound on the aggregate complete parsed Markdown bytes of all documents in one submitted message. |

```yaml
- id: document-parser
  name: '@deepseek-ai/dsh-document-parser'
  config:
    provider: mineru
    maxDirectMarkdownBytes: 1048576
```

Provider selection is registration-order independent. A configured missing/unavailable provider, no usable provider, or multiple usable providers fails explicitly with a `DocumentParserError`; the runtime never silently chooses another backend.

## Lifecycle

The Host persists every admitted original document first, calls `ctx.documentParser.parse(...)` for each document, persists each parser bundle through the existing attachment store, and only then appends the owning user message. `maxDirectMarkdownBytes` is checked against the aggregate complete Markdown bytes across that submitted document batch before the event is appended. Parser failures can therefore leave unreachable immutable attachment objects, but cannot leave a durable user message whose model-visible contents cannot be reconstructed.

The parser result is transient bytes: complete Markdown, complete `content_list` JSON, and zero or more extracted raster images. Durable session state records only attachment references created by the Host.

## Model Experience

Indirectly through Host document admission and LLM request projection. Accepted parsed documents reach text-capable providers as complete UTF-8 Markdown between explicit document delimiters; session history retains only the originals and parser-artifact references. A submitted document batch whose aggregate parsed Markdown exceeds the configured direct-context budget is rejected rather than truncated.

#### KV Cache effect

A parsed document becomes ordinary model-visible text at its durable message position, so it changes the request prefix from that message onward exactly like equivalent user text. The parser seam adds no hidden cache invalidation or provider-private file state.

## Known Limitations and Deferred Work

- **Version one is direct-context only.** There is no automatic chunking, embeddings, vector database, reranking, or document RAG workflow.
- **Parsing is synchronous from prompt admission.** Background ownership, if needed later, belongs to Harness jobs rather than an external parser task id.
- **The seam standardizes only final parse outputs.** OCR strategy, formulas, tables, parser backend choices, and service-specific tuning remain provider/deployment concerns until a provider-neutral need is demonstrated.
