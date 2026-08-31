# Agent Note: PTC 投影纯校验 MCP Schema 关键字

Status: implemented

[English](2026-08-31-ptc-mcp-validation-schema-types.md) | 中文

## 问题

MCP `tools/list` 常在普通对象 Schema 外携带 draft 标记以及字符串或数组校验约束。TypeScript PTC generator 原先复用 ToolRuntime 强制执行的 Schema assertion，因此任一此类关键字都会把整个工具参数声明加宽为 `unknown`，即使对象属性和必填字段已经存在。模型因而看不到 MCP binding 的参数名。

## 决策

TypeScript PTC 投影使用独立 assertion 检查共享 JSON Schema 结构。它只忽略 `$schema`、`minLength`、`maxLength`、`pattern`、`minItems` 与 `maxItems`，因为这些关键字约束取值但不改变 TypeScript 类型类别。对象、数组、属性、必填项、标量、enum、const 与 `oneOf` 声明全部保留；不受支持的结构性关键字仍生成 `unknown`。

`assertSupportedJsonSchema` 仍是运行时强制执行 assertion，并继续拒绝闭合子集之外的全部关键字。MCP server 接收并校验未经归一化的原始 Schema。

## 已考虑的替代方案

**在每段模型提示中讲解缺失参数名。** 拒绝，因为这会在 prose 中复制每个工具 Schema，并随 MCP 工具变化而漂移。

**让 ToolRuntime 校验接受额外关键字。** 拒绝，因为运行时 validator 不执行其语义；接受它们会声称 execution 实际忽略的约束。

**从 MCP server 删除校验关键字。** 拒绝，因为 server 是 ingress owner，必须保留长度、正则和元素数量校验。

## 后果

PTC 模型能获得常见 MCP draft-07 Schema 的可用 TypeScript 参数声明，原 server 仍是被省略约束的唯一 owner。TypeScript 无法表达这些运行时限制，因此取值违反约束时调用仍会失败。core-tools focused coverage 固定 DataOps `sources` 数组案例、未放松的运行时拒绝，以及结构性 `allOf` 继续生成 `unknown`。
