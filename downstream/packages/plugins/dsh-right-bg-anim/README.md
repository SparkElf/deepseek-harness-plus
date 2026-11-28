# dsh-right-bg-anim

> 由 SparkElf 作为 DSH Plus 自有插件维护，源码位于 [deepseek-harness-plus](https://github.com/SparkElf/deepseek-harness-plus) 的 `downstream/packages/plugins/dsh-right-bg-anim`。

DSH 装饰插件：**只在新会话的主内容区（侧边栏右侧）叠加一层透明流体动画**，其余界面全部保持官方原样。

## 效果

- **流体薄膜**：WebGL2 实时流体，随鼠标方向、速度产生水波、卷曲与渐进恢复。
- **弹性网格**：鼠标靠近时推开节点、拉伸连线，静止后自动休眠。
- **明暗双主题**：跟随宿主 `body[data-ds-dark-theme]`，切换主题即时重算配色，无需刷新。
- **只在新建会话显示**：进入已有对话后自动隐藏，官方背景原样恢复。

## 两种合成模式（设置页可切换）

| 模式 | 做法 | 观感 |
| --- | --- | --- |
| **玻璃薄膜**（默认） | 半透明着色薄片叠加在背景上，官方底色仍占主导 | 玻璃质感、可见度可调 |
| **调制雾感** | 自身不带颜色，用 `mix-blend-mode: soft-light` 只调制背景明暗 | 雾气拂过页面 |

> 实测约束：`soft-light` 在**两个极端底色上都不响应**——官方深色底 `#151517` 上中灰仅移动约 1.6/255，纯白底 `#ffffff` 上几乎为 0。所以单一混合模式无法同时服务两套主题：深色底用 `soft-light` **提亮**（0xD8 ≈ +19.9），浅色底改用 `multiply` **压暗**（0x60 ≈ −127），色阶随之取反。这是本插件显式处理的适配点。

## 设置项

设置 → 通用 → **新会话背景动画**：

- 启用开关
- 效果模式：玻璃薄膜 / 调制雾感
- 明显程度：玻璃模式=薄膜不透明度；调制模式=雾感强度
- 网格强度：0–3
- 流动速度：0.2–3

**参数按「模式 × 主题」分别记忆**。两种模式所需的量级相差一个数量级（玻璃约 0.04 就够，调制在深色底需要约 0.48 才可见），共用一个值会在切换时错位，因此：

- 切换模式 → 落到该模式上次用过的值（首次即该模式默认值）；
- 切换明暗主题 → 各自保留，互不覆盖。

默认值：

| 模式 | 深色 | 浅色 |
| --- | --- | --- |
| 玻璃薄膜 | 0.04 | 0.04 |
| 调制雾感 | **0.48** | 0.1 |
| 网格强度 | 1 | 1.8 |

> 浅色主题下 `multiply` 作用在白底上比深色下的 `soft-light` 强得多，因此浅色的雾感默认取较轻的 0.1，并把网格加粗到 1.8 作为主要可见元素。

## 安装

```bash
dsh plugin --profile <你的profile> add dsh-right-bg-anim
```

安装后刷新页面即可。

## 它刻意不做的事

- ❌ 不覆盖任何官方 CSS（上游主题插件的 89 条全局规则全部丢弃）
- ❌ 不覆盖 `--dsw-*` token，不锁定深色
- ❌ 不修改侧边栏、输入框、按钮、弹窗
- ❌ 无鱼儿动画

## 目录

```text
src/
  client.js               # 客户端入口：样式、挂层、阶段/主题观察、设置行
  css.js                  # 唯一一份样式（图层 + 设置行）
  settings.js             # 设置存储与默认值
  wallpaper-profile.js    # 双模式配色：按明暗主题与参数现算
  anim/
    interaction-sources.js  # 指针源，归一化到容器坐标
    pointer-field.js        # WebGL2 流体 host 侧
    fluid-shaders.js        # 流体着色器
    fluid-profile.js        # 流体运动参数
    elastic-grid.js         # Canvas2D 弹性网格
    elastic-grid-profile.js # 网格参数
scripts/build.mjs         # 零依赖单文件打包（含重名守卫）
lib/                      # 构建产物
```

## 构建

```bash
node scripts/build.mjs
```

## 致谢

动画算法 fork 自 [dsh-official-homepage-theme](https://github.com/JohnnyTing/dsh-official-homepage-theme)@1.0.7（MIT）。本项目的改动集中在容器化（限制在右侧主内容区）、透明化、去主题化与参数化。

## License

MIT