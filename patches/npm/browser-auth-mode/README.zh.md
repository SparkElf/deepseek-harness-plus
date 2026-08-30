# @sparkelf/dsh-patch-browser-auth-mode

[English](README.md) | 中文

该data-only package为official Connection增加唯一显式`browserAuthentication: required | disabled`策略。`required`保持official default，保留process-token exchange、signed cookie与401 response。`disabled`不创建launch token或signing record，打印clean Web URL，接受index requests，并在独立Host/Origin trust fence通过后把Host API requests视为authenticated。

Plus选择`disabled`，因为其accepted local Web workflow优先保证直接访问，不保留browser identity。该选择会把包含Shell、files与Sessions在内的完整Host API开放给所有能访问accepted authority的进程，并非只影响DataOps。shipped CLI仍绑定loopback并拒绝`--host 0.0.0.0`，custom trusted authorities仍由deployment负责。

target是exact official source base `cd5ef8148158c3a752a658978873241fdf8e2bbc`。本package没有JavaScript entry、lifecycle script、credential material或fallback variant。official DSH暴露等价profile-selected browser-authentication policy后retire本package。
