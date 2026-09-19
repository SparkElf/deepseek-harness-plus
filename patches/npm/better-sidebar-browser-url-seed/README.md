# @sparkelf/dsh-patch-better-sidebar-browser-url-seed

English | [中文](README.zh.md)

This data-only package patches `dsh-better-sidebar@0.19.1`. Clicking an external link in the conversation opened the sidebar's browser tab with an empty address bar: the tab record never received the link's URL.

Three places dropped it. `openTab` builds the tab record for the native surface and copied only `path` and `diff` from the seed, ignoring `url`; the native tab adapter did the same when minting a record on first open; and when navigating a record that already existed it stored the URL in `meta.url`, a field no view reads. The browser view takes its address from `tab.path` and writes navigations back to the same field, so all three left the address bar empty.

The payload changes only `lib/client.js`. Each site now resolves `path ?? url` into `path`, the field the browser view already owns, and the dead `meta.url` copy is removed. The parenthesised comparison is deliberate: `??` binds looser than `===`, so the unparenthesised form sends a present `path` into the empty-object branch and loses it.

## Model Experience

None. The patch changes which field an already-passed URL lands in; no model-visible input, tool result, prompt, or session event changes.

## Known Limitations and Deferred Work

- **The patch pins `dsh-better-sidebar@0.19.1`.** A later release that carries the URL seed itself makes this patch redundant rather than wrong; retire it then.
- **Only the native right-Sidebar path is covered.** A bottom-workbench open resolves the URL onto `path` already, so it needs no change here; a future surface that introduces a third path would need the same treatment.
