# @sparkelf/dsh-patch-session-query-unindexable-session

[English](README.md) | 中文

## Summary

当一个会话的已存日志无法迁移时，仍让内容搜索可用；并让被中断的首次索引不再从零开始。

## Why it is needed

内容搜索要读取每一个会话日志来建立索引。有两种行为让这在 200+ 会话的历史上永久失败：

**一个被迁移拒绝的会话会终止整轮。** v2→v3 的会话格式迁移不会转换内容 kind 为 `document` 的消息，因此冷读抛出 `SessionFormatUnsupportedError`。该抛出逃出观察循环，于是一个会话阻断了其余每一个会话的索引 —— 而由于它每次尝试都被较早读到，索引永远填不满：

```
format v2 agent/inbox/spliced at seq 4 data.inserted[0].content[0]:
cannot safely transform unclassified message content kind "document"
name=SessionFormatUnsupportedError aborted=false
```

**写入排在整个读取之后。** 在每一个日志被读完之前什么都不会发布，因此一次中断会丢弃全部工作。在这份历史上，第一轮要读取 214 个会话，耗时数分钟。

补丁前的实测：每次搜索之后索引都是**零行**，且每次搜索在 20–38 秒内失败。补丁后：210 个会话、202803 条文档被索引，后续搜索约一秒作答。

## What it changes

| 行为 | 之前 | 之后 |
|---|---|---|
| 一个无法迁移其日志的会话 | 让整次搜索失败 | 被跳过并点名；其余仍被索引 |
| 何时写入一个会话 | 整个语料读完之后 | 一被读取就写 |
| 提交形态 | 每轮一个事务 | 有界分批 |

## Install

该补丁不携带自己的代码；profile supervisor 会在安装 `@deepseek-ai/dsh-session-query-sqlite` 时把它应用上去。

## Known Limitations and Deferred Work

**被跳过的会话对内容搜索不可见。** 只出现在被跳过会话正文中的词找不到，而搜索界面不报告任何东西。该跳过会在部署日志中被点名；把它呈现在 UI 中属于后续工作。

**迁移拒绝本身未被改动。** 教会 v2→v3 迁移转换 `document` kind 会让那些会话可被搜索，但那是关于转换后的值该为什么的上游决定。
