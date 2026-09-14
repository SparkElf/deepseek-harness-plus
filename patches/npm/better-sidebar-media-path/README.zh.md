# @sparkelf/dsh-patch-better-sidebar-media-path

[English](README.md) | 中文

这个纯数据包修补 `dsh-better-sidebar@0.19.1`。它的 `/sidebar/file` 路由把查询里的 `path` 直接交给 `ensureWorkspacePath`，而后者要求绝对路径；客户端发送的却是它显示的那条路径——文件位于会话内时是工作区相对路径——并且在查询里带上 `cwd`，正是为了让宿主解析它。于是工作区内从对话链接的每张图片都返回 `400 "is not an absolute path"`，而同一个文件在调用方发送绝对路径时却能正常提供。

payload 只修改 `lib/index.js`，把相对路径接到解析后的会话 cwd 上，与 `resolveGitPath` 已有的做法一致。当 `dsh-better-sidebar` 发布相同行为后即可移除；上游修复见 [omdsh-dev/DSH-better-sidebar#673](https://github.com/omdsh-dev/DSH-better-sidebar/pull/673)。

## Model Experience

无。该补丁改变的是浏览器如何解析它已经收到的文件链接；不涉及任何模型可见输入、工具结果或提示词。
