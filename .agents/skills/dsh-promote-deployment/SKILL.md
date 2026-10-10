---
name: dsh-promote-deployment
description: Use when promoting the running DSH deployment to a new release, building or switching a release mirror, restarting the supervisor that serves it, or diagnosing a deployment that reports a new version while serving old behavior. Covers the mirror build, the profile guard's acceptance step, and the runtime package versions that prove a promotion actually happened.
---

# DSH Deployment Promotion

Use this skill to move a running deployment onto a new release. The deployment is not the repository checkout: it is a **release mirror** under the DSH home, with its own sources, build outputs, and profile. Changing a version in the profile does not change what the runtime executes.

## Find the tools before writing any step

The deployment already owns this procedure. Read these before running anything, and call them rather than re-deriving their contents:

| Command | Owns |
|---|---|
| `dsh-plus-build <mirror>` | `pnpm install` twice (a patch that adds a dependency changes the graph, and only a second install links it), then `pnpm run build --profile official`, then verify the brand record and that no workspace with dependencies lacks `node_modules`. |
| `dsh-plus-switch` | Move the served release to another mirror, tracking phases. |
| `dsh-plus-refresh rebuild \| accept \| restart \| all` | Rebuild the mirror, record the profile as accepted, restart, or all three in that order. |
| `dsh-plus-mirror create --tag <official-tag> --mirror <path> --runtime <version>` | Extract an official tag into a fresh mirror, apply this repository's reviewed patches, typecheck them, regenerate the standalone manifests, build, create the profile, write the compatibility exemptions, relink the scope, and repair shadowed packages. `dsh-plus-mirror check --mirror <path>` reports the scope verdict. |
| `dsh-plus-exemptions --runtime <version> [--out <path>]` | Derive the profile's `compatibility.json`: every plugin whose published peer ranges cannot match the runtime. |
| `repair-shadowed-scope.mjs --release <mirror>` | Replace real directories that shadow a release package with links to its source. |
| `dsh-3080-restart` | Restart through the supervisor: repair profile scope, prove module uniqueness, re-accept the fingerprint, restart, then verify the client modules and the connection surface. |
| `relink-release.mjs --release <mirror>` | Restore the `@deepseek-ai` scope links a `pnpm install` inside the mirror rewrote. |
| `check-profile-scope.mjs --release <mirror>` | Report duplicate `@deepseek-ai` packages and unresolvable dependencies; both break every tool call while HTTP stays 200. |

Writing a second, partial copy of any of these is the mistake this skill exists to prevent. A hand-written promotion that edits only the profile's distribution version reports success, passes an HTTP check, and serves the previous release: the runtime packages resolve from the mirror's sources, which the promotion never touched.

### The step a promotion cannot skip

Plus does not install the official packages directly. Its profile's `overrides` redirect 27 of them to this repository's republished builds:

    "@deepseek-ai/dsh-api-gateway": npm:@sparkelf/dsh-api-gateway@0.1.7-rc.2

Those republished packages carry the patches, and **they are the runtime**. A profile whose overrides still name the previous revision installs the previous runtime beside a mirror built from the new source, and the result passes an HTTP check while serving the old release.

So promoting onto a new official revision has a prerequisite the mirror build cannot satisfy:

    node scripts/release/republish-patched-official.mjs --source <mirror> --version <official-version>

This packages each patched official workspace, verifies the packaged output against the workspace it came from, and publishes. It is one command because those steps must not be separated — every reported defect came from a package that packaged cleanly and was verified against a list its author had written rather than against its source.

Run it before `dsh-plus-mirror create`. Without it the promotion has no runtime to point at, and `dsh-plugin-backup`-style peer mismatches are the least of the symptoms.

### Driving the Windows desktop from a WSL deployment

`computer-use` has no desktop of its own: the provider spawns an installed driver over stdio, and the driver owns the connection to the desktop. A deployment running under WSL drives the Windows desktop because WSL interop can execute a Windows executable directly, so the provider's `command` is the `/mnt/<drive>/...` path of `cua-driver.exe` — the `C:\` form is not an executable that process can spawn. The Windows daemon reaches the interactive session through a named pipe, so it must already be running there.

    /root/.dsh/dsh-plus-cua --profile <profile dir>

The tool discovers the executable under `/mnt/c/Users/*/AppData/Local/Programs/Cua`, proves it answers an MCP `initialize`, and writes the `command` into the profile's `computer-use-cua-driver-mcp` row. `--check` reports without writing. A layer that carries the row with no `command` activates the provider and then fails discovery, which reads as a plugin defect rather than a missing path.

The provider exposes the driver's own tools, including `list_windows`, `click`, `type_text`, and `verify_state`. The driver's agent-cursor overlay is part of it: a window named `Cua.AgentCursorOverlay.default` in `list_windows` means the virtual cursor is live.
### Where a hand-written row belongs

The profile has one user layer, `<profile>/cordis.patch.yml`, and a capability change rewrites it. The rewrite keeps rows it does not own, but the file is still the layer that changes: a deployment's own configuration belongs in `$DSH_HOME/cordis.patch.yml` instead, which the loader applies last and nothing rewrites.

    # $DSH_HOME/cordis.patch.yml
    - id: llm-pi-ai
      name: "@deepseek-ai/dsh-llm-pi-ai"
      config:
        providers: ...

Measured 2026-09-29: a hand-written model provider, permission presets, theme, and welcome-notice version lived in the profile layer; one capability change from the GUI emptied the 9.6 kB file to 318 bytes. Restoring them into the home layer is what made the configuration survive the next capability change.

### One command

`dsh-plus-mirror create` performs the whole sequence below. Each of its steps was added after a promotion failed on it: a hunk that applied but stopped compiling, a standalone manifest whose peer overrides no longer matched, a profile install the compatibility gate rejected, and a scope the check reported DEFECTIVE because real directories shadowed it. The step-by-step sections that follow explain what each one does and how to diagnose it; run them by hand only to repair a mirror the command could not finish.

## Promotion order

1. **Build the mirror.** Check out the new official revision in a release mirror, keep the previous mirror as the rollback anchor, apply this repository's patches, then run `dsh-plus-build <mirror>`.
2. **Point the profile at the matching republished packages.** The overrides live in the profile's `pnpm-workspace.yaml`. Two version sequences meet here and they are not the same number: the distribution releases as `0.2.0-rc.N`, while a republished official package carries the official revision it was built from, `0.1.7-rc.1`. Read the range from the version being promoted, never from the installed one — the installed copy names the base being left.
3. **Write the manifest last, after acceptance.** A running supervisor rewrites its manifest on every progress phase — `announce()` calls `writeStatus()`, not only `stop()` — so a manifest written before a multi-second acceptance step is the supervisor's own older copy by the time anything reads it. Measured: the manifest named the new mirror, acceptance ran for seconds, and the reload adopted the previous mirror. `dsh-plus-switch` orders its steps `link → accept → manifest → reload → verify` for this reason.

4. **Record the profile closure.** The supervisor's profile guard refuses to start when the accepted closure changed without a new acceptance. `dsh-plus-refresh accept` does this; a bare restart does not, and the guard then rolls the profile back while the unit retries until `StartLimitBurst` trips, leaving one bare exit code in the journal.
5. **Restart through the supervisor**, not the service manager. The unit runs the supervisor and the web process is its child; `systemctl restart` kills both, so the control socket disappears and every connection is refused during the restart. Use `dsh-3080-restart` or `dsh-plus-refresh restart`.
6. **Verify the runtime, not the distribution version.** See below: this is the step whose absence makes a failed promotion look successful.

## Verify the runtime package versions

The distribution version is a wrapper. What executes is the mirror's own sources, linked into the profile's `@deepseek-ai` scope, so a promotion is complete only when those report the new revision:

```sh
# The mirror's sources, which the profile links to:
cd <mirror> && git rev-parse --short HEAD

# The versions the runtime actually resolves:
for p in dsh-session dsh-tools dsh-host-webserver; do
  node -p "require('<profile>/node_modules/@deepseek-ai/$p/package.json').version"
done
```

Every one must name the new official revision. A distribution version of `0.2.0-rc.N` beside `@deepseek-ai/dsh-tools@0.1.6-alpha.2` is a promotion that changed the wrapper and left the runtime behind, and it will pass an HTTP check and a client-module check while serving the old release.

The mirror also records what it was built from, which is the fastest way to date it:

```sh
node -p "require('<mirror>/.dsh-build/client-build-environment.json').environment"
```

## Diagnose a restart that will not start

Run the checks in the order the interlock runs them, because each answers a question the next cannot:

1. `check-profile-scope.mjs --release <mirror>` — duplicate `@deepseek-ai` packages (two module instances, two scheduler Symbols, every tool call failing with `reading 'prepare'`) and release packages whose dependencies do not resolve. A previous source sync that **moved** rather than copied package `node_modules` trees causes this; `repair-profile-scope.mjs` replaces the shadows with links, and `restore-nested-modules.mjs` brings the nested trees back.
2. `check-plugin-imports.mjs` — every bundle imports.
3. `profile-guard.mjs guard --state <accepted-profile.json>` — the accepted closure still matches.

`preflight-start.mjs` runs all three and repairs what it can; it is the unit's `ExecStartPre`, so a restart issued through the supervisor's runtime command skips it.

## A registry mirror lags the registry

An image or mirror that installs from `registry.npmmirror.com` cannot resolve a release published minutes ago, and the failure names a version that plainly exists — because it does, upstream. Before concluding that packaging is broken, ask both registries:

```sh
curl -s https://registry.npmjs.org/<encoded-name> | grep -c '"<version>"'
curl -s https://registry.npmmirror.com/<encoded-name> | grep -c '"<version>"'
```

Served by the mirror: build. Served upstream only: trigger a sync with `curl -X PUT https://registry.npmmirror.com/-/package/<encoded-name>/syncs`, or point the build at the upstream registry. Served nowhere: the release did not publish, and no retry fixes it.

## When the artifact is right and the deployment is still wrong

Every trap below produced a mirror that built, booted, answered HTTP 200, and served the wrong
thing. The gates in this skill check the artifact; these check relationships the artifact cannot
express. All measurements are 2026-10-10, DSH 0.2.1-alpha.2.

**An override that names an unpublished version.** The 27 substitutions are written by hand, and
nothing rejects a version that does not exist: pnpm keeps whatever the registry has, so an alpha.1
package lands beside the alpha.2 runtime. Five overrides named unpublished alpha.2 builds, and the
mirror died with `does not provide an export named isWildcardHost` — which reads as a plugin bug.
Only patched workspaces are republished, so the version is never uniform; `resolvePeerOverrides`
derives it per package, a hand-written override does not.

```sh
node -e "
const o = require('./packages/bundle/plus/package.json').dshPlus.profile.overrides
for (const v of Object.values(o)) { const m = /npm:(@[^@]+)@(\S+)/.exec(v); if (m) console.log(m[1] + '@' + m[2]) }" \
| while read spec; do npm view --registry=https://registry.npmjs.org "$spec" version >/dev/null 2>&1 || echo "MISSING $spec"; done
```

**One package declared twice installs two copies that fight.** A package in both
`profile.dependencies` and `profile.overrides` installs under each name; two versions shipping
one client module register one module id twice (`duplicate factory registration`), the page shows
"Failed to load plugins", and the profile never boots. The declarations are not redundant:
`dependencies` carries the patched bytes for an **npm** patch target, while `overrides` is what
an official package's `workspace:*` dependency resolves through. A **dsh-source** target needs only
the override. So: decide by the target's `kind`, and when both exist pin them to one version.

**The reviewed set is a declaration.** `verify-plus-governance` compares
`profile.dependencies` against a hardcoded list in `scripts/verify-plus-governance.ts` and rejects
any difference. A version bump, upgrade, or removal belongs in the same commit as the manifest
edit — a mismatch means the reviewed set and the shipped set disagree, which is the condition the
gate exists to catch, not a false positive.

**A patch that applies is not a patch that is still needed.** Upstream can implement what a patch
carries, and the patch then stops applying for the best possible reason: retire it, do not rebase.
`curated.yaml` pre-declares the condition in `retireWhen`; check whether the new release contains
the identifier the patch introduced. Measured: `better-sidebar 0.25.0` has
`const nextPath = params?.path ?? params?.url`, byte-identical to a patch's replacement, so that
patch retired. Retiring also removes it from `patchPackages` **and** `dshPlus.dependencies`; a
leftover fails with `must reference every source patch package exactly once`. An npm patch's
`target.range` moves with the version it was rebuilt against, upper bound exclusive, because the
gate packs that range and runs the same strict `git apply --check` the applier does.

**A plugin that installs is not a plugin that mounts.** A package becomes a layer only when its
manifest declares `dsh.bundle` pointing at a `cordis.patch.yml` carrying its rows. Without it the
module installs as a plain dependency and nothing mounts it — the profile reports success while the
capability never runs. Measured: `@sparkelf/dsh-image-hoist` declared no bundle and was skipped
with `declares no dsh.bundle`, invisible because its own layer in the plus patch named it.

**A peer range that cannot match is not always a broken plugin.** `dsh-plus` refuses a plugin
whose published `peerDependencies` cannot match the runtime, per exact version.
`dsh-plus-exemptions` derives the exemption list and the mirror writes it to
`profiles/plus/compatibility.json`; **a profile without that file skips every such plugin
silently** while HTTP still answers 200. Generate it for the runtime being served, not the one
being left:

```sh
node /root/.dsh/dsh-plus-exemptions --runtime <runtime> \
  --manifest packages/standalone/plus-standalone/package.json \
  --out <mirror>/profiles/plus/compatibility.json
```

**A repair that repairs nothing.** `repair-shadowed-scope.mjs` defaults to `<release>/profile`;
a mirror keeps its profile at `profiles/plus`. Given only `--release` it finds no scope, prints
`nothing to repair`, and exits 0 — leaving every `@deepseek-ai` package on its registry copy
(measured: 276 shadowed). Pass `--profile` explicitly and follow it with a `pnpm install` in the
release root, because the links now point at sources whose third-party imports only that install
provides. A repair that reports success while changing nothing deserves more suspicion than one
that fails; check the effect with `check-profile-scope.mjs`, not the exit code.

**Promote from the merged revision.** The mirror builds from `PLUS_REPO`, a working tree. Building
it from an unmerged branch and switching production to the result puts unreviewed bytes in front of
users: the observed symptoms (a duplicate module, a skipped plugin) then describe the branch rather
than the release, and every diagnosis is against the wrong artifact. Merge first, then build the
mirror from that revision.

### 一个 override 可能指向「这仓库从不发布」的包

`PATCHED_WORKSPACES` 是 republisher 会构建的全部 workspace（27 个）。override 若命名了不在其中的包，
它指向的是一个**本仓库从不发布**的包 —— 版本永远停在最后一次发布。2026-10-10 实测：

```sh
# override 数 ≠ PATCHED_WORKSPACES 数时，多出来的就是孤儿
node -e "
const p=require('./packages/bundle/plus/package.json');
const src=require('fs').readFileSync('scripts/release/package-patched-official.mjs','utf8');
const block=src.slice(src.indexOf('PATCHED_WORKSPACES = ['), src.indexOf(']', src.indexOf('PATCHED_WORKSPACES = [')));
const ws=[...block.matchAll(/'([^']+)'/g)].map(m=>m[1]);
const official=new Set(ws.map(w=>require('./'+w+'/package.json').name));
for (const n of Object.keys(p.dshPlus.profile.overrides)) if(!official.has(n)) console.log('孤儿 override: '+n);
"
```

实测有 5 个孤儿（`dsh-llm`、`dsh-host-webserver`、`dsh-subagent`、`dsh-host-frontend-static`、
`dsh-api-terminal-controller`），全部停在 `0.2.1-alpha.1`，而 runtime 是 `0.2.1-alpha.2`。
其中 3 个与同版本官方包 **`lib/` 逐字节相同**（override 是空操作），另 2 个只差一个生成的类型描述文件。
官方 alpha.2 这 5 个包都存在，所以替换买到的是更旧的代码。

判断一个 override 是否还有意义，比较**同版本**的官方与 `@sparkelf` 构建：

```sh
for spec in "@deepseek-ai/<pkg>@<v>" "@sparkelf/<pkg>@<v>"; do
  d=$(echo "$spec" | tr '/@' '__'); mkdir -p "$d"
  npm pack --registry=https://registry.npmjs.org "$spec" --pack-destination "$d" >/dev/null 2>&1
  tar -xzf "$d"/*.tgz -C "$d"
done
diff -rq _deepseek-ai_*/package/lib _sparkelf_*/package/lib && echo "空操作：可移除 override"
```

### floor 与 override 版本必须相容

`compatibility.dsh` 是 **floor**，却是生成器和 `ship.ts` 推导 runtime 版本的**唯一来源**
（`/^>=?(.+)$/` 或 `replace(/^[^\d]*/,'')`）。floor 写着 `>=0.2.1-alpha.1` 时，生成的 override
全部指向 alpha.1，而镜像实际建在 alpha.2 上 —— 于是：

- `verify:standalone-manifest` 拿 floor 推导出的结果比对按 alpha.2 生成的文件，**永远不可能一致**；
- 5 个孤儿 override 因为 alpha.1 满足 floor 而**没有任何门禁反对**。

提升 runtime 时把 floor 一起提到该 runtime，两件事同时解决。判别：

```sh
node -e "console.log(require('./packages/bundle/plus/package.json').dshPlus.compatibility.dsh)"
# 应等于镜像构建时 --runtime 的值（>=<runtime>）
```

### 前缀匹配不是 workspace 匹配

`packages/llm/llm-pi-ai/` 以 `packages/llm/llm` 开头，但它们是两个不同的 workspace。
用 `startsWith` 判断「哪个补丁改了哪个包」会把 `responses-reasoning-status`（改 `llm-pi-ai`）
误判成改了 `llm`。比较时带上结尾斜杠，或用 manifest 的 `name` 比对。

### 改动生成物后必须重新生成，且用对命令

`profile.dependencies` 一改，两份 standalone manifest 立刻过期。门禁会报
`is stale in overrides, dshPlusStandalone`。**不要手工编辑 manifest** —— 它由生成器产出：

```sh
pnpm run verify:standalone-manifest   # 只检查（--check），失败时打印必填命令
```

生成器慢（每个 override 都要问 registry），必须 **后台跑**：

```sh
nohup npx tsx scripts/standalone/generate-manifest.ts \
  --distribution packages/bundle/plus \
  --out packages/standalone/plus-standalone/package.json > /tmp/gen.log 2>&1 &
```

**在生成器跑完之前读 manifest 会读到半写状态**（本次因此误判过一次「52 个 alpha.2」）。
等进程真正退出再读。

### 改插件前先确认哪一份是权威源码

2026-10-10 实测踩坑：`@sparkelf/dsh-image-hoist` 在 `/root/projects/` 下**有两份副本**：

| 路径 | 性质 |
|---|---|
| `dsh-plugins-plus/packages/image-hoist/` | **权威源码**，被 git 跟踪，带 `repository` / `scripts` / `devDependencies` |
| `dsh-image-hoist/`（`/root/projects/` 顶层） | 手工拷贝的散件，**未被任何仓库跟踪**，缺 `repository` 且 peer 范围被简化成 `"*"` |

我在散件上改了并发布了 `0.1.2` —— peer 范围降级成通配、丢掉 `repository`，
导致 harness 仓库的 `gen-third-party-notices` 预提交钩子直接失败
（`cannot resolve repository for @sparkelf/dsh-image-hoist`）。版本号已消耗，只能发 `0.1.3`。

**发版前先确认权威位置**：

```sh
# 被 git 跟踪的那份才是源码；未跟踪的同名目录是散件
cd /root/projects/dsh-plugins-plus && git ls-files packages/<name> | head
git -C /root/projects ls-files dsh-<name>   # 空 = 未跟踪，不要用它发版
```

发版后的元数据也要核对 —— 缺失的字段往往在发布被拒时才暴露：

```sh
npm view --registry=https://registry.npmjs.org <pkg>@<version> repository peerDependencies dsh --json
```

### 无 src 的插件：lib/ 就是源码

`dsh-plugins-plus` 里多数包有 `src/` 且带 `prepack: pnpm run build`，`lib/` 被 `.gitignore` 忽略。
但 `image-hoist` **没有 `src/`** —— 它的 `lib/index.js` 是手写源码、直接入库发布。
判断一个包属于哪种：

```sh
ls packages/<name>/src 2>/dev/null || echo "无 src → lib 是源码，无 prepack"
node -p "JSON.stringify(require('./packages/<name>/package.json').scripts)"
```

### 生成器不能是非确定的，否则它自己的门禁会间歇失败

`resolvePeerOverrides` 遍历插件、对每个插件问 registry 拿 peer；`publishedPeers` 在 `npm view`
失败时**静默返回 `{}`**。于是一次瞬时超时会让某个插件的 peer 改由**另一个声明同一 peer 的插件**
插入 —— 集合完全相同，**顺序不同**。而生成器的 `--check` 用 `JSON.stringify` 比较：

```ts
const stale = owned.filter(key => JSON.stringify(previous[key]) !== JSON.stringify(manifest[key]))
```

`JSON.stringify` 对对象键顺序敏感，所以这个门禁会**间歇性失败**，且报错只说
`is stale in overrides, dshPlusStandalone`，不指出差别只是顺序。

诊断方法 —— 连跑两次，比较集合与顺序：

```sh
npx tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus --out /tmp/a.json
npx tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus --out /tmp/b.json
node -e "
const a=require('/tmp/a.json'), b=require('/tmp/b.json');
console.log('集合相同:', JSON.stringify(Object.keys(a.overrides).sort())===JSON.stringify(Object.keys(b.overrides).sort()));
console.log('顺序相同:', JSON.stringify(Object.keys(a.overrides))===JSON.stringify(Object.keys(b.overrides)));
"
```

修法是在**输出处**排序（`overrides` 与 `peerOverrides` 都按 name 排），让产物只由输入决定：

```ts
...Object.fromEntries([...overrides].sort((l, r) => l.name.localeCompare(r.name)).map(e => [e.name, e.version])),
```

注意：**改生成器后必须重新生成两份 manifest**，否则 `--check` 会因排序变化而失败 —— 这本身
就是这条规则生效的证据。

### 改完依赖必须重新生成，且生成器很慢

`profile.dependencies` 一改（升级插件、加/删条目），两份 standalone manifest 立即过期。生成器
为每个 override 查一次 registry，实测单份约 3–5 分钟。**必须后台跑**，并在**进程真正退出后**再读文件：

```sh
nohup npx tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus \
  --out packages/standalone/plus-standalone/package.json > /tmp/gen.log 2>&1 &
# 用 pgrep 确认退出，不要靠 sleep 猜
while pgrep -f generate-manifest >/dev/null; do sleep 10; done
```

写文件发生在**最后一步**，中途读会拿到半写内容（本次因此误判过两次）。

### 提升必须建在已合并的 revision 上

镜像构建读 `PLUS_REPO`，默认是**当前工作树**：

```sh
# /root/.dsh/dsh-plus-mirror:50
PLUS_REPO=${PLUS_REPO:-/root/projects/deepseek-harness-plus}
```

2026-10-10 实测：在**未合并的分支** `fix/alpha2-substitution-set` 上建镜像并切 3080，把没过
master 门禁的产物推上生产。页面白屏，报

```
client-modules: duplicate factory registration for
  "@deepseek-ai/dsh-client-ui-permission-presets"
```

更糟的是 **master 上的真实缺陷被这一层掩盖**（5 个 override 指向不存在的 npm 版本），
症状描述的是分支而不是发布版，所有诊断都对着错的产物。

正确顺序：**先 merge 到 master → 从 master 建镜像 → 再切 3080 / 更新工作区 pin**。

判断镜像建在哪个 revision：

```sh
cd <mirror> && git log --oneline -1     # 应等于 origin/master 的 tip
```

### 一个 override 可能指向「本仓库从不发布」的包

`PATCHED_WORKSPACES` 是 republisher 构建的全部 workspace。override 若命名不在其中的包，它指向
一个**本仓库从不发布**的包，版本永远停在最后一次发布。实测有 5 个这样：

| 包 | `@sparkelf` 最新 | 官方 alpha.2 | `lib/` 对比 |
|---|---|---|---|
| `dsh-llm` | alpha.1 | 存在 | **逐字节相同** |
| `dsh-host-webserver` | alpha.1 | 存在 | **逐字节相同** |
| `dsh-host-frontend-static` | alpha.1 | 存在 | **逐字节相同** |
| `dsh-subagent` | alpha.1 | 存在 | 差一个生成的类型描述 |
| `dsh-api-terminal-controller` | alpha.1 | 存在 | 差一个生成的类型描述 |

三个是空操作，另两个把描述文件钉在 runtime 后面。**override 数应等于 PATCHED_WORKSPACES 数**：

```sh
node -e "
const p=require('./packages/bundle/plus/package.json');
const src=require('fs').readFileSync('scripts/release/package-patched-official.mjs','utf8');
const i=src.indexOf('PATCHED_WORKSPACES = [');
const ws=[...src.slice(i, src.indexOf(']', i)).matchAll(/'([^']+)'/g)].map(m=>m[1]);
const official=new Set(ws.map(w=>require('./'+w+'/package.json').name));
const extra=Object.keys(p.dshPlus.profile.overrides).filter(n=>!official.has(n));
console.log('override 数:', Object.keys(p.dshPlus.profile.overrides).length, ' patched:', ws.length);
extra.forEach(n=>console.log('  孤儿 override:', n));
"
```

判断一个 override 是否还有意义 —— 比较**同版本**的官方与 `@sparkelf` 构建：

```sh
for spec in "@deepseek-ai/<pkg>@<v>" "@sparkelf/<pkg>@<v>"; do
  d=$(echo "$spec" | tr '/@' '__'); mkdir -p "$d"
  npm pack --registry=https://registry.npmjs.org "$spec" --pack-destination "$d" >/dev/null 2>&1
  tar -xzf "$d"/*.tgz -C "$d"
done
diff -rq _deepseek-ai_*/package/lib _sparkelf_*/package/lib && echo "空操作 → 可移除 override"
```

### floor 与 override 版本必须相容

`compatibility.dsh` 是 floor，却是生成器与 `ship.ts` 推导 runtime 版本的**唯一来源**。floor 写着
`>=0.2.1-alpha.1` 时，派生的 override 全指向 alpha.1，而镜像建在 alpha.2 上 —— 于是
`verify:standalone-manifest` 拿 floor 推导的结果比对按 alpha.2 生成的文件，**永远不可能一致**；
5 个孤儿 override 因 alpha.1 满足 floor 而**无人反对**。

提升 runtime 时把 floor 一起提到该 runtime，两件事同时解决。

### 前缀匹配不是 workspace 匹配

`packages/llm/llm-pi-ai/` 以 `packages/llm/llm` 开头，但它们是两个不同 workspace。
用 `startsWith` 判断「哪个补丁改了哪个包」会把 `responses-reasoning-status`（改 `llm-pi-ai`）
误判成改了 `llm`。比较时带结尾斜杠，或用 manifest 的 `name`。

### 生成器不能是非确定的，否则它自己的门禁会间歇失败

`resolvePeerOverrides` 对每个插件问 registry 拿 peer，而 `publishedPeers` 在 `npm view` 失败时
**静默返回 `{}`**。一次瞬时超时就让某个 peer 改由**另一个声明同一 peer 的插件**插入 —— 集合完全
相同，**顺序与归因不同**。而 `--check` 用 `JSON.stringify` 比较，对键顺序敏感，于是门禁**间歇失败**，
报错只说 `is stale in overrides, dshPlusStandalone`，不指出差别只是顺序。

诊断 —— 连跑两次比较集合与顺序：

```sh
npx tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus --out /tmp/a.json
npx tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus --out /tmp/b.json
node -e "
const a=require('/tmp/a.json'), b=require('/tmp/b.json');
console.log('集合相同:', JSON.stringify(Object.keys(a.overrides).sort())===JSON.stringify(Object.keys(b.overrides).sort()));
console.log('顺序相同:', JSON.stringify(Object.keys(a.overrides))===JSON.stringify(Object.keys(b.overrides)));
"
```

修法：比较时**只对 `overrides` 与 `peerOverrides`** 做规范化（按 name 排序、`peerOverrides` 去掉
诊断用的 `reason`）。**不要排序一切** —— `bundles` 的顺序是装配顺序、`dependencies` 是安装顺序，
那里的变化是真实变化，必须仍被门禁捕获。

### 无 src 的插件：lib/ 就是源码

`dsh-plugins-plus` 里多数包有 `src/` 且带 `prepack: pnpm run build`，`lib/` 被 `.gitignore` 忽略。
但 `image-hoist` **没有 `src/`** —— 它的 `lib/index.js` 是手写源码、直接入库发布：

```sh
ls packages/<name>/src 2>/dev/null || echo "无 src → lib 是源码，无 prepack"
node -p "JSON.stringify(require('./packages/<name>/package.json').scripts)"
```

### 改插件前先确认哪一份是权威源码

实测：`@sparkelf/dsh-image-hoist` 在 `/root/projects/` 下有**两份副本** —— 权威源码在
`dsh-plugins-plus/packages/image-hoist/`（被 git 跟踪，带 `repository`/`scripts`/`devDependencies`），
另有一个未跟踪的散件目录（缺 `repository`，peer 范围被简化成 `"*"`）。

在散件上改动并发布了 `0.1.2` —— peer 范围降级、丢失 `repository`，harness 的
`gen-third-party-notices` 预提交钩子直接失败。版本号已消耗，只能发 `0.1.3`。

**发版前先确认权威位置**：

```sh
cd /root/projects/dsh-plugins-plus && git ls-files packages/<name> | head   # 被跟踪的才是源码
git -C /root/projects ls-files dsh-<name>                                   # 空 = 散件，不要用它发版
npm view --registry=https://registry.npmjs.org <pkg>@<version> repository peerDependencies dsh --json
```

### 生成器很慢，且写文件在最后一步

每个 override 查一次 registry，单份实测 3–5 分钟。**必须脱离会话跑**（`systemd-run`），
并在**进程真正退出后**再读文件 —— 中途读会拿到半写内容（本次因此误判过两次）：

```sh
systemd-run --collect --unit=dsh-gen-1 \
  --working-directory=/root/projects/deepseek-harness-plus \
  --setenv=PATH=/root/.nvm/versions/node/v24.18.0/bin:/usr/bin:/bin \
  bash -c 'npx tsx scripts/standalone/generate-manifest.ts ... > /tmp/gen.log 2>&1; touch /tmp/gen-done'
# 用完成标记判断，不要靠 sleep 猜
while [ ! -f /tmp/gen-done ]; do sleep 10; done
```

会话内的 `nohup ... &` **会被 supervisor 重启带走**，`systemd-run` 不会。

### 一个「修复」脚本可能什么都没修，却报成功

`dsh-plus-allow-builds` 的职责是把发行版记录的 native 构建许可写入 profile 的
`pnpm-workspace.yaml`。它**只处理已存在的 `allowBuilds:` 块**：

```js
if (changed === 0) console.log('dsh-plus-allow-builds: every entry already answered')
```

而 pnpm **只在它有话要问时才写这个块**。于是「块不存在」和「块已全部作答」在脚本看来完全一样 ——
它打印 `every entry already answered` 后**什么都不写**，紧接着的
`pnpm install` 继续以 `ERR_PNPM_IGNORED_BUILDS` 失败。

2026-10-11 实测：alpha.2 镜像**连续两次**停在这一步，日志完全一样：

```
[mirror] resolving the profile's allowBuilds placeholders
dsh-plus-allow-builds: every entry already answered
[mirror] installing again with the build decisions in place
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: koffi@3.1.1, node-pty@1.2.0-beta.15, ...
```

**判据**：脚本报成功时，核对目标文件是否真的变了：

```sh
grep -A 11 "^allowBuilds" <profile>/pnpm-workspace.yaml || echo "块不存在 —— 脚本没有写入"
```

**修法**：块不存在时从发行版整块写出，而不是只在已有块内作答。

**一般规则**：一个修复脚本报「无需修改」时，要区分「已经正确」和「它没找到目标」。
后者必须报错或主动创建，不能算成功 —— 否则它把失败推迟到下游，而下游的报错指向别处
（这里是 pnpm 的 `ERR_PNPM_IGNORED_BUILDS`，看起来像 profile 的问题，其实是修复没做）。

### 补丁升级后必须重建 hunk 行号，否则 pnpm 拒绝而 patch 接受

升级插件版本时，改目标的补丁**必须重新生成**，不能只改 `target.range`。

**为什么 `patch` 测试会骗你**：`patch(1)` 默认允许 fuzz（模糊匹配）。行号差了 3078 行时它仍报
成功，只是把 hunk 落到别处并警告：

```
Hunk #1 succeeded at 19752 with fuzz 2 (offset 3078 lines).
```

**pnpm 不允许 fuzz**，所以同一份补丁在镜像构建里直接失败：

```
[ERR_PNPM_PATCH_FAILED] Could not apply patch .../dsh-better-sidebar@0.25.0.patch
```

**验证补丁必须用零 fuzz**，这才等同于 pnpm 的严格度：

```sh
rm -rf /tmp/v && cp -r <解包的插件> /tmp/v && cd /tmp/v
patch -p1 -F 0 --dry-run < <补丁>     # -F 0 = 不许 fuzz；报 "Hunk #1 FAILED" 就是会被 pnpm 拒
```

**重新生成的方法**（a/ 是原始包，b/ 是打过补丁的）：

```sh
cd /tmp/regen
cp -r <原始包> a && cp -r <原始包> b
(cd b && patch -p1 --forward < <旧补丁>)
diff -u a/lib/x.js b/lib/x.js > raw.diff
# 加上 git 头并去掉 mtime 后缀 —— pnpm 需要 diff --git 行
```

**两个格式要求**（缺任一 pnpm 就失败，且报错不说原因）：

1. 必须有 `diff --git a/<path> b/<path>` 首行
2. `---`/`+++` 行不能带 mtime 后缀（`diff -u` 默认会加）

**判定等价**：重建前后对同一版本应用，结果文件必须**逐字节相同**：

```sh
rm -rf /tmp/rA /tmp/rB
cp -r <原始包> /tmp/rA && (cd /tmp/rA && patch -p1 --forward < <旧补丁>)
cp -r <原始包> /tmp/rB && (cd /tmp/rB && patch -p1 --forward < <新补丁>)
diff -q /tmp/rA/lib/x.js /tmp/rB/lib/x.js && echo "等价"
```

### 排查补丁失败时，先确认你的测试补丁本身是对的

我一个自制的测试补丁反复失败，结论一度跑偏到「pnpm 坏了」。真实原因是
`diff -u <绝对路径> <绝对路径>` 生成的 `---`/`+++` 行**不是 `a/`、`b/` 前缀**，
pnpm 因此拒绝——与插件版本无关。

**做法**：先用一个「只插入一行、前缀正确」的最小补丁建立基线，确认它能通过，
再拿真实补丁对比。基线不过就是环境问题，基线过了才是补丁问题。

同时注意**标记字符串别撞车**：我用 `MARKER` 做标记，而 0.25.0 里本来就有 5 处
`SETTINGS_NAV_MARKER`，于是「标记已落地」的计数完全失真，得出了相反结论。
用 `PROBE_UNIQUE_<随机>` 这类不可能撞车的字符串。

### 宿主 mirror 不会打 npm 补丁（镜像会）

DataOps 镜像用 `materialize-npm-patches.mjs` 把 `patchedDependencies` 写进 profile，
pnpm 在 install 时打补丁。**但宿主侧的 `dsh-plus-mirror` 不做这件事** ——
它把补丁目录搬进 profile（`.dsh-plus/patches/`），却不写 `patchedDependencies`，
也不跑 `dsh-plus apply`。

实测 2026-10-11：

| 部署 | better-sidebar | `mediaCwd` | `catalogRequests` |
|---|---|---|---|
| 021a5（上一个） | 0.24.1 | 3 | 3 |
| 021a2（mirror 新建） | 0.25.0 | **0** | **0** |

021a2 的 `lib/index.js` 与官方 0.25.0 **逐字节相同**（md5 `e6c2a9925acf`），
说明补丁完全没打上；而它的 `.dsh-plus/patches/` 里躺着 0.2.0-rc.23 时代的旧补丁目录
（`combined/dsh-better-sidebar%400.19.1/`），是从上一版 carry 来的残留。

**判据**（比看版本号可靠）：

```sh
P=<profile>/node_modules/dsh-better-sidebar
for pair in "lib/index.js:mediaCwd" "lib/index.js:htmlCwd" "lib/client.js:catalogRequests"; do
  f=${pair%%:*}; k=${pair##*:}
  echo "  $f $k = $(grep -c "$k" "$P/$f" 2>/dev/null || echo 0)"
done
# 全 0 且 md5 与官方包相同 = 补丁没打
md5sum "$P/lib/index.js" <(tar -xzOf <官方tgz> package/lib/index.js) 2>/dev/null | awk '{print "  "$1}'
```

**为什么 `dsh-plus apply` 用不了**：它要求一个 HEAD 等于发行版 base revision 的
官方 DSH git checkout（`--dsh-root`），registry 安装没有 checkout。

**影响评估要实测，不要从字节推断**：021a2 缺三个补丁，但侧边栏下载实测 **200**
（相对路径与绝对路径都返回文件内容），所以「Failed to fetch」不复现 ——
缺的是路径解析的边界处理，不是主路径。判定故障是否存在的依据是请求结果，不是文件 diff。

**防回归**：给镜像加断言，让补丁丢失时构建失败而不是静默通过：

```dockerfile
RUN set -eux; \
    sidebar="${DSH_INSTALL_HOME}/profiles/${DSH_PROFILE_NAME}/node_modules/dsh-better-sidebar"; \
    grep -q htmlCwd "${sidebar}/lib/index.js"; \
    grep -q mediaCwd "${sidebar}/lib/index.js"; \
    grep -q catalogRequests "${sidebar}/lib/client.js"
```
