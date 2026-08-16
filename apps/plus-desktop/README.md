# Desktop Runtime Supervisor

English | [中文](README.zh.md)

The desktop manager installs and controls one local Harness runtime. Its setup guide uses the Harness visual system in one column; language and theme selections update the guide immediately and become <code>locale.preference</code> and <code>ui-theme.preference</code> in the installed DSH_HOME settings document.

On Windows, the guide can install directly on Windows or inside a selected installed WSL distribution. The installation directory, Git and pnpm commands, settings, Supervisor, Harness Web process, rebuilds, repairs, and updates remain in that target. Linux and macOS packages use their native environment.

The tray reads Supervisor status and opens the production Harness page and Supervisor page independently. It enables the candidate Harness entry only while the candidate workflow's 3083 Supervisor reports a Web runtime on 3081. It also starts, stops, rebuilds, checks for available upstream commits without installing them, upgrades, repairs, and opens the target data directory.

## Preview the setup guide

Run the renderer-only preview without installing or writing configuration:

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop preview:installer
~~~

Open <code>http://127.0.0.1:4177</code>. Query parameters select a review state, for example <code>?theme=dark&locale=zh&target=wsl&step=1</code>. The preview simulates Windows and installed WSL distributions; the packaged app reads the real platform and distribution list.

## Supervisor commands

The command-line client prints Supervisor phase events and final status.

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> --branch <branch-name> rebuild-and-restart
~~~

The Supervisor owns Harness Web, the configured port, the optional client HMR watcher, rebuilds, runtime logs, and its HTTP/SSE page. A branch rebuild completes before the current Web process stops; a failed build leaves the current process running and retains raw output in the runtime log.

## Development modes

Client-plugin source-only changes use the current production worktree when its <code>pnpm run dev:web</code> watcher is active. Web shell, client runtime, Host, Supervisor, desktop, settings/schema, dependency, lockfile, bundle, and built-artifact changes use a candidate branch in a separate worktree with its own DSH_HOME, Web port 3081, and progress page port 3083. The reusable procedure is documented in <code>.agents/skills/supervisor-runtime-control/SKILL.md</code>.
