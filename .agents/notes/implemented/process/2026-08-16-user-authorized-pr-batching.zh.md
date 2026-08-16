# Agent Note: User-authorized pull request batching

Status: implemented

[English](2026-08-16-user-authorized-pr-batching.md) | 中文

## Problem

每项改动完成后都创建 pull request，会在用户选择 review boundary 前拆散相关工作。Candidate branch、验证通过或 push 只记录工程进度，并不表示用户希望开始 GitHub review。

## Decision

PR authoring workflow 只有在用户明确要求汇总改动提 PR、指定 PR unit 或要求 release integration 后，才创建新 pull request。Implementation、review、verification、完成的 candidate 和 push 请求都会让工作继续留在 candidate 或 aggregate branch。

用户要求 consolidated PR 时，author 先盘点已接受改动，并按用户指定的 review boundary 分组。已有 selected PR 仍要同步其拥有的完整工作；本规则不允许用 replacement PR 代替它们，也不允许保留 stale remote head。

## Alternatives considered

**每项完成的改动都创建一个 pull request。** 这会让 implementation cadence 决定 review topology，并迫使用户事后整理 GitHub 状态。

**没有字面命令就绝不创建 pull request。** Release integration 和用户指定的 PR unit 已经表达同一项明确意图；要求唯一固定措辞只会增加步骤，不会让 ownership 更清楚。

## Consequences

Candidate branch 可以在发布前包含多项已接受改动。用户决定这些工作何时成为 review unit；已有 PR 同步与 branch cleanup 仍是独立的必需流程。
