# @sparkelf/dsh-patch-ptc-mcp-schema-types

[English](README.md) | 中文

该 data-only package 让 MCP 工具带有 JSON Schema draft 标记、字符串长度或正则约束、数组元素数量约束时，TypeScript PTC 声明仍保留精确类型。投影只省略这些校验关键字，对象、数组、属性、必填项与标量类型均保留；不受支持的结构性关键字仍渲染为 `unknown`。

ToolRuntime 强制执行的 Schema 子集保持不变，MCP server 继续校验完整原始 Schema。目标为 exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`。

当 official DSH 能以相同行为把纯校验 MCP 关键字投影为 PTC 声明，且不放松运行时 Schema 校验时，退役该 package。
