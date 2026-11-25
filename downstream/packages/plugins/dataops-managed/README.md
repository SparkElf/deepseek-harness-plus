# @sparkelf/dsh-dataops-managed

## 中文

这是DataOps托管工作区使用的DeepSeek Harness集成插件。它接收当前DataOps会话JWT，并通过credential-backed HTTP MCP提供DataOps工具；DSH Settings显示只读的DataOps身份与权限说明。

本包不发起OAuth，也不提供连接、重新授权或断开按钮。DataOps父页面把现有JWT交给固定Host route；插件把它存入DSH credential，MCP transport在每次请求前读取当前值。DataOps API根据该JWT对应的当前角色和资源授权决定可执行范围。

本包只应安装到DataOps托管profile。独立DSH需要用户授权时使用@sparkelf/dsh-dataops-integration，两者不应同时安装。

### 万相品牌

DataOps设置中的“应用万相品牌”默认开启，并在本机浏览器中持久化。开启时，侧栏、折叠导航、新会话欢迎页、浏览器标题和favicon使用万相数据平台品牌；关闭后立即恢复DSH官方品牌。欢迎页四单元Logo在支持hover且未启用减少动态效果时播放轻微的等距展开动画。

### 模型体验

本包增加命名空间化DataOps MCP tool schema，但不把JWT写入system prompt、tool参数、结果或session log。认证本身不增加token或改变KV cache。

### 工具按权限披露

工作区的DataOps角色决定模型能看到哪些技能/审核工具：插件在JWT变更、首次连接和审核上下文刷新时读取`/api/ai/review/context`，按`skill:*`能力与审核角色注册或注销工具；没有能力的工具不会出现在模型工具列表中。工具执行时不再重复读取角色，DataOps后端仍对每次API调用做最终授权、参数校验、审批与审计。`dataops_api_docs`只向「超级管理员」披露，用于只读检索`/api/openapi.json`。后端 MCP 工作流工具`workflow_query`／`workflow_definition`／`workflow_deployment`／`workflow_run_control`同样只向「超级管理员」披露：它们在模型侧的名称是`mcp__<serverName>__<name>`，插件把该名称映射回声明表后参与会话级披露，群聊房间会按发言人身份隐藏非超管不可见的工具。同一份 scope 还会通过`ctx.skills.useViewer`约束技能目录；技能中心的连接器 Tab 读取`/api/dsh-skill-center/connectors`，未授权能力不会出现在目录中。

### 已知限制

- JWT尚未同步或DataOps拒绝当前权限时，MCP client直接呈现对应连接或工具错误。

## English

This is the DeepSeek Harness integration plugin for DataOps-managed workspaces. It accepts the current DataOps session JWT and provides DataOps tools through credential-backed HTTP MCP; DSH Settings shows a read-only identity and permission summary.

The package starts no OAuth flow and exposes no connect, reauthorize, or disconnect control. The DataOps parent supplies its existing JWT to one fixed Host route; the plugin stores it as a DSH credential, and the MCP transport resolves the current value before every request. DataOps APIs decide the allowed operations from the JWT principal's current roles and resource grants.

Install this package only in a DataOps-managed profile. Standalone DSH deployments that need user authorization use @sparkelf/dsh-dataops-integration; the two packages must not be installed together.

### Wanxiang Branding

The Apply Wanxiang branding setting defaults on and persists in the local browser. When enabled, the sidebar, collapsed rail, New Session welcome view, document title, and favicon use the Wanxiang Data Platform identity; disabling it immediately restores the official DSH identity. The four-unit welcome mark animates a subtle isometric expansion only on hover-capable devices when reduced motion is not requested.

### Model Experience

The package adds namespaced DataOps MCP tool schemas but never places the JWT in the system prompt, tool arguments, results, or Session log. Authentication adds no model tokens and does not affect the KV cache.

### Permission-Based Tool Disclosure

The workspace's DataOps role decides which skill and review tools the model can see. The plugin reads `/api/ai/review/context` when the JWT changes, on the first connect, and whenever the review-context route refreshes, then registers or disposes tools according to the `skill:*` capabilities and review role. A tool the principal cannot use is never offered. Execution does not re-read the role; DataOps still performs final authorization, parameter validation, approval and audit on every API call. `dataops_api_docs` is disclosed only to 超级管理员 and searches `/api/openapi.json` read-only. The backend's MCP workflow tools — `workflow_query`, `workflow_definition`, `workflow_deployment`, and `workflow_run_control` — are likewise disclosed only to 超级管理员: their model-facing names are `mcp__<serverName>__<name>`, and the plugin maps that name back to the declaration so a group-chat room hides any tool its speaker could not use. The same scope is applied to the skill catalog through `ctx.skills.useViewer`; the skill center's connector tab reads `/api/dsh-skill-center/connectors`, which omits capabilities the account cannot use.

### Known Limitations

- Before JWT synchronization, or when DataOps rejects current permissions, the MCP client exposes the corresponding connection or tool error.
