# Agent Note: Keep patched third-party plugins patch-owned in Plus

Status: implemented

English | [中文](2026-09-01-patched-third-party-plugin-workflow.zh.md)

## Problem

A third-party plugin can have two valid code locations: the upstream source repository and the package expanded for a Plus profile patch. The active DSH profile executes the patched package, so editing only an upstream checkout does not change the product under test. Without a standing ownership check, contributors can implement and validate against different code planes while believing they are changing the same plugin.

## Decision

Every third-party package or plugin task starts by checking the root workspace and active profile `pnpm-workspace.yaml#patchedDependencies`. A matching package remains patch-owned inside Plus: contributors edit the directory produced by `pnpm patch` or the retained `packages-preview/<topic>/edit` directory, regenerate the patch with `pnpm patch-commit`, and verify the profile that declares that patch. The extracted package already includes earlier Plus changes, so contributors modify it incrementally instead of replacing complete built files with upstream artifacts.

A managed profile Host restarts only through its owning supervisor after profile installation and validation. The official Plus deployment uses `deepseek-harness-plus.service`; direct process termination and `nohup` launches bypass supervisor ownership and diagnostics.

The upstream checkout is a separate contribution plane. After the patched Plus profile passes its required validation, contributors port the same behavior to a clean upstream branch and submit the upstream pull request. Upstream source changes never substitute for the internal patch during Plus development.

The root `AGENTS.md` carries the always-loaded ownership check. The contributor procedure lives in `docs/development.md`; the patch file and profile `patchedDependencies` entry remain the executable source of truth.

## Alternatives considered

- **Develop only in the upstream checkout, then install it locally.** Rejected because it bypasses the exact package and patch that Plus ships, so local success does not prove the active profile.
- **Edit `node_modules` or the generated patch directly.** Rejected because installed files are disposable and a hand-edited patch does not preserve the reproducible extraction and commit workflow.
- **Vendor every patched plugin as source.** Rejected because a package patch is sufficient for bounded downstream changes and keeps upstream ownership intact without importing another source tree into Plus.

## Consequences

- Agents identify package ownership before editing code, so an active profile patch is visible before an upstream repository is cloned.
- Internal review sees the exact patch shipped by Plus; upstream review receives a clean source-level change after internal validation.
- A change touching a patched package may require two synchronized diffs, but each diff has one owner and one verification target.
- Incremental patch edits preserve existing Plus compatibility, and supervisor-owned restarts expose import failures through one service journal.
