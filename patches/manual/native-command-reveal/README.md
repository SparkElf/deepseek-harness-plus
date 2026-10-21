# Manual patch: reveal must not await Explorer's exit

## Why it is manual

`@deepseek-ai/dsh-native-command` ships inside the runtime tree the deployment builds
from source, and the profile's patch set cannot reach that tree. This patch is applied
to the built `lib/index.js` of the served release.

## Symptom

Choosing "reveal in file manager" leaves the card on *正在文件管理器中显示…* forever.
No error reaches the client because no result ever does.

## Cause

`runExplorer` awaited `execFile`, which resolves on the child's **exit**. Explorer hands
the request to the already-running desktop process and, under WSL, does not exit.
Measured from this host: `execFile('explorer.exe', ['/select,', 'C:\\Users'])` was still
running after 8 s, repeatably; `Start-Process` and a detached `spawn` return in
milliseconds.

## Apply

From the release tree:

```sh
cd <release>/packages/util/native-command
git apply /path/to/native-command-reveal.patch
```

Restart the service afterwards; the module loads at boot.

## What it changes

`runExplorer` spawns Explorer detached and resolves on the `spawn` event, so the request
completes once the argv has been handed over. A genuine failure to start still surfaces
through the spawn `error` event, which is the only outcome the caller could act on.

## Retire when

`runExplorer` stops waiting for Explorer to exit upstream — every GUI launcher this
module drives has the same property, so the fix belongs there rather than here.
