# @sparkelf/dsh-patch-officecli-deliverables

[English](README.md) | 中文

本data-only package patch official DSH revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`。它让existing deliverables projection识别会写入原始Office文件的`officecli` argv operations，使完成turn把DOCX、XLSX或PPTX path列为可点击产物。它不render、copy、convert或cache该文件。

payload只修改`packages/client/ui-deliverables/src/client/turn-deliverables.ts`。Official DSH识别相同OfficeCLI output contract后删除本patch。

## 模型体验

无。OfficeCLI tool持有model instructions与results；本patch只改变browser output link。
