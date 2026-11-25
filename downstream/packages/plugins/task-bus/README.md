# @sparkelf/dsh-task-bus

DataOps Task Center for the DSH Web shell.

The first source is DataOps approval work:

- `asset-access-approval`
- `application-request-approval`
- `application-resource-request-approval`

Approval tasks stay authoritative in DataOps. This plugin projects them into one
stable `approval:<taskId>` card and links `办理` back to the existing DataOps
approval detail. It never creates a second approval task or re-implements BPMN.

Generic group/session/manual tasks use the separate `task:<uuid>` Task Bus record.
The MVP does not include a connector marketplace, connector uploads, versioning,
OAuth, certificates, or a local credential manager.

## Development

```sh
pnpm --filter @sparkelf/dsh-task-bus typecheck
pnpm --filter @sparkelf/dsh-task-bus build
```

The Host bridge uses the managed workspace's `DATAOPS_ACCESS_TOKEN` credential
through `ctx.credentials` and the configured DataOps backend:

- `DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL`
- `DATAOPS_PUBLIC_APP_ORIGIN` (used only to make approval deep links absolute)

The browser talks only to `/dsh-task-bus/api`; it never receives the token or the
DataOps API origin.