# @sparkelf/dsh-kb-citation

Client-only DSH plugin for knowledge-base citations. The single citation contract is the
stable token `kb://doc/<docId>/chunk/<key>` emitted by `kb_search` / `kb_chunk_get`.

The viewer parses that token first, resolves it through `POST /knowledge-base/api/chunk`,
and renders it as a readable file link:

```
文件名:第N块
```

Clicking the link opens the original document (never the derived `.docx.md`/`.pdf.md`
sibling), scrolls to the chunk's page, and draws **exactly one union box per page**. The
`chunk`/`resolve` endpoints already return that union in `unionBoxes` (and in `boxes`); the
client also collapses legacy per-paragraph payloads and duplicated page groups before the
first paint, so the reader never sees a stack of small blue rectangles merge a frame later.
Source panel, assistant answer and GenUI cards all use the same parser and the same label
function, so a bare token, an inline-code token, a Markdown link and a GenUI 打开原文 button
agree.

Legacy `.docx.md:193` / `path:line` links are still accepted as a compatibility fallback:
the resolver maps the derived path back to the original Office file, verifies that the
line's text belongs to the resolved chunk, and pins the click to that chunk token. New
answers must not author these forms; they carry the `citation` token instead.

The `:第N块` suffix is muted and atomic so the native hover underline covers the filename,
not the block marker. PDF citations with `page`/`boxes` scroll and draw normalized boxes;
text-only citations use the PDF text layer and list every match instead of silently taking
the first.