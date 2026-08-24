# @deepseek-ai/dsh-client-ui-attachment

[English](README.md) | 中文

对话 UI 的动态附件呈现插件。它通过 `ctx.slots.inject` 等待 conversation 包声明 `conversation.input.attachments` 与 `conversation.message.images`，随后注册混合输入区附件栏、整页文件拖放呈现、持久历史图片画廊和原图灯箱。conversation 持有方提供浏览器草稿记录、回调、图片加载能力以及命名空间翻译器；呈现组件保持纯 props，且不从包入口导出。

## 附件栏

`AttachmentRail` 是一条可横向滚动的混合附件栏。待发送图片继续使用已有的固定 64px 缩略图卡片，并支持单击查看原图。待发送文档使用更宽的紧凑卡片，显示文件名、文件类型标签和人类可读大小；文档卡片不会假装能够预览或解析正文。两类条目共用相同的删除控制与溢出行为。

滚动条始终隐藏，溢出由两端圆形箭头提示。每个箭头按一个视口减去一张上下文卡片的距离翻页（下限 200px），除非用户请求减少动画，否则使用平滑滚动。箭头显隐会在滚动、条目数量变化和 rail ResizeObserver 变化时重算。带纵向分量的滚轮事件会被消费并转成有界横向移动，因此不会同时滚动输入区背后的会话；纯横向平移保持原生行为。新增条目会展示栏尾，删除则保持当前位置。

## 输入区拖放呈现

`ComposerAttachments` 监听本 slot entry 持有的 document 级文件拖拽。文件会按类型分流：栅格图片转给已有图片准入回调，其他文件转给文档准入回调，由持有方执行权威的 PDF/DOCX/PPTX/XLSX 校验。输入区被锁定时显示通用附件禁用遮罩，并且不会转发任何文件。遮罩只负责呈现；数量、字节和媒体类型准入仍由 conversation 持有方和 Host 负责。

混合草稿不会改变图片行为。图片卡片仍会打开 `ImageLightbox`；文档卡片没有灯箱。删除文档调用文档专用回调，而删除图片还会让 conversation runtime 回收其浏览器对象 URL。

## 消息图片与灯箱

`MessageImage` 通过持有方的 `ImageLoader` 加载会话授权 URL 来渲染一张持久历史图片；失败时提供重试控制，成功后可打开 `ImageLightbox`。单图最长边最多 240px，展示宽高比钳制在 [0.25, 4]；多图 tile 仍是固定 64px 方块。`ImageGallery` 负责换行与消息侧对齐。`ImageLightbox` 是 document 级模态框，可通过 Escape、遮罩按下或关闭按钮关闭，并在关闭后把焦点还给打开者。

持久文档历史卡片由 conversation 包根据 `DocumentBlock` 元数据渲染，而不是由这个图片呈现插件负责。本包之所以渲染输入区文档卡，是因为 composer attachment slot 属于它的呈现表面；它不持有会话内容语义。

## 模型体验

无，因为该包只渲染附件状态并调用持有方回调。

#### KV Cache 影响

无；该包不会发起模型调用。

## 已知限制与待完成工作

- 输入区文档卡支持通用 PDF/DOCX/PPTX/XLSX 草稿路径，但没有内嵌 PDF/Office 预览，也没有上传进度百分比。
- 历史文档卡在独立解析器能力提供解析内容前只显示元数据；解析器内部细节不属于本包。
- 图片灯箱没有缩放或下载控制，也不锁定焦点，不过它会设置 `aria-modal` 并在关闭时恢复焦点。
