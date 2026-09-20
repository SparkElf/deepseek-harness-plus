# Agent Note: The skill center is our package, built on the official skill registry

Status: proposed

[English](2026-09-20-the-skill-center-is-our-package.md) | 中文

## Problem

侧边栏技能中心来自第三方包 `@linxin666/dsh-client-ui-skill-explorer`。它能用，但它不属于这个外壳：

- **它的行与页面和旁边的面板不一致。** 入口自绘内联 SVG 而不是用共享图标集，页面把样式打包进 bundle，并且在官方「插件」面板有行图标、副标题、分组计数的地方，它一个都没有。
- **它靠注入 DOM 抵达桌面。** 它自己的文件头记录了原因：「dsh 的侧边栏外壳没有暴露任何外部插件可注册的槽位，因此……入口行被注入到外壳的『新会话』按钮与工作区浏览器之间」。那套机制靠 mutation observer 自愈。
- **它带遥测。** `src/client/telemetry.ts` 把它记录的每个插件的名称、版本与安装渠道，以一个匿名访客 id（它自行生成并存在 localStorage）发到 `https://dsh-market.com/api/telemetry/event`。
- **它的 host 半边自己扫文件系统。** 一套与 harness 自身并列的第二套扫描器，带着它自己的分组规则。

用户要求面板与官方面板一致，并要求这个包归我们所有。

## Proposal

**用一个我们拥有的包 `@sparkelf/dsh-client-ui-skill-center` 替换它，功能范围保持不变。**

侧边栏行通过官方 `sidebar.panellist` 槽位注册，页面通过键控的 `main` 槽位注册，与官方「插件」面板完全一致，因此行、标签与选中态由外壳负责。图标是共享 primitives 里的 `IconSkillOutline16`，页面沿用官方面板的度量：28px 内缩、20px 标题配 13px 引言、实心主操作、带计数的分组标题、每行一个 48px 发丝边框图标，以及悬停面比内容外扩 8px 的无边框行。

**读取走官方注册表；只有写操作是我们自己的。** `ctx.skills` 提供目录、它的提供者优先级与热更新，路由读取它而不是扫盘。注册表的摘要有意省略文件路径 —— 它们是调用无关元数据 —— 因此写操作在需要时通过 `ctx.skills.get()` 解析路径。这些调用共享的目录由 `collect()` 缓存，所以该解析不是第二次扫描。

注册表是只读的，因此三个写操作在官方没有等价物，留在这里：启用/停用就地改写 YAML 前置块里的 `disable-model-invocation`，新建写入标准 `SKILL.md`，删除把技能移入同级的 `.trash`。

不携带任何形式的遥测：上报模块被删除，而不是被停用。

## Findings this change rests on

1. **第三方入口声称不存在的侧边栏槽位其实存在。** `sidebar.panellist` 声明在 `packages/client/ui-sidebar/src/client/contract/slots.ts`，并由该包客户端插件里的 `entriesOfSlot` 读取 —— 官方「插件」入口就是这样注册的。
2. **那个旧包不发源码，只发带内联 source map 的 bundle。** 从中可以还原出 11 个真实 TypeScript 文件，这才使一次忠实替换（而非仅凭行为重写）成为可能。
3. **它的遥测端点与访客键就是那份还原源码里的字面量。**
4. **注册表的摘要不携带路径。** `toSummary` 解构七个字段，path 不在其中，因此写路由必须自行解析它。
5. **隔离实例以中文渲染该面板、控制台零错误**，把行注册在官方「插件」入口旁边，并按来源分组列出已加载的技能。
6. **三个写操作对运行中的实例都可用**，通过新建一个技能、停用它（文件获得 `disable-model-invocation: true`）、再删除它（它移入 `.trash`）验证。

## Acceptance criteria

- 侧边栏入口通过 `sidebar.panellist` 注册，页面通过 `main` 注册；不注入 DOM，不用 mutation observer。
- 行图标来自 `@deepseek-ai/dsh-client-ui-primitives`。
- 已发布 bundle 里没有任何字符串抵达第三方端点；不存在遥测模块。
- 目录来自 `ctx.skills`；`~/.dsh/skills` 或某个项目根下的用户技能无需第二套扫描器即可出现。
- 分组、搜索、启用/停用、新建、删除的行为与之前一致。
- 在同一个页面上，该面板与官方面板的度量一致。

## Alternatives considered

**给第三方包的 bundle 打补丁。** 它没有可供打补丁的源码，这次的改动是重写它的呈现层，而结果会是我们的修改躺在别人的产物里、每次发版都要重来。

**保留 DOM 注入，只重新给行做样式。** 否决：外壳通过槽位拥有这一行，所以给注入的行重做样式，等于保留了官方面板并不需要的机制。

**停用遥测上报模块而不是删除它。** 否决：一个部署不该携带它永不使用的上报路径，而下一次改动的评审者还得重新确认它是关的。

**让新包像旧包那样扫文件系统。** 否决：那会重复 harness 的发现过程、失去热更新，而且它的分组会与注册表逐渐分叉。

## Risks

**注册表不列出的技能无法在这里管理。** 面板显示的是 `ctx.skills` 报告的内容，因此注册表拒绝加载的技能文件在这里不可见；旧扫描器本会显示它。

**写操作需要注册表解析出技能路径。** 一个没有文件路径的技能 —— 虚拟的或运行时注册的 —— 无法被切换或删除，面板会报告这一点而不是执行动作。

**旧包的用户失去它的附带能力。** 它的源码里还有一个过滤模块与一条本包未复现的遥测渠道；这次承接过来的是该部署用到的功能集 —— 浏览、搜索、切换、新建、删除。
