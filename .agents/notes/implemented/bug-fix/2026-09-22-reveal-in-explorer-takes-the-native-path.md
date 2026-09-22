# Agent Note: the Explorer reveal gesture takes the native path

Status: implemented

English | [中文](2026-09-22-reveal-in-explorer-takes-the-native-path.zh.md)

## Problem

"Reveal in file manager" always opened the desktop on a WSL host for a path containing non-ASCII characters, and never selected the file. Only non-ASCII paths were affected, which is why manual verification with English paths stayed green.

`revealNativePath` passed the `wslpath -w` output through `pathToFileURL(windowsPath, { windows: true })` before handing it to Explorer. Explorer does not resolve a percent-encoded non-ASCII path in that form, so it selected nothing and opened its default location.

## Decision

`revealNativePath` in `patches/npm/wsl-native-open` hands Explorer the native path directly:

```ts ignore-check
try {
  await run('explorer.exe', ['/select,', windowsPath], signal)
} catch (error) {
  // Explorer can exit 1 after delegating to the existing desktop process.
  if (!(error instanceof Error) || !('code' in error) || error.code !== 1) throw error
}
```

`wslpath -w` already produces the spelling Explorer reads, so the URL conversion was a redundant layer that also caused the defect. The now-unused `pathToFileURL` import is removed with it.

## Findings this change rests on

1. **The two forms differ only in encoding.** A single-variable comparison against a directory Explorer had never opened: the native path selected `子目录/测试文件.txt`, while the URL form changed nothing.
2. **An ASCII control ruled out argument passing.** The same ASCII path worked in both forms, so neither splitting `/select,` from the path nor merging them is the cause. That also refutes the earlier diagnosis that named argument passing.
3. **The observation is window state, not exit code.** Explorer always exits 1 after delegating to the running desktop process, so the exit code cannot separate success from failure; `LocationName` and `Document.SelectedItems()` from `Shell.Application.Windows()` are the decidable observations.
4. **The patch plane and the upstream plane are separate.** The repository source at `packages/util/native-command/src` is the upstream plane, and its existing unit test asserts `file:///C:/work/%E6%8A%A5%E5%91%8A.txt`, which freezes the defect. The behavior fix lives on the patch plane; the upstream fix travels on its own branch ([workflow](../../../../docs/development.md#patched-third-party-packages)).
5. **Explorer cannot claim the foreground from a service session.** The same command issued by a native Windows process reaches the foreground, while a systemd-hosted DSH session does not, and `AppActivate` reports success without moving the window. This is the Windows foreground lock, so the revealed window stays behind the browser. Changing the opener cannot fix it; a UI acknowledgement is the place to address it if a product wants the user to notice.

## Alternatives considered

**Keep the URL form but stop percent-encoding non-ASCII characters.** An unencoded `file://` URL is no longer a valid URL once the path holds a space or a comma, and both characters are common in Windows paths. The native path covers both.

**Quote the path as `/select,"path"`.** Measured to fall back to the default location for the same non-ASCII path, so it was not adopted.

**Switch the gesture to PowerShell `Invoke-Item`.** That opens the file rather than revealing and selecting it, duplicates the existing `openNativePath` branch, and loses the selection semantics.


## Consequences

- Paths containing Chinese characters, spaces, and commas are now located correctly on WSL hosts.
- The fix ships inside the `wsl-native-open` patch, so it reaches both a source-run deployment and a registry installation; the patch's `packages/util/native-command/` target and the existing override keep it reachable.
- Once upstream merges the fix, this patch's corresponding hunk retires.
