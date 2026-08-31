# @sparkelf/dsh-patch-browser-auth-mode

English | [中文](README.zh.md)

This data-only package adds one explicit `browserAuthentication: required | disabled` policy to official Connection. `required` remains the official default and preserves the process-token exchange, signed cookie, and 401 response. `disabled` creates no launch token or signing record, prints the clean Web URL, admits index requests, and treats Host API requests as authenticated after the independent Host/Origin trust fence succeeds.

Plus selects `disabled` because its accepted local Web workflow prioritizes direct access over browser identity. This exposes the complete Host API, including Shell, files, and Sessions, to every process that can reach an accepted authority; it does not only affect DataOps. The shipped CLI still binds loopback and rejects `--host 0.0.0.0`, while custom trusted authorities remain a deployment responsibility.

The target is exact official source base `0a53fb55bea101816fa226bb964ae2bed71c343b`. The package has no JavaScript entry, lifecycle script, credential material, or fallback variant. Retire it when official DSH exposes an equivalent profile-selected browser-authentication policy.
