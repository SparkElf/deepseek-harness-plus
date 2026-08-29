# @sparkelf/dsh-patch-web-base-path

English | [中文](README.zh.md)

This data-only package adds complete reverse-proxy mount-prefix support to the exact official DSH source base. One `--base-path /prefix` or `DSH_WEB_BASE_PATH=/prefix` value is normalized by WebServer, stripped before HTTP and upgrade route dispatch, injected as the document `<base>`, propagated to startup/browser URLs, and consumed by Connection RPC and Session export. Vite assets, parser preloads, PWA metadata, Backup, and DataOps browser requests resolve below the same document base.

The payload intentionally spans the WebServer, frontend static owner, Web app startup and shell, Connection browser transport, Session export, and Web source assets. Splitting those files would permit partially mounted deployments, so they share one patch lifecycle. Default empty-prefix behavior remains byte-for-byte root-relative from the user's perspective.

The target is official source base `cd5ef8148158c3a752a658978873241fdf8e2bbc`; the package has no JavaScript entry, lifecycle script, compatibility fallback, or credential data. Retire it when official DSH ships equivalent end-to-end base-path behavior.
