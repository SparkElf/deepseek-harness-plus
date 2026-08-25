# Agent Note: MCP 数据查询接入与 A/B 查询方案

Status: proposed

[English](2026-08-23-mcp-data-query-architecture.md) | 中文

## Problem

DataOps 当前通过与自身服务强绑定的合同提供 AI 取数能力，而 DeepSeek Harness 已经能够把外部 MCP 工具接入普通工具运行时。本次迁移必须继续由 DataOps 拥有目录可见性、权限、SQL/API 执行、结果存储和审计，同时给后续 Agent 一份可以跨 DataOps 与 deepseek-harness-plus 两个仓库实施的 A/B 方案。

两种方案解决的问题不同。方案 A 把物理查询知识提供给模型，由模型编写 SQL。方案 B 给模型逻辑查询接口，由 DataOps 选择物理来源并编译 SQL。资源描述不是语义编译器，逻辑语义模型也不足以支持模型直接编写物理 SQL。

现有 DataOps MCP Server 可以复用，但目前工具会直接转发较大的 JSON payload，并通过固定进程环境变量绑定身份。因此迁移还需要有界结果、可重复使用的结果引用、单主体 DSH runtime 合同、基于 credential 的 HTTP MCP 鉴权，以及批量模型工作的明确所有权。

## Proposal

DataOps继续拥有MCP查询合同，DSH复用现有`@deepseek-ai/dsh-mcp-client`。本文把用户直接打开并自行维护`DSH_HOME`、通过Settings连接DataOps的形态称为“直接使用的DSH（standalone）”；把用户从DataOps工作区进入、身份和容器由DataOps分配的形态称为“DataOps托管DSH”。直接使用的DSH使用已认证Streamable HTTP MCP。DataOps托管的每用户容器使用本地 MCP adapter 和 DataOps-owned Unix broker，使 workspace principal 不进入 DSH 主进程。独立浏览器授权和 credential 生命周期由可选 DataOps Auth/Integration Plugin 提供，但不在 DSH 中新增 DataOps 查询工具实现，不让 DSH 执行 SQL，也不把 Bash 作为正式查询接口。DataOps 拥有用户认证、授权、runtime 分配、资源发现、API connector、查询执行、结果物化和审计。

本集成遵循[插件归属与分发决策](../../implemented/architecture/2026-08-20-plugin-ownership-and-distribution.md)：DataOps 专属身份、配置、UI、工具和部署只能留在可选 plugin 或 profile overlay。缺少 DSH 扩展点时，必须另行汇报并取得用户显式批准后才能修改 core source；本 RFC 本身不构成该批准。

暴露两个可选择的查询能力面。方案 A 是覆盖广泛临时查询的迁移 MVP。方案 B 是后续治理型能力，只有重点业务模型的指标和物理路由正确性值得建设编译器时才采用。两种方案共用结果、导出和图表合同。

### Ownership

| Responsibility | Owner | Contract |
| --- | --- | --- |
| 用户认证和 DSH 实例分发 | DataOps | DataOps 为每个用户分配一个拥有独立 `DSH_HOME` 的容器，并将该 runtime 永久绑定到同一 principal |
| DSH 中的可选 DataOps 集成 | `dsh-plugins-plus` 中的 `@sparkelf/dsh-dataops-integration` | 拥有Authorization Code + PKCE、delegated access credential、Settings UI、routes和通用MCP组合；省略插件时保持通用MCP匿名传输 |
| 通用 MCP 传输 | DSH MCP client | 严格使用已配置的普通Streamable HTTP header，不感知DataOps身份、OAuth、credential或生命周期 |
| MCP tools | DSH MCP client and DataOps MCP server | DSH 发现并调用工具；DataOps 鉴权每个 HTTP 请求并提供工具 |
| Resource catalog | DataOps | 搜索、完整枚举、详情、可见性、描述、使用说明书、字段和血缘 |
| Design A query | Model plus DataOps query executor | 模型选择物理资源并编写 SQL；DataOps 执行通用检查和查询 |
| Design B query | DataOps semantic query service | 模型提交逻辑成员；DataOps 选择来源并编译 SQL |
| Result snapshots | DataOps | 不可变授权结果引用、有界分页、导出、过期和审计 |
| Interactive chart | `@sparkelf/dsh-chart` | DSH 注册顶层 `render_chart` 工具并拥有持久图表呈现 |
| Batch AI analysis | `@sparkelf/dsh-query-result-analysis` 与 DSH 内建、由会话支撑的进程内 `spawn` 提供方 | 插件注册 `analyze_query_result` 并拥有分页、断点和归并；持久子会话及其 AgentLoop 拥有模型调用、记录和重试 |

### Authentication and deployment

DataOps 是多用户控制面。`AiWorkspaceService` 为每个 DataOps 用户创建或复用唯一 DSH 容器，每个容器使用独立 `DSH_HOME` 保存 credential、session history 和 plugin state。容器 owner 不可变：该 runtime 中的所有 conversation 和 DataOps connection 都属于同一个 principal。容器位置提供隔离，但不能替代认证。

DataOps 托管容器不重复浏览器 OAuth。已认证 DataOps 浏览器只通过 `http://<dshTargetRef>.dsh.<internal-domain>/` 的 Workspace Web Gateway 访问 DSH：一个不可变 managed target 拥有一个 browser origin，静态 wildcard DNS 把所有 target host 路由到同一个 gateway。DataOps parent 与 target host 使用相同 scheme 和 site。可信内网部署合同默认使用 HTTP/WS 和不带 `Secure` 的 host-only、HttpOnly、SameSite=Strict cookie；显式配置 HTTPS parent 后不能回落到 HTTP。一次性 launch code 在 gateway 设置 cookie 前绑定 target host、用户和有效 DataOps session。每个用户的main container拥有独立network namespace，只有该用户的companion加入并监听loopback 3080，因此多个用户可复用该端口且不发布host port。现有workspace agent tunnel把原生root-mounted DSH HTTP/WebSocket流量转发到该loopback service；DSH core不需要base-path能力。容器内 DSH 调用本地 MCP adapter，再由 DataOps-owned Unix broker 委托。只有 broker 接收 workspace user ID、internal token 和 backend location；DSH 主进程、模型上下文、URL 和工具参数不能收到这些 credential。托管 DSH 不挂载独立授权 plugin，因此 Settings 不提供 Connect、Reauthorize 或 Disconnect。

外部`@sparkelf/dsh-dataops-integration` plugin只用于可选独立DSH。它读取自己的delegated access credential，并用普通`Authorization` header挂载通用Streamable HTTP MCP client。没有该plugin时，直接配置的通用MCP client只发送显式header，也可以尝试匿名连接；是否存在匿名能力由远端MCP Server决定。生产DataOps取数MCP endpoint要求认证，因此拒绝匿名尝试。

直接访问独立DSH时发起带PKCE的DataOps Authorization Code流程。loopback HTTP callback无需注册；所有非loopback HTTP或HTTPS callback origin都必须显式注册，HTTP表示可信内网合同而不是HTTPS fallback。DSH为每次standalone连接在credential store中保存一个随机target reference。浏览器授权页、正常登录、MFA和明确账号确认由DataOps拥有。首次批准会将未绑定target reference原子绑定到所选OIDC `sub`；当前连接的后续批准和MCP session都必须使用该owner。一个delegated access token只在其绑定的DataOps `AuthSession`、账号、target owner、audience、scope和当前权限持续有效时可用。显式Disconnect验证并撤销grant、释放standalone binding并轮换可写target，因此下一次Connect重新进入明确账号选择。DataOps托管workspace target保持不可变，且不提供standalone连接操作。

从DataOps启动时只可携带绑定用户、OAuth client、目标DSH instance、audience、state和过期时间的短期一次性code；plugin在服务端交换后从URL删除。delegated access credential不得进入URL参数、工具参数、模型上下文、浏览器local storage或session log。DataOps Web access token和refresh cookie继续按tab隔离；新的重新授权popup通过签名授权请求和浏览器自动携带的HttpOnly cookie识别已有active browser session，不复制上一个popup的token或auth-tab identity。Plugin通过DSH credential service存储delegated credential，并把它提供给通用MCP child的普通HTTP header配置。显式重新授权只替换credential并重挂该child一次；不存在后台refresh、周期轮换或周期remount。

已认证的 Streamable HTTP MCP 请求携带 `Authorization: Bearer <access-token>`。DataOps校验issuer、audience、仍有效的绑定`AuthSession`、授权client、用户、target owner和MCP scope，然后向工具handler投影`AuthorizationPrincipal`。MCP audience 和 scope 只允许进入受保护 endpoint，不授予任何 Resource access。现有 DataOps permission 和 Resource authorization 判定每个工具操作，并在结果分页和导出时重新授权当前用户。DSH 不复制或解释 DataOps role/permission matrix。

DataOps将每个已连接MCP session identifier绑定到一个runtime principal。同一OIDC `sub`的显式重新授权credential可以替换旧grant并重挂MCP child一次；该连接存在时，不同`sub`会被拒绝。显式Disconnect结束standalone连接后，新target才可选择其他账号。MCP session identifier、DSH conversation identifier和result reference都不是credential。Conversation identifier后续可以提供审计关联，但不改变授权。

现有 [DataOps MCP Server](https://github.com/SparkElf/dataops/blob/main/infra/docker-workspace/runtime-daemon/src/dataops-mcp-server.mjs) 继续作为 embedded adapter 起点。独立生产模式使用 Streamable HTTP；托管容器使用 adapter 和 Unix broker。两种 transport 都在调用相同 catalog、query、result、permission 和 audit owner 前派生相同 DataOps principal。

## MCP contracts

MCP 参数和 `structuredContent` 使用 JSON。模型可见文本可以紧凑，但不能重复完整结构化 payload。跨边界 ID 是 opaque 且受 principal 约束的引用。access token 只通过 HTTP `Authorization` header 传输；工具参数不得包含access token、user ID、tenant ID或verification字段。模型不能收到数据库凭据、连接字符串或未限定范围的内部数字 ID。

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

`export_query_result` 通过同一授权分页路径消费 `resultRef`，增量创建 CSV 或 JSONL，且不重新执行来源操作。它返回 `{artifactRef, fileName, mediaType, sizeBytes, downloadUrl, expiresAt}`。`downloadUrl` 是不含 credential 的 DataOps application绝对路由；用户打开后，页面使用当前 DataOps 登录态，binary endpoint重新校验 result owner、expiry和来源 Resource权限。

`analyze_query_result({resultRef, instruction, resumeAnalysisRef?})` 对 DataOps 已按所需业务粒度完成过滤、Join、聚合和排序的结果执行 AI 语义分析。每个 DataOps 页面进入一个仅调用模型的 DSH 持久子会话并使用稳定 `<resultRef>#row-N` 证据标签；分组归并也使用同类子会话。插件保存已完成批次断点、传播取消并逐层归并摘要，最终返回 `analysisRef`、`summary`、行数、批次数、续跑状态和全部分析子会话 ID。每个子会话继承当前模型提供方和模型配置，由普通 AgentLoop 持久记录完整模型可见输入与输出，并执行提供方重试策略。操作断点仍是插件文件而非根会话事件，因此该可选包不需要 DSH core 事件类型，也不使会话读取依赖插件。

确定性过滤、Join、聚合、排名、去重和精确统计必须在创建 `resultRef` 前由 `execute_sql` 或 `call_data_api` 完成。`analyze_query_result` 只解释和归纳多页结果；有损模型摘要不能作为精确数值事实源。

### Interactive chart presentation

`@sparkelf/dsh-chart` 在 DSH 中注册顶层 `render_chart({sourceResultRef, option, title?})` 工具，而不是注册到 DataOps MCP。一张图只有一个非空 `sourceResultRef`。DataOps 必须先产出适合展示粒度的结果；如果仍需数据库规模的过滤、Join 或聚合，Agent 应重新执行更合适的查询，不能在可视化代码中重建数据引擎。

在Native或Both mode中，简单图表可以由Agent直接调用`render_chart`。在Code Mode中，程序读取所需结果页，完成展示级映射、过滤、排序、reshape、类型转换、百分比、累计值、参考线或注释，再通过nested SDK dispatch调用`render_chart`并传入完整JSON ECharts option。Code Mode不Join多个result reference。

`option`包含回放所需的全部数据，并且必须可JSON序列化；不允许JavaScript callback function。直接结果将完整option保存在tool-result `presentationMeta`中；nested Code Mode结果将同一份已验证投影保存在持久`tool/code-dispatch.content`内的chart-owned block中，该日志内容不会回流模型。`sourceResultRef`只保留provenance。Session replay直接渲染已记录option，不访问DataOps，也不依赖result TTL。

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

DataOps `AiWorkspaceService`拥有一用户一容器映射、独立`DSH_HOME`分配、不可变per-target browser origin、Workspace Web Gateway和broker identity。DataOps还为独立集成提供带PKCE的Authorization Code，原子记录未绑定target的connection owner，在该连接的后续选择中校验owner，只在验证后的Disconnect释放standalone binding，交换一次性launch code，签发面向MCP audience的token和scope，鉴权每个HTTP MCP请求，并将两种transport映射到现有catalog、query、API、result、permission和audit service；仅为真实跨资源指导新增 QueryGuide 存储；方案 B 在后续独立编译器项目中实现。DataOps backend 和 MCP Server 不引入 DSH package。

DSH core不需要改动。可选`@sparkelf/dsh-dataops-integration` package从`dsh-plugins-plus`分发给独立DSH，位于core和default profile之外，并拥有connection-scoped target reference、浏览器OAuth、access credential、普通MCP header配置和通用MCP client组合，不能在active connection内替换已绑定principal；Disconnect只轮换可写standalone target，并且该package不在DataOps托管容器中挂载。该 package 不包含 DataOps 查询标识、SQL 执行、来源路由、授权策略或 connector 逻辑。DSH 通过公开 plugin/profile 扩展点组合 `@sparkelf/dsh-chart` 和 `@sparkelf/dsh-query-result-analysis`；两个 plugin 只消费公开结果能力，不能接收 DataOps transport credential。

此前 [HTTP `dq/v1` 提案](../../rejected/architecture/2026-08-19-generic-data-query-protocol.md) 和假设的 `dsh-plugin-dataquery` 被本提案取代。选定传输是 MCP。

## Alternatives considered

**HTTP 加 DSH data-query plugin。** 否决，因为 DSH 已经桥接 MCP 工具；另一个查询 plugin 会重复传输、schema 投影、取消和结果处理。这不否决独立 DataOps Auth/Integration Plugin；后者拥有 OAuth 和 credential 生命周期，但不实现工具。

**由用户在profile MCP配置、stdio环境或启动URL中管理静态token。** 否决，因为这会让连接与撤销依赖手工操作，并把credential放入持久部署输入。独立plugin在授权后拥有一个credential-store value并把它提供给一个内存MCP child；托管容器使用broker-owned identity，浏览器入口使用一次性launch code。

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
- 每个`render_chart`调用只指定一个source result，并将完整JSON ECharts option持久化到直接presentation metadata或nested chart-owned dispatch block；回放不解引用DataOps，chart code不Join result reference。
- DataOps 为每个用户分配恰好一个拥有独立 `DSH_HOME` 的容器和一个不可变 browser origin；托管容器使用可信内网 HTTP target host、gateway 和 broker identity，独立集成使用OAuth/PKCE和connection-scoped target绑定，两条路径都不能把active runtime重新绑定到其他principal；standalone用户可以先显式Disconnect再重新选择。
- MCP audience 和 scope 只授予 endpoint 入口；每个工具调用、结果页和导出仍以 DataOps permission 和 Resource authorization 为权威，工具参数不包含身份字段。
- 旧 HTTP 提案被拒绝并指向本 MCP 提案。

## Risks

- 即使 QueryGuide 正确，方案 A 仍可能选择错误物理来源；不可接受时使用方案 B 或已审核模板。
- QueryGuide 如果重复 Resource 事实会变旧；它必须引用资源，只说明跨资源例外。
- 大型清单必须经过分页和产物导出，不能把完整行直接放入模型上下文。
- 结果引用必须绑定 principal、过期、每次读取鉴权，并审计创建和访问。
- 持久化完整 chart option 会把展示数据复制到 DSH session。只有测得 option 体积证明 session record 不适合时，才增加独立 chart artifact 或自动 sampler。
- 即使 MCP 请求仍能正确授权，在多个 DataOps 用户间复用一个 `DSH_HOME` 也会混合 credential、session history 和 plugin state。`AiWorkspaceService` 必须保持一用户一容器映射和不可变 owner 绑定。
- 独立grant随其绑定的DataOps `AuthSession`结束；显式重新授权只重挂DataOps MCP child一次。增加后台refresh或周期remount只会引入生命周期复杂度，不能改善已批准的用户路径。
- 超出交互预算的操作只有在 DataOps 拥有持久执行状态和显式取消后才能返回 accepted；只增加响应字段会让数据库工作缺少生命周期 owner。
- 方案 B 是较大编译器工作，在编译器和一致性覆盖交付前不能宣称可用。

## Verification

该决策的验证范围包括独立 `DSH_HOME` 的一用户一容器分配、隔离 browser storage 的 per-target origin、可信内网 HTTP bootstrap、无需 DSH core 修改的原生 root routing、DSH 进程不含 secret 的托管 gateway/broker identity、独立模式MFA登录和一次性launch-code交换、session-lifetime access与无需再次登录的同principal重新授权、连接期间target-owner和principal不一致拒绝、standalone Disconnect后重新选择账号、托管模式不提供账号切换操作、按请求 scope 和 Resource authorization、模型可见调用中不存在 secret 和身份字段、completed 结果物化、snapshot/分页/过期授权、不重新执行来源操作的导出、精确八加二工具组合和无 key 模型可见 snapshot。图表覆盖必须证明顶层工具注册、单source校验、direct与nested Code Mode调用后的持久回放、keyed browser rendering、theme/resize lifecycle和通用用户可见失败输出。批量分析覆盖必须证明有界分页读取、稳定行证据、每个批次或归并调用只使用一个持久子会话、子会话完整重建模型可见内容、由 AgentLoop 拥有提供方重试、父级取消、已完成批次续跑、分层归并，以及不修改 DSH core。方案 B 在可用前必须覆盖汇总来源选择、明细 fallback、可加和不可加指标、不安全 fanout 拒绝、方言渲染、权限谓词和稳定带版本 provenance。
