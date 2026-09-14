# @sparkelf/dsh-patch-better-sidebar-media-path

English | [中文](README.zh.md)

This data-only package patches `dsh-better-sidebar@0.19.1`. Its `/sidebar/file` route passed the query's `path` straight to `ensureWorkspacePath`, which requires an absolute path, while the client sends the path it displays — workspace-relative when the file lies inside the session — and rides `cwd` in the query for exactly that purpose. Every image linked from a conversation inside a workspace answered `400 "is not an absolute path"`, and the same file served fine when the caller sent an absolute form.

The payload changes only `lib/index.js`, joining a relative path onto the resolved session cwd as `resolveGitPath` already does. Remove it when `dsh-better-sidebar` publishes the same behavior; the upstream fix is [omdsh-dev/DSH-better-sidebar#673](https://github.com/omdsh-dev/DSH-better-sidebar/pull/673).

## Model Experience

None. The patch changes how the browser resolves a file link it already receives; no model-visible input, tool result, or prompt changes.
