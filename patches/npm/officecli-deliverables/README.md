# @sparkelf/dsh-patch-officecli-deliverables

English | [中文](README.zh.md)

This data-only package patches official DSH revision `5dda764ed3aa172535a7967b06ff95d9cbfe536a`. It teaches the existing deliverables projection which `officecli` argv operations write an original Office file, so a completed turn lists the DOCX, XLSX, or PPTX path as a clickable output. It does not render, copy, convert, or cache the file.

The payload changes only `packages/client/ui-deliverables/src/client/turn-deliverables.ts`. Remove it after official DSH recognizes the same OfficeCLI output contract.

## Model Experience

None. The OfficeCLI tool owns model instructions and results; this patch changes the browser's output link only.
