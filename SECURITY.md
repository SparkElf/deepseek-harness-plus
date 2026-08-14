# Security Policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose credentials, private workspaces, session data, model access, or a multi-user runtime.

Use the repository's private security advisory flow and include a minimal reproduction, affected version or commit, impact, and any mitigation already applied. Do not include live credentials or customer data.

## Deployment posture

A production deployment keeps Harness runtimes on a private network. The public gateway owns authentication and authorization; individual runtime containers receive only the workspace and credentials assigned to that user or tenant.
