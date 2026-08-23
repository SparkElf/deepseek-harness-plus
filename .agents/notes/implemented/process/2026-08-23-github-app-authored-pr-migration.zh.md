# Agent Note: 使用 GitHub App 重建 Pull Request

Status: implemented

[English](2026-08-23-github-app-authored-pr-migration.md) | 中文

## Problem

创建PR的管理员不能批准自己创建的PR。作者是管理员的PR会被要求Code Owner审批的规则阻塞。

## Decision

使用已安装的GitHub App创建替代PR。替代分支指向原PR的head提交，并保留原base分支、标题、正文和代码内容。确认替代PR存在后才关闭源PR，然后由仓库管理员使用普通用户账号批准替代PR。本流程不会合并目标分支。

已经Merged或已经Closed的PR是不可变历史记录，不会被重建，也不会删除其源分支。

## Alternatives considered

**使用管理员bypass。** Bypass可以绕过审批直接合并，但不会产生审批记录，也不保留仓库的Review约束。

**增加第二个管理员。** 第二个管理员可以批准作者PR，但安装App可以解决PR作者身份问题，不需要为此增加专用人工账号。

**让GitHub App成为Code Owner。** App安装身份不能作为CODEOWNERS条目。仓库管理员仍然是Code Owner和审批人。

## Consequences

每个迁移项会同时保留一个关闭的源PR和一个开放的替代PR。替代PR保留原分支关系和提交内容。替代PR仍需通过Required Checks；仅有审批不会使PR自动可合并。Installation Token是短期凭据，必须在本机由仓库外的私钥生成。

## Verification

迁移会比较源PR和替代PR的head SHA、base分支、标题和正文，并验证App作者、管理员审批、源PR关闭以及没有合并目标分支。
