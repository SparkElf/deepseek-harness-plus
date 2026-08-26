# attachment/ - durable attachment capability family

English | [中文](README.zh.md)

The durable binary attachment store, provider-neutral document parsing capability, local content-addressed provider, and optional MinerU HTTP parser. These are product packages; document parsing reuses the same attachment object store rather than introducing parser-owned storage.

| Package | Role | ctx key |
|---|---|---|
| `attachment/` | Immutable file/image/document references, admission limits, and storage service | `ctx.attachments` |
| `attachment-local/` | Content-addressed private storage below `DSH_HOME` | (provides `ctx.attachments`) |
| `document-parser/` | Parser provider registry and aggregate complete direct-document text budget | `ctx.documentParser` |
| `document-parser-mineru/` | Synchronous external MinerU `/file_parse` provider | (registers on `ctx.documentParser`) |

Unsent browser drafts remain outside this capability family. Image originals become durable before their user event. Document input is advertised and accepted only with a parser; the Host persists the original, complete Markdown, `content_list`, and extracted images and passes the complete rendered-document text budget before recording their required references in the user event.
