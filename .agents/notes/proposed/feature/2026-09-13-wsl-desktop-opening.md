# Agent Note: Desktop opening from a WSL service

Status: proposed

English | [中文](2026-09-13-wsl-desktop-opening.zh.md)

## Problem

The Session-header "open workspace in application" action reported a failure on a WSL host while the Windows interpreter it needs sat on the mounted volume the whole time. Two independent causes were behind it.

The open path resolves `powershell.exe` by name. WSL adds its Windows directories to PATH only for the processes it starts interactively, so a service — which is how the browser UI is normally reached — inherits a PATH with no Windows entry and resolves nothing. Reaching the desktop from that process is impossible even though the mount is present.

Separately, the catalog offered the Linux file manager on that host. The locator asked `canOpenNativePath()`, which answers whether a path can be opened anywhere and returns true for any WSL host because WSL opens through Windows. A Linux GUI program is not what opens a path there, so the button rendered an application that could not exist, and its icon request answered 404.

## Decision

Name the interpreter on the mounted Windows volume when PATH carries no Windows entry. `openWindowsPath` tries the name first, which keeps a WSL host with a healthy PATH on its existing path, and falls back to the known mount only when the spawn failed with ENOENT. A non-zero exit from PowerShell is a real launch failure and still rejects.

Answer the Linux-desktop question separately. `canOpenLinuxDesktop()` reports whether a Linux GUI program can receive a path: a display server is announced and the host is not WSL. The `requiresDesktop` locator check uses it, so WSL stops advertising `xdg-open`.

The resolver gained an `osRelease` seam alongside its existing platform seam. Without it a test that names a platform still reads the host kernel, so the same suite answered differently on a WSL workstation than in CI.

## Alternatives considered

**Fall back only, never try the name.** Rejected: a WSL host with PATH injection reaches the interpreter as it always did, and putting the mount first would change behavior that works.

**Widen PATH inside the process.** Rejected: mutating the process environment to repair one child's lookup leaks into every other command the Host runs.

**Answer the desktop question false whenever WSL is detected.** Rejected as the primary fix: it would remove a working capability. Suppressing the Linux file manager is a consequence of WSL opening through Windows, not a substitute for reaching it.

## Consequences

A WSL service now opens the Windows desktop for a workspace directory. `nativeFileManager()` already returned `explorer` there, so the open action and the reveal action agree.

A host whose PATH carries no Windows entry and whose Windows volume is not mounted at `/mnt/c` still cannot open a path; it reports that PowerShell is unreachable rather than a spawn error naming nothing.

The tests that assert platform behavior now declare the kernel release, so their result no longer depends on where they run. Seven tests previously failed on a WSL workstation and pass on any host.

## Proposal

Add the mounted-interpreter fallback to `openWindowsPath` and the `canOpenLinuxDesktop()` predicate to `@deepseek-ai/dsh-native-command`, use the predicate for the `requiresDesktop` locator check in the open-in-app resolver, and give that resolver an `osRelease` seam so its tests declare the kernel they assume.

## Acceptance criteria

- `canOpenLinuxDesktop()` answers false on a WSL host and on a headless Linux host, and true on a Linux host announcing a display server.
- The Linux file manager is absent from the catalog a WSL host serves, and the icon route is never asked for it.
- `openNativePath` reaches the Windows desktop from a process whose PATH carries no Windows entry and whose Windows volume is mounted at `/mnt/c`.
- A PowerShell failure that is not a missing executable is reported as-is, without a second attempt.
- Tests asserting platform behavior pass on a WSL host and on a non-WSL host alike.

## Risks

The fallback names one Windows installation layout. A host that mounts its Windows volume elsewhere keeps the previous behavior and reports the interpreter as unreachable, which is the same outcome as before this change.

An `ENOENT` from a Windows program that genuinely does not exist is indistinguishable from a missing mount, so a misspelled interpreter would be retried against the mount before the error surfaces.

## Verification

`packages/util/native-command`: 45 tests pass, including the mounted-interpreter fallback and the two desktop predicates; the suite failed six tests on a WSL workstation before this change.

`packages/host/open-in-app`: 63 tests pass; the suite failed one test on a WSL workstation before this change and two more once the Linux file manager was correctly suppressed, which the `osRelease` seam then resolved.

On the affected host: `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe` answers `PS-WORKS` when invoked with the service's PATH, and `canOpenLinuxDesktop()` answers false there while answering true for an ordinary Linux desktop and false for a headless one.
