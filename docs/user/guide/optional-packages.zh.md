# 安装可选包

[English](optional-packages.md) | 中文

Plus 随附两项能力但其单独安装：computer use 与 Exa 网络搜索提供方。它们同时出现在 `dependencies` 与 `optionalDependencies` 中，这正是"可选"的含义——发行物始终声明它们，而装不上其中之一的机器仍然能拿到其余部分。

## "可选"改变了什么

| 声明 | 作用 |
|---|---|
| `dependencies` | 该包属于本次发行，所有使用者解析到同一版本范围。 |
| `optionalDependencies` | 该包安装失败不会导致整体安装失败。 |

同时列在两处的包，像其他包一样被发行，又像原生扩展一样被容忍。安装会报告失败并继续；profile 中其他任何部分都不因它而被扣下。

## 哪些包是可选的

| 包 | 能力 |
|---|---|
| `@deepseek-ai/dsh-computer-use` | 针对桌面截图、点击与输入 |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | computer use 所对接的 CUA 驱动 MCP 服务端 |
| `@deepseek-ai/dsh-web-search-exa` | 以 Exa 作为网络搜索提供方 |

## 判断某个包是否已安装

`dsh` 通过其插件行绑定能力；安装失败的包只是没有行可供绑定。直接确认包本身：

```sh
ls "${DSH_HOME:-$HOME/.dsh}"/profiles/plus/node_modules/@deepseek-ai/dsh-computer-use
```

解析成功时该命令打印目录，未解析时报告文件不存在。**设置 → 内置插件**列出真正挂载的行。

## 显式安装某一项

```sh
dsh plugin --profile plus add @deepseek-ai/dsh-computer-use
```

`dsh plugin` 把参数转发给 profile 目录中的 pnpm，因此所有 pnpm 动词都可用，`add @scope/name@version` 可固定某一版本。

当 registry 上最新的版本不是运行时所需时，请固定版本：computer use 把当前线发布在 `next` 下、把较早的线发布在 `latest` 下，因此裸 `add` 会解析到 `latest`——一个本运行时会拒绝的版本。

## computer use 为什么需要显示器

该能力通过截图与合成输入驱动桌面，因此需要一个带显示器的会话。无头容器或后台服务没有显示器，而这个包被声明为可选，正是为了让这类部署无需修改发行物即可省略它。

## 继续

- [配置模型](./providers.zh.md)
- [使用 Web 界面](./index.zh.md)
- [子系统参考](../../subsystems/README.zh.md)
