# Agent Note: Stop the supervisor before editing the manifest it owns

Status: proposed

[English](2026-09-17-supervisor-owns-its-manifest.md) | 中文

## Problem

把 3080 从 rc.28 镜像提升到 rc.29，看起来失败了三次。每次尝试都把 `/root/.dsh/supervisor/runtime.json` 改成新镜像的入口、重启 `deepseek-harness-plus.service`，然后拿到 200 响应 —— 而 web 进程仍在跑 `plus-rc28`。

manifest 与运行中的进程互相矛盾，而且 manifest 不断被改回去：

```
runtime.json: /root/.dsh/releases/plus/plus-rc29/apps/cli/lib/bin.js web process:  /root/.dsh/releases/plus/plus-rc28/apps/cli/lib/bin.js --profile plus --port 3080
```

## Why it reached production

**supervisor 缓存自己的 manifest，并在停止时写回。** `readSupervisorManifest` 只在启动时运行一次；此后每次写入用的都是那份内存副本：

```js
// runtime/supervisor.mjs async stop() {
  ...
  this.writeStatus()          // serializes THIS.MANIFEST, not the file
} writeStatus() {
  const content = JSON.stringify({ ...this.manifest, state, webPid, phase })
  writeSupervisorManifest(this.manifestPath, content)
}
```

因此，在服务运行期间做的修改，会被紧随其后的停止覆盖。错的是顺序，不是那次编辑：先改后重启，会让停止覆盖改动，随后启动读到的正是刚被恢复的旧值。

**重启循环掩盖了原因。** 每次尝试都报 200 健康，因为应答端口的是**上一个**镜像。整条序列里没有任何一步拿请求的镜像与正在服务的镜像作对比，于是三次尝试产生了三个绿色健康检查，以及零次提升。

**runbook 命名了步骤，却没有说出顺序上的约束。** 其第 7 步说要捕获会话并原子地切换 profile；而这里真正要的原子性，是在编辑 manifest 之前先停止进程，没有任何一步写明这一点。

## 后续测量：不止 stop，每个阶段都会写

升级到 `0.1.7-rc.1` 时以另一种触发方式复现了同一问题。`dsh-plus-switch` 先写 manifest， 随后运行 `profile-guard accept` —— 该步骤耗时数秒，期间 supervisor 仍在服务 —— 之后执行的 reload 采纳的却是**前一个** mirror：

```
reload.adopting  from=.../plus-rc30/apps/cli/lib/bin.js  to=.../plus-rc30/apps/cli/lib/bin.js
```

写入者是 `announce()`，而不只是 `stop()`：

```js
announce(key, values = {}) {
  this.phase = { key, values }
  ...
  this.writeStatus()          // every progress phase serializes the in-memory manifest
}
```
因此仍在运行的 supervisor 会在任意进度阶段重写该文件，单元处于 active 时写入与读取 manifest 之间的窗口并不安全。成立的顺序是**先 accept、最后写 manifest**，且紧接其后就是读取它的 reload；`dsh-plus-switch` 现在正因如此把步骤排为 `link → accept → manifest → reload → verify`。

## Proposal

**在编辑一个文件之前，先停止拥有它的进程；并验证实际服务的产物，而不是命令的退出状态。**

`dsh-plus-switch` 按该约束要求的顺序执行：

1. 停止 unit，并等它离开 `active`。
2. 把 `profiles/plus` 指向新镜像。
3. 此时才编辑 `runtime.json` —— 已无 supervisor 持有副本。
4. 用 `profile-guard accept` 记录被接受的 profile。
5. 启动、等端口就绪，然后**把 web 进程实际运行的镜像与请求的镜像作对比**，不一致则失败。

第 5 步正是它的缺席让失败不可见。健康检查回答的是「有没有东西在服务」，而一个过期镜像同样满足这一点。

## Findings this change rests on

1. **supervisor 只读一次 manifest。** `bin.mjs` 在启动时调用 `readSupervisorManifest(args.manifest)`；`startWeb` 用 `this.manifest.runtime.command` 与 `this.manifest.runtime.args` 派生进程。
2. **`stop()` 会把那份缓存副本写回。** 实测：服务运行中、`runtime.json` 已指向 plus-rc29，`systemctl stop` 之后文件又变回 plus-rc28。
3. **过期镜像照样能应答健康检查。** 三次重启每次都返回 200，而应答者是用上一份 manifest 启动的进程。
4. **profile guard 每次都接受了变更。** 其日志在 web 进程切换之前很久就记录了 `acceptedProfile` 变为 plus-rc29，所以 guard 不是阻塞点。
5. **镜像路径出现在入口参数与 cwd 里，不在 flag 里。** 只有 `args[0]` 与 `cwd` 命名镜像；按模式改写其余参数会把脚本绑死在它们当前的写法上。
6. **实际服务的 profile 可从进程列表读出。** `ps -eo args` 显示 web 进程的入口路径，这正是验证步骤要拿来与请求镜像对比的东西。

## Acceptance criteria

- 在服务运行期间切换镜像并重启，不会让 `runtime.json` 仍指向先前的镜像。
- 当重启后的 web 进程不是请求的镜像时，`dsh-plus-switch <mirror>` 以非零退出，且消息同时给出两者。
- 一次成功的切换之后，`profiles/plus`、`runtime.json` 与 web 进程三者命名同一个镜像。

## Alternatives considered

**改 `runtime.json` 后调用 `systemctl restart`。** 否决：停止会把缓存的 manifest 写回，改动因此丢失，重启成了一次报成功的空操作。

**停止、编辑、启动，然后相信 `systemctl` 的退出状态。** 否决：无论读到哪份 manifest，启动都会成功；三次尝试就是这样通过的，而它们服务的仍是旧镜像。

**通过 supervisor 每次启动都会读取的环境变量来设置运行时路径。** 暂不采纳：manifest 是 supervisor 的文档化输入，引入第二处真相来源还需要它自己的优先级规则。

## Risks

**切换会停止服务，因此启动失败会让 3080 处于停机状态。** 脚本在报告成功之前会等待 unit 应答；失败时给出端口，但恢复仍需人工。无法容忍这段空窗的调用方应先面向一个独立实例。

**验证读取进程列表。** 若某部署以另一种参数写法运行 web 进程，会把一次正确的切换判为失败；该模式匹配的是本部署使用的入口路径。