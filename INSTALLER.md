# Plus Desktop Installer

Status: in development

[中文](INSTALLER.zh.md)

## User goal

You want a local Harness workspace without hand-cloning a repository, remembering a home directory, or opening a terminal to start and stop the service. The installer sets up one isolated local runtime and leaves a tray control available after the window closes.

## First-release path

1. Choose an empty installation directory and an existing workspace directory.
2. Choose Code Mode, a local port, and whether the daemon starts after installation.
3. Enter a DeepSeek API key, default model, and optional reasoning effort.
4. The installer clones SparkElf/deepseek-harness-plus, installs locked dependencies, builds the source, writes an isolated DSH_HOME, and starts the local Web service when requested.
5. The tray menu opens the local UI, starts or stops the service, opens the log directory, or exits the daemon.

The isolated DSH_HOME lives under the chosen installation directory. It prevents the Plus runtime from overwriting another local Harness installation. The API key is written only to the local runtime environment file with owner-only filesystem permissions where the platform supports them.

The source-build installer currently requires Git and pnpm on the local machine. It checks both before cloning any repository and reports a missing tool in the setup window. A self-contained toolchain is deferred until the release package can validate that additional ownership.

## Provider scope

The first installer release configures the native deepseek-official route. It applies the selected default model and reasoning effort through the Harness settings document. A custom endpoint or OpenAI-compatible provider remains configurable through the existing Web UI after installation; the installer does not claim to import a provider configuration it cannot verify.

## UI contract

The installer uses the existing Harness visual language: quiet near-white surfaces, compact controls, black primary actions, muted gray structure, and a restrained blue state accent. The first window is a real setup tool, not a landing page. It has three steps: location, model, and confirmation. Every field reports its validation at the field that owns it. The confirmation screen shows the target directory, isolated home, provider route, model, port, and start behavior before any filesystem mutation begins.

## Acceptance

- You can complete setup with an empty target directory, a workspace directory, a DeepSeek key, and a model id.
- The app clones the fork into that directory, creates an isolated Harness home, and writes the selected native provider settings without modifying another Harness home.
- You can use the tray to start, stop, open, and exit the local service after setup.
- A failed clone, dependency install, build, settings write, or service start remains visible in the installer and leaves no claim that setup completed.
- The generated desktop package contains the app, renderer, and daemon code required for this path.
