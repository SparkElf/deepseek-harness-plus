# Agent Note: Plus keeps a durable Session content index

Status: implemented

[English](2026-09-06-plus-session-content-search.md) | 中文

## Problem

Official DSH交付SQLite Session query provider时关闭full-text search。因此即使canonical compressed JSONL history仍存在，Plus侧边栏也只按title和Workspace匹配。用户无法用仅出现在message中的文字找回旧对话。

## Decision

Plus profile覆盖既有`session-query-sqlite`行，设置`openAt: first-search`及专用路径`$DSH_HOME/storages/session-query.sqlite`。首次内容查询到达时，official provider从live Sessions及persisted JSONL对账derived FTS5 database，后续搜索增量刷新。Compressed JSONL仍是唯一authoritative history；SQLite文件可删除并重建。临时`@sparkelf/dsh-patch-session-history-search` source patch接受两种已有证据的pre-release records，并在同一stable-corpus transaction内逐Session写入，使reconciliation memory有界。

这是[内容搜索opt-in决策](../architecture/2026-08-13-session-content-search-opt-in.zh.md)预期的deployment opt-in，不是replacement provider或official-default change。Archive visibility仍为独立语义：归档Session在Workspace archive state恢复前不进入侧边栏结果。

Plus Web system flow创建一个第二轮含有首轮title所无词语的Session，再新建Session，通过侧边栏搜索唯一词并从内容结果重新打开原对话。

## Alternatives considered

**保留仅title匹配。** 否决，因为已报告的对话仍在磁盘，却无法通过记得的message文字找回。

**使用`:memory:`。** 否决，因为每次Supervisor重启后，首次有用结果前都要重扫完整history corpus。持久derived database保留已完成对账，同时仍可丢弃。

**启动时打开。** 否决，因为不使用搜索的用户不应为history reconciliation延迟普通3080就绪。`first-search`允许部署后显式预热，而不把该工作加入每次启动。

**新增Plus search provider。** 否决，因为official JSONL-aware FTS5 provider已持有literal search、ranking、paging及incremental reconciliation。保留语料证明两种historical record shapes会阻断official migration，且把全部changed Session document arrays保留至commit会超过实际可用内存，因此需要exact temporary source patch。

## Consequences

- 侧边栏内容搜索在首次查询初始化后可用，并在正常重启间保持warm。
- Derived database增加本地磁盘占用及与保留history规模成比例的一次性对账工作。
- Patch不跳过malformed Session，也不增加alternate reader；仅迁移两种已有证据的historical shapes，其他unsupported records仍走official failure reporting。
- Archive state继续独立于message是否已索引而隐藏Session。
