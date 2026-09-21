# Agent Note: the Explorer reveal gesture takes the native path

Status: implemented

English | [中文](2026-09-22-reveal-in-explorer-takes-the-native-path.zh.md)

## Problem

「在文件资源管理器中显示」在 WSL 主机上对**含非 ASCII 字符的路径**永远打开桌面，
从不选中目标文件。它只影响中文路径，所以英文路径的手工验证一直是绿的。

`revealNativePath` 把 `wslpath -w` 的输出再经 `pathToFileURL(windowsPath, { windows: true })`
转成 `file://` URL 才交给 Explorer。Explorer 不解析该形式下的百分号编码非 ASCII 路径，
于是选不中任何目标并退回默认位置。

## Decision

`patches/npm/wsl-native-open` 的 `revealNativePath` 直接传原生路径：

```ts
try {
  await run('explorer.exe', ['/select,', windowsPath], signal)
} catch (error) {
  // Explorer can exit 1 after delegating to the existing desktop process.
  if (!(error instanceof Error) || !('code' in error) || error.code !== 1) throw error
}
```

`wslpath -w` 已经产出 Explorer 能读的拼写，URL 转换是多余的中间层；它同时也是缺陷来源。
不再使用的 `pathToFileURL` 导入一并移除。

## Findings this change rests on

1. **两种形式只差编码。** 用 Explorer 从未打开过的目录做单变量对照：
   原生路径选中了 `子目录/测试文件.txt`，URL 形式没有任何变化。
2. **ASCII 对照排除了参数拼接。** 同一 ASCII 路径在两种形式下均正确，
   所以 `/select,` 与路径分成两个 argv 或合并成一个都不是原因，
   这也否定了先前把它当作根因的判断。
3. **判据是窗口状态而非退出码。** Explorer 委托给已运行实例后总是以 1 退出，
   退出码无法区分成功与失败；`Shell.Application.Windows()` 的
   `LocationName` 与 `Document.SelectedItems()` 才是可判定的观测。
4. **补丁平面与上游平面分离。** 仓库源码 `packages/util/native-command/src` 是上游平面，
   其现有单测断言 `file:///C:/work/%E6%8A%A5%E5%91%8A.txt`，即把缺陷固化了；
   行为修复位于补丁平面，上游修复走独立分支（见 `docs/development.md` 的补丁工作流）。

## Alternatives considered

**保留 URL 形式，改为不对中文做百分号编码。** 一个未编码的 `file://` URL 在含空格或逗号时
不再是一个合法 URL，而这两类字符在 Windows 路径里常见。原生路径同时覆盖这两类。

**改成 `/select,"路径"` 的引号形式。** 实测在中文路径下同样退回默认位置，未采用。

**在该手势里改用 PowerShell 的 `Invoke-Item`。** 那是「打开」而非「定位到并选中」，
与 `openNativePath` 的既有分支重复，且丢失选中语义。

## Consequences

- WSL 主机上含中文、空格、逗号的路径现在都能被正确定位。
- 修复随 `wsl-native-open` 补丁分发，因此它同时到达源码运行与 registry 安装两种形态；
  该补丁的 `packages/util/native-command/` 目标目录与既有 override 让它保持可达。
- 上游把该修复合入后，本补丁的对应 hunk 应随之退役。
