# Agent Note: Plus Backup作为单个full-stack插件

Status: proposed

[English](2026-08-30-plus-backup-plugin.md) | 中文

## Problem

已验收的Plus runtime会导出并恢复完整用户数据home，提供流式进度、磁盘承载且有上限的upload、mutation前archive校验、Workspace与Session cache恢复、mutation前cancel、失败retry以及成功后的单次browser reload。该行为目前分散在旧Host ApiProxy、Connection package、Workspace private code、仅Client的settings package和Web Bundle rows中。官方DSH `dsh-v0.1.2-alpha.1`已经提供外部Host插件所需的public WebServer与Connection trust operations，但没有public Workspace operation可在外部restore期间关闭durable storage并随后重建live indexes。在旧Connection API上开发会要求compatibility adapter，并保留错误的source base。

## Proposal

只在official tag的隔离worktree中开发Backup。由`packages/plus/backup`发布单个`@sparkelf/dsh-plugin-backup` package；其Host与Client entries共同形成一个capability，npm closure包含全部runtime dependencies。只添加最小temporary DSH source patch：public `WorkspaceRegistry.withStorageRestore(restore)` operation；它与现有Workspace mutations串行，关闭storage domain，执行传入的restore，再通过正常initialization路径重开domain。distribution引用plugin与独立patch package；精确选择版本只属于deployment lock。

package name从第一次commit起即为最终名称。Plus candidate只增加识别`@sparkelf/*` artifacts所需的source与release governance；不会先以`@deepseek-ai`名称发布后再rename。core installation path基于npm/profile：先执行`dsh plugin --profile plus add @sparkelf/dsh-plus`，再执行distribution的显式`dsh-plus apply --dsh-root <official-root>` command，最后执行`dsh --profile plus`。apply command只materialize data-only patch metadata并写exact lock；它没有install lifecycle script，也不包含capability implementation。

## Package and runtime ownership

Host entry拥有archive planning、64 KiB compression/restore chunks、manifest marker、generated-directory exclusion、mutation前validation、same-name replacement、作为package config公开且默认2 GiB的upload policy、one-use temp-file tokens、cleanup、progress framing以及四条exact routes。它通过`ctx.webServer.register`注册routes；每个handler在读取body或mutation前先调用`ctx.connection.requestRejection`。Upload把Node request流式写入Host temp file，绝不进入Connection JSON buffer。Export preparation和import在response backpressure下写有序NDJSON progress；GET/HEAD download流式传输暂存ZIP，只有GET消费token。

Client entry拥有Settings section、local operation state、upload progress、Host progress parsing、completion可见前的stream-reader release、cancellation、browser download、retry、import completion和reload action。所有product copy都在package自有typed中文与英文dictionaries中。UI保持已验收layout并继续消费现有semantic tokens；本次迁移不进行visual redesign，不新增shared store、polling或background recovery。

Workspace package拥有durable-domain transaction与live cache rebuild。Backup只提供file replacement callback。Connection拥有Host/Origin/browser authentication。WebServer拥有route dispatch。Settings File继续通过`settings.documentPath`提供DSH home path；没有file-backed settings provider的deployment在package activation时失败，不选择其他path。

## Data and error flow

Export从Settings button流向POST `/api/backup.export.prepare`、Host file planning与ZIP output、有序progress lines、one-use GET URL及browser download。Import从file picker流向POST `/api/backup.upload`、one-use token、POST `/api/backup.import`、archive validation、`withStorageRestore`、progress lines及可见reload action。四个route parsers是唯一untrusted HTTP ingress owners；archive validation是唯一ZIP entry/path owner。下游只消费已校验token、progress records与archive entries，不重复normalize，也不保留fallback fields。

预期user errors返回明确HTTP status或一个terminal progress error，并恢复Settings actions供retry。非预期Host exceptions保留原始stack，以稳定`[plus-backup]` console error记录route与phase，但不记录archive content、settings values、credentials或filesystem paths。不添加automatic retry、fallback transport、compatibility protocol、queue、worker、polling loop或额外lock。

## Migration and deletion

先完成official-base package。完整capability path可用后，distribution用`@sparkelf/dsh-plugin-backup`替换`@sparkelf/dsh-client-ui-settings-backup`，把Workspace delta移入独立data-only patch package，并一次性删除旧ApiProxy Backup API/archive/routes、Connection Backup routes、Client-only package、bundle row、tests、docs和dependencies。不保留dual package name、dual route owner、legacy manifest field或runtime fallback。

official tag的active Agent Notes没有覆盖user-data Backup，因此本proposal不supersede任何Note；现有storage与WebServer notes继续拥有各自mechanisms。

## Delivery stage and verification

这是一个capability大阶段：namespace governance、Workspace operation、full-stack package、profile composition、独立patch payload、exact lock integration、旧路径删除、docs、locales与现有Electron system case全部完成后才进入code review与verification。由于Workspace method与package Host entry共享同一runtime contract，工作串行执行；并行修改文件不能缩短critical path。

functional acceptance从official DSH installation开始，通过DSH profile command安装`@sparkelf/dsh-plus`及其npm closure。随后只通过Playwright UI操作生成的Plus Web profile：导出真实archive并看到scan/compress progress，导入并看到upload/validate/restore/reload progress，reload后观察恢复的Session与Workspace state。同一case选择invalid ZIP，看到可操作error并可retry。browser diagnostics收集console warnings/errors、page errors、failed requests、unexpected HTTP failures、CORS failures与stalled requests。Desktop与tray applications可以调用该public profile workflow，但不是prerequisites或acceptance owners。official tag没有Playwright runner，因此Plus distribution拥有Web Playwright harness；不新增Vitest或direct HTTP替代测试。

## Alternatives considered

**在accepted fork上开发并适配两套Connection API。** 拒绝，因为adapter只为保留将被移除的source base存在，会增加route ownership并违反no-compatibility要求。

**把Backup routes放入official Connection或ApiProxy。** 拒绝，因为WebServer route registration和Connection trust policy已经允许feature拥有transport；只有Workspace storage restoration缺public operation。

**替换files后重启Host。** 拒绝，因为这会弱化已验收的即时cache restoration、把Backup耦合到Supervisor，并在mutation后process restart失败时留下含糊结果。

**把Host、Client、archive与protocol拆成多个npm packages。** 拒绝，因为它们围绕一个user capability共同演进，没有independent consumer，拆分只会增加package与composition overhead。

**使用JSON RPC与base64 archive。** 拒绝，因为它会buffer大archive、丢失native upload/download streaming，无法保持已验收progress与memory behavior。

## Acceptance criteria

- `@sparkelf/dsh-plugin-backup`是包含Host、Client、profile、locale与dependency closure的单个public npm package。
- official DSH是唯一source base；plugin不import旧ApiProxy或旧Connection API，也没有compatibility branch。
- temporary DSH patch只包含public Workspace restore transaction，可独立ownership、version、lock与retire。
- Export、upload、import、progress、cancellation、download、retry、reload及恢复后Session/Workspace visibility通过现有Electron Playwright path与accepted production等价。
- Invalid archive在mutation前失败，UI显示可恢复error，Host原始stack诊断得到保留且不含敏感内容。
- distribution切换composition时删除全部旧Backup owners；任一runtime都不存在两个route或locale owners。

## Risks

Workspace restore operation临时扩展official DSH public surface，官方release提供等价storage restoration后必须retire。restore失败可能使user files处于部分替换状态；accepted algorithm有意保持当前same-name replacement语义，不引入用户未要求的transaction format或rollback copy。Direct WebServer handlers必须在每条route读取body前应用Connection rejection；遗漏会暴露privileged local data。默认2 GiB允许较高disk与CPU消耗，因此package保留已验收explicit limit并将其作为可配置policy，所有大数据均使用streaming。
