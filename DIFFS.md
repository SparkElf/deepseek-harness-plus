# Plus Diff Protocol

[中文](DIFFS.zh.md)

Plus maintains two separate registries so you can see whether a change modifies Harness itself or the community layer around it.

| Registry | Owns |
| --- | --- |
| `diffs/core/registry.yaml` | Upstream Harness behavior and core-plugin changes. |
| `diffs/community/registry.yaml` | Community plugins, presets, installer, deployment, and governance assets. |

Each record includes a stable ID, status, feature, source repositories, upstream baseline, affected files, plugin roles, compatibility, owner, and verification. Line numbers are excluded because they drift during upstream sync.

## Status

`planned` names accepted work that has not changed production behavior. `active` names a shipped local divergence. `retired` names work that landed upstream or was removed locally.

## Plugin composition

A community plugin or preset declares its active tool names, routes, settings namespaces, UI slots, persistence owner, permissions, and dependencies in `presets/compositions/registry.yaml`. The governance verifier rejects duplicate active claims, because a plugin ecosystem cannot depend on implicit overwrite order.

## Maintenance

Use [dsh-maintain-diffs](.agents/skills/dsh-maintain-diffs/SKILL.md) whenever a change affects either registry or the composition manifest. Run `pnpm run verify:plus-governance` before review.
