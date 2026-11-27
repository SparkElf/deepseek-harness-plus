# @sparkelf/dsh-mineru

## 中文

本包为DeepSeek Harness增加`mineru_parse_pdf`模型工具。Official DSH持有文件上传、持久存储、消息卡片及向模型显示的只读路径；本工具接受该路径，调用配置的MinerU `/file_parse` endpoint，并返回解析后的Markdown、content-list及提取图片名称。

请求按MinerU 4.x的约定构造：multipart body只放`files`一个字段，`tier`与`output_formats`作为query参数传递。4.x只从query串读取解析选项，body里多出的字段会被拒绝（`Too many fields. Maximum number of fields is 0.`）。`tier`显式传入，默认`basic`；服务器在未指定时自行选择`standard`，同一个单页PDF实测17.8秒对2.0秒（2026-10-15，MinerU 4.0.12）。可用`tier`选择`flash`/`basic`/`standard`/`advanced`。

本包没有prompt hook、attachment provider、browser client或Office parser。DOCX、XLSX及PPTX使用`@sparkelf/dsh-officecli`。

将`DSH_MINERU_ENDPOINT`设为同步MinerU endpoint；变量缺失时bundle保持禁用。

## English

This package adds the `mineru_parse_pdf` model tool to DeepSeek Harness. Official DSH owns file upload, durable storage, message cards, and the read-only path shown to the model. The tool accepts that path, calls the configured MinerU `/file_parse` endpoint, and returns the parsed Markdown plus content-list and extracted-image names.

The request follows the MinerU 4.x contract: the multipart body carries `files` and nothing else, while `tier` and `output_formats` travel as query parameters. 4.x reads every parse option from the query string, so any extra body field is rejected with `Too many fields. Maximum number of fields is 0.`. `tier` is always named and defaults to `basic`, because an unnamed tier lets the server pick `standard`, which measured 17.8 s against 2.0 s for the same one-page PDF (2026-10-15, MinerU 4.0.12). Set `tier` to `flash`, `basic`, `standard`, or `advanced`.

The package has no prompt hook, attachment provider, browser client, or Office parser. Use `@sparkelf/dsh-officecli` for DOCX, XLSX, and PPTX files.

Set `DSH_MINERU_ENDPOINT` to the synchronous MinerU endpoint. The bundle stays disabled when the variable is absent.
