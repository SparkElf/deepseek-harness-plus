# Agent Note: MCP 数据查询接入与 A/B 查询方案

Status: proposed

[English](2026-08-23-mcp-data-query-architecture.md) | 中文

## Problem

DataOps 当前通过与自身服务强绑定的合同提供 AI 取数能力，而 DeepSeek Harness 已经能够把外部 MCP 工具接入普通工具运行时。本次迁移必须继续由 DataOps 拥有目录可见性、权限、SQL/API 执行、结果存储和审计，同时给后续 Agent 一份可以跨 DataOps 与 deepseek-harness-plus 两个仓库实施的 A/B 方案。

两种方案解决的问题不同。方案 A 把物理查询知识提供给模型，由模型编写 SQL。方案 B 给模型逻辑查询接口，由 DataOps 选择物理来源并编译 SQL。资源描述不是语义编译器，逻辑语义模型也不足以支持模型直接编写物理 SQL。

现有 DataOps MCP Server 可以复用，但目前工具会直接转发较大的 JSON payload，并通过固定进程环境变量绑定身份。因此迁移还需要有界结果、可重复使用的结果引用、单主体 DSH runtime 合同、基于 credential 的 HTTP MCP 鉴权，以及批量模型工作的明确所有权。

## Proposal

DataOps 继续拥有 MCP 查询合同，DSH 复用现有 `@deepseek-ai/dsh-mcp-client`。独立 DSH 使用已认证 Streamable HTTP MCP。DataOps 托管的每用户容器使用本地 MCP adapter 和 DataOps-owned Unix broker，使 workspace principal 不进入 DSH 主进程。独立浏览器授权和 credential 生命周期由可选 DataOps Auth/Integration Plugin 提供，但不在 DSH 中新增 DataOps 查询工具实现，不让 DSH 执行 SQL，也不把 Bash 作为正式查询接口。DataOps 拥有用户认证、授权、runtime 分配、资源发现、API connector、查询执行、结果物化和审计。

本集成遵循[插件归属与分发决策](../../implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md)：DataOps 专属身份、配置、UI、工具和部署只能留在可选 plugin 或 profile overlay。缺少 DSH 扩展点时，必须另行汇报并取得用户显式批准后才能修改 core source；本 RFC 本身不构成该批准。

暴露两个可选择的查询能力面。方案 A 是覆盖广泛临时查询的迁移 MVP。方案 B 是后续治理型能力，只有重点业务模型的指标和物理路由正确性值得建设编译器时才采用。两种方案共用结果、导出和图表合同。

### Ownership

| Responsibility | Owner | Contract |
| --- | --- | --- |
| 用户认证和 DSH 实例分发 | DataOps | DataOps 为每个用户分配一个拥有独立 `DSH_HOME` 的容器，并将该 runtime 永久绑定到同一 principal |
| DSH 中的可选 DataOps 集成 | 外部 DataOps Auth/Integration Plugin | 发起 Authorization Code + PKCE、获取/存储 credential reference 并组合通用 MCP Client；省略插件时保持通用 MCP 匿名传输 |
| 通用 MCP 鉴权 | DSH credential service and MCP client | 配置 credential reference 时解析并附加当前传输凭据；未配置时不发送 `Authorization` header |
| MCP tools | DSH MCP client and DataOps MCP server | DSH 发现并调用工具；DataOps 鉴权每个 HTTP 请求并提供工具 |
| Resource catalog | DataOps | 搜索、完整枚举、详情、可见性、描述、使用说明书、字段和血缘 |
| Design A query | Model plus DataOps query executor | 模型选择物理资源并编写 SQL；DataOps 执行通用检查和查询 |
| Design B query | DataOps semantic query service | 模型提交逻辑成员；DataOps 选择来源并编译 SQL |
| Result snapshots | DataOps | 不可变授权结果引用、有界分页、导出、过期和审计 |
| Interactive chart | `@sparkelf/dsh-chart` | DSH 注册顶层 `render_chart` 工具并拥有持久图表呈现 |
| Batch AI analysis | `@sparkelf/dsh-query-result-analysis` | DSH 注册顶层 `analyze_query_result` 工具并拥有模型调用、重试、断点和归并 |

### Authentication and deployment

DataOps 是多用户控制面。`AiWorkspaceService` 为每个 DataOps 用户创建或复用唯一 DSH 容器，每个容器使用独立 `DSH_HOME` 保存 credential、session history 和 plugin state。容器 owner 不可变：该 runtime 中的所有 conversation 和 DataOps connection 都属于同一个 principal。容器位置提供隔离，但不能替代认证。

DataOps 托管容器不重复浏览器 OAuth。已认证 DataOps 浏览器只通过 Workspace Web Gateway 访问 DSH。容器内 DSH 调用本地 MCP adapter，再由 DataOps-owned Unix broker 委托。只有 broker 接收 workspace user ID、internal token 和 backend location；DSH 主进程、模型上下文、URL 和工具参数不能收到这些 credential。托管 DSH 不挂载独立授权 plugin，因此 Settings 不提供 Connect、Reauthorize 或 Disconnect。

外部 DataOps Auth/Integration Plugin 只用于可选独立 DSH。如果没有配置该 plugin，或者通用 Streamable HTTP MCP client 没有 credential reference，DSH 不发送 `Authorization` header，只尝试匿名 MCP 连接；是否存在匿名能力由远端 MCP Server 决定。生产 DataOps 取数 MCP endpoint 要求认证，因此拒绝该匿名尝试。

直接访问独立 DSH 时发起带 PKCE 的 DataOps Authorization Code 流程。DSH 在 credential store 中生成一次随机 target reference，并在该 `DSH_HOME` 的整个生命周期中保留。浏览器授权页、正常登录、MFA 和明确账号确认由 DataOps 拥有。首次批准会将未绑定 target reference 原子绑定到所选 OIDC `sub`；后续批准、刷新、重连和 MCP session 都必须使用该 owner。Disconnect 只清除 access 和 refresh credential，保留 target reference 及其 DataOps 绑定，因此其他账号会被拒绝，不能重新绑定当前 runtime。

从 DataOps 启动时只可携带绑定用户、OAuth client、目标 DSH instance、audience、state 和过期时间的短期一次性 code；plugin 在服务端交换后从 URL 删除。access 和 refresh credential 不得进入 URL 参数、工具参数、模型上下文、浏览器 local storage 或 session log。Plugin 通过 DSH credential service 存储独立模式的 provider credential；通用 MCP Client 在每个 HTTP 请求前解析当前 bearer token，并且不记录 token。

已认证的 Streamable HTTP MCP 请求携带 `Authorization: Bearer <access-token>`。DataOps 校验 issuer、audience、过期、授权 client、用户和 MCP scope，然后向工具 handler 投影 `AuthorizationPrincipal`。MCP audience 和 scope 只允许进入受保护 endpoint，不授予任何 Resource access。现有 DataOps permission 和 Resource authorization 判定每个工具操作，并在结果分页和导出时重新授权当前用户。DSH 不复制或解释 DataOps role/permission matrix。

DataOps 将每个 MCP session identifier 绑定到不可变 runtime principal。同一 OIDC `sub` 的刷新 credential 可以继续使用；不同 `sub` 会被拒绝，不能在该 runtime 中替换 credential 或 remount MCP child。MCP session identifier、DSH conversation identifier 和 result reference 都不是 credential。Conversation identifier 后续可以提供审计关联，但不改变授权。

现有 [DataOps MCP Server](https://github.com/SparkElf/dataops/blob/main/infra/docker-workspace/runtime-daemon/src/dataops-mcp-server.mjs) 继续作为 embedded adapter 起点。独立生产模式使用 Streamable HTTP；托管容器使用 adapter 和 Unix broker。两种 transport 都在调用相同 catalog、query、result、permission 和 audit owner 前派生相同 DataOps principal。

## MCP contracts

MCP 参数和 `structuredContent` 使用 JSON。模型可见文本可以紧凑，但不能重复完整结构化 payload。跨边界 ID 是 opaque 且受 principal 约束的引用。access token 只通过 HTTP `Authorization` header 传输；工具参数不得包含 access token、refresh token、user ID、tenant ID 或 verification 字段。模型不能收到数据库凭据、连接字符串或未限定范围的内部数字 ID。

### Design A MVP tool composition

模型可见的数据工作流包含十个领域工具，由两类 owner 注册。DataOps MCP Server 注册 `search_resources`、`list_resources`、`describe_resource`、`search_query_guidance`、`execute_sql`、`call_data_api`、`read_query_result` 和 `export_query_result`。DSH profile 将 `render_chart` 和 `analyze_query_result` 注册为顶层 plugin tool；两者都不是 MCP tool。

两个 DSH 工具消费 DataOps 结果，但不拥有 DataOps transport 或授权。`analyze_query_result` 在同一个 Agent 中调用可见的 `read_query_result` 能力，因此每一页仍使用当前 MCP principal 并经过 DataOps 授权。`render_chart` 接收一个 source reference 和由该结果准备的完整 chart option；它本身不解引用 DataOps 结果。

`execute_query_template` 是可选 Design A 扩展，不属于八工具 MCP MVP。Design B 的 semantic-model 发现和执行工具也不属于本 MVP。

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

Design A MVP 只实现同步 completed 路径。`execute_sql` 和 `call_data_api` 在交互预算内完成执行和物化后返回 `{status:"completed", resultRef, preview, provenance}`。持久 `accepted + executionRef`、状态和取消能力继续延期，直到真实负载证明需要持久执行 owner。

每个已完成 SQL 或 API 结果只物化一次，成为不可变、principal-scoped 且由服务端控制过期时间的 staging snapshot。模型只接收 opaque `resultRef`、有界 preview、metadata 和 provenance；不能收到 staging table name，也不能在一次工具响应中收到完整结果。

`read_query_result` 接受 `{resultRef, cursor?, columns?, limit?}`，返回受字节上限约束的完整行或 JSON item 页面、返回数量、已知时的总数、`hasMore` 和 opaque 且绑定列投影的 `nextCursor`。DataOps Result Service 在 MCP/模型投影前应用字节上限；行数只是第二层限制。分页使用对模型隐藏的稳定行序号，不重新执行来源操作，并在每一页重新授权当前 principal。

`export_query_result` 通过同一授权分页路径消费 `resultRef`，增量创建 CSV 或 JSONL，且不重新执行来源操作。它返回 `{artifactRef, fileName, mediaType, sizeBytes, downloadUrl, expiresAt}`；有期限授权下载由 DataOps 拥有。

`analyze_query_result({resultRef, instruction, resumeAnalysisRef?, maxBatchRetries?})` 对 DataOps 已按所需业务粒度完成过滤、Join、聚合和排序的结果执行 AI 语义分析。每个 DataOps 页面成为一个 DSH 模型批次，并使用稳定 `<resultRef>#row-N` 证据标签。DSH 保存已完成批次断点，只在请求上限内重试符合 provider policy 的失败，传播取消，并分组归并批次摘要，最终返回 `analysisRef`、`summary`、行数、批次数、续跑状态和 provider/model 事实。

确定性过滤、Join、聚合、排名、去重和精确统计必须在创建 `resultRef` 前由 `execute_sql` 或 `call_data_api` 完成。`analyze_query_result` 只解释和归纳多页结果；有损模型摘要不能作为精确数值事实源。

### Interactive chart presentation

`@sparkelf/dsh-chart` 在 DSH 中注册顶层 `render_chart({sourceResultRef, option, title?})` 工具，而不是注册到 DataOps MCP。一张图只有一个非空 `sourceResultRef`。DataOps 必须先产出适合展示粒度的结果；如果仍需数据库规模的过滤、Join 或聚合，Agent 应重新执行更合适的查询，不能在可视化代码中重建数据引擎。

简单图表可以由 Agent 直接调用 `render_chart`。需要展示级映射、过滤、排序、reshape、类型转换、百分比、累计值、参考线或注释时，DSH Code Mode 先读取所需结果页并生成 JSON ECharts option，再执行顶层工具调用。Code Mode 不 Join 多个 result reference。

`option` 包含回放所需的全部数据，并且必须可 JSON 序列化；不允许 JavaScript callback function。DSH 将完整 option 保存在持久 tool-result `presentationMeta` 中，`sourceResultRef` 只保留 provenance。Session replay 直接渲染已记录 option，不访问 DataOps，也不依赖 result TTL。

Keyed Web Client view 渲染交互式 ECharts presentation，并拥有初始化、resize、theme recreation 和 disposal。正常 conversation view 只显示可选标题、图表和必要 loading/failure state，不暴露 option JSON、result reference、plugin 实现术语或原始 ECharts exception。该 plugin 为 opt-in，由 DataOps 托管 DSH profile 显式包含，不进入 DSH default profile。

## Design A orchestration

1. 对明确的表、字段、数据库、schema、清单、数量或存在性问题使用目录工具。完整列表使用 `list_resources`，精确存在性使用 exact list filter，选定详情使用 `describe_resource`。
2. 对涉及多个资源、指标、汇总/明细选择或 Join 风险的含糊业务问题，调用 `search_query_guidance`。
3. QueryGuide 已提供足够关键映射时生成 SQL；只有资源引用但缺少技术事实时，用 `describe_resource` 补充。
4. 使用声明资源和 alias 生成 SQL，然后调用 `execute_sql`。
5. 用 `read_query_result` 查看有界输出，用 `export_query_result` 交付完整数据，用 `render_chart` 呈现准备好的结果，只在处理后的多页结果需要 AI 语义归纳时使用 `analyze_query_result`。

Skill 推荐此顺序；服务端不追踪搜索历史。不存在 `searchRef`。执行校验真实来源和 SQL，不校验模型之前是否调用过发现工具。

## Design B orchestration

1. 发现逻辑模型并查看维度、指标、关系、别名和示例。
2. 仅使用逻辑成员提交 `execute_semantic_query`。
3. DataOps 根据 active semantic snapshot 和内部物理映射校验并编译。
4. DataOps 执行编译 SQL 并返回共用结果引用。
5. 共用结果引用支持有界分页和导出；DSH plugin tool 提供图表呈现和 AI 语义分析。

方案 B 中模型不选择汇总或明细来源。紧凑执行 provenance 解释路由，编译器拥有物理 SQL。

## Storage

DataOps 继续以数据库为事实源。Resource `remark`、`usageManual`、字段和血缘存储单资源事实。只有不能清晰归属到单个资源的跨资源场景知识才新增 QueryGuide。已审核固定 SQL 场景继续使用 SemanticQueryTemplate。

方案 B 使用独立的结构化 SemanticModel snapshot，包含逻辑成员、指标表达式、已批准关系、物理实现、来源覆盖、粒度、可加性、新鲜度和安全策略。模型侧投影不必暴露物理映射，但编译器需要加载它们。

不要为了复制 Wren 的 MDL 目录把 DataOps 切换成文件事实源。Wren 文件是版本化编译器输入；DataOps 已经拥有数据库草稿、审批、权限、资源、血缘和 AI 可见性。后续可以导出 YAML 或 JSON 供 Git 审查或外部引擎使用，但文件和数据库不能成为竞争权威来源。

## Implementation split

DataOps `AiWorkspaceService` 拥有一用户一容器映射、独立 `DSH_HOME` 分配、Workspace Web Gateway 和 broker identity。DataOps 还为独立集成提供带 PKCE 的 Authorization Code，原子记录未绑定 target 的首次 owner，并在后续选择中校验该 owner，交换一次性 launch code，签发面向 MCP audience 的 token 和 scope，鉴权每个 HTTP MCP 请求，并将两种 transport 映射到现有 catalog、query、API、result、permission 和 audit service；仅为真实跨资源指导新增 QueryGuide 存储；方案 B 在后续独立编译器项目中实现。DataOps backend 和 MCP Server 不引入 DSH package。

DSH core 只新增通用 credential-backed MCP 鉴权能力。独立 DSH 可以分发位于 core/default profile 之外的可选 DataOps-specific integration package，但它只拥有持久 target reference、浏览器 OAuth、credential 获取和通用 MCP Client 组合，不能在运行中的 identity workspace 内替换已绑定 principal，并且不在 DataOps 托管容器中挂载。该 package 不包含 DataOps 查询标识、SQL 执行、来源路由、授权策略或 connector 逻辑。DSH 通过公开 plugin/profile 扩展点组合 `@sparkelf/dsh-chart` 和 `@sparkelf/dsh-query-result-analysis`；两个 plugin 只消费公开结果能力，不能接收 DataOps transport credential。

此前 [HTTP `dq/v1` 提案](../../rejected/architecture/2026-08-19-generic-data-query-protocol.md) 和假设的 `dsh-plugin-dataquery` 被本提案取代。选定传输是 MCP。

## Alternatives considered

**HTTP 加 DSH data-query plugin。** 否决，因为 DSH 已经桥接 MCP 工具；另一个查询 plugin 会重复传输、schema 投影、取消和结果处理。这不否决独立 DataOps Auth/Integration Plugin；后者拥有 OAuth 和 credential 生命周期，但不实现工具。

**在 MCP 配置、stdio 环境或启动 URL 中放静态 token。** 否决，因为 token 会过期，并且这些位置会泄漏或无法安全刷新。选定路径是独立 MCP HTTP 请求使用 credential reference、托管容器使用 broker-owned identity，浏览器入口使用一次性 launch code。

**在同一个 DSH runtime 内切换 DataOps 账号。** 否决，因为替换 credential 并只 remount MCP child 会让前一账号的 session history 和 plugin state 留在同一个 `DSH_HOME`。不同 principal 使用自己的每用户容器；当前 runtime principal 不可变。

**Bash 调用 HTTP endpoint。** 作为正式合同否决，因为 stdout 截断、字符串解析、凭据暴露、shell 权限和弱审计身份仍然存在。

**一个过载的发现工具。** 否决，因为模糊召回、完整枚举、选定详情和跨资源指导具有不同完整性和 payload 语义。它们可以共享后端服务，但不共享模型合同。

**在 DataOps MCP 中渲染图表，或回放时读取 live result reference。** 否决，因为图表构建和浏览器呈现属于 DSH，而 live `resultRef` 会过期，并让 session replay 依赖 DataOps 可用性和当前授权。完整 JSON option 是持久回放记录。

**在 chart plugin 中 Join 多个 result reference。** 否决，因为这会引入第二个数据计算和授权 owner。DataOps 产出一个 chart-ready 结果；chart plugin 只执行展示级转换。

**只向方案 A 暴露逻辑语义模型。** 否决，因为编写物理 SQL 的模型需要场景相关物理映射和警告；重复逻辑维度和指标不能解决汇总/明细选择。

**迁移前先建设方案 B。** 否决 MVP 范围。方案 A、有界结果和已审核模板足以迁移；只有观察到指标或路由错误足以证明编译器投入时才建设方案 B。

**使用文件语义存储。** 否决，因为会在现有数据库治理之外引入第二权威来源。可选导出足够。

## Acceptance criteria

- 方案说明保持方案 A 的模型生成物理 SQL与方案 B 的 DataOps 编译逻辑查询相互独立。
- DataOps 拥有 HTTP MCP Server 及其八个 Design A 工具；DSH 组合通用 MCP Client 和顶层 `render_chart`、`analyze_query_result` plugin tool，不实现 DataOps 查询语义。
- 目录合同区分模糊候选、完整列表和选定详情；模糊未命中绝不等于不存在。
- QueryGuide 是叠加在现有资源事实上的稀疏跨资源知识，不重复完整 schema。
- 方案 A 明确排除自动路由、SQL 重写和搜索历史证明。
- 方案 B 定义逻辑输入、编译器所有权、来源选择、粒度/指标规则、SQL 渲染和带版本 provenance。
- Design A MVP 只暴露 completed 的不可变 `resultRef`；在真实负载要求前，不提供持久 accepted execution、状态和取消工具。
- 共用结果定义不可变 snapshot、字节有界分页、当前 principal 重新授权、DataOps 导出产物，以及由 DSH 拥有的图表和 AI 分析消费者。
- 确定性数据处理在创建 `resultRef` 前完成；`analyze_query_result` 只执行有界 AI 语义归纳，不能定义精确数值事实。
- 每个 `render_chart` 调用只指定一个 source result，并将完整 JSON ECharts option 持久化为 DSH presentation metadata；回放不解引用 DataOps，chart code 不 Join result reference。
- DataOps 为每个用户分配恰好一个拥有独立 `DSH_HOME` 的容器；托管容器使用 gateway 和 broker identity，独立集成使用 OAuth/PKCE 和一次性 target 绑定，两条路径都不能把运行中的 runtime 重新绑定到其他 principal。
- MCP audience 和 scope 只授予 endpoint 入口；每个工具调用、结果页和导出仍以 DataOps permission 和 Resource authorization 为权威，工具参数不包含身份字段。
- 旧 HTTP 提案被拒绝并指向本 MCP 提案。

## Risks

- 即使 QueryGuide 正确，方案 A 仍可能选择错误物理来源；不可接受时使用方案 B 或已审核模板。
- QueryGuide 如果重复 Resource 事实会变旧；它必须引用资源，只说明跨资源例外。
- 大型清单必须经过分页和产物导出，不能把完整行直接放入模型上下文。
- 结果引用必须绑定 principal、过期、每次读取鉴权，并审计创建和访问。
- 持久化完整 chart option 会把展示数据复制到 DSH session。只有测得 option 体积证明 session record 不适合时，才增加独立 chart artifact 或自动 sampler。
- 即使 MCP 请求仍能正确授权，在多个 DataOps 用户间复用一个 `DSH_HOME` 也会混合 credential、session history 和 plugin state。`AiWorkspaceService` 必须保持一用户一容器映射和不可变 owner 绑定。
- 静态 MCP header 无法刷新 credential。生产 HTTP MCP 鉴权前必须交付通用 credential-reference 集成和重连行为。
- 超出交互预算的操作只有在 DataOps 拥有持久执行状态和显式取消后才能返回 accepted；只增加响应字段会让数据库工作缺少生命周期 owner。
- 方案 B 是较大编译器工作，在编译器和一致性覆盖交付前不能宣称可用。

## Verification

该决策的验证范围包括独立 `DSH_HOME` 的一用户一容器分配、DSH 进程不含 secret 的托管 gateway/broker identity、独立模式 MFA 登录和一次性 launch-code 交换、同 principal token 刷新、target-owner 和 principal 不一致拒绝、托管模式不提供账号切换操作、按请求 scope 和 Resource authorization、模型可见调用中不存在 secret 和身份字段、completed 结果物化、snapshot/分页/过期授权、不重新执行来源操作的导出、精确八加二工具组合和无 key 模型可见 snapshot。图表覆盖必须证明顶层工具注册、单 source 校验、从 presentation metadata 持久回放、keyed browser rendering、theme/resize lifecycle 和通用用户可见失败输出。批量分析覆盖必须证明有界分页读取、稳定行证据、遵循 provider policy 的重试、取消、已完成批次续跑和分层归并。方案 B 在可用前必须覆盖汇总来源选择、明细 fallback、可加和不可加指标、不安全 fanout 拒绝、方言渲染、权限谓词和稳定带版本 provenance。
