# Agent Note: Web Reverse-Proxy Base Path

Status: implemented

English | [中文](2026-08-25-web-reverse-proxy-base-path.zh.md)

## Problem

A DSH Web process can be mounted below a reverse-proxy path instead of at an origin root. Server-side path stripping alone is insufficient: browser code that requests root-relative APIs, WebSockets, event streams, plugin bundles, or metadata escapes the mount, bypasses the mounting gateway, and can collide with unrelated origin routes.

## Decision

`dsh web --base-path` names one normalized external mount prefix. The Web server accepts requests only below that prefix, strips it once before internal routing, and injects a matching HTML `base` element before browser scripts execute. Root deployment normalizes to an empty prefix and uses the same path.

Browser transports treat Host paths such as `/api/session.list`, `/plugins/events`, and `/sidebar/api/shell.get` as logical routes. They resolve those routes against `document.baseURI`; no client package concatenates or stores the deployment prefix. This applies to unary APIs, WebSockets, generic RPC, dynamic plugin bundles, parser preloads, settings backup and session export, and the HMR event stream.

The default external `dsh-better-sidebar` package owns its `/sidebar/api/*` HTTP carrier. Plus carries a pinned pnpm patch that resolves this carrier against `document.baseURI`; this document-base hunk is retired when the external release provides the same behavior.

## Alternatives considered

**Proxy DSH origin-root routes beside the mount.** Rejected because it exposes a second unauthenticated routing path, conflicts with routes owned by the parent application, and makes the advertised mount incomplete.

**Rewrite DSH HTML, JavaScript, or requests in each embedding gateway.** Rejected because a gateway does not own DSH client internals and content rewriting would duplicate the deployment prefix across products and built artifacts.

**Pass the mount prefix to each client plugin.** Rejected because the HTML document already provides one browser-native base URL. Per-plugin configuration creates duplicate state and allows transports to drift.

## Consequences

Standalone Web behavior is unchanged because `document.baseURI` points at the origin root. Mounted deployments keep every document, asset, API, WebSocket, event stream, and external-sidebar request below one gateway path.

External plugins that construct origin-root URLs remain incompatible with mounted deployment until their owning carrier adopts `document.baseURI` or Plus carries a reviewed patch. Gateway implementations do not compensate with root-route proxies.

Browser integration verification must exercise the mounted page through its parent application's real UI and reject console errors, failed requests, and unexpected API responses; server-only availability is not acceptance evidence.
