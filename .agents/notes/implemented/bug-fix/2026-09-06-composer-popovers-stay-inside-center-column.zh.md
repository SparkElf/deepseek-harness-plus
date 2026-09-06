# Agent Note: Composer弹层保持在center column内

Status: implemented

[English](2026-09-06-composer-popovers-stay-inside-center-column.md) | 中文

## Problem

Composer的permission与model menu把trigger和browser viewport作为水平定位参考。collapsed navigation rail仍占用viewport左缘，因此menu可能满足viewport margin却跨进rail。breakpoint-specific alignment change只能把menu移到trigger另一侧，既没有定义可用水平区间，也无法在该区间小于design width时缩小menu。

## Decision

Portaled composer menu使用带`data-dsh-center-col`标记的center column作为可选horizontal placement limit。`Menu`与`useAnchoredPosition`将该element rectangle与viewport取交集，在两个水平边缘各保留12px，把measured menu钳制到剩余区间，并把该区间作为menu maximum width。`Menu`还会在必要时降低design minimum width。Permission与model menu始终使用fixed body portal；compact mode只控制dimensions，不决定是否启用collision handling。

未提供horizontal limit时，shared primitives继续使用viewport placement，包括[feedback popover decision](2026-08-13-feedback-note-editor-popover.zh.md)描述的feedback editor behavior。`ResizeObserver`跟踪已提供的limit，因此sidebar或column width变化会重新定位open menu，无需等待window resize。

Plus mobile Web source patch拥有相对official revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`所需的`ui-primitives`、`ui-conversation`与`ui-model-selection`改动。

## Alternatives considered

**只钳制到browser viewport。** 这能防止pixel超出屏幕，但会把navigation rail当作可用overlay space，无法解决可见缺陷。

**在breakpoint处从start alignment切换到end alignment。** Alignment只选择trigger的初始一侧，不能表达center column的两个边缘，并会在breakpoint变化时产生不连续位移。

**使用composer card作为horizontal limit。** Card带有额外content padding，并可能明显窄于可用center column，从而造成不必要的menu truncation。Center column的左缘就是rail boundary，右缘就是application boundary。

## Consequences

空间充足时menu仍靠近trigger，但当trigger-aligned rectangle跨过任一边缘时，center column优先。极窄width下，两个menu都会缩小到同一可用区间，而不会覆盖navigation。Shared placement API增加optional element reference与end alignment；省略reference的caller继续保持viewport behavior。

Plus Playwright系统验收会在390x844打开两个composer menu，并把其browser rectangle与真实center column比较。现有runner继续强制执行console、page、request与HTTP diagnostics。
