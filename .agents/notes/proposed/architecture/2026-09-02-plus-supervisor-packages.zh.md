# Agent Note: Plus Supervisor与Desktop npm packages

Status: proposed

[English](2026-09-02-plus-supervisor-packages.md) | 中文

## 问题

npm Plus distribution会materialize official DSH及Plus-owned packages，但没有published owner跨越一次受控Web process restart。process停止时仍在运行的Session会保留durable history，却不会在replacement process启动后得到新turn。以前的Desktop application把source installation、Electron presentation、process supervision及browser-based recovery放在一起；把它作为一个application恢复会在npm profile旁重新建立第二条distribution path。

## 提案

Plus发布两个独立持有的npm packages。<code>@sparkelf/dsh-plugin-supervisor</code>包含Host Cordis entry、plain Node Supervisor executable、local command client及progress page。<code>@sparkelf/dsh-plus-desktop</code>只包含由Electron host消费的可选tray function并依赖Supervisor package。distribution package会materialize Supervisor并mount其Host entry，但不依赖Desktop。

Supervisor manifest声明已经materialize的runtime command、arguments、working directory、DSH home、Web port、Supervisor port、local socket及可选build command。Supervisor不clone repository，也不选择source branch。Desktop读取该manifest，在需要时启动Supervisor，把所有command委托给它，并在Desktop退出后保持Supervisor与Harness运行。

一次受控restart是一个有序operation。rebuild会在旧Web process仍可用时完成。随后Supervisor调用Host entry捕获running顶层Sessions的ids，停止旧process，启动manifest command，等待Web port，再通过<code>SessionController.prompt</code>为每个captured id提交一条queue prompt。prompt要求模型检查durable history、workspace state及tool results，避免重复已经完成的操作，完成剩余工作，并在没有剩余任务时回复<code>已完成</code>。capture或recovery failure由同一个Supervisor operation报告。Supervisor restart始终启用recovery，不提供configuration switch。

普通start、stop、process crash、network reconnect及client HMR都不触发recovery。Host message使用既有user-message log path，因此不增加Session event或agent-loop branch。

## Package ownership

| Package | Ownership |
|---|---|
| <code>@sparkelf/dsh-plus</code> | 把Supervisor package与official DSH及其他Plus packages一起materialize并compose。 |
| <code>@sparkelf/dsh-plugin-supervisor</code> | Host capture/recovery entry、external process lifecycle、command socket、manifest、runtime log及progress page。 |
| <code>@sparkelf/dsh-plus-desktop</code> | 可选tray presentation及对Supervisor command client的delegation。 |
| Official Session Controller | 列出running Sessions、resume cold Sessions、接收logged recovery user message并queue其turn。 |

## 考虑过的替代方案

**原样恢复以前的Desktop tree。** 不采用，因为其Git clone、branch switch、dependency installation及source build流程会重复npm materializer。

**把recovery实现为official-source patch。** 不采用，因为official Session Controller已经提供Plus capability所需的operations。

**继续把recovery放在browser HMR。** 不采用，因为browser connectivity不持有process restart，且browser不存在时无法恢复工作。

**把Desktop与Supervisor保留在一个package。** 不采用，因为npm-only Plus必须能在不安装Electron时监管runtime，而Desktop presentation保持可选。

## 验收标准

- Plus bundle会materialize Supervisor，不要求Desktop或第二条source-install path。
- 受控restart会捕获每个running顶层Session，并在replacement Web runtime开始监听后准确排入一条recovery prompt。
- 普通start、stop、crash、reconnect及HMR不会排入recovery。
- Package、process、progress及recovery行为继续由release与system-test gates覆盖。

## 风险

过期或无效manifest会阻止Supervisor启动；capture或recovery失败会使受影响Session保持暂停，直到operator重试。单一有序restart operation必须持续报告这些失败，不能用另一条lifecycle隐藏。

## 验证

一条Plus system path通过Supervisor启动materialized runtime，在Harness Web提交工作，在Session仍running时从Supervisor progress page触发restart，并在同一Session观察保留的recovery message及恢复的turn。同一path验证progress page报告captured、recovered及failed counts。
