# Agent Note：把独立工作委派给子会话

Status: implemented

[English](2026-09-11-delegate-independent-work-to-child-sessions.md) | 中文

## Problem

持有一个objective的session有时会遇到与它相互独立的工作：另一个项目中的defect、一次long-running verification、一项bounded investigation。把这类工作内联执行会让它排在当前objective之后，并让primary session的context被第二个问题消耗。本session已经拥有避免这种情况的机制；不会使用它的agent要么把工作串行化，要么误报该能力不存在。

## Decision

在把独立工作串行化之前，先考虑child session。

- `ralph`每一轮都运行一个fresh child session，**没有parent conversation、也没有此前的child session**：共享workspace是轮次之间唯一的memory，每轮只有一个bounded structured report跨轮传递。它适用于另一个项目中的自包含任务；必须把child需要的每一项事实都写进objective text以及该项目中的一份durable file，因为child看不到本conversation。
- `list_agents`按durable id与status（`running` / `idle` / `ready`）报告children，其中`ready`表示可resume，而不是已完成。
- `send_message`可steer一个running child，或为idle/ready的child开启一个turn。
- `interrupt_agent`停止child当前的turn，但不丢弃该child。

当工作会超出单次tool call时，把它作为background job执行。`ralph`是foreground的：一轮若超出外层调用的ceiling，仍会在child中完成，因此要通过child写入的文件确认其产出，而不要假定该调用的timeout取消了它。

## Consequences

另一个项目的defect得以修复，而不消耗primary objective的context，primary session同时继续工作。代价是child是盲启动的：objective若缺少target path、evidence或constraint，就会在错误的位置产出一个看似合理的改动。属于本session的决策仍留在本session。

## Verification

2026-09-11，本session发现了一个DataOps backend crash（interval tick抛出的未处理database error使进程退出），它在本session自身objective之外。本session把root cause、两种reproduction与acceptance criteria写入`/root/projects/dataops/.trellis/tasks/backend-database-unreachable-crash.md`，然后用该路径作为objective启动了`ralph` child。child在当天只修改了`backend/src/ai/ai-agent-scheduler.service.ts`，新增`tests/unit/ai-agent-scheduler-database-unreachable.test.ts`，且未触碰该仓库中六个无关的modified文件。它的四条测试在有修复时通过；移除新增的`catch`后其中两条失败，因此该test守住了这个regression。
