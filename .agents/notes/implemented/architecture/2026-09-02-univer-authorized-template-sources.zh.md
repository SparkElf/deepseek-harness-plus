# Agent Note: 按来源所有权授权 Univer 模板文件

Status: implemented

[English](2026-09-02-univer-authorized-template-sources.md) | 中文

## 问题

模型可以从用户拥有的模板创建新 Univer 文件，也可以使用其它可信 Host 插件分发的只读资产。如果所有来源都限制在 session workspace，资产插件就必须增加暂存 Tool；如果接受任意绝对路径，又会暴露无关的本地文件。两种来源下，输出都必须由 workspace 拥有。

## 决策

Plus 补丁向 `dsh-univer-office@0.2.12` 回移 `univer_new.templateFile`。模型提供的目标继续位于当前 session workspace 且不覆盖。模板真实路径位于该 workspace，或位于可信 Host 插件通过 `ctx.univer.registerTemplateRoot` 注册的只读根时，才允许作为来源。

Univer Provider 拥有来源授权。它把注册根模板暂存到 workspace，委托现有 Gateway 创建最终文件，并在 Gateway 返回后删除暂存文件。资产插件通过 Cordis effect 注册根，不需要面向模型的暂存 Tool。领域模板和 Skill 不进入 core patch。

相同的通用行为会提交给上游 `dsh-univer-office`；在正式上游版本同时包含 alpha.2 兼容和已授权模板创建前，Plus package 保持 exact alpha.2 回移。

## 曾考虑的替代方案

- **允许任意绝对模板路径。** 不采用，因为复制模板会授予对其完整内容的读取权限。
- **要求每个资产插件暴露暂存 Tool。** 不采用，因为每个插件都会重复 workspace 复制、清理和错误行为。
- **使用模板 ID 和元数据 Registry。** 本次不采用，因为可信目录注册保留直接路径，不需要引入另一套用户可见 ID 系统。

## 后果

- 已在 workspace 中的用户和 Agent 模板继续使用直接路径。
- 可信资产插件只需一次可撤销根注册即可保持资产加 Skill 形态，不需要 Tool。
- Gateway 继续是最终 `.univer` 创建和不覆盖语义的唯一 owner。
- 注册的来源目录只能包含允许模型读取的模板资产。
