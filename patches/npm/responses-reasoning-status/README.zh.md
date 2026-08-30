# @sparkelf/dsh-patch-responses-reasoning-status

[English](README.md) | 中文

该data-only package为接受历史reasoning input items、但拒绝其中response-only `status`字段的OpenAI Responses网关增加一个显式`llm-pi-ai` route option。仅当`api: openai-responses`时才接受`responsesCompatibility.omitReasoningInputStatus: true`；pi-ai完成整个request序列化后，adapter只从顶层`type: reasoning` input items删除`status`。assistant messages、tool items与其他所有fields均保持不变。

official Models editor只在effective protocol为`openai-responses`的pi-ai routes中显示localized **中转站兼容模式** checkbox。user-layer关闭操作在没有inherited true时删除该leaf；存在inherited true时写入显式false。切换protocol会删除或遮蔽不兼容设置，而不会替换sibling fields。

target是exact official source revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`。本package没有JavaScript entry、lifecycle script、Cordis plugin、fallback或alternate variant。official DSH提供等价pi-ai Responses input adjustment与Models editor behavior后，retire本package。
