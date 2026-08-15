# Desktop Runtime Supervisor

English | [中文](README.zh.md)

The desktop runtime uses a detached Supervisor process to own Harness Web, the configured port, optional client HMR watcher, and rebuild lifecycle.

The Supervisor manifest records the explicit install path, DSH_HOME, port, mode, branch, revision, dirty state, phase, and managed child PIDs. The tray sends lifecycle commands through a local Unix socket or Windows named pipe instead of directly owning the Web child. It retakes a listener only when its PID matches the recorded Web PID; set `allowPortTakeover: true` only for a deliberate external handoff.

## Commands

The command-line client prints Supervisor progress events and the final status.

```sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
```

## Progress Page

The progress server hosts a local control page that sends start, restart, and rebuild-and-restart only through the Supervisor socket. It renders phase history and raw process output from the configured runtime log.

```sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:progress -- --port 3082 --manifest <manifest-path> --socket <socket-path>
```

The page reads `locale.preference` from the configured DSH_HOME settings document. With no explicit preference, it follows the browser language and uses Chinese unless the browser language starts with `en`.
