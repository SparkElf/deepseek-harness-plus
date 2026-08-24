# attachment/ - durable attachment capability family

English | [中文](README.zh.md)

The durable binary attachment store, provider-neutral document parsing capability, local content-addressed provider, and optional MinerU HTTP parser. These are product packages; document parsing reuses the same attachment object store rather than introducing parser-owned storage.

| Package | Role | ctx key |
|---|---|---|
| `attachment/` | Immutable file/image/document references, admission limits, and storage service | `ctx.attachments` |
| `attachment-local/` | Content-addressed private storage below `DSH_HOME` | (provides `ctx.attachments`) |
| `document-parser/` | Parser provider registry and aggregate direct-Markdown admission budget | `ctx.documentParser` |
| `document-parser-mineru/` | Synchronous external MinerU `/file_parse` provider | (registers on `ctx.documentParser`) |

Unsent browser drafts remain outside this capability family. The Host persists accepted original attachment bytes before their user event; when a document parser is composed, it also persists Markdown, `content_list`, and extracted images as immutable attachment objects and records only their durable references in the session.
