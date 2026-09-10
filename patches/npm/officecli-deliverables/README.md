# @sparkelf/dsh-patch-officecli-deliverables

English | [中文](README.zh.md)

This data-only package patches official DSH revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. It teaches the existing deliverables projection which `officecli` argv operations write an original Office file, so a completed turn lists the DOCX, XLSX, or PPTX path as a clickable output. It does not render, copy, convert, or cache the file.

The payload changes only `packages/client/ui-deliverables/src/client/turn-deliverables.ts`. Remove it after official DSH recognizes the same OfficeCLI output contract.

## Model Experience

None. The OfficeCLI tool owns model instructions and results; this patch changes the browser's output link only.
