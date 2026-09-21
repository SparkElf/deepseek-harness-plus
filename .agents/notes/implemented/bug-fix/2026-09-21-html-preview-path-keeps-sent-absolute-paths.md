# Agent Note: the HTML preview route keeps an absolute path it was sent

Status: implemented

English | [中文](2026-09-21-html-preview-path-keeps-sent-absolute-paths.zh.md)

## Problem

The sidebar's HTML preview route (`/sidebar/html`) refused every produced file that lived outside the session workspace:

```json
{"ok":false,"error":{"code":"fs-error","message":"cannot resolve target \"/root/projects/mnt/d/BaiduSyncdisk/.../题库.html\": ENOENT"}}
```

The reported path was not the one the client sent. A deliverable at `/mnt/d/...` had been joined onto the session cwd, producing `/root/projects/mnt/d/...`, which does not exist.

The `better-sidebar-html-preview-path` patch introduced that join to fix a real case: a produced-file path can arrive workspace-root-relative (`/x.html`), which the host reads as a POSIX root and realpaths outside the workspace. Its predicate was `isAbsolute(decodedPath) && !isWithin(htmlCwd, decodedPath)` — "absolute and outside the workspace". A mounted drive is exactly that, so every legitimate absolute path outside the workspace was rewritten into a path that cannot exist.

The media route (`/sidebar/file`) had solved the same problem correctly and was unaffected: it joins only when the path is **not** absolute (`isAbsolute(raw) ? raw : join(cwd, raw)`).

## Decision

The HTML route chooses by **existence**, not by containment:

```js
const htmlCwd = await sessionCwdOf(ctx, sessionId);
let path = decodedPath;
if (isAbsolute(decodedPath) && !isWithin(htmlCwd, decodedPath)) {
    const candidate = join(htmlCwd, decodedPath);
    const exists = await stat(candidate).then(info => info.isFile(), () => false);
    if (exists) path = candidate;
}
const absolute = await ensureWorkspacePath(htmlCwd, path, fenceEnabledOf(() => settingsFace));
```

The relative shape the patch was written for still resolves, because the cwd-joined candidate exists for it; every other absolute path is used exactly as sent. Containment stays where it already belonged: `ensureWorkspacePath` still realpaths the result and `assertWithinWorkspace` still enforces the fence.

Measured on the live 3080 instance with a real session id and the deliverable that reported the failure: HTTP 200 and the full 5.65 MB body, while a workspace-relative path keeps returning 200. Paths outside the workspace still resolve only because `workspaceFence` is off in that deployment — the change does not alter fence behaviour in either state.

## Alternatives considered

**Rewrite the predicate to "absolute and the cwd-joined candidate does not exist" with no stat.** This is the same rule with the test moved into the branch condition, but it cannot express a fallback: the candidate must be probed before deciding, and a bare `existsSync` on the request path would block the event loop.

**Normalise `/mnt/...` specially.** Keying on a mount prefix encodes one deployment's filesystem layout into a published patch.

**Mirror the media route exactly (`isAbsolute ? raw : join`).** That drops the workspace-root-relative case the patch exists to fix, so a produced `/x.html` would resolve against the filesystem root again.

**Put the decision in the client and send only resolved paths.** The route must stay safe for any client, and the relative shape is what older clients send.

## Consequences

The payload was also repaired: the earlier edit had left the hunk header at `-5080,8 +5080,14` while the hunk carried 21 new lines, so `git apply` rejected the whole file with `corrupt patch at line 29`. The header now matches the body, and the payload applies cleanly to `dsh-better-sidebar@0.19.1`.
