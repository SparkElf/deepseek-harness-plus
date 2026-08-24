# @deepseek-ai/dsh-client-ui-attachment

English | [中文](README.zh.md)

Dynamic attachment presentation plugin for the conversation UI. It waits for the conversation package's `conversation.input.attachments` and `conversation.message.images` declarations through `ctx.slots.inject`, then registers the mixed composer attachment rail, whole-page file-drop presentation, durable history image gallery, and original-image lightbox. The conversation owner supplies browser draft records, callbacks, image loading, and its namespace translator; presentation components stay pure props and are not exported from the package entry.

## Attachment rail

`AttachmentRail` is one horizontally scrolling mixed-attachment row. Pending images keep the existing fixed 64px thumbnail card and single-click original-image preview. Pending documents use wider compact cards that show the filename, file-type label, and human-readable size; document cards do not pretend to preview or parse file contents. Both item kinds share the same remove control and overflow behavior.

The scrollbar stays hidden and overflow is announced by circular edge arrows. Each arrow pages one viewport minus one card of context (with a 200px floor), using smooth scrolling unless the user requests reduced motion. Arrow visibility is recomputed on scroll, item-count changes, and rail ResizeObserver changes. A vertical wheel is consumed and translated into bounded horizontal travel so the conversation behind the composer does not scroll at the same time; a purely horizontal pan remains native. Newly added items reveal the rail end, while removal keeps the current position.

## Composer drop presentation

`ComposerAttachments` listens to the document-level file drag owned by this slot entry. File drops are split by kind: raster images are forwarded to the existing image intake callback and all other files are forwarded to the document intake callback, whose owner performs the authoritative PDF/DOCX/PPTX/XLSX validation. A blocked composer shows the generic attachment-disabled overlay and forwards nothing. The overlay is presentation only; count/byte/media-type admission stays in the conversation owner and Host.

Mixed drafts do not change image behavior. Image cards still open `ImageLightbox`; document cards have no lightbox. Removing a document calls the document-specific owner callback, while removing an image also lets the conversation runtime revoke its browser object URL.

## Message images and the lightbox

`MessageImage` renders one durable historical image by loading a session-authorized URL through the owner's `ImageLoader`; failure provides a retry control, and a settled image opens `ImageLightbox`. A lone image renders up to 240px on its longer edge with the displayed aspect ratio clamped to [0.25, 4], while multi-image tiles remain fixed 64px squares. `ImageGallery` owns wrapping and message-side alignment. `ImageLightbox` is a document-level modal that closes on Escape, mask press, or its close control and restores focus to its opener.

Durable document-history cards are rendered by the conversation package from `DocumentBlock` metadata rather than by this image-presentation plugin. This package owns the composer document cards because the composer attachment slot is its presentation surface; it does not own session content semantics.

## Model Experience

None. This plugin only renders attachment state and invokes owner callbacks; it neither creates durable content nor assembles provider requests.

#### KV Cache effect

None; this package performs no model call.

## Known Limitations and Deferred Work

- Composer document cards support the generic PDF/DOCX/PPTX/XLSX draft path, but provide no embedded PDF/Office preview or upload-progress percentage.
- Historical document cards are metadata-only until the separate parser capability makes parsed content available; parser internals do not belong in this package.
- The image lightbox has no zoom or download control and does not trap focus, although it sets `aria-modal` and restores focus when closed.
