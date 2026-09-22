# Agent Note：HTML 预览路由保留客户端发来的绝对路径

Status: implemented

[English](2026-09-21-html-preview-path-keeps-sent-absolute-paths.md) | 中文

## 问题

侧边栏的 HTML 预览路由（`/sidebar/html`）拒绝每一个位于会话工作区之外的产品文件：

```json
{"ok":false,"error":{"code":"fs-error","message":"cannot resolve target \"/root/projects/mnt/d/BaiduSyncdisk/.../题库.html\": ENOENT"}}
```

报出的路径并不是客户端发来的那个。位于 `/mnt/d/...` 的交付物被拼接到会话 cwd 上，得到不存在的 `/root/projects/mnt/d/...`。

`better-sidebar-html-preview-path` 补丁引入该拼接是为了修一个真实场景：产品文件路径可能以工作区根相对形式（`/x.html`）到达，而 host 会把它读作 POSIX 根并在工作区之外 realpath。它的判据是 `isAbsolute(decodedPath) && !isWithin(htmlCwd, decodedPath)`，即「绝对且在工作区之外」。挂载盘恰好符合该条件，于是每个合法的绝对路径都被改写成不可能存在的路径。

媒体路由（`/sidebar/file`）已正确解决同一问题且未受影响：它只在路径**不是**绝对路径时拼接（`isAbsolute(raw) ? raw : join(cwd, raw)`）。

## 决策

HTML 路由按**是否存在**选择，而不是按是否包含：

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

补丁原本要处理的相对形式仍能解析，因为对它而言 cwd 拼接后的候选路径存在；其他所有绝对路径都按发来的样子使用。包含关系留在它本来该在的位置：`ensureWorkspacePath` 仍对结果做 realpath，`assertWithinWorkspace` 仍执行围栏。

在运行中的 3080 实例上用真实 session id 与报错的交付物实测：HTTP 200 且完整 5.65 MB 响应体，同时工作区相对路径仍返回 200。工作区之外的路径之所以能解析，只是因为该部署关闭了 `workspaceFence`；本改动不改变围栏在任一状态下的行为。

## 已考虑但未采用的方案

**把判据改写成「绝对且 cwd 拼接后的候选路径不存在」，不做 stat。** 这是把判断挪进分支条件的同一规则，但无法表达回退：必须先探测候选路径再决定，而对请求路径直接 `existsSync` 会阻塞事件循环。

**专门规范化 `/mnt/...`。** 以挂载前缀为键会把某个部署的文件系统布局编码进已发布的补丁。

**完全照搬媒体路由（`isAbsolute ? raw : join`）。** 那会丢掉补丁存在的理由，即工作区根相对形式，于是产品文件 `/x.html` 会再次相对文件系统根解析。

**把判断放到客户端，只发解析后的路径。** 路由必须对任何客户端保持安全，而相对形式正是旧客户端发送的形式。

## 影响

载荷同时被修复：先前的编辑把 hunk 头留在 `-5080,8 +5080,14`，而该 hunk 实际携带 21 个新行，于是 `git apply` 以 `corrupt patch at line 29` 拒绝整个文件。现在头部与内容一致，载荷可干净应用到 `dsh-better-sidebar@0.19.1`。
