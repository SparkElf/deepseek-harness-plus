# Agent Note: Web 反向代理基础路径

Status: implemented

[English](2026-08-25-web-reverse-proxy-base-path.md) | 中文

## 问题

DSH Web 进程可以挂载在反向代理路径下，而不必位于 origin 根路径。仅由服务端剥离路径并不完整：浏览器代码如果请求根相对 API、WebSocket、事件流、插件 bundle 或 metadata，就会逃逸挂载路径、绕过挂载 gateway，并可能与 origin 上其他 route 冲突。

## 决策

`dsh web --base-path` 指定一个规范化的外部挂载前缀。Web server 只接收该前缀下的请求，在内部路由前剥离一次，并在浏览器脚本执行前注入匹配的 HTML `base` 元素。根部署规范化为空前缀，使用同一路径。

浏览器 transport 将 `/api/session.list`、`/plugins/events` 和 `/sidebar/api/shell.get` 等 Host path 视为逻辑 route，并相对 `document.baseURI` 解析；任何 client package 都不拼接或保存部署前缀。这一规则覆盖 unary API、WebSocket、generic RPC、动态插件 bundle、parser preload、settings backup、session export 以及 HMR event stream。

默认外部package `dsh-better-sidebar@0.16.1`拥有`/sidebar`下的API、upload、media、HTML preview、lazy bundle和WebSocket carrier。Plus通过固定版本的pnpm patch让所有client carrier相对`document.baseURI`解析；[上游PR #422](https://github.com/omdsh-dev/DSH-better-sidebar/pull/422)拥有外部实现和focused tests。该变更合并并发布、DSH采用包含它的release后，移除这一临时hunk。

## 考虑过的替代方案

**在挂载路径之外同时代理 DSH origin 根 route。** 不采用，因为这会暴露第二条未认证路由路径、与父应用拥有的 route 冲突，并使对外声明的挂载路径不完整。

**由每个嵌入 gateway 改写 DSH HTML、JavaScript 或请求。** 不采用，因为 gateway 不拥有 DSH client internals，内容改写还会让多个产品和 built artifact 重复持有部署前缀。

**把挂载前缀传给每个 client plugin。** 不采用，因为 HTML document 已提供唯一的 browser-native base URL。逐插件配置会产生重复状态，并允许 transport 发生偏离。

## 后果

Standalone Web 行为不变，因为 `document.baseURI` 指向 origin 根路径。挂载部署的 document、asset、API、WebSocket、event stream 和外部 sidebar request 全部保留在同一 gateway path 下。

构造 origin 根 URL 的外部插件与挂载部署不兼容，直到其所属 carrier 使用 `document.baseURI`，或 Plus 携带经过 review 的 patch。Gateway implementation 不通过根 route 代理进行补偿。

浏览器集成验证必须从父应用真实 UI 操作挂载页面，并拒绝 console error、failed request 和 unexpected API response；只有 server 可访问不能作为验收证据。
