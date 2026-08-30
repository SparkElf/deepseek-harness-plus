# Agent Note：功能等价的 Plus npm 发行层

状态：提案

[English](2026-08-29-ranged-plus-patchset-distribution.md) | 中文

## 问题

已验收的Plus production把official DSH behavior、完整user capabilities、product defaults、external plugins、temporary source repairs及optional Desktop deployment behavior放在一个tree中。只安装settings-only package或重放选定fork commits不能复原该产品，还会静默遗漏Agent Teams UI与Turn folding等official capabilities。Official DSH必须是唯一source base，candidate verification前每个accepted difference都必须有一个current owner。

## 提案

只使用三种delivery forms。完整user capability是一个npm-installable Cordis plugin closure，包含所需全部Host/Client roles、provider、persistence rule、profile face及locale。`@sparkelf/dsh-plus`只拥有dependency closure、ordered profile composition、defaults、enablement、compatibility metadata和independent patch-package references。Official DSH或external package中有证据的gap才成为一个data-only npm patch package，拥有一个exact payload variant和一个retirement lifecycle；patch package不包含JavaScript entry、lifecycle script、Cordis plugin、fallback或compatibility adapter。

primary materialization path不依赖Desktop或tray application：

```bash
dsh plugin --profile plus add @sparkelf/dsh-plus
dsh plugin --profile plus exec dsh-plus apply --dsh-root <official-dsh-root>
dsh --profile plus
```

`dsh-plus apply`解析installed patch-package manifests，要求official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`，以显式`node-pty` build permission安装profile-owned `dsh-better-sidebar@0.17.1` dependency，用exact checkout的dsh CLI dependency tree及out-of-tree peers所需source workspaces共同构建profile的official package scope，把selected payloads复制进profile，配置exact npm patches，应用exact source patches，通过`build:official`构建source，并写credential-free `.dsh-plus/patchset.lock.json`。`plus` release family发现完整`@sparkelf` closure，分配一个`plus-npm-v*` tag，canonicalize packed manifest object keys，并通过manual npm workflow发布credential-free pack job两次生成且逐字比较的exact tarballs。随后manual publication audit要求18个registry entries全部public，并逐文件比较registry解包内容与该release artifact。Explicit dist-tag promotion只接受一个successful exact-tag release run，会先对其artifact重复该comparison，再移动全部18个package tags并逐个读回；仅在此流程成功后promotion unversioned installation。Desktop与tray application可以调用同一public workflow，但不是prerequisite、manifest owner、release owner或acceptance path。

## 最终inventory

完整capability packages为`@sparkelf/dsh-plugin-backup`、`@sparkelf/dsh-plugin-subagent-settings`、`@sparkelf/dsh-plugin-document-attachments`、`@sparkelf/dsh-plugin-dataops`及其内部挂载的`@sparkelf/dsh-plugin-mcp-credentials`依赖。Backup拥有streamed export/import progress、mutation前validation、retry/reload UI及Session/Workspace restoration。Document attachments拥有wire admission、parser/provider behavior、durable model text、browser transport、单个mixed draft transaction、cards和locale。Subagent Settings拥有persisted execution settings与browser UI。DataOps和MCP credentials各自在自身package中保留完整runtime ownership。DataOps遵循current service的access-only delegated grant：它存储一个access credential与stable target identity；delegated grant过期或其browser session被revoke后会弹出DataOps-owned DSH shell modal，其用户动作打开real OAuth popup；Settings保留同一个distinct recovery state。MCP authentication rejection仍是current agent turn内的tool error，不会终止task；结果未确认的operation不会被自动重放。Plus不发明DataOps authorization server未暴露的refresh credential、refresh timer或grant type。

独立official-source patch packages为`@sparkelf/dsh-patch-browser-auth-mode`、`@sparkelf/dsh-patch-workspace-storage-restore`、`@sparkelf/dsh-patch-subagent-settings-presets`、`@sparkelf/dsh-patch-document-attachments`、`@sparkelf/dsh-patch-legacy-code-preset`、`@sparkelf/dsh-patch-session-export-chinese`、`@sparkelf/dsh-patch-responses-reasoning-status`、`@sparkelf/dsh-patch-mobile-web-layout`及`@sparkelf/dsh-patch-web-base-path`。Browser Auth patch增加profile-selected `required | disabled` policy，并保持`required`为official default；Plus在official Host/Origin fence之后选择`disabled`以实现direct local Web access。Document patch只包含generic file-object、durable content、prepared prompt、model projection、mixed draft、Host limit、在指令按钮后渲染的专用attachment-picker slot和nested presentation integration points。Legacy preset patch在真实`code` preset不存在时把持久化`code`解析到`ptc`，不改写Session日志，也不遮蔽真实`code` preset，并在浏览器里把该legacy id显示为PTC。Session export copy patch只替换简体中文browser dictionary中混用的英文`Session`。Responses patch是面向拒绝历史reasoning `status`的gateway的定向pi-ai与Models editor compatibility repair。

External packages仍为`dsh-better-sidebar`、`@sparkelf/dsh-mobile-bridge`、`dshmarket`及`@changfenhuang/dsh-genui`；其独立patch为`@sparkelf/dsh-patch-better-sidebar-app-frame`、`@sparkelf/dsh-patch-genui-streaming-echart`及`@sparkelf/dsh-patch-mobile-bridge-serialized-actions`。GenUI拥有model-taught `dsh-ui` surface与inline interactive chart rendering；Plus不保留local Chart package或`render_chart` tool。Exact-version GenUI patch在[upstream PR #87](https://github.com/omdsh-dev/dsh-genui/pull/87)进入npm且真实inline-chart path通过后退役。Curation恰好一次拥有每个external/source patch retirement condition。

Welcome onboarding、home-path display、code-dispatch spill、ask-user card collapse、Turn folding、Workspace picker、Session export behavior、creator guidance、durable image intake/storage/model projection及`read_image` dimensions直接继承official DSH，不创建Plus package或patch。发现official equivalence时立即删除拟议Plus owner。Agent Teams不属于tracked accepted composition：其official service、tools、Client UI及Web profile packages均是release families排除且shipped profiles默认disabled的private experimental workspaces。

## Package与copy ownership

Runtime与peer manifests使用minimum-only ranges；唯一例外是profile-owned Better Sidebar dependency及其native build permission，它们是materialization的exact security inputs。Deployment lock记录resolved DSH、distribution、plugin、patch-package、target、variant、payload、profile dependency及build-permission facts。Credential values、settings、Session data、prompts及model output不进入该lock。Product copy归实现behavior的capability或targeted patch所有；不存在generic Plus locale plugin。

Backup-specific note `2026-08-30-plus-backup-plugin.md`继续拥有archive、route、restore及progress details。本note只拥有complete distribution forms、final inventory、materialization path和deletion rule。

## 删除规则

Review删除没有current accepted workflow、重复official behavior或形成old/new runtime paths的任何package、patch、field、UI state、test或document。Implementation不保留accepted-fork fallback、fuzzy patching、automatic promotion、dual daemon、runtime v5、empty package、inline patch compatibility或speculative framework。

## 验证

Candidate verification从official DSH installation开始，安装npm/profile closure，运行explicit apply，并使用isolated home与`3081/3083`。Real Playwright UI acceptance通过无token或cookie的clean root URL进入Plus，先验证official branding、简体中文Session export copy及指令按钮旁的attachment picker，再覆盖Backup export/import/progress/retry/restoration、Subagent Settings persistence/execution、Document intake/history/model use、DataOps/chart、external plugins及official Turn folding。Browser diagnostics收集page errors、console errors、failed requests、CORS failures与stalls。Explicit user acceptance前，production `3080`与`/root/.dsh`保持不变。

## 考虑过的替代方案

**把payload与capability code放进`@sparkelf/dsh-plus`。** 拒绝，因为无关compatibility repairs会共享一个lifecycle，且不完整Host/Client roles容易遗漏。

**让Desktop成为materializer或acceptance owner。** 拒绝，因为npm/profile composition才是product contract；Desktop只是optional installer convenience。

**每个source file创建一个patch或保留selective fork commits。** 拒绝，因为package boundaries跟随user capability或retirement lifecycle，而selected commits会把fork保留为隐式second source base。

## 验收标准

- 安装`@sparkelf/dsh-plus`、对exact official source运行explicit apply并启动`dsh --profile plus`，会materialize完整selected runtime closure及credential-free deployment lock，不由Desktop或tray持有。
- Governance对每个accepted capability、external package及temporary repair恰好分类一次；unsupported compatibility、Agent Teams、fuzzy patching及accepted-fork fallback保持不存在。
- Real Plus Web acceptance通过UI operations连接real Host、MinerU、model及DataOps services；DataOps authorization使用external DataOps Web UI中的authenticated account。
- Explicit user acceptance及promotion前，production `3080`与`/root/.dsh`保持不变。

## 风险

未来DSH release可能仍接受exact patch，但surrounding runtime semantics已经变化。Exact base revision checks、loud application failure、isolated materialization、real UI verification及一个curation retirement owner约束该风险。Final inventory仍可能遗漏hidden accepted delta；因此review在声明zero unclassified differences前会检查production source、notes、profiles、locales、external manifests与UI paths。
