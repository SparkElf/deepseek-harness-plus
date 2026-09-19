# Agent Note: A WSL deployment reaches the Windows desktop through the MCP provider

Status: proposed

English | [中文](2026-09-19-a-wsl-deployment-reaches-the-windows-desktop-through-the-mcp-provider.zh.md)

## Problem

The Plus deployment here runs inside WSL, which has no desktop: `DISPLAY` and `WAYLAND_DISPLAY` are unset and no X server runs. Full Power activated computer-use on a Windows host without moving the deployment out of WSL.

Neither provider works as documented. The native provider is the obvious choice and cannot work at all:

```
@trycua/cua-driver-win32-x64-msvc/
  cua_driver_node_runtime.node   643920 bytes   Node native addon (Windows PE)
  cua_driver_sdk.dll           25250128 bytes   Windows DLL
```

A Linux Node cannot load either. Pointing the provider's resolution at the Windows tree — the first idea, and the one this Note exists to save the next person from trying — fails in `dlopen`, and no configuration can change that, because the payload is compiled for the other platform.

## Proposal

**Mount the MCP provider and point its `command` at the Windows executable.**

```yaml
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: computer-use-cua-driver
      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'
      config:
        command: /mnt/c/Users/Administrator/AppData/Local/Programs/Cua/cua-driver/bin/cua-driver.exe
        args: [mcp]
```

The MCP provider spawns a process and speaks JSON-RPC over its stdio, so it never loads the payload into its own address space. WSL's interop layer runs the Windows executable:

```
$ ps aux | grep cua-driver
root 1305505 /init /mnt/c/.../cua-driver/bin/cua-driver.exe
```

`/init` is the WSL interop shim, and the process behind it is a Windows process in the interactive session. It is not emulated and not remote-controlled: it observes and operates the real desktop because that is where it runs.

### The agent cursor is an overlay, not the pointer

`move_cursor` takes a `scope`:

| `scope` | Effect |
|---|---|
| `window` | Moves only the session's overlay; the OS pointer does not move |
| `desktop` | Moves the real OS pointer |

Measured on `scope: "window"`: `get_cursor_position` answered `(1002, 1501)` before and after. The overlay is animated — `spring`, `arc_flow`, `arc_size`, `glide_duration_ms`, `dwell_after_click_ms`, `idle_hide_ms`, `start_handle`, `end_handle`, `turn_radius` — and it appears in the desktop's own window list as `Cua.AgentCursorOverlay.default`. Themes are installable from a Lottie source through `cursor-theme build|install`; the shipped theme is `cua.default`.

The two are independent: `click` drives the real pointer, while the overlay shows the model's intent to a watching user.

## Findings this change rests on

1. **The Windows driver reports the real desktop from WSL.** `cua-driver doctor` answers `interactive session: session 1 has an attached interactive desktop`, `UI Automation: CoCreateInstance(CUIAutomation) succeeded`, and `EnumWindows visible: 17 windows`.
2. **Coordinates are the physical display.** `get_screen_size` answers `2880×1800, scale_factor 2.0`, and `get_cursor_position` tracks the real pointer.
3. **The MCP handshake completes.** A raw `initialize` written to `cua-driver.exe mcp` on stdin returns a result declaring the `tools` capability.
4. **A model turn through the deployment reaches it end to end.** Asked to capture the desktop and list window titles, DSH on 3080 returned the live window stack — including its own browser window, named as the foreground — and saved `desktop_capture.png`. It also reported a real limitation unprompted: the screenshot is dominated by the browser because the other windows are occluded, and `list_windows` coordinates are window positions rather than proof of visibility.
5. **The daemon is a prerequisite, not a side effect.** The binary refuses every call with `daemon is not running on \\.\pipe\cua-driver` until `cua-driver autostart kick` starts it. The installer registers it at `RunLevel=Highest`, so it returns after a reboot without a login.

## Acceptance criteria

- A deployment inside WSL, with no display of its own, lists the Windows desktop's windows and captures it.
- The driver reports the Windows platform and the interactive session, not a Linux substitute.
- `move_cursor` at `scope: "window"` leaves `get_cursor_position` unchanged.
- A deployment without a running daemon fails with the socket message rather than silently degrading.

## Alternatives considered

**Redirect the native provider's resolution into the Windows package tree.** Rejected: the payload is a Windows addon and DLL, so loading it in the Linux process fails regardless of how the path is resolved.

**Run a second DSH on Windows and drive it remotely.** Rejected for this deployment: it duplicates the profile, the sessions, and the plugins, and the goal was one deployment that can reach the other platform's desktop.

**Expose the Windows daemon over a socket and implement a client for it.** Rejected: the MCP provider already ships that client, and the WSL interop boundary is transparent for process spawn and stdio.

## Risks

**The deployment depends on a Windows-side install and a running daemon.** Neither is visible from inside WSL when it is missing, and the first symptom is an empty tool namespace rather than an error at boot.

**`command` names an absolute Windows path through `/mnt/c`.** A different Windows user or drive breaks it, and nothing validates the path at load time.

**The driver controls the real desktop.** Multiple sessions and separate DSH processes can operate the same desktop, and the provider's default permission mode performs promptless automation; callers coordinate complete observe, act, and verify sequences themselves.
