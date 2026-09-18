# @sparkelf/dsh-patch-better-sidebar-main-view-session

English | [中文](README.zh.md)

This data-only package patches `dsh-better-sidebar@0.19.1`. The sidebar read the on-screen session from `sessions.list.current`; DSH 0.1.6-alpha.2 removed that field, so the read produced `undefined` and `store.setSession(undefined)` cleared the session. Every file click then ran `openFile` → `openTab`, which returns without opening anything when the store holds no session id — a click that opened no tab, made no request, and logged nothing, for every file type.

The payload changes only `lib/client.js`, adding `mainViewSessionId` and reading the session through it. The helper returns `list.current` when the runtime publishes it and otherwise mirrors the rule the runtime's own ui-session service uses to pick the main view: the row whose `retainedBy.mainView` count is positive. One build therefore serves both runtime generations. It deliberately does not fall back to the first listed id — catalog order is host order, so with several sessions open the sidebar would bind to a session the user is not looking at.

## Model Experience

None. The patch changes which session the sidebar binds to; no model-visible input, tool result, prompt, or session event changes.

## Known Limitations and Deferred Work

- **The patch pins `dsh-better-sidebar@0.19.1`.** A later release that adopts the alpha.2 rule itself makes this patch redundant rather than wrong; retire it then.
- **The helper reads `retainedBy` structurally.** A runtime that renames the retention field leaves the sidebar unbound again, exactly as it was before this patch, rather than failing loudly.
