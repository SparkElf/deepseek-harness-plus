# Agent Note: 以 fail-open 方式选择拉取请求 CI 影响范围

Status: implemented

[English](2026-08-22-fail-open-pr-ci-impact.md) | 中文

## 问题

required 拉取请求工作流会为每项源码改动运行全仓覆盖率、构建产物消费方、另外两个 Node 版本、Python release 检查、Wine 与原生 Windows。多数 workspace 没有独立 test 或 build target，因此仅靠包依赖图无法缩小这些根级聚合任务。局部 Client 呈现改动也会因此承担无关的 Host、Python 与平台约定成本。

改动路径仍不是充分证据。Client 插件通过动态组合进入交付的 Web 应用，浏览器用例不会静态导入它所覆盖的每个包；manifest、编译器 face、生成约定、Cordis 配置、Loader、产物与 release 输入也可能影响路径子树之外的消费方。若选择器猜测这些关系，required 作业的错误跳过可能隐藏回归。

## 决策

CI 工作流会在启动拉取请求作业前解析一份影响范围 plan。[scripts/resolve-ci-impact.mjs](../../../../scripts/resolve-ci-impact.mjs) 在关闭 rename detection 的情况下比较拉取请求 merge base 与 head，对 Git status/path 对分类，并输出供 GitHub Actions 消费的作业模式。每个拉取请求都会运行静态检查 lane。

选择器有三种模式。**docs** 只接受文档新增或修改，并跳过覆盖率、浏览器、兼容性、Python 与 Windows 作业。**client** 只接受明确映射的 Client 包中 src 与 tests 下的新增或修改，以及具名 Web 浏览器用例和文档；它运行 Vitest 的 changed-test discovery，把覆盖率限制到改动的 TypeScript，构建一次 official 产物，校验 built package，运行 lint 与 duplication，并通过既有有界 runner 执行映射中的浏览器文件且保持其串行 owner。**full** 保留全仓覆盖率、consumer、Node 兼容性、Python、Wine 与原生 Windows 作业。

删除或其他结构性 Git status、空改动集、manifest 或配置文件、未映射的 Client 包、非 Client 生产代码、CI 或仓库脚本、混合运行时区域及无效输入都会选择 **full** 或使 planner 失败。required aggregate 了解每个被选择的作业，仅当 plan 明确选择跳过时才接受 skipped；被选择的作业若 skipped、cancelled 或 failed，aggregate 会失败。因此 planner、workflow、映射或 aggregate 自身的改动会获得完整拉取请求矩阵。

Client 映射为每个可使用增量模式的包列出 [apps/web/tests](../../../../apps/web/tests) 下的浏览器文件。把包加入映射是一项测试所有权决策：列表要覆盖消费该包的每条稳定浏览器流程；在所有权能够可靠说明前，共享组合包保持未映射。显式改动的浏览器用例只选择自身；共享 Web support 与应用源码选择 **full**。

默认分支的 nightly 运行会强制选择 **full**，不依赖改动路径。它保留完整的跨平台与 release-shaped 信号，同时避免在每次 master push 上增加完整托管矩阵。

## 考虑过的替代方案

**引入 Nx affected execution。** Nx 可以发现 pnpm project，并推断部分 TypeScript、Vite 与 Vitest 任务，但仓库的测试和构建仍是根级聚合任务，tsdown 没有第一方 Nx inference，动态 Cordis 与 Client 关系仍需要自有图规则。Nx 要先引入第二套编排层，之后才能提供此选择器的有限收益。

**使用既有 change-scope 报告作为 planner 输入。** [显式范围报告](../process/2026-07-27-explicit-change-scope-report.md)通过 TypeScript 命令负责本地 committed、staged、unstaged 与 untracked 证据。CI 只需要依赖安装前的 committed merge-base 范围；在选择作业前安装 workspace 依赖会给每条 lane 增加延迟。因此 CI planner 保留一个窄范围、零依赖的 committed-diff reader，而 change-scope 继续负责更丰富的本地证据。

**只使用 GitHub path filter。** Workflow path 可以抑制作业，但不能表达 Git status、经过评审的包到浏览器用例关系、改动文件覆盖率，或由 aggregate 校验有意跳过。分散的 filter 也会产生多个策略 owner。

**每个拉取请求都保留完整矩阵。** 此方案的选择风险最低，但会让无关平台与 release 约定占用最长 lane，延迟局部 Client 改动和文档的反馈。

**从 import 推断所有受影响的浏览器用例。** 构建后的 Web 用例覆盖动态插件组合，不会导入每个所属 Client 包。静态 import 可达性会在浏览器 lane 要保护的组装行为上产生假阴性。

## 后果

文档拉取请求在静态 lane 后完成。符合条件的 Client 改动保留改动 TypeScript 文件的按文件 100% 覆盖率和选定的真实浏览器行为，同时避免无关的兼容性、Python 与 Windows 工作。高影响和未知改动保留既有的完整拉取请求证据，nightly full 运行则保留广泛的漂移检测。

显式映射属于正确性基础设施，需要承担评审成本。不完整映射可能把未选择的浏览器回归推迟到 nightly full 运行，因此共享包保持 fail-open，扩展映射需要浏览器测试 owner 提供证据。此方案有意接受比通用 project graph 更少的自动范围，换取一个小型、可检查的策略 owner，并避免新增任务框架。
