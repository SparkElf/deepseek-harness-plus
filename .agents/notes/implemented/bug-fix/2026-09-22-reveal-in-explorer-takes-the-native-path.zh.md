# Agent Note：在资源管理器中显示手势使用原生路径

Status: implemented

[English](2026-09-22-reveal-in-explorer-takes-the-native-path.md) | 中文

## 问题

在 WSL 主机上，「在文件资源管理器中显示」对含非 ASCII 字符的路径总是打开桌面，从不选中目标文件。只有非 ASCII 路径受影响，所以用英文路径做手工验证一直是绿的。

`revealNativePath` 把 `wslpath -w` 的输出先经 `pathToFileURL(windowsPath, { windows: true })` 再交给 Explorer。Explorer 不解析该形式下的百分号编码非 ASCII 路径，于是选不中任何目标并退回默认位置。

## 决策

`patches/npm/wsl-native-open` 的 `revealNativePath` 直接传原生路径：

```ts ignore-check
try {
  await run('explorer.exe', ['/select,', windowsPath], signal)
} catch (error) {
  // Explorer can exit 1 after delegating to the existing desktop process.
  if (!(error instanceof Error) || !('code' in error) || error.code !== 1) throw error
}
```

`wslpath -w` 已经产出 Explorer 能读的拼写，URL 转换是多余的中间层，也是缺陷来源。不再使用的 `pathToFileURL` 导入一并移除。

## 本改动依据的实测事实

1. **两种形式只差编码。** 用 Explorer 从未打开过的目录做单变量对照：原生路径选中了 `子目录/测试文件.txt`，URL 形式没有任何变化。
2. **ASCII 对照排除了参数拼接。** 同一 ASCII 路径在两种形式下均正确，所以把 `/select,` 与路径分成两个 argv 或合并成一个都不是原因。这也否定了先前把它当作根因的判断。
3. **判据是窗口状态而非退出码。** Explorer 委托给已运行实例后总是以 1 退出，退出码无法区分成功与失败；`Shell.Application.Windows()` 的 `LocationName` 与 `Document.SelectedItems()` 才是可判定的观测。
4. **补丁平面与上游平面分离。** 仓库源码 `packages/util/native-command/src` 是上游平面，其现有单测断言 `file:///C:/work/%E6%8A%A5%E5%91%8A.txt`，即把缺陷固化了。行为修复位于补丁平面；上游修复走独立分支（[工作流](../../../../docs/development.zh.md#patched-third-party-packages)）。
5. **Explorer 无法从服务会话抢占前台。** 同一条命令由 Windows 原生进程发出会到达前台，而由 systemd 托管的 DSH 会话发出则不会，且 `AppActivate` 会报告成功却不移动窗口。这是 Windows 的前台锁，因此被定位的窗口停留在浏览器之后。改启动器无法修复它；若产品希望用户察觉，应在 UI 反馈处处理。

## 已考虑但未采用的方案

**保留 URL 形式，改为不对非 ASCII 做百分号编码。** 未编码的 `file://` URL 在路径含空格或逗号时不再是合法 URL，而这两类字符在 Windows 路径里常见。原生路径同时覆盖这两类。

**改成 `/select,"路径"` 的引号形式。** 实测在同样的非 ASCII 路径下退回默认位置，未采用。

**在该手势里改用 PowerShell 的 `Invoke-Item`。** 那是打开文件而非定位并选中，与既有 `openNativePath` 分支重复，且丢失选中语义。


## 影响

- WSL 主机上含中文、空格、逗号的路径现在都能被正确定位。
- 修复随 `wsl-native-open` 补丁分发，因此同时到达源码运行与 registry 安装两种形态；该补丁的 `packages/util/native-command/` 目标与既有 override 让它保持可达。
- 上游合入该修复后，本补丁对应的 hunk 应随之退役。
