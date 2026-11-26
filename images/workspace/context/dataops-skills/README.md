# dataops-skills（翻译目录）

本目录随镜像复制到 `/opt/dataops-skills`，由 profile 的 `translationRoot` 读取。技能中心只读取
`<skill>/i18n/zh.json` 这三个字段：`title`、`description`、`summary`；技能正文来自已安装插件在
`SKILL.md` 旁提供的资源，不从这里读取。

- 只有 `i18n/zh.json` 的技能目录是正常的；不要为了“看起来完整”再手工复制一份 `SKILL.md`。
- 合并后的 canonical 技能：`browser`、`knowledge-base`、`memory`；对应的正文在
  `dsh-plugins-plus/packages/dataops-managed/skills/browser/` 与
  `dsh-plugins-plus/packages/knowledge-base/{SKILL.md,references/,skills/memory/}`。
- `dataops-collect/` 目前仍保留完整 `SKILL.md`，因为它受其他改动保护；迁移前不要删除。
- 新增翻译时只加 `<skill>/i18n/zh.json`，并把 `i18n/.progress.json` 的 `total`/`done` 一起更新。