# Agent Note: Official file upload and MinerU have separate owners

Status: implemented

English | [中文](2026-09-05-official-file-upload-mineru-tool.zh.md)

## Problem

The former `@sparkelf/dsh-plugin-document-attachments` package owned browser intake, prompt transport, durable parsed artifacts, document cards, sidebar preview, a parser registry, and the MinerU provider. Official DSH `0.1.3-alpha.1` now owns generic upload, durable file references, Chat and Trajectory presentation, and a read-only execution-world path in model history. Keeping the former package would duplicate the official input path and make PDF parsing control unrelated attachment behavior.

## Decision

Official `dsh-client-file-upload`, `dsh-attachment`, and the official Client UI remain the only owners of file intake, storage, prompt admission, history, and attachment presentation. Plus removes the Document Attachment capability package and its exact-source integration patch.

MinerU moves to the independently versioned `@sparkelf/dsh-mineru` package in `SparkElf/dsh-plugins-plus`. It registers the `mineru_parse_pdf` model tool, accepts the exact read-only path already shown in official file history, calls the configured synchronous MinerU endpoint, and returns Markdown to the model. It owns no prompt hook, attachment provider, browser Client, or Office path. `@sparkelf/dsh-officecli` remains the DOCX, XLSX, and PPTX tool, while the Better Sidebar Office plugin previews original Office files.

The Plus profile default-mounts both external tools. `DSH_MINERU_ENDPOINT` independently enables MinerU; its absence does not disable official attachments or Office handling.

## Alternatives considered

**Keep a provider-neutral parser registry between attachments and MinerU.** Rejected because one selected PDF service and one model-facing consumer do not need a replaceable service layer. It would keep prompt admission coupled to parsing and hide the capability from explicit tool selection.

**Patch official upload to invoke MinerU automatically.** Rejected because upload completion is not consent to parse every file, and Office files belong to OfficeCLI. The model already receives a usable path and can select the matching tool.

**Keep custom parsed-document cards and semantic sidebar previews.** Rejected because they duplicate official attachment cards and compete with the original-file Office viewer. MinerU output belongs in the tool result and normal model answer.

## Consequences

- Upload, queue, Chat, Trajectory, and file-path behavior upgrade with official DSH without a Plus attachment fork.
- MinerU can be installed, disabled, upgraded, or removed without changing attachment or Office UI.
- The former package and `@sparkelf/dsh-patch-document-attachments` have no compatibility wrapper; Plus is pre-stable and removes their profile rows directly.
- PDF parsing becomes an explicit model tool call. DOCX, XLSX, and PPTX continue through OfficeCLI and the original-file viewer.
