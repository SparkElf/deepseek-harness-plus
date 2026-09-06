# @sparkelf/dsh-patch-better-sidebar-office-viewer

English | [中文](README.zh.md)

This data-only package patches exactly `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.2.0`. It removes the redundant download prompt, gives DOCX a page canvas with fit-width and zoom controls, keeps the complete XLSX Univer editing interface while improving workbook style projection, and adds PPTX thumbnails, search, zoom, and centered slides. It also consumes the font manifest supplied by `@sparkelf/dsh-office-viewer-fonts`.

The payload changes only `lib/client.js`; the upstream package still owns every Viewer registration and lifecycle. Remove this patch after an upstream release includes the same viewer behavior and the three-format system workflow passes without it.

## Model Experience

None. This package changes only browser presentation.
