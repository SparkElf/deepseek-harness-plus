# @sparkelf/dsh-patch-officecli-deliverables

English | [中文](README.zh.md)

This data-only package patches official DSH revision `b2e3b2a0125854567a4a5fcba75782e42fe84901`. It teaches the existing deliverables projection which `officecli` argv operations write an original Office file, so a completed turn lists the DOCX, XLSX, or PPTX path as a clickable output. It does not render, copy, convert, or cache the file.

The payload changes only `packages/client/ui-deliverables/src/client/turn-deliverables.ts`. Remove it after official DSH recognizes the same OfficeCLI output contract.

## Model Experience

None. The OfficeCLI tool owns model instructions and results; this patch changes the browser's output link only.
