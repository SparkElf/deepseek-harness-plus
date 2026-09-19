# Agent Note: An unindexable session must not fail the whole content search

Status: proposed

[English](2026-09-20-an-unindexable-session-must-not-fail-the-whole-content-search.md) | 中文

## Problem

该部署上的内容搜索从未工作过。每次尝试都以侧边栏提示「内容搜索暂不可用」结束，而 SQLite 索引在每次搜索之后**始终是零行**，尽管它的 schema 已经建好：

```
persisted_sessions  0
persisted_docs      0
```

在该部署与一个以同一份历史（214 个会话）为种子的隔离实例上测得的同一组现象：

| 轮次 | 结果 | 之后的索引 |
|---|---|---|
| 第一次搜索 | CONTENT-ERROR 约 20–38 秒 | 0 行 |
| 第二次搜索 | CONTENT-ERROR 约 1 秒 | 0 行 |
| 第三次搜索 | CONTENT-ERROR 约 1 秒 | 0 行 |

**这个反复出现的失败不是超时**；把它当超时处理 —— 把工具预算提到十五分钟 —— 没有任何改变：搜索仍在二十秒左右失败。

## Why it happened

对观察过程加上追踪后，第一次尝试就点出了原因：

```
reading session-2bc1778f-236a-41fa-9377-bdc988a3fbff
CAUGHT: format v2 agent/inbox/spliced at seq 4 data.inserted[0].content[0]:
        cannot safely transform unclassified message content kind "document";
        source v2 artifact remains unchanged
        name=SessionFormatUnsupportedError  aborted=false
```

该会话带有一条 `agent/inbox/spliced` 事件，其插入内容的 kind 是 `document` —— 一个 Word 附件：

```
"attachment": {
  "mediaType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "name": "公安项目202608进度报告 (2).docx"
}
```

v2→v3 的会话格式迁移拒绝转换该 kind，于是冷读抛出。**该抛出没有被捕获**，因此一个会话就终止了整轮观察，索引也就永远不会被写入。

这份历史中有两个会话带有该 kind —— 在部署与该隔离副本上分别测得：

```
sessions with a v2 artifact: 184
carrying kind "document":      2
```

它们总是被较早读到，因此**每一次**搜索都在同一处失败。手工排除它们之后，索引填满到 210 个会话，内容搜索在一秒内作答 —— 这就锁定了原因：一个无法建立索引的会话，让其余每一个会话同样无法建立索引。

## Proposal

**一个无法迁移的已存日志，应被跳过，而不是致命。**

观察循环本就能容忍一个它决定不索引的会话；它同样必须容忍一个持久化层拒绝读取的会话：

```js
let loaded
try {
  loaded = await readColdSessionLog(persistence, entry.header.id, signal)
} catch (readError) {
  if (readError?.name !== 'SessionFormatUnsupportedError') throw readError
  // Leave it out of this pass; every other session still gets indexed.
  continue
}
```

**每个会话在被读取时即刻建立索引，而不是等整个语料读完。** 写入目前位于观察循环之后，因此在每一个日志被读完之前什么都不会发布。在较大的历史上，第一轮要花数分钟，而任何中断都会把它全部丢弃。按会话提交可以保住进度，而 revision 检查会在下一次尝试时跳过已经索引过的部分。

两处改动都是必需的：跳过让这一轮能够跑完，而按会话写入让被中断的一轮不必从头开始。

## Findings this change rests on

1. **该失败是一次被拒绝的迁移，不是超时。** 追踪点出 `SessionFormatUnsupportedError` 且 `aborted=false`；把工具预算提到 900 秒后，约 20 秒的失败没有变化。
2. **该拒绝是按会话的，且是确定性的。** 每一次尝试失败的都是同样两个会话 id，在部署与同一份历史的隔离副本上都是如此。
3. **一次拒绝就让整轮失败。** 该抛出逃出观察循环，因此其后的写入永不执行。
4. **排除这两个会话后索引即填满。** 实测：210 个会话、202803 条文档被索引，首次搜索 185 秒，后续搜索 2.0 秒，对只出现在消息正文中的词也能返回内容命中。
5. **两个部署携带同样这两个会话。** 对部署的 184 个 v2 产物扫描，找到的正是同样两个 id。

## Acceptance criteria

- 一份包含无法迁移会话的历史，仍能为其余会话建立完整索引。
- 被跳过的会话在诊断中被点名，而不是被静默丢弃。
- 索引存在后，内容搜索在约一秒内作答。
- 被中断的第一轮保留它已经索引过的会话。

## Alternatives considered

**改 v2→v3 迁移以接受 `document` kind。** 那是完整的修法，且属于上游；但该拒绝是有意为之 —— 迁移无法安全转换该内容 —— 所以让迁移接受它，意味着要先决定转换后的值该是什么。无论如何，跳过对索引而言都是正确行为：部署读不了的会话就无法建立索引，而它不能让其余部分也变得不可读。

**提高超时。** 已实测并否决：该失败不是期限问题。预算被提到 900 秒，搜索仍在约 20 秒内失败。

**删除有问题的会话。** 否决：它们是真实对话历史，其中包含一份已投递的文档。应当是索引容忍它们，而不是为了迁就索引而移除数据。

## Risks

**被跳过的会话对内容搜索不可见。** 只出现在被跳过会话正文中的词将找不到，而部署在搜索界面上不会报告任何东西。在日志中点名该跳过是缓解措施；把它呈现在 UI 中不属于本次改动。

**按会话写入会增加事务数量。** 由每轮一个事务变成每会话一个事务。210 个会话上实测：第一轮含全部冷读共 185 秒，因此写入开销不是主导项。
