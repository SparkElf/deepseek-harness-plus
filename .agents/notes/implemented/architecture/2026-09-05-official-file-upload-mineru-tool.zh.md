# Agent Note：Official file upload与MinerU由不同owner持有

Status: implemented

[English](2026-09-05-official-file-upload-mineru-tool.md) | 中文

## 问题

旧`@sparkelf/dsh-plugin-document-attachments` package同时持有browser intake、prompt transport、durable parsed artifacts、document cards、sidebar preview、parser registry及MinerU provider。Official DSH `0.1.3-alpha.1`现已持有generic upload、durable file references、Chat/Trajectory presentation，并在model history中提供read-only execution-world path。保留旧package会重复official input path，还会让PDF解析控制无关的attachment behavior。

## 决策

Official `dsh-client-file-upload`、`dsh-attachment`及official Client UI是file intake、storage、prompt admission、history及attachment presentation的唯一owner。Plus删除Document Attachment capability package及其exact-source integration patch。

MinerU迁至`SparkElf/dsh-plugins-plus`中独立versioned的`@sparkelf/dsh-mineru` package。它注册`mineru_parse_pdf` model tool，接受official file history已向模型显示的exact read-only path，调用configured synchronous MinerU endpoint，并把Markdown返回模型。它不持有prompt hook、attachment provider、browser Client或Office path。`@sparkelf/dsh-officecli`继续持有DOCX、XLSX及PPTX工具，Better Sidebar Office插件预览原始Office文件。

Plus profile默认mount两个external tools。`DSH_MINERU_ENDPOINT`独立启用MinerU；缺失该变量不会禁用official attachments或Office handling。

## 已考虑的替代方案

**在attachments与MinerU之间保留provider-neutral parser registry。** 否决，因为一个selected PDF service与一个model-facing consumer无需replaceable service layer。它会继续把prompt admission耦合到parsing，并把capability隐藏在explicit tool selection之外。

**Patch official upload以自动调用MinerU。** 否决，因为upload完成不等于同意解析每个文件，且Office files属于OfficeCLI。模型已收到usable path，可选择匹配工具。

**保留custom parsed-document cards与semantic sidebar previews。** 否决，因为它们重复official attachment cards，并与original-file Office viewer竞争。MinerU输出应进入tool result及正常model answer。

## 后果

- Upload、queue、Chat、Trajectory及file-path behavior随official DSH升级，无Plus attachment fork。
- MinerU可独立安装、禁用、升级或删除，不改变attachment或Office UI。
- 旧package及`@sparkelf/dsh-patch-document-attachments`不设compatibility wrapper；Plus仍为pre-stable，直接删除其profile rows。
- PDF解析成为explicit model tool call；DOCX、XLSX及PPTX继续经过OfficeCLI与original-file viewer。
