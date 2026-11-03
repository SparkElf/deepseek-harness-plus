# Agent Note: 技能受众与权限元数据

Status: implemented

[English](2026-10-30-skill-permission-metadata.md) | 中文

## Problem

技能目录过去与调用策略无关，却也与受众无关。提供方可以让技能不进入模型目录（`modelInvocable: false`）或不进入用户命令，但没有任何字段表达「只有管理员可见」或「读取者必须持有 `skill:manage`」。挂载敏感技能的部署——例如读取 DataOps 管理接口的连接器——只能二选一：把所有技能发布给全部用户，或者把技能移出共享目录、失去可发现性。

DataOps 已决定：权限不在每次工具或技能调用里重新检查。插件在初始化、登录、角色变化和能力变化时调整自身行为——注册或 dispose 工具、隐藏技能——后端 API 仍是最终授权边界。因此技能框架需要让消费方声明一次受众，由注册表在目录与加载边界应用，而不是把每次 `get()` 变成一次权限查询。

## Decision

`SkillSummary` 增加两个可选字段，并由 `SkillCandidate` 与 `SkillDefinition` 继承：

- `requiredPermissions?: readonly string[]`——列出的权限标识必须全部被授予。
- `visibility?: 'public' | 'admin' | 'super-admin'`——最低受众级别；省略即 `public`。

`SkillViewer` 描述读取者：`permissions?: readonly string[]` 与 `role?: 'user' | 'admin' | 'super-admin'`。两个字段都可选；省略的读取者就是没有任何权限点的普通用户。`SkillVisibility` 与 `SkillViewerRole` 是这些取值背后的封闭联合类型。

### 过滤边界

`isSkillVisible(skill, viewer)` 要求读取者角色达到所声明的可见级别，并且所列权限点全部授予。`filterVisibleSkills(skills, viewer)` 把它应用到目录，同时保持顺序与元素类型，便于消费方投影自己构造的列表。

注册表在同一条规则的两个位置应用：`list()` 与 `snapshot()` 在投影摘要前丢弃不可见候选项，`get()` 对不可见候选项或已加载定义返回 `undefined`，与「名称不存在」同语义。因此模型无法通过猜名字加载它看不到的技能。未标注的技能对所有读取者保持可见，既有提供方与运行时注册的受众不变。

### 读取者解析

`SkillViewOptions.viewer` 让单个消费方为一次查找指定读取者。`ctx.skills.useViewer(viewer)` 为不指定读取者的消费方注册部署级读取者——正好匹配「一个工作区只有一个 DataOps 用户」的形态——并返回清除它的 Cordis disposer。注册或清除不同身份的读取者会失效已完成目录并发出 `skills/change`，使已经发布的模型目录按新受众重发；重复注册相同身份是 no-op。被更新的注册取代的旧注册在 dispose 时不会清掉新值。

`SkillLookupOptions.viewer` 把解析后的读取者转发给提供方，提供方可以在源头省略自己无法提供的候选项。发现缓存把稳定的读取者身份（角色加去重排序后的权限点）纳入键，因此两个受众不会共用一份提供方结果，而相同受众共用。注册表在提供方发现之后仍会应用已声明的元数据，提供方无法通过省略或额外返回候选项放宽受众。未指定读取者且没有已注册读取者的查找，会原样转发调用方自己的选项对象。

### 来源解析

本地提供方从 frontmatter 读取 `required-permissions`（单个标识或列表）与 `visibility`，对权限点去重，并把两者投影到候选项与定义。取值非法、列表项不是字符串，或使用 camelCase 拼写 `requiredPermissions`，只会让该技能随警告被丢弃，同目录下合法的技能仍可列出。注册表在缓存或返回之前，会拒绝提供方候选项、运行时注册与已加载定义上的格式错误元数据。

### 这不是什么

元数据是披露，不是授权。部署从已经解析出的 principal 注册读取者，并在角色变化时重新注册；没有任何工具或技能调用去查权限树。后端 API 继续对每个请求授权。必须在没有已注册读取者时看到带标注技能的消费方——例如代表浏览器用户读取的技能中心——按查找传入 `viewer`。

## Alternatives considered

**在每次技能加载时重新检查权限。** 被它服务的部署决策否决：逐次权限查询把一次授权往返塞进模型的工具循环，重复插件在登录时已经做过的工作，而且真正的边界仍然是后端。

**由技能包新增一个 principal 服务。** 否决，因为 harness 没有会话级 principal 可读：DataOps 工作区是单用户的，其插件已经持有 JWT 与角色上下文。部署级读取者注册加单次查找覆盖，已经覆盖两种形态，不必再发明第二个身份权威。

**在各消费方分别过滤，而不是在注册表。** 否决，因为模型目录、加载工具与技能中心会各自重新推导规则并最终漂移；`get()` 还会保持未过滤，模型可以按名字加载隐藏技能。

**在 `visibility` 之外再加一个 `audience` 字段。** 否决，因为两者表达同一个次序；一个封闭的级别字段让 frontmatter 与类型只有一种拼写，与调用策略的单一规范化形式一致。

**缓存提供方发现时不带读取者。** 否决，因为会在源头过滤的提供方会把一个受众的结果泄漏给另一个；缓存键里的读取者身份让相同受众共用一次发现。

## Testing

`packages/skill/skill/tests/skill.spec.ts` 覆盖可见性规则与角色级别、权限交集、`list()` 的目录过滤与 `get()` 的拒绝、加载后提高自身受众的定义、已注册读取者及其失效、被取代注册的 dispose、每个不同读取者一次提供方发现且读取者被转发、以及注册/候选项/定义三处边界的格式错误元数据。

`packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` 覆盖两个键的 frontmatter 解析、单个与列表权限形式、按管理员读取者过滤，以及非法值或旧 camelCase 键只跳过出错文件。

`packages/skill/tool-skill/tests/tool-skill.spec.ts` 覆盖读取者注册前后的模型目录与 `skill` 工具：受限技能不在目录中且被工具拒绝，读取者变化后出现在替换目录里并可加载。

三个包通过各自的聚焦测试与项目引用的 `tsc -b`。`docs/subsystems/skills.md` 及其中文对照用 `ts type-equiv` 块记录新类型，并在 `scripts/type-equiv.manifest.json` 注册。

## Related decisions

调用策略仍由 [skill 调用策略](2026-07-28-skill-invocation-policy.zh.md) 拥有；受众元数据是同一摘要上的第二条独立轴。DataOps 连接器的披露规则——有效能力、工具注册与 dispose、后端作为最终边界——记录在 `dataops/docs/dataops-connector-development-spec.md`，不在本仓库。

## Consequences

开始声明元数据的提供方会立刻失去不匹配的受众：没有注册读取者时，带标注的技能被隐藏。这是有意的失败关闭默认值，也意味着「接线读取者」是发布这类技能的一部分。

两个调用点仍在本仓库的技能包之外：技能中心宿主路由必须按调用方角色传入读取者，DataOps 连接器必须在登录后注册 `useViewer` 并在角色变化时重新注册。在那之前，带标注的技能在两个界面都被隐藏，而不是展示给错误的受众。