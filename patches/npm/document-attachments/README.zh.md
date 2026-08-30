# @sparkelf/dsh-patch-document-attachments

[English](README.md) | 中文

该data-only package为 `@sparkelf/dsh-plugin-document-attachments` 补充generic official-source integration points：AttachmentStore中的immutable generic objects、durable DocumentBlock content、从persisted modelText artifact生成的request-only LLM projection、prepared Session prompt callbacks、单个mixed Client draft transaction、Host-projected Document limits，以及nested composer、Chat和Trajectory presentation slots。Image-only AttachmentStore providers保留明确的generic-file unsupported结果；local provider override完整generic object implementation。payload还为existing attachment plugin提供一个generic mixed image-and-document file chooser；该选择器注册到专用composer slot，直接渲染在指令按钮右侧，并使用conversation-owned bilingual label。它不包含parser、wire admission、product delimiters、Document cards、provider endpoint或fallback behavior；这些均由capability package持有。

target是exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`，payload在该source tree build前应用。本package没有JavaScript entry、lifecycle script、Cordis plugin、compatibility adapter或alternate variant。

official DSH提供等价generic file-object storage、Document content persistence与model projection、prepared prompt settlement、mixed draft attachment integration、generic attachment file selection及nested Document presentation slots后，retire本package。
