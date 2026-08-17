# Agent Note: 持久 Bash 重新声明终端后端的受控提示符

Status: implemented

[English](2026-08-17-persistent-bash-prompt-alignment.md) | 中文

## 问题

极简模式下，无论命令多快完成，每条 bash 调用都要约 3.5 秒才返回——1ms 级的小命令也是如此——新 shell 上的第一条调用约 7 秒。同一条命令走标准与沙箱的一次性执行器时毫秒级返回。上游报告：deepseek-ai/deepseek-harness discussions #2175 与 #2656。

极简模式组合 `dsh-terminal`、`dsh-terminal-bash` 与 `dsh-tool-bash-persistent`：命令跑在常驻交互式 PTY shell 里，由后端判定一次 send 何时结算。后端的提示符路径（`stdin_read`）只认私有 OSC 标记之后与受控提示符 `dsh> ` 完全一致的文本。持久工具的初始化把 `PS1` 覆盖成自己的标记式提示符 `__DSH_PERSISTENT_BASH_PROMPT__ `，提示符路径因此永远无法匹配，每次 send 都落到静默窗口：`idleSilenceMs`（3000）加 `handoffGraceMs`（500）。

## 决策

工具的初始化改为把后端的受控提示符重新设为 `PS1`，并用测试钉住这层对齐。stub 组合断言初始化 send 恰为 `stty -echo; PS1=$'<CONTROLLED_PROMPT>'`，其中 `CONTROLLED_PROMPT` 从 `dsh-terminal-bash` 导入。REAL Loader 组合保留出厂静默默认值，并为一条快速 `pwd` 设定远低于它们的时延上限；提示符再次漂移时，失败的是测试套件而不是用户感知的时延。

该值仍存在于两个包中：消费端运行时不从提供端导入任何东西，缝边界保持在工具与 `ctx.terminals` 之间。

## 考虑过的替代方案

- 把 `dsh-terminal-bash` 的 `CONTROLLED_PROMPT` 改成长标记（讨论 #2656 提出的修复）。后端拥有就绪协议，且同一常量还驱动 `dsh-tool-terminal` 会话——那里的提示符是可见终端输出的一部分；在那里采用消费端的标记会改动无关表层。
- 把工具的 END 标记接成消费端确认完成的结算（讨论 #2175 的提案）。那是更大的缝改动——新增服务操作与等待原因——相对提示符路径约 25ms 的提速尚不足以证明其必要；推迟到确有消费端需要提示符路径给不了的完成证据时再做。
- 调低 `idleSilenceMs` 默认值。那用真正安静的命令可能被截断的风险换时延，且掩盖而非修复这层错位。

## 后果

快速命令经 `stdin_read` 提示符路径在几十毫秒内结算，不再等约 3.5 秒；新 shell 上的首条调用也不再叠加一个静默窗口。模型可见结果不变：提示符本就从结果中剥离，标记对仍然界定输出。`dsh-tool-terminal` 会话与一次性 shell 执行器不受影响。

## 测试

- stub 契约测试把初始化 send 钉在后端的受控提示符上。
- REAL Loader 组合保留出厂 `idleSilenceMs`/`handoffGraceMs` 默认值，把一条快速 `pwd` 限定在 2s 内；换回旧提示符时同一测试实测约 7.6s 并失败。
- `persistent-tools` 快照回放无变化。
