# OfficeCLI DOCX 样式包

OfficeCLI 没有全局样式包、默认模板或 `config` 切换入口：`create` 只写 Word 基线，`merge`
只替换 `{{key}}`，`style` 只改单个文档的 `/styles`。所以这里用「模板 DOCX + `officecli-create`
包装器」提供默认版式。

## 目录

```text
officecli/
├── bin/officecli-create          # 创建 DOCX：默认复制 gbt9704-2012，--style-pack 切换
├── build-style-packs.mjs         # 重新生成模板（可重复执行）
├── check-style-packs.mjs         # 回归检查：颜色、字体、页边距、docGrid、--force 重开
└── style-packs/
    ├── gbt9704-2012/            # 默认：普通公文
    ├── gbt9704-letter/          # 函：主送/落款/成文日期/附件说明
    ├── gbt9704-minutes/         # 纪要：标题下日期/分送/版记
    └── red-header/              # 红头：发文机关标志/发文字号/红线/版记
```

镜像里复制到 `/opt/officecli/`，并安装 `/usr/local/bin/officecli-create`。DSH 插件
`@sparkelf/dsh-officecli` 默认从 `/opt/officecli/style-packs` 读取；可用
`OFFICECLI_STYLE_PACKS_DIR` 指向其他目录。

## 用法

```bash
officecli-create 通知.docx                       # 默认 gbt9704-2012
officecli-create 函.docx --style-pack gbt9704-letter
officecli-create 纪要.docx --style-pack gbt9704-minutes
officecli-create 红头.docx --style-pack red-header
officecli-create 通知.docx --force               # 覆盖已有文件（会先释放 resident）
officecli-create --list
```

创建后继续用 `officecli` 编辑同一个路径：

```bash
officecli add 通知.docx /body --type paragraph --prop style=Heading1 --prop 'text=一、核心结论（执行摘要）'
```

## 模板内容

`gbt9704-2012`：

- A4；上 37 mm / 下 35 mm / 左 28 mm / 右 26 mm；`docGrid type=lines linePitch=578`（22 行）。
- `Normal`：三号仿宋_GB2312（16 pt），固定行距 28.9 pt，首行缩进 2 字。
- `Title`：二号方正小标宋简体（22 pt），居中。
- `Heading1`：三号黑体；`Heading2`：三号楷体_GB2312；`Heading3`–`Heading6`：三号仿宋加粗。
- `Title` / `Heading1`–`Heading6` 全部 `w:color=000000`，无 `themeColor`。
- 页脚 `— n —`：四号宋体，单页右、双页左。

`gbt9704-letter` 额外提供 `ZhuSong`（主送机关，顶格）、`LuoKuan`（落款，右对齐）、
`ChengWenRiQi`（成文日期，右对齐）、`FuJianShuoMing`（附件说明）；无红头/发文字号/红线。

`gbt9704-minutes` 额外提供 `JiYaoDate`（标题下成文日期，居中）、`JiYaoFenSong`（分送）、
`BanJi`（版记，上下黑色边框）；无红头/发文字号/红线。

`red-header` 额外提供 `FawenJiguan`（红色发文机关标志）、`FawenZihao`（发文字号）、
`HongXian`（红色分隔线）、`BanJi`（版记）。

## 重新生成 / 验证

```bash
node build-style-packs.mjs --binary /path/to/officecli
node check-style-packs.mjs --binary /path/to/officecli
```

`check-style-packs.mjs` 断言模板与生成件无 `themeColor`/蓝色，`Title`/`Heading1`–`Heading6`
颜色为 `000000`，字体/页边距/docGrid 正确，并覆盖 `--force` 覆盖 live resident 的回归。