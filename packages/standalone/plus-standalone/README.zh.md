---
description: "DeepSeek Harness Plus 的 registry 安装入口：pin runtime 与全部受审 plugin，并携带生成的挂载顺序。"
kind: "package-reference"
---

# @sparkelf/dsh-plus-standalone

[English](README.md) | 中文

从 registry 安装 DeepSeek Harness Plus，无需 source checkout、无需构建、无需 git 即可到达浏览器 UI。

## 目录

- [使用此软件包](#use-this-package)
- [模型体验](#model-experience)
- [已知限制和延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 概述

一次 `npm install` 带来 official runtime、Plus distribution 与全部受审 plugin。随后 `dsh-plus start` 写出 launcher 启动所需的 profile、选择空闲端口、启动 server 并打印 URL。其余命令覆盖 launcher 留给用户的部分：stop、status、update 与 doctor 检查。该 package 是一份 manifest，其 dependencies 与 bundle 顺序由 distribution 生成，因此加入其中的 plugin 不可能只进入 distribution 而不进入这里的挂载顺序。

<a id="use-this-package"></a>
## 使用此软件包

```sh
npm install -g @sparkelf/dsh-plus-standalone
dsh-plus start
```

| Command | Effect |
|---|---|
| `dsh-plus start` | 首次运行写出 profile、选择空闲端口、启动 server、打印 URL |
| `dsh-plus stop` | 在 grace period 内结束后台 server |
| `dsh-plus status` | 报告 server 是否运行及端口 |
| `dsh-plus update` | 移到更新的已发布 release；`--check` 只报告不安装 |
| `dsh-plus doctor` | 检查 Node、distribution、profile 与端口 |

<a id="model-experience"></a>
## 模型体验

### Standalone installation

#### What the model sees

Nothing。`@sparkelf/dsh-plus-standalone` 选择 profile 挂载的 runtime 与 plugins；它自身不注册任何 tool、prompt section 或 Session event。model 只会遇到被挂载 plugins 所暴露的内容。

#### Token effect

Zero。该 package 不增加任何 model-request tokens。

#### KV Cache effect

None。它不贡献 prompt 内容，因此无法移动 cache prefix。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制和延期工作

No invariant companion is published because 该 package 只选择其它 package、自身不观察任何关系。

- `dsh-plus update` 会修改 profile 并重装，但正在运行的 server 保持其启动时的版本；restart 才会加载新 release。
- manifest 为三个已发布 plugin 携带 peer overrides，它们声明的范围无法匹配所交付的 runtime。overrides 是推导出来的，plugin 修正其范围后即消失；在那之前该 plugin 自己声明的范围仍未被满足。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

本 Dev Note 是维护者的工作上下文；已交付行为、限制与理由位于上文各节、package code 与所链接的 Agent Note。

- [独立发行版 Agent Note](../../../.agents/notes/proposed/feature/2026-09-11-standalone-distribution.zh.md) 负责安装决策；`package.json` 与 [`packages/bundle/plus/`](../../bundle/plus/README.zh.md) 中的 `dsh-plus` command 负责当前行为。
- 用 `pnpm exec tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus --out packages/standalone/plus-standalone/package.json --runtime-version <version>` 重新生成该 manifest；它会重写派生字段并保留身份字段。

</details>
