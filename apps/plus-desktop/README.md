# Desktop Runtime Supervisor

English | [中文](README.zh.md)

The desktop manager installs and controls one local Harness runtime. Its compact four-step guide applies language and theme selections immediately, lets a person choose an installation location, and writes <code>locale.preference</code> and <code>ui-theme.preference</code> into the installed DSH_HOME settings document.

On Windows, the guide offers Windows or a selected installed WSL distribution, then opens its native file picker for the installation folder. Selecting a WSL folder opens that distribution in Explorer and returns its Linux path. The installation directory, commands, settings, Supervisor, Harness Web process, rebuilds, repairs, and updates remain in the selected target. Linux and macOS packages use their native environment.

The tray reads Supervisor status and opens the production Harness page and Supervisor page independently. The installer stores separate production, candidate, Supervisor, and candidate Supervisor ports, so the candidate Harness entry probes the configured candidate Supervisor instead of fixed ports. Version management lists tagged Plus releases by exact commit, supports normal upgrade or rollback, and opens an AI merge session for local source changes. The tray also starts, stops, rebuilds, repairs, and opens the target data directory.

The guide configures one initial default model. It supports DeepSeek, OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral, xAI, and an OpenAI-compatible custom provider. It writes the provider profile to <code>settings.yaml</code> and the key to the managed <code>.credentials.yaml</code> document. Harness Web remains the later interface for adding or editing providers and models.

## Preview the setup guide

Run the renderer-only preview without installing or writing configuration:

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop preview:installer
~~~

Open <code>http://127.0.0.1:4177</code>. The preview centers the actual 980×780 installer card on a reverse-theme canvas: a dark card uses a light canvas and a light card uses a dark canvas. Query parameters select a review state, for example <code>?theme=dark&locale=zh&target=wsl&step=1</code>. The preview simulates Windows and installed WSL distributions; the packaged app reads the real platform and distribution list.

## Supervisor commands

The command-line client prints Supervisor phase events and final status.

~~~sh
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> status
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> rebuild-and-restart
pnpm --filter @deepseek-ai/dsh-plus-desktop supervisor:command -- --socket <socket-path> --branch <branch-name> rebuild-and-restart
~~~

The Supervisor owns Harness Web, the configured Harness and Supervisor ports, the optional client HMR watcher, rebuilds, runtime logs, and its HTTP/SSE page. Windows starts the native Supervisor with Electron's utility process, and waits for the named pipe to finish listening before reporting startup complete. A branch rebuild completes before the current Web process stops; a failed build leaves the current process running and retains raw output in the runtime log.

## Development modes

Client-plugin source-only changes use the current production worktree when its <code>pnpm run dev:web</code> watcher is active. Web shell, client runtime, Host, Supervisor, desktop, settings/schema, dependency, lockfile, bundle, and built-artifact changes use a candidate branch in a separate worktree with its own DSH_HOME and separately selected Web and Supervisor ports. The reusable procedure is documented in <code>.agents/skills/supervisor-runtime-control/SKILL.md</code>.
