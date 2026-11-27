# knowledge-graph

知识图谱是知识库的导航层，不是第二套文档库。它只有三样东西：**图谱**（一个可见文件夹）、**主题**（图谱下的可见子文件夹 + `index.md` 卡）、**关系**（`index.md` 之间的一篇文档）。

## 1. 目录长什么样

```text
<scope>/知识图谱/<graph>/
  <主题>/
    index.md                 # 主题卡：front-matter + 摘要 + 自由正文
    <document>.md            # 文档，知识库能搜、能预览、能分享
  .kg/
    links/<a>--<b>.md        # 关系文档，点开头，KB 文件树和 FTS 跳过
```

- `<scope>` 是 `global` / `department/<部门链>` / `personal/<uid>`；个人路径由 Host 解析，**不要让模型拼 uid**。
- 主题文件夹名可读、可改；关系引用 `index.md` 里的 `id`，不引用文件夹名，所以改名不断边。
- 一个图谱一条 grant，覆盖主题文档与 `.kg`；写操作走 `kg_add` / `kg_set` / `kg_del`，不要用 shell 直接写文件。

当前图谱模型同时支持 graph-json（新建图谱默认用它）：

```text
<scope>/.graphs/<graph-id>/graph.json          # 拓扑与元数据：nodes/edges + name/scope/visibility
<scope>/.graphs/<graph-id>/links/<edge-id>.md  # 可选的关系正文
<scope>/<分类>/<文档>.md                       # 节点正文，仍是普通知识库文档
```

- 节点属性（type/authority/origin/reviewStatus/tags）写在节点文档的 front matter，`graph.json` 只存 `{id,path}` 与边。
- 图谱页把每个节点投影成一张卡片；空图谱也会出现在图谱树里，加上第一个节点后画布就有内容。
- `.graphs/` 是隐藏目录，不要用文件树或 shell 直接编辑；新建用 `kg_add kind=graph`，改拓扑用 `kg_add` / `kg_set` / `kg_del`。

### 总图（三级 computed / read-only）

`总图` 是**物化读模型**，不是磁盘上的 `graph.json`。它分三级，每个调用者按自己的范围看到：

```text
global/.graphs/__overview__/links.json              # 全局总图；共享
department/<chain>/.graphs/__overview__/links.json  # 部门总图；同部门共享
personal/<uid>/.graphs/__overview__/links.json      # 个人总图；按用户
```

- 三级的源数据仍是各自的 `graph.json`；`__overview__` 目录下**没有** `graph.json`，只有跨图关系。
- `kg_get {"graph":"总图"}` 默认解析到**个人总图**；要读其它级，用 `global/__overview__`、`department/__overview__`、`personal/__overview__`（也接受 `<级>/总图`）。
- 每次返回该级的 `graphs[]` 图谱摘要、`nodes[]`（id 形如 `<graphId>:<nodeId>`，带 graphId/type/title/authority/reviewStatus/docPath）、
  `edges[]`（端点已重映射；跨图边 `crossGraph:true`）。
- **继承模型**（`graphsForLevel`）：
  - `global` 总图 = global scope；
  - `department` 总图 = 本部门 + 子部门 + global 可读贡献；
  - `personal` 总图 = 个人 + 本部门链（含子部门）+ global 可读贡献。
  - 每级都排除该级 `总图` 自身；跨图边两端都必须在该级的贡献集合内且可读，不会泄露另一侧的名称或计数。
- 上级贡献的图/节点/边带 `contributed:true`、`readOnly:true`；个人总图不能改上级源图，编辑必须回到源图谱。
- `总图` 只读：`kg_set` 被拒绝；`kg_add kind=node` 被拒绝（请把节点加到源图谱，`总图` 会自动出现它）。
- 跨图关系用 `kg_add` 写入该级 `__overview__` 的 `links.json`：

```json
{"kind":"edge","graph":"personal/__overview__","id":"policy-to-role",
 "fromGraph":"personal/.graphs/procurement","from":"policy-1",
 "toGraph":"personal/.graphs/hr","to":"role-1","type":"governs"}
```

  先不带 `confirm` 拿草稿，用户确认后加 `"confirm":true`。`id` 是跨图边 id，必须唯一；`from`/`to` 仍然是**节点 id**，不是图谱 id。
  两个端点图谱都必须可读、在该级贡献集合内、节点必须存在，否则返回 `not-found`；重复 id 返回 `exists`；
  `authority`/`origin`/`reviewStatus`/`tags`/`sourceRefs` 与普通边同规则校验。
- `kg_del {"graph":"总图","id":"<跨图边 id>"}` 把这条关系移到该级 `.graphs/__overview__/_trash/links/`，不真删。
- 图谱页里三级 `总图` 都显示 `[计算] [只读]`；画布按来源图谱分簇，跨图边走虚线，点击节点跳到源图谱的对应节点。

#### 存储与生命周期（为 Relate 预留）

MVP 用 JSON 后端（`JsonOverviewStore`），**不安装原生 Relate 依赖**。存储层统一为 `OverviewStore` 接口：

```text
open()            按需加载一次
query()           读取当前跨图关系快照（不重复读盘）
close()           释放内存，不删盘
lastUsed()        最近使用时间
revision()        内容版本，聚合缓存据此失效
replace(links)    写回（MVP 的写方法）
estimatedBytes()  内存预算估算
```

`OverviewStoreManager` 负责生命周期，未来把 provider 换成内存优先的 Relate 后端即可：

- **按需加载 + 引用计数**：`acquire` 打开/复用并加引用，`release` 减引用；没有操作时不加载。
- **空闲 TTL**（可配置，构造时按范围钳制）：个人 5–10 分钟（默认 10）、部门 15–30（默认 20）、全局 30–60（默认 45）。
- **LRU 上限与内存预算淘汰**：只淘汰空闲（引用为 0）的 store；预算超了先淘汰最久未用的。
- **重建原子切换**：`rebuild()` 先把新 store 完整构建/加载，再换入 map，最后关闭旧 store；读者不会看到半成品。
- **共享与隔离**：全局/部门按 scope 共享一个 store；个人按 `userId` 独立，绝不把所有用户塞进一个 store。
- **登出/撤权**：调用 `closePersonal(userId)` 立即关闭该用户个人 store；插件 dispose / 进程退出调用 `closeAll()`。
- 以上默认值都是 `OverviewStoreManager` 构造参数，部署可按内存与访问频率调整；上限不允许突破约定区间。

#### 存储目录与兼容性 probe

- 物化 store 默认放 `<kbRoot>/.overview/`（`overviewStoreDir` 可改）；`overviewEnabled:false` 可整体关闭三级总图；
  `overviewStoreFallbackDir`、`overviewTtlMinutes.*`、`overviewMaxStores`、`overviewMemoryBudgetMB` 可调；**不假设 NAS 可用**。
- 启动时对目标目录做 open / write / fsync / read / lock 五项 probe；任一项失败自动 fallback 到本地
  `/var/lib/dataops/kb-overview`，并把 `{requested, dir, fallback, ok, checks}` 写日志（warn/info）。
- `links.json` 仍是跨图关系的持久真相；store 目录只放派生的物化快照，probe 失败不影响读取，也不阻塞 `kg_get`。
- 两个盒子是两家公司的独立实例：总图只在**本实例**的可读图谱内聚合，不做跨盒聚合，也不共享个人 store。
- MVP 不安装原生 Relate 依赖；第五阶段把 `OverviewStoreProvider` 换成 Relate 适配器，管理器的 TTL/LRU/预算/
  原子重建/close 契约不变。

## 2. 主题卡与关系文档

主题卡好例子：

```markdown
---
id: task-bus
title: 任务总线
status: active
depth: 4
domain: dsh
tags: [任务, 状态机]
updated: 2026-10-31
---

# 任务总线

DSH 的跨来源任务底座，任务卡是唯一状态载体。

## 现在
v0.1 设计稿评审完，正在拆实现任务。
```

坏例子：没有 `id`（关系会指向文件夹名，改名断边）；把全部正文塞进摘要（卡片会变成一堵墙）；`status` 写成自由文本（画布只能识别 active/paused/done）。

关系文档好例子：

```markdown
---
a: task-bus
b: group-chat
label: 任务来源
updated: 2026-10-31
---

# 任务来源

群聊把讨论转成任务；任务总线承接状态，不反向写群聊。
```

坏例子：`a`/`b` 指向不存在的 id（画布会丢弃这条边）；一篇文档写三段互不相关的关系（关系文档只表达两端之间的一件事）。

## 3. 四个动作

工具名与 `kg.py` 对齐：`kg_add` / `kg_get` / `kg_set` / `kg_del`。所有写动作**先返回草稿**，把草稿给用户看，用户确认后再带 `confirm: true` 调用。

| 动作 | 做什么 |
|---|---|
| `kg_add` | `kind: graph` 新建 graph-json 图谱；`kind: topic` 新增一条线（文件夹 + 卡）；`kind: link` 新增一条关系；`kind: node` / `kind: edge` 给 graph-json 图谱加节点/关系；`graph:"总图"` + `kind:"edge"` 新增跨图关系 |
| `kg_get` | 不带 `graph`/`id` 返回全部图谱总览；带 `graph` 返回该图谱；带 `graph`+`id` 返回卡、文档、关系；`graph:"总图"` 返回聚合总图 |
| `kg_set` | 改一个主题的 `status` / `depth` / `title` / `domain` / 摘要 / 正文；graph-json 图谱改节点/关系字段 |
| `kg_del` | 把主题移到 `<graph>/_trash/`；有关联关系时需 `force: true` 一并移走，**不真删** |

### 新建图谱（graph-json）

`.graphs/<id>/graph.json` 是当前图谱模型。新建图谱**不需要先有可见文件夹**，也不要手工拼路径或写 shell：

1. `kg_add {"kind":"graph","scope":"personal","id":"nenghui-governance","name":"能汇制度图谱"}`
   返回完整 manifest 草稿（`schemaVersion/id/name/scope/visibility/nodes/edges`），此时不写盘。
2. 把草稿给用户看；确认后同参数再加 `"confirm":true`，写入 `<scope>/.graphs/<id>/graph.json`。
   写成功后图谱页/`kg_get` 概览立刻能看到它（`format: "graph-json"`）。
3. 继续加内容：`kg_add {"graph":"personal/.graphs/nenghui-governance","kind":"node","id":"policy-1","path":"制度/采购制度.md","title":"采购制度","type":"policy"}`，
   同样是先草稿、再 `confirm:true`。节点正文是普通 `.md` 文档，图谱只记录 `{id,path}` 拓扑。

- `scope`：`personal`（默认，写调用者自己的个人范围）、`department`（复用已有部门图谱的部门路径；首次可显式传 `department/<部门链>`）、`global`（通常需要管理员写权限）。权限由 Host 的 `canWrite` 判定，越权返回 `forbidden`。
- `id` 只能是小写字母、数字、连字符；同一范围内重复 id **或重名**都会返回 `exists`。
- `kg_add` / `kg_get` 报 `no readable graph matches ...` 时，按错误里的提示先用 `kind:"graph"` 建图；不要用 `find`/`map` 或 shell 绕开工具。
- 新建图谱的 `status` 是 `draft`；发布/审核是后续动作，不要为了“让它出现”改 manifest。

### 六个剧本

1. **新建图谱**：`kg_get` 总览里没有目标图谱（或 `kg_add` 报 `no readable graph matches`）→ `kg_add {kind:"graph"}` 草稿 → 用户确认 → `confirm:true` 建出 `.graphs/<id>/graph.json`。
2. **新建一条线**：`kg_get` 看当前图谱 → `kg_add {kind:"topic"}` 草稿 → 用户确认 → `confirm:true`。
3. **接续**：`kg_get {graph,id}` 读卡与关系 → 更新正文/摘要 → `kg_set` 草稿 → 确认。
4. **寻址**：`kg_get` 不带 id 看总览 → 按名称找 graph → `kg_get {graph,id}` 读一条线；不要用 `find`/`map` 另造工具。
5. **沉淀**：把一次会话的结论写成文档（`kb_file_write` 到主题文件夹），再用 `kg_set` 更新卡摘要；图谱不复制文档内容。
6. **复盘**：`kg_get` 总览 → 对每条线读 `kg_get {graph,id}` → 把 `status`/`depth` 调整回真实状态；`kg_del` 只移 `_trash`，不删。
7. **跨图关联**：`kg_get {graph:"总图"}`（或 `global/__overview__` / `department/__overview__`）确认两个图谱都在该级贡献集合内且可读 → `kg_add {graph:"总图",kind:"edge",id,fromGraph,toGraph,from,to,type}` 草稿 → 用户确认 → `confirm:true`；不要为了跨图关系改任一图谱的 `graph.json`。

## 4. 扫历史会话（shell，不配工具）

需要从旧会话里找线索时，直接读会话日志，不要新建 `scan` 工具：

```sh
zstd -dc ~/.dsh/sessions/<session>.jsonl.zst \
  | rg -i '任务总线|group-chat|kg' \
  | head -80
```

把命中的原文片段带回当前对话，再由 agent 写成主题卡或文档；工具只负责图谱的四个动作，不负责扫描历史。
