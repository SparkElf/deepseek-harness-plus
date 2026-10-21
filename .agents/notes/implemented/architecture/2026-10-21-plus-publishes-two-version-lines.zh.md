# Agent Note：Plus 家族发布两条版本线

Status: implemented

[English](2026-10-21-plus-publishes-two-version-lines.md) | 中文

## Problem

`PlusFamily` 继承了 `DshFamily` 的 `verifyVersions`，该规则要求每个成员同版本。这条规则对官方包是对的——一个 tag 命名一个源码版本。但对本家族是错的，因为它发布两类工件，而两类工件的版本回答两个不同问题。

补丁包的版本命名它所补的运行时。`dshPatch.variants[].dsh` 范围和 `target.baseRevision` 已经精确承载这个绑定；版本号是同一事实的人类可读形式，随运行时移动而前进。发行版包的版本命名本家族自己的发布。把两者绑在一起，意味着发行版只能通过把每个补丁包挪到一个错误描述其所补对象的新版本来发布。

代价已经在支付。`0.2.1-rc.2` 针对 rc.2 运行时发布了 28 个补丁包，而 `packages/bundle/plus` 停在 `0.2.1-alpha.31`，于是 `bump.ts` 和 `pack.ts` 双双中止，`0.2.1-alpha.31` 是由手工 `chore(release)` 提交记录的，而不是由发布路径切出的。读 `dsh-plus@0.2.1-alpha.31` 的人无法判断它打包的是哪个运行时，而下一次发布已经无号可用：共享号已发布，补丁包又动不了。

## Decision

`PlusFamily` 覆盖 `verifyVersions` 并接受独立版本，只拒绝本仓库无法发布的版本号。发行版跟随它所打包的运行时：`0.2.1-rc.2` 命名 rc.2 交付线，同一运行时下的变更把第四段推进为 `0.2.1-rc.2.1`。补丁包版本继续命名运行时。

两个事实使这是唯一可行的写法。`0.2.1-rc.2` 已为 28 个补丁包发布，因此仅发行版变更在该线上没有可用版本号。并且 semver 把 `0.2.1-rc.2.1` 排在 `0.2.1-rc.2` 之上、`0.2.1-rc.3` 之下，而连字符写法如 `0.2.1-rc.2-0.2.1` 做不到：它的预发布标识按 `["rc", "2-0", 2, 1]` 比较，排在 `0.2.1-rc.3` **之后**，等下一个运行时发布后既不满足 `>=0.2.1-rc.2` 也不满足 `^0.2.1-rc.2`。

## Alternatives considered

**两条线共用一个版本。** 这正是继承来的规则所要求的。它迫使每个补丁包为它并不承载的变更重发，并且在共享号发布后不给仅发行版的发布留下任何版本——正是本家族当时所处的状态。

**连字符第四段（`0.2.1-rc.2-0.2.1`）。** 它读作「rc.2 下的第 N 个发布」，正是想要的含义，但上面的排序使它不可用：后续运行时的 `0.2.1-rc.3` 排在它**之下**，于是范围会优先解析到过期的已打补丁构建，而不是新运行时。

**手工记录发行版清单。** 这是 `0.2.1-alpha.31` 的产生方式。它让发布不可复现，并跳过 `bump.ts` 与 `pack.ts` 运行的 gate，本家族出现四个并存版本（rc.2、alpha.29、alpha.30、alpha.31）就是这样来的。

## Consequences

一次发行版发布不再触碰 28 个补丁包，因此其打包集是 36 个 tarball 而非 37 个，未改动的补丁包按内容跳过而不是重发。

补丁与其运行时的绑定现在完全由 `dshPatch` 承载，材料化器正是从那里读取，因此版本号与目标漂移的补丁仍能正确应用，而目标移动了却没跟上的补丁会在安装时响亮失败。

`verifyVersions` 不再捕获滞留在旧版本的发行版成员。没有东西取代这项检查：`verify:plus-governance` 覆盖 profile 组成、补丁声明、源码基线和 curation，不覆盖发行版成员之间的版本一致性。

## Verification

`release:local --family plus` 打包 36 个 tarball，`verify-packed-install` 报告两个安装器均为 `0.2.1-rc.2.1`，随后 `verify-published` 确认每个成员都可被提供且 `latest` 解析到它。`verify:plus-governance`、`verify:standalone-manifest`、`verify:standalone-variants` 通过。28 个未改动的补丁包以 "already published with identical content" 跳过形式发布。