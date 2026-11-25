# @sparkelf/dsh-query-result-analysis

## 中文

这是面向 DeepSeek Harness（DSH）不可变查询结果引用的有界、可续跑批量分析插件。

插件注册一个模型可见工具：

```text
analyze_query_result({ resultRef, instruction, resumeAnalysisRef? })
```

### 所有权

插件拥有有界结果读取、断点和分层归并。DSH 内建 `spawn` Subagent provider 在持久本地子会话中拥有每次模型调用，普通 AgentLoop 拥有 provider-aware retry 和请求记录。插件不拥有 DataOps credential、transport、SQL/API 执行或结果存储。

插件消费显式配置的 `readToolName`。bundle 默认值是 `serverName: dataops` 的 generic MCP client 注册的限定名 `mcp__dataops__read_query_result`。其他 MCP namespace 必须把 `readToolName` 改成实际注册名，使嵌套调用始终经过 DSH 可见工具注册表。

```text
analyze_query_result
  -> DSH ToolRuntime nested dispatch
  -> mcp__dataops__read_query_result(resultRef, cursor)
  -> 有界不可变页面
  -> 使用当前 DSH provider/model 的持久子会话
  -> 带子会话 ID 的断点
  -> 持久子会话分层归并
```

插件不会获知 DataOps URL、workspace token、数据库 credential 或来源 SQL/API 细节。

### 批处理

配置的不可变结果工具返回的每个页面构成一个分析批次。工具直接返回页面时读取其canonical value；generic MCP client返回标准`{ content, structuredContent }` envelope时读取`structuredContent`中的同一页面。DataOps先按字节限制结果页面，再按行数限制，因此插件不会把完整结果装入一次模型请求。

每行使用从不可变结果引用派生的稳定证据标签：

```text
<resultRef>#row-1
<resultRef>#row-2
...
```

批次摘要按有界组宽逐层归并，直到只剩最终摘要。

### 模型选择与重试

每个子会话继承当前 DSH 会话最新持久 `request/header` 中的 provider、model、reasoning effort 和 token 上限。`batchOutputMaxTokens` 与 `reduceOutputMaxTokens` 只能进一步降低该上限。模型 credential 仍由 DSH Settings/Credentials 和 provider 插件拥有。

插件通过 DSH 内建、session-backed 的 in-process `spawn` provider 为每个批次或归并调用创建一个持久子会话。普通 AgentLoop 应用所选 provider 的 retry policy、记录每次请求与输出，并传播父工具执行的取消信号。子会话不获得工具，因此分析保持为有界且仅调用模型的操作。

### 持久断点

新分析创建 opaque `qa2_<uuid>` 引用。断点位于 DSH home：

```text
$DSH_HOME/query-result-analysis/<session-hash>/<analysisRef>.json
```

每个批次完成后以及最终归并完成后，插件原子替换该文件。文件保存来源结果引用、指令、已完成批次摘要、下一个 cursor、持久子会话 ID，以及完成后的最终摘要。

分析引用创建后若执行失败，工具错误包含：

```text
Resume with resumeAnalysisRef=qa2_...
```

使用相同 `resultRef`、`instruction` 和 `resumeAnalysisRef` 再次调用，会从最后一个已完成结果 cursor 继续，不重读已完成页面。已完成断点直接返回，不产生新的结果读取或模型调用。

断点是操作进度而不是模型历史，因此不进入 DSH session event vocabulary。每个模型可见批次、归并输入、请求配置、重试与输出由普通持久子会话拥有，从而可完整重建，且无需向 DSH core 添加插件事件类型，也不会让根会话读取依赖该可选包。

### 模型体验

#### System Prompt 影响

根 Agent 不增加 system-prompt section。每个分析子会话在普通 DSH 子会话 system prompt 之上使用上文定义的批次或归并 persona。

#### Tool Schema 影响

根模型看到一个 `analyze_query_result` 工具。成功结果公开最终摘要、行数、批次数、续跑状态，以及生成答案使用的每个持久子会话 ID。

#### Token 影响

每个不可变页面进入一个有界子请求。归并请求最多携带 `reduceGroupSize` 个摘要，两个输出限制分别约束批次与归并生成。

#### KV Cache 影响

每个子会话相互独立，页面数据不会累积进持续增长的单一上下文。稳定 persona 与 schema 仍可按 provider 的普通 request-prefix 规则使用缓存。

### Profile bundle

package 在 `package.json` 中声明 DSH bundle。使用 `dsh plugin --profile <name> add ...` 安装时，`cordis.patch.yml` 注册 Host 插件：

```yaml
- insert:
    - id: query-result-analysis
      name: '@sparkelf/dsh-query-result-analysis'
      config:
        readToolName: mcp__dataops__read_query_result
        batchOutputMaxTokens: 1200
        reduceOutputMaxTokens: 1600
        reduceGroupSize: 8
```

package 没有 browser half；最终摘要通过普通 DSH tool-result UI 渲染。

### 真实 UI 验收

标准 `pnpm run test:system` 入口发现 `tests/system/dataops-query.spec.mjs`。该用例要求已配置模型并已连接 DataOps 的真实 DSH profile、真实 DataOps 服务和当前开发数据库；`DSH_E2E_DATA_QUERY_PROMPT`、`DSH_E2E_DATA_QUERY_CHART_TITLE` 与 `DSH_E2E_DATA_QUERY_ANALYSIS_MARKER` 定义业务问题和可见结果。缺少这些输入时用例显式跳过，不能作为产品验收通过证据。

## English

Bounded, checkpointed batch analysis for immutable query-result references in DeepSeek Harness (DSH).

The plugin registers one model-facing tool:

```text
analyze_query_result({ resultRef, instruction, resumeAnalysisRef? })
```

## Ownership

This plugin owns bounded result reads, checkpoints, and hierarchical reduction. DSH's built-in `spawn` Subagent provider owns every model call in a durable local child session, while the normal AgentLoop owns provider-aware retry and request logging. The plugin does **not** own DataOps credentials, transport, SQL/API execution, or result storage.

It consumes the explicitly configured `readToolName`. The bundle default is the qualified name registered by a generic MCP client with `serverName: dataops`: `mcp__dataops__read_query_result`. Deployments that choose another MCP namespace must change `readToolName` to that registered tool name, so nested dispatch never guesses or bypasses the visible DSH tool registry.

```text
analyze_query_result
  -> DSH ToolRuntime nested dispatch
  -> mcp__dataops__read_query_result(resultRef, cursor)
  -> bounded immutable page
  -> durable child session with the current DSH provider/model
  -> checkpoint with child session id
  -> durable child-session reduction
```

The plugin never knows the DataOps URL, workspace token, database credentials, or source SQL/API details.

## Batching

Each page returned by the configured immutable-result tool is one analysis batch. A direct tool supplies that page as its canonical value; the generic MCP client's standard `{ content, structuredContent }` envelope supplies the same page in `structuredContent`. DataOps currently caps each result page by bytes before rows, so the plugin does not load the complete result into one model request.

Rows receive stable evidence labels derived from the immutable result reference:

```text
<resultRef>#row-1
<resultRef>#row-2
...
```

Batch summaries are reduced in bounded groups until one final summary remains.

## Model selection and retry

Each child inherits the active DSH session's latest durable `request/header` provider, model, reasoning effort, and configured token ceiling. `batchOutputMaxTokens` and `reduceOutputMaxTokens` can only lower that ceiling. Model credentials remain owned by DSH Settings/Credentials and provider plugins.

The plugin uses DSH's built-in, session-backed in-process `spawn` provider to create one durable child per batch or reduction call. Its normal AgentLoop applies the selected provider's retry policy, logs every request and output, and propagates cancellation from the parent tool execution. Children receive no tools, so analysis remains a bounded model-only operation.

## Durable checkpoints

A new analysis creates an opaque `qa2_<uuid>` analysis reference. Checkpoints live under the DSH-owned home directory:

```text
$DSH_HOME/query-result-analysis/<session-hash>/<analysisRef>.json
```

The file is atomically replaced after every completed batch and after final reduction. It contains the source result reference, instruction, completed batch summaries, next cursor, durable child session ids, and final summary when complete.

If an analysis fails after an analysis reference is created, the tool error includes:

```text
Resume with resumeAnalysisRef=qa2_...
```

Calling the tool again with the same `resultRef`, `instruction`, and `resumeAnalysisRef` resumes from the last **completed** result cursor. Already completed pages are not re-read. A completed checkpoint returns immediately without new result reads or model calls.

The checkpoint is deliberately outside the DSH session event vocabulary because it is operation progress, not model history. Every model-visible batch, reduction input, request configuration, retry, and output is instead owned by a normal durable child session. This preserves complete reconstruction without adding plugin event types to DSH core or making root-session reads depend on this optional package.

## Model Experience

### System Prompt Impact

The root Agent receives no extra system-prompt section. Each analysis child uses the batch or reduction persona documented above on top of the normal DSH child-session system-prompt sections.

### Tool Schema Impact

The root model sees one `analyze_query_result` tool. Successful results expose the final summary, row and batch counts, resume state, and every durable child session id used to produce the answer.

### Token Impact

Each immutable page enters one bounded child request. Reduction requests carry at most `reduceGroupSize` summaries, and the two output limits cap batch and reduction generations independently.

### KV Cache Impact

Each child is a separate session, so page data does not accumulate in one growing context. Stable personas and schemas remain cacheable within the provider's ordinary request-prefix rules.

## Profile bundle

The package declares a DSH bundle in `package.json`. Installing it with `dsh plugin --profile <name> add ...` appends its `cordis.patch.yml`, which registers the Host plugin:

```yaml
- insert:
    - id: query-result-analysis
      name: '@sparkelf/dsh-query-result-analysis'
      config:
        readToolName: mcp__dataops__read_query_result
        batchOutputMaxTokens: 1200
        reduceOutputMaxTokens: 1600
        reduceGroupSize: 8
```

The package has no browser half; its final summary is rendered through the normal DSH tool-result UI.

## Real UI acceptance

The standard `pnpm run test:system` entry discovers `tests/system/dataops-query.spec.mjs`. It requires a real DSH profile with a configured model and an active DataOps connection, the real DataOps services, and the current development database. `DSH_E2E_DATA_QUERY_PROMPT`, `DSH_E2E_DATA_QUERY_CHART_TITLE`, and `DSH_E2E_DATA_QUERY_ANALYSIS_MARKER` define the business question and visible result. The case explicitly skips when these inputs are absent and cannot count as product acceptance evidence in that state.
