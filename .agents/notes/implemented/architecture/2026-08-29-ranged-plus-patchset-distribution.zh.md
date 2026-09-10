# Agent Note：功能等价的Plus npm发行层

Status: implemented

[English](2026-08-29-ranged-plus-patchset-distribution.md) | 中文

## Problem

DeepSeek Harness Plus组合official DSH、selected external plugins、product defaults与temporary repairs。Fork commit集合或settings-only package无法复原该产品，也可能在official DSH接管功能后继续保留重复实现。Official DSH必须保持唯一source base，每个accepted difference必须有一个current owner与retirement condition。

## Decision

Plus使用四种delivery form。完整capability是包含所需全部Host与Client role的npm-installable Cordis plugin。可选out-of-process application消费这些capability，但不进入DSH process。@sparkelf/dsh-plus拥有dependency closure、ordered profile composition、defaults、exact source compatibility及independent patch package references。经过证明的official或external gap成为一个data-only patch package，只有一个exact payload variant，不包含JavaScript entry、lifecycle hook、Cordis plugin、fuzzy fallback或compatibility adapter。

rc.25 distribution以official DSH 0.1.5-rc.1 revision 183f08e9c6dde7e36cd2318eaee70b0da08fb35e为target。dsh-plus apply要求该exact checkout，在isolated Git index中验证全部source patch，安装profile dependencies，应用pending payload，构建official source，把official workspace packages链接到profile，并写credential-free .dsh-plus/patchset.lock.json。

Profile installation不自动安装official peer packages，因为selected source checkout提供这些package。普通Plus capability package（包括SQL Workbench 0.5.0）从npm解析；profile不再包含普通GitHub tarball closure或source-owned package override。Production upgrade policy为accepted profile与candidate之间每个runtime file变化记录fingerprint。

## Official ownership and patch retirement

Official DSH拥有Sidebar navigation、file与text preview、Session search、responsive columns、Settings chrome及Composer结构。Plus不携带Better Sidebar、旧Sidebar Office viewer、video-preview bundle、重复Session-search实现或宽泛mobile-layout patch。聚焦的composer-boundary patch只修改center-column标记与Permission/Model portal定位，并在其upstream贡献发布后retire。

Package manifest是当前plugin与patch inventory。每次review删除重复official behavior或没有accepted Plus workflow的package、patch hunk、profile row、test或document。Patch可以增加、修改或删除target package source；其单位是一个behavior与retirement lifecycle，而不是diff方向或大小。

## Alternatives considered

**把selected fork commits作为产品。** 拒绝，因为fork会成为隐式第二source base，deployment closure无法识别已retire behavior。

**保留宽泛patch并机械修复冲突。** 拒绝，因为clean apply不能证明owner没有重复。DSH 0.1.5迁移直接删除旧Sidebar、Session-search及mobile-layout实现，而不是rebase它们。

**把全部patch放入distribution package。** 拒绝，因为无关repair会共享同一个release与retirement lifecycle。

**让Desktop持有materialization。** 拒绝，因为npm/profile路径是产品合同；Desktop只是可选installer，并且只打包否则需要用户编译环境的native dependency。

## Consequences

Official baseline merge会带入upstream `.github/`树，因此仓库自己的CI customization必须跨merge保留：仓库保留自身的workflow runner选择、job集合与required-check aggregate，而不是upstream baseline副本。静默恢复upstream workflow的baseline merge会加入upstream-only job并丢掉repository-only job，从而改变pull-request verdict。Official baseline merge同时会取用upstream release family源码，因此每个official family都必须保留自己的package-name ownership predicate：official family只拥有`@deepseek-ai`名称并跳过并存于同一路径的Plus package，Plus family则在自身path patterns下拥有`@sparkelf`名称。丢失该predicate的family会拒绝另一authority的manifest，导致pack与verify job失败。Plus升级需要exact official revision与fresh profile证明。未发布npm的external package保持为固定reviewed release asset。Official升级可能改变数百个package fingerprint，因此promotion policy从真实baseline与candidate profile生成，不复制旧policy。删除冗余plugin会缩小dependency graph，并把official UI extension points留给新的focused plugin。

## Verification

Candidate verification从exact official checkout开始，在没有historical cache ownership的情况下安装rc.25 profile，运行explicit apply，完成official Host/Client/Web build，并验证生成的production profile policy。每次profile修改后都必须重新打包distribution，并在clean checkout重新运行apply；安装失败后的重试必须重新执行幂等pnpm install，不能因为requirements未变而跳过恢复。源码同步使用完整文件读取或Git index校验，禁止用截断输出覆盖源码；clean build aggregate必须显式引用每个有clientBundle配置的Plus package。既有Plus Playwright suite通过真实browser验收official Sidebar与Session search、Backup、Subagent Settings、OfficeCLI、MinerU、DataOps、market与Supervisor integrations、Session export placement及composer Permission/Model boundaries。Official baseline merge后，Plus release family仍由显式release-pack owner负责；Plus Web setup通过pnpm lifecycle调用它，使pack脚本获得npm_execpath，并区分ordinary profile dependencies与Cordis bundles。Linux filemanager icon等known optional host resource只有在official Host catalog声明资源不存在时才加入scoped diagnostic allowance。Platform CI负责Windows、Linux与macOS package behavior；Desktop只打包需要编译环境的native dependency。
