# @sparkelf/dsh-patch-session-envelope-ignorable

[English](README.md) | 中文

这个 data-only 包让「只写日志」的事件可以在 `Session.append` 时声明会话信封的 `ignorable` 标记。

信封从已发布的会话格式起就带 `ignorable`，持久化读取路径也强制它：读取器不认识的类型会被拒绝，除非该事件标了 ignorable —— 因为静默跳过一条不可忽略的事件会重建出错误的会话。**但没有任何写入者能设置它。** `Session.append` 用 `type`、`seq`、`time`、`data` 和 surface 元数据构造信封，所以外部插件追加自己的事件类型时，只能产出「所有没挂载该插件的读取器都拒绝」的记录 —— 包括卸载插件后它自己。

补丁在 `packages/core/session/src/types.ts` 增加 `EnvelopeIntent`，并把 `append` 的剩余参数放宽为非 surface 事件可接受它。事件构造只在调用方传入恰好 `true` 时把 `ignorable: true` 复制到信封上，与该字段自身的契约一致：缺省即必需，显式的假值与「本意相反的生产者」无法区分。

部署里有三个由 `@sparkelf/dsh-image-hoist` 在本补丁之前写入的会话：`session-08bf0cc7-b831-4834-a30f-9153854503fe`、`session-160644ce-0546-4a75-8482-3848a0f2ebc7`、`session-7dad49d6-1745-4158-b578-8fddf54cb45f`。它们的 `image/hoist` 记录已就地修复，把标记移到信封上。本包是写入侧改动：从镜像暂存区搬进受审查的补丁，重建不会再丢掉它。
