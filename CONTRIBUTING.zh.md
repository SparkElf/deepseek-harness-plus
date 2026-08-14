# 参与贡献

[English](CONTRIBUTING.md)

DeepSeek Harness Plus 接受能够改善可靠性、部署、预设、文档和开发体验的社区贡献。

## 选择合适入口

- 产品方向、预设提案和运行模型问题请使用 **Discussions**。
- 可复现缺陷和范围明确的功能请求请使用 **Issues**。
- 聚焦且便于审查的改动请通过 **Pull Requests** 提交，并附带文档和相关验证证据。
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 的方式私下报告。

## Pull Request

每个 Pull Request 应聚焦一项用户可见能力、运行修复或文档改进。请说明问题、可观察结果和已执行的检查。修改预设时，必须同时提供配置、权限模型、凭据要求、安装路径和验证说明。

不要提交模型凭据、数据库凭据、客户数据、会话日志或生成的构建产物。同步 DeepSeek Harness 代码时，请保留上游许可证和第三方声明。

## 标签与审查

维护者使用 `kind/*` 和 `area/*` 标签分派工作。可通过 `good first issue` 和 `help wanted` 查找已有 owner 和明确范围的贡献。合并前，维护者会审查权限、部署影响、文档和验证证据。

## 开发

请遵循 [AGENTS.md](AGENTS.md)、[docs/development.md](docs/development.md) 和所改文件目录中的专属说明。
