# @sparkelf/dsh-patch-better-sidebar-office-viewer

[English](README.md) | 中文

本data-only package仅patch `@huanlin/dsh-plugin-better-sidebar-plugin-office@0.2.0`。它删除多余的下载提示，为DOCX增加带适宽与缩放控制的页面画布，在改善workbook style projection的同时保留完整XLSX Univer编辑界面，并为PPTX增加缩略图、搜索、缩放及居中幻灯片。它还消费`@sparkelf/dsh-office-viewer-fonts`提供的font manifest。

payload只修改`lib/client.js`；全部Viewer registration及lifecycle仍由upstream package持有。Upstream release包含相同viewer behavior，且三格式system workflow在无本patch时通过后删除本patch。

## 模型体验

无。本package只改变browser presentation。
