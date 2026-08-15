# Desktop Runtime Supervisor

English | [中文](README.zh.md)

The desktop runtime uses one Supervisor process to own Harness Web, the configured port, the optional client HMR watcher, the rebuild lifecycle, and the local control page. On the current WSL development host, systemd keeps the production Supervisor independent of Electron and agent shells.

The Supervisor manifest records the explicit install path, DSH_HOME, Web port, progress port, mode, branch, revision, dirty state, phase, and managed child PIDs. The tray sends lifecycle commands through a local Unix socket or Windows named pipe instead of directly owning the Web child. The 3082 HTTP/SSE page is opened by the Supervisor itself; no second progress-server process is required.

## Commands

The command-line client prints Supervisor phase events and final status.

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> --branch <branch-name> rebuild-and-restart
~~~

The progress page also accepts a target branch for Build and restart. The branch name is the deployment target; the Supervisor builds the branch first and stops 3080 only after the build succeeds. A failed build leaves the current Web process running and keeps complete raw output in the runtime log.

## Development modes

Client-plugin source-only changes use the current production worktree when its <code>pnpm run dev:web</code> watcher is active. Web shell, client runtime, Host, Supervisor, desktop, settings/schema, dependency, lockfile, bundle, and built-artifact changes use a candidate branch in a separate worktree with its own DSH_HOME, Web port 3081, and progress page port 3083. The reusable procedure is documented in <code>.agents/skills/supervisor-runtime-control/SKILL.md</code>.

The page follows <code>locale.preference</code> from the configured DSH_HOME settings document. With no explicit preference, it follows the browser language and uses Chinese unless the browser language starts with <code>en</code>.
