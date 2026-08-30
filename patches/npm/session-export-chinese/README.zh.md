# @sparkelf/dsh-patch-session-export-chinese

[English](README.md) | 中文

该data-only package把official简体中文会话导出按钮和状态对话框中混用的英文`Session`统一替换为既有中文术语`会话`。英文文案和导出行为保持不变。

target是exact official source revision `cd5ef8148158c3a752a658978873241fdf8e2bbc`，payload在该source tree build前应用。本package没有JavaScript entry、lifecycle script、Cordis plugin、compatibility adapter或alternate variant。

official DSH发布统一的简体中文会话导出文案后，retire本package。
