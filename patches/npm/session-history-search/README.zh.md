# @sparkelf/dsh-patch-session-history-search

[English](README.md) | 中文

该data-only patch使official SQLite Session内容搜索可用于保留的pre-release history。v0迁移将历史pi-ai replay-state v1扁平记录转换为当前`{ response, blocks }`信封，并把subagent descriptor v2提升至v3；v3相对v2只新增可选reasoning-effort字段。Message content、tool records、title及Workspace archive state均不变。

大型history仍走official JSONL到v2路径。完整日志Zstandard解码复用既有multi-frame decoder，将小输出合并为有界batch并周期性让出event loop。Session-format snapshot只记忆已经由owner完成脱离及冻结的对象，使codec和相邻migration可组装这些owned rows，而不重复复制同一整份日志。

SQLite reconciliation观察到一份changed persisted Session后，立即经attempt savepoint写入，而非在完整corpus读取结束前保留全部Session document arrays。外层transaction仍只提交一个stable corpus，或整体rollback；source snapshot变化会先丢弃本轮再重试。

在暴露问题的166份Session、623 MB保留语料上，全部历史日志迁移均无错误。最大source由3,500,551条v0 events折叠为122,575条v2 events，用时4:49.86，峰值5.50 GiB；全部Session已迁移后建立索引用时58.42秒，峰值3.64 GiB；warm内容查询用时0.74秒。这些是该语料的观测值，不是通用性能承诺。

target是exact official source revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`。本package不含runtime JavaScript、alternate history reader、archive mutation或fallback provider。official DSH等价接受这些历史记录并有界化full-corpus reconciliation后，retire本package。
