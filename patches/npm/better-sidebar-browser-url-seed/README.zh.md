# @sparkelf/dsh-patch-better-sidebar-browser-url-seed

[English](README.md) | 中文

这个纯数据包给 `dsh-better-sidebar@0.19.1` 打补丁。点击对话中的外部链接会打开侧边栏的浏览器标签，但地址栏是空的：标签记录从未拿到该链接的 URL。

三处把它丢了。`openTab` 为原生承载面构造标签记录时，只从 seed 复制了 `path` 与 `diff`，忽略了 `url`；原生标签适配器在首次打开铸造记录时同样如此；而在导航一个已存在的记录时，它把 URL 存进了 `meta.url` —— 一个没有任何视图读取的字段。浏览器视图从 `tab.path` 取地址、并把导航写回同一字段，因此这三处都让地址栏空着。

载荷只改 `lib/client.js`。每处现在把 `path ?? url` 归到 `path`，也就是浏览器视图本就拥有的那个字段，并删掉了已死的 `meta.url` 副本。那对括号是刻意的：`??` 的优先级比 `===` 低，不加括号会把存在的 `path` 送进空对象分支从而丢失。

## Model Experience

无。本补丁改变的是一个已经传入的 URL 落在哪个字段；没有模型可见的输入、工具结果、提示词或会话事件发生变化。

## Known Limitations and Deferred Work

- **本补丁钉住 `dsh-better-sidebar@0.19.1`。** 后续版本若自行承载 URL seed，本补丁会变得多余而非错误；届时退役它。
- **只覆盖原生右侧栏这条路径。** 底部工作台的打开已经把 URL 归到 `path`，因此无需改动；将来若出现第三个承载面，需要同样处理。
