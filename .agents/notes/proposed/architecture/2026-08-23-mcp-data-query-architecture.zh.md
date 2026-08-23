# Agent Note: MCP 数据查询接入与 A/B 查询方案

Status: proposed

[English](2026-08-23-mcp-data-query-architecture.md) | 中文

## Problem

DataOps 当前通过与自身服务强绑定的合同提供 AI 取数能力，而 DeepSeek Harness 已经能够把外部 MCP 工具接入普通工具运行时。本次迁移必须继续由 DataOps 拥有目录可见性、权限、SQL/API 执行、结果存储和审计，同时给后续 Agent 一份可以跨 DataOps 与 deepseek-harness-plus 两个仓库实施的 A/B 方案。

两种方案解决的问题不同。方案 A 把物理查询知识提供给模型，由模型编写 SQL。方案 B 给模型逻辑查询接口，由 DataOps 选择物理来源并编译 SQL。资源描述不是语义编译器，逻辑语义模型也不足以支持模型直接编写物理 SQL。

现有 DataOps MCP Server 可以复用，但目前工具会直接转发较大的 JSON payload，并通过固定进程环境变量绑定身份。因此迁移还需要有界结果、可重复使用的结果引用、单主体 DSH runtime 合同、基于 credential 的 HTTP MCP 鉴权，以及批量模型工作的明确所有权。

## Proposal

使用 DataOps 作为 Streamable HTTP MCP Server，DSH 复用现有 `@deepseek-ai/dsh-mcp-client`。新增由 DataOps 拥有的外部 Auth/Integration Plugin，负责登录、credential 生命周期和 MCP 组合，但不在 DSH 中新增 DataOps 查询工具实现，不让 DSH 执行 SQL，也不把 Bash 作为正式查询接口。DataOps 拥有用户认证、授权、资源发现、API connector、查询执行、结果物化和审计。

暴露两个可选择的查询能力面。方案 A 是覆盖广泛临时查询的迁移 MVP。方案 B 是后续治理型能力，只有重点业务模型的指标和物理路由正确性值得建设编译器时才采用。两种方案共用结果、导出和图表合同。

### Ownership

| Responsibility | Owner | Contract |
| --- | --- | --- |
| 用户认证和 DSH 实例分发 | DataOps | DataOps 认证用户、分配隔离 DSH runtime，并为每个 runtime 绑定一个 principal |
| DSH 中的可选 DataOps 集成 | 外部 DataOps Auth/Integration Plugin | 发起 Authorization Code + PKCE、获取/存储 credential reference 并组合通用 MCP Client；省略插件时保持通用 MCP 匿名传输 |
| 通用 MCP 鉴权 | DSH credential service and MCP client | 配置 credential reference 时解析并附加当前传输凭据；未配置时不发送 `Authorization` header |
| MCP tools | DSH MCP client and DataOps MCP server | DSH 发现并调用工具；DataOps 鉴权每个 HTTP 请求并提供工具 |
| Resource catalog | DataOps | 搜索、完整枚举、详情、可见性、描述、使用说明书、字段和血缘 |
| Design A query | Model plus DataOps query executor | 模型选择物理资源并编写 SQL；DataOps 执行通用检查和查询 |
| Design B query | DataOps semantic query service | 模型提交逻辑成员；DataOps 选择来源并编译 SQL |
| Result snapshots | DataOps | 不可变授权结果引用、有界分页、导出、过期和审计 |
| Batch AI analysis | DSH generic workflow/agent capability | DSH 拥有模型调用、预算、重试、断点和汇总 |

### Authentication and deployment

DataOps 是多用户控制面；每个已认证 DSH runtime 是单主体运行时。DataOps 可以使用 Docker 分配和隔离 runtime，但容器位置不是认证。同一个 DataOps 浏览器可以同时持有多个有效账号 session，因此授权页必须列出可用账号并要求用户明确选择。被选中的账号就是绑定该隔离 runtime 的 principal。重新认证必须得到同一个 principal；不同 principal 需要不同 runtime。

外部 DataOps Auth/Integration Plugin 是可选的。如果没有配置该插件，或者通用 Streamable HTTP MCP client 没有配置 credential reference，DSH 不发送 `Authorization` header，只尝试匿名 MCP 连接；是否存在匿名能力由远端 MCP server 决定。生产 DataOps 取数 MCP endpoint 要求认证，因此会拒绝该匿名尝试。

需要 DataOps 身份时，直接访问 DSH 会发起带 PKCE 的 DataOps Authorization Code 流程。浏览器授权页和明确账号选择由 DataOps 拥有；如果所选账号尚未完成认证，DataOps 负责自身正常登录流程以及需要的 MFA challenge。MFA 是 DataOps 的身份认证步骤，不替代 OAuth 授权。从 DataOps 启动时可以只携带短期一次性 code；code 绑定用户、OAuth client、目标 DSH 实例、audience、state 和过期时间，由 plugin 在服务端交换后从 URL 删除。access 和 refresh credential 不得进入 URL 参数、工具参数、模型上下文、浏览器 local storage 或 session log。

Plugin 通过 DSH credential service 存储 provider credential。通用 MCP Client 使用 credential reference，而不是字面量静态 header：配置 reference 时在 transport 边界解析当前 bearer token，并且不记录 token。这是通用 authenticated-MCP 增强，不是 DataOps 查询逻辑。

已认证的 Streamable HTTP MCP 请求携带 `Authorization: Bearer <access-token>`。DataOps 校验 issuer、audience、过期、授权 client、用户和工具 scope，然后向工具 handler 投影 `AuthorizationPrincipal`。工具 schema 只包含业务参数。DataOps 将每个 MCP session identifier 绑定到已认证 principal，并拒绝后续 principal 不一致的请求；只有 principal 不变时才允许刷新后的 token 继续使用。MCP session identifier 和 result reference 都不是 credential。

DSH conversation identifier 是关联元数据，不是用户认证，也不是 access-token claim。新的可复用 MCP 服务删除当前对进程全局 DataOps `conversationId` 的要求；权限和结果绑定已认证 principal。后续通用 per-call MCP metadata 能力可以增加 DSH session 审计关联，而不改变授权。

现有 [DataOps MCP Server](https://github.com/SparkElf/dataops/blob/main/infra/docker-workspace/runtime-daemon/src/dataops-mcp-server.mjs) 是实现起点。生产服务复用其 handler 委托逻辑，并以 Streamable HTTP 替换固定身份的 stdio transport。如果 MCP Server 与 DataOps backend 是独立服务，由 workload identity 认证 MCP 服务，由 delegated user principal 授权具体操作。

## MCP contracts

MCP 参数和 `structuredContent` 使用 JSON。模型可见文本可以紧凑，但不能重复完整结构化 payload。跨边界 ID 是 opaque 且受 principal 约束的引用。access token 只通过 HTTP `Authorization` header 传输；工具参数不得包含 access token、refresh token、user ID、tenant ID 或 verification 字段。模型不能收到数据库凭据、连接字符串或未限定范围的内部数字 ID。

### Catalog tools

候选搜索、完整枚举和选定对象详情具有不同的完整性语义，应作为同一 DataOps Catalog Service 上不同的模型可见工具。

| Tool | Purpose | Completeness |
| --- | --- | --- |
| `search_resources` | 对名称、别名、描述、使用说明书和索引元数据做模糊发现 | 仅候选召回；未命中不能证明不存在 |
| `list_resources` | 精确过滤、稳定排序和分页枚举 | 读取全部页面后，在当前用户可见范围内完整 |
| `describe_resource` | 返回选定资源的请求事实 | 对选定引用和请求字段完整 |

`search_resources` 接受 `{query, kinds?, limit?}`，返回包含 `resourceRef`、类型、展示名、摘要、可查询状态和匹配原因的紧凑候选。默认不返回全部字段或血缘边。

`list_resources` 接受类型、源系统、数据库、schema、标签、可查询状态，以及物理名称精确或前缀匹配等目录过滤条件。它返回紧凑目录行、`returnedCount`、`hasMore` 和 opaque `nextCursor`。可选 `totalCount` 用于精确回答数量和存在性，不要求模型读取每一行。大型完整清单后续通过产物导出，而不进入模型上下文。

`describe_resource` 接受选定引用和 include 集合，例如 `description`、`usageManual`、`columns`、`lineage` 和 `execution`。现有 DataOps Resource 的 `remark`、`usageManual`、字段和血缘继续作为单资源知识来源。方案 A 不新增重复的 `grain` 字段：使用说明书可以说明一行代表什么。跨资源规则放入 QueryGuide。

### Design A tools

方案 A 是知识增强型 Text-to-SQL。模型接收技术事实和跨资源指导，选择物理来源并编写 SQL。DataOps 执行通用检查并执行 SQL，不自动路由或重写。

`search_query_guidance` 搜索跨资源、按场景索引的 QueryGuide。它接受 `{query, domain?, limit?}`，返回包含相关资源引用、来源选择建议、容易误用的关键物理映射、跨资源警告、示例和已审核模板引用的紧凑候选。它不能重复 `describe_resource` 返回的完整字段或血缘。

Resource 使用说明书解释一个资源。QueryGuide 解释一个业务场景中多个资源如何共同使用。SemanticQueryTemplate 为一个稳定场景提供已审核的带参数 SQL。最小 QueryGuide 包含稳定引用、标题、业务域、别名、示例问题、相关资源、简明来源选择指导、关键逻辑到物理例外、危险 Join 和模板引用。它是模型知识，不是可执行规则 DSL。

`execute_sql` 接受 `{sources, sql, guideRef?}`。每个 source 包含 opaque `resourceRef` 和 SQL alias。`guideRef` 是可选来源记录，不是已搜索的证明。服务端检查权限、只读 SQL、可解析性、声明的 source 使用和普通字段/资源有效性，但不推断缺失来源、不选择汇总表、不重写指标，也不保证模型理解了指导。

如果 QueryGuide 说明轨迹级聚合使用汇总表、分项级问题使用明细行，模型在编写 SQL 时应用这项知识。如果业务要求无论模型行为如何都必须选对来源，则使用方案 B 或已审核查询模板。

`call_data_api` 接受 opaque 的已注册 `operationRef` 和类型化业务参数。connector 拥有 URL、方法、凭据、请求构造、响应提取和分页。模型不能提供任意 URL、身份凭据或自由 result path。

可选 `execute_query_template` 校验参数并执行已审核 SemanticQueryTemplate。它是稳定场景的方案 A 快捷路径，不是语义编译器，也不是临时 SQL 前置条件。

### Design B tools

方案 B 是治理型语义编译器。模型通过 `list_semantic_models` 和 `describe_semantic_model` 或等价 semantic-model 目录投影发现模型。模型上下文包含逻辑业务对象、维度、指标、逻辑关系、别名和示例；物理映射由编译器拥有。

`execute_semantic_query` 接受类似 `{modelRef:"semantic-model:trajectory",dimensions:["month"],metrics:["total_distance"],filters:[],orderBy:[{field:"month",direction:"asc"}],limit:1000}` 的逻辑请求。

DataOps 编译器校验成员，加载 active semantic snapshot，寻找可用物理来源，检查成员覆盖和来源粒度，展开指标定义，解析已批准关系，拒绝不安全 fanout，渲染目标方言 SQL，注入授权谓词，并调用现有查询执行器。它返回结果引用和紧凑 provenance，包含 `semanticSnapshotRef`、语义版本、compiler version、选中的 `resourceRef`、维度、指标和稳定的 compiled-SQL hash。DataOps 为审计保留已授权的编译 SQL；只有策略允许时，模型才收到 hash 和脱敏预览。

当汇总来源覆盖所有请求维度、指标和过滤条件时，编译器选择汇总来源；当必要成员不在汇总表时选择明细来源。不能只因汇总和明细共享 ID 就 Join。物理来源粒度、指标可加性、关系基数、新鲜度和安全范围是编译器事实。

`execute_sql` 可以保留为高级逃生口，但不获得方案 B 自动路由。两种 operation kind 保持可观察。

### Shared result tools

`execute_sql`、`execute_semantic_query` 和 `call_data_api` 使用同一个执行生命周期。在交互式服务预算内完成的工作返回 `{status:"completed", resultRef, preview, provenance}`。无法在 MCP 调用超时前完成的工作必须在传输截止前返回 `{status:"accepted", executionRef}`，不能留下无人追踪的数据库查询。

`get_query_execution` 接受 opaque `executionRef`，返回 `queued`、`running`、`completed`、`failed` 或 `cancelled`，仅在完成后返回 `resultRef`。`cancel_query_execution` 请求取消，DataOps 在底层 SQL/API 执行支持时传播取消。MCP transport abort 取消尚未持久接受的工作；已经返回 accepted 后由显式取消拥有生命周期。DataOps 持久化执行状态、过期、失败详情和 principal 绑定。

完成后的不可变 `resultRef` 在服务端 TTL 到期前可重复使用；相同引用和 cursor 读取同一快照，不重新执行查询。`read_query_result` 接受 `{resultRef, cursor?, columns?, limit?}`，返回受字节上限约束的行或 JSON item 页面、返回数量、已知时的总数、`hasMore` 和 opaque `nextCursor`。DataOps Result Service 在 MCP/模型投影前应用字节上限；行数只是第二层限制。每次读取都重新授权当前 principal；知道 result reference 不会获得访问权。

`export_query_result` 把结果引用转换成 `{artifactRef, fileName, mediaType, sizeBytes, downloadUrl, expiresAt}`。DataOps 拥有短期授权 download URL；当前 DSH MCP bridge 可以把它显示为文本/resource link，但不宣称能把 CSV 或 XLSX 摄取为聊天附件。`render_chart` 消费结果引用和经过校验的图表规范，返回图片产物或后续通用图表规范。两者都不重新执行原查询。

后续通用 DSH `analyze_query_result` 能力可以读取页面，按有限批次调用模型，保存稳定 row reference，重试失败批次并返回输出结果引用。DSH 拥有它，因为 DSH 拥有模型调用和上下文预算。在真实全量 AI 分析流程需要它之前延期。

## Design A orchestration

1. 对明确的表、字段、数据库、schema、清单、数量或存在性问题使用目录工具。完整列表使用 `list_resources`，精确存在性使用 exact list filter，选定详情使用 `describe_resource`。
2. 对涉及多个资源、指标、汇总/明细选择或 Join 风险的含糊业务问题，调用 `search_query_guidance`。
3. QueryGuide 已提供足够关键映射时生成 SQL；只有资源引用但缺少技术事实时，用 `describe_resource` 补充。
4. 使用声明资源和 alias 生成 SQL，然后调用 `execute_sql`。
5. 用 `read_query_result` 查看有界输出，用 `export_query_result` 交付完整数据，用 `render_chart` 生成图表，逐行 AI 工作使用后续通用批量能力。

Skill 推荐此顺序；服务端不追踪搜索历史。不存在 `searchRef`。执行校验真实来源和 SQL，不校验模型之前是否调用过发现工具。

## Design B orchestration

1. 发现逻辑模型并查看维度、指标、关系、别名和示例。
2. 仅使用逻辑成员提交 `execute_semantic_query`。
3. DataOps 根据 active semantic snapshot 和内部物理映射校验并编译。
4. DataOps 执行编译 SQL 并返回共用结果引用。
5. 共用结果工具处理分页、导出、图表和后续批量分析。

方案 B 中模型不选择汇总或明细来源。紧凑执行 provenance 解释路由，编译器拥有物理 SQL。

## Storage

DataOps 继续以数据库为事实源。Resource `remark`、`usageManual`、字段和血缘存储单资源事实。只有不能清晰归属到单个资源的跨资源场景知识才新增 QueryGuide。已审核固定 SQL 场景继续使用 SemanticQueryTemplate。

方案 B 使用独立的结构化 SemanticModel snapshot，包含逻辑成员、指标表达式、已批准关系、物理实现、来源覆盖、粒度、可加性、新鲜度和安全策略。模型侧投影不必暴露物理映射，但编译器需要加载它们。

不要为了复制 Wren 的 MDL 目录把 DataOps 切换成文件事实源。Wren 文件是版本化编译器输入；DataOps 已经拥有数据库草稿、审批、权限、资源、血缘和 AI 可见性。后续可以导出 YAML 或 JSON 供 Git 审查或外部引擎使用，但文件和数据库不能成为竞争权威来源。

## Implementation split

DataOps 新增带 PKCE 的 Authorization Code、浏览器有效账号的明确选择、一次性 launch-code 交换、面向 MCP audience 的 token 和 scope、按请求 HTTP MCP 鉴权，以及映射到现有目录、查询、API、执行和结果服务的 Streamable HTTP handler；仅为真实跨资源指导新增 QueryGuide 存储；方案 B 在后续独立编译器项目中实现。DataOps backend 和 MCP Server 不引入 DSH package。

DSH core 只新增通用 credential-backed MCP 鉴权能力。可以随 DSH 分发一个可选的 DataOps-specific integration package，但它位于 core/default profile 之外，只拥有浏览器 OAuth、credential 获取和通用 MCP Client 组合，不包含 DataOps 查询标识、SQL 执行、来源路由、授权策略或 connector 逻辑。后续批准的通用批量结果能力属于 DSH。

此前 [HTTP `dq/v1` 提案](../../rejected/architecture/2026-08-19-generic-data-query-protocol.md) 和假设的 `dsh-plugin-dataquery` 被本提案取代。选定传输是 MCP。

## Alternatives considered

**HTTP 加 DSH data-query plugin。** 否决，因为 DSH 已经桥接 MCP 工具；另一个查询 plugin 会重复传输、schema 投影、取消和结果处理。这不否决独立 DataOps Auth/Integration Plugin；后者拥有 OAuth 和 credential 生命周期，但不实现工具。

**在 MCP 配置、stdio 环境或启动 URL 中放静态 token。** 否决，因为 token 会过期，并且这些位置会泄漏或无法安全刷新。选定路径是 MCP HTTP 请求使用 credential reference，浏览器入口使用一次性 launch code。

**Bash 调用 HTTP endpoint。** 作为正式合同否决，因为 stdout 截断、字符串解析、凭据暴露、shell 权限和弱审计身份仍然存在。

**一个过载的发现工具。** 否决，因为模糊召回、完整枚举、选定详情和跨资源指导具有不同完整性和 payload 语义。它们可以共享后端服务，但不共享模型合同。

**只向方案 A 暴露逻辑语义模型。** 否决，因为编写物理 SQL 的模型需要场景相关物理映射和警告；重复逻辑维度和指标不能解决汇总/明细选择。

**迁移前先建设方案 B。** 否决 MVP 范围。方案 A、有界结果和已审核模板足以迁移；只有观察到指标或路由错误足以证明编译器投入时才建设方案 B。

**使用文件语义存储。** 否决，因为会在现有数据库治理之外引入第二权威来源。可选导出足够。

## Acceptance criteria

- 方案说明保持方案 A 的模型生成物理 SQL与方案 B 的 DataOps 编译逻辑查询相互独立。
- DataOps 拥有 HTTP MCP Server 和授权/token endpoint；DSH 的可选 DataOps integration package 只负责浏览器 credential 获取并组合通用 MCP Client，不实现 DataOps 查询工具。
- 目录合同区分模糊候选、完整列表和选定详情；模糊未命中绝不等于不存在。
- QueryGuide 是叠加在现有资源事实上的稀疏跨资源知识，不重复完整 schema。
- 方案 A 明确排除自动路由、SQL 重写和搜索历史证明。
- 方案 B 定义逻辑输入、编译器所有权、来源选择、粒度/指标规则、SQL 渲染和带版本 provenance。
- 查询执行定义 completed 和 accepted 结果、状态、取消、transport abort 所有权，以及从 `executionRef` 到不可变 `resultRef` 的转换。
- 共用结果定义可重复使用的不可变引用、有界分页、明确的 DataOps 下载产物、图表和未来批量分析所有权。
- 鉴权定义每个 DSH runtime 一个 principal、OAuth/PKCE 和一次性启动入口、credential 刷新、按请求 bearer 传输、服务端派生 principal context，以及工具参数不含身份字段。
- 旧 HTTP 提案被拒绝并指向本 MCP 提案。

## Risks

- 即使 QueryGuide 正确，方案 A 仍可能选择错误物理来源；不可接受时使用方案 B 或已审核模板。
- QueryGuide 如果重复 Resource 事实会变旧；它必须引用资源，只说明跨资源例外。
- 大型清单必须经过分页和产物导出，不能把完整行直接放入模型上下文。
- 结果引用必须绑定 principal、过期、每次读取鉴权，并审计创建和访问。
- 一个 DSH runtime 绝不能同时服务多个 DataOps principal。Docker 隔离本身不是认证；Auth/Integration Plugin 和 DataOps token service 建立 principal。
- 静态 MCP header 无法刷新 credential。生产 HTTP MCP 鉴权前必须交付通用 credential-reference 集成和重连行为。
- accepted execution 需要 DataOps 持久状态和显式取消；否则 MCP timeout 会留下无人拥有的数据库查询。
- 方案 B 是较大编译器工作，在编译器和一致性覆盖交付前不能宣称可用。

## Verification

本 PR 仅包含设计。运行仓库双语配对、Markdown 链接、Agent Note 格式和空白检查。实现 PR 必须覆盖直接 MFA 登录、一次性 launch-code 交换、token 刷新和 MCP 重连、principal 不一致拒绝、按请求 scope 执行、模型可见调用中不存在 secret 和身份字段、completed/accepted/cancelled 执行路径、结果快照/分页/过期授权、导出链接字段、查询模板和无 key 模型可见 snapshot。方案 B 在可用前必须覆盖汇总来源选择、明细 fallback、可加和不可加指标、不安全 fanout 拒绝、方言渲染、权限谓词和稳定带版本 provenance。
