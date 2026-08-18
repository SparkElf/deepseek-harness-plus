---
name: fast-artifact-downloads
description: Use when downloading large build artifacts or files (GitHub Actions artifacts, release assets, any large HTTP body) that crawl on a single stream. Parallelize with HTTP ranges, resume on interruption, and prefer a proxy when a probe shows it is faster.
---

# Fast Artifact Downloads

Single-stream downloads from CI artifact storage are routinely throttled (~50 KB/s on a 96 MB installer). Always parallelize when the server answers ranged requests; never make the user watch a half-hour single stream.

## GitHub Actions artifacts

1. Resolve the storage blob WITHOUT downloading the body: request the API zip endpoint with the auth header and read the 302 `Location` header (`curl -s -D - -o /dev/null` + awk). Do NOT use `curl -L` here — it follows the redirect and streams the whole body into your probe.
2. Read `Content-Length` from the blob URL (the SAS token is embedded; no auth header needed on the blob).
3. Split into 8 contiguous byte ranges and download concurrently (`curl -s -r START-END` in background, `wait` for all), then `cat` the parts in index order.
4. Verify before use: zip integrity (`zipfile.testzip()` or extract) and sha256 against the expected checksum. Swap user-facing installers atomically: write `.new-setup.tmp` beside the target, then `mv -f`.
5. If a part stalls, resume it with `curl -C -` rather than restarting the transfer.

## Proxy preference

When `http_proxy`/`https_proxy` or a user-supplied proxy is present, probe before the big transfer: fetch ~8 MB single-stream with and without the proxy, compare throughput, and run the parallel download over the faster path. Without a configured proxy, skip the probe.

## Rules

- Large downloads run as background jobs; poll them, never block a foreground call past the wall-clock ceiling.
- Checksum-verify before swapping anything the user installs.
- Report the achieved parallel throughput in the handoff so regressions are visible.
