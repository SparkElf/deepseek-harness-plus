# Agent Note: Every declared patch is deliverable to a registry installation

Status: proposed

English | [中文](2026-09-15-patch-delivery-strategy.zh.md)

## Problem

The Plus distribution declares twelve patches against official DSH source plus one against a third-party npm package. `dsh-plus apply` applies both kinds because it requires `--dsh-root`, a full official checkout it then rebuilds. A registry installation has no such checkout: `dsh-plus start` creates a profile from published packages and can apply only npm-target patches.

The asymmetry was invisible while no patch worked for those users; adding the npm-target path made one work and left twelve failing, which is how a fixed defect (the sidebar media route) reached consumers while a preset defect did not.

The measured facts:

- An official npm package publishes `lib/` (bundled output), `lib/types/`, and its `README`; **it does not publish `src/`**.
- `@deepseek-ai/dsh-agent-presets` is the exception: it publishes `presets/` as data.
- Rewriting a source patch's path prefix and applying it to the published package **succeeds only when the target is non-generated data** (`yml`, `css`, `json`, `html`, `md`).
- Nineteen of twenty affected packages publish no `src/`, so a TypeScript change cannot be expressed as an npm patch without hand-editing a bundle.

A patch that requires downloading and building official source is not deliverable to a user who installed a package. Keeping one is a claim the distribution does not honour.

## Proposal

Classify every patch by what it actually changes, and deliver each by the cheapest mechanism that reaches registry installations. Retire the patch when a cheaper mechanism can carry it.

### The four delivery mechanisms, cheapest first

1. **Profile configuration** — `cordis.patch.yml` already supports id-targeted `config` overrides, `disabled`, and `insert` rows. A patch that only changes a plugin's configuration, disables a row, or adds a row needs no file patch at all. This is the preferred mechanism because it survives every upstream upgrade untouched.
2. **Our own plugin** — a patch that changes a package's behaviour can become a plugin that provides the same behaviour, mounted in place of the official row by a profile `insert` or `disabled` pair. `@sparkelf/dsh-plugin-subagent-settings` is the working precedent: it replaced `@deepseek-ai/dsh-tool-subagent` through the preset's own row list rather than by patching the package.
3. **npm-target patch on published data** — `presets/`, `package.json`, CSS, or locale files that ship verbatim can be patched directly, as `better-sidebar-media-path` proves. Cheap, but still a fork of upstream content.
4. **Source patch** — only for a change that cannot be expressed above. Because a registry installation cannot apply it, **a source patch is not a deliverable**; it is either converted or the capability is dropped from the registry distribution.

### Per-patch classification

| Patch | Changes | Mechanism | Work |
|---|---|---|---|
| subagent-settings-presets | 3 `presets/*.cordis.yml` | **npm patch** (verified: `git apply --check` passes) | None — rewrite the path prefix |
| session-export-chinese | 1 `locales.ts` | **our plugin** or locale data if published | Small |
| browser-auth-mode | 3 `connection/src/*.ts` | **profile config** (the mode is a config choice) or plugin | Small |
| legacy-code-preset | `session-controller`, `ui-agent-preset` | **profile config** if the mapping is data | Medium |
| ptc-mcp-schema-types | `core/tools` schema types | **our plugin** (a schema type provider) | Medium |
| responses-reasoning-status | `llm-pi-ai` adapter | **our plugin** (a provider adapter) | Large |
| officecli-deliverables | `ui-deliverables` one function | **our plugin** registering the output projection | Medium |
| workspace-storage-restore | `workspace` one function | **our plugin** or upstream first | Medium |
| mobile-journal-generation | `api-gateway` client stream | **our plugin** | Medium |
| composer-popover-boundaries | `ui-layout`, `ui-primitives`, `ui-conversation` | **our plugin** (layout/popover) | Large |
| session-log-trajectory-toolbar | `ui-trajectory`, `session-log-export` | **our plugin** (a toolbar contribution) | Large |
| web-base-path | `apps/web`, `host/webserver`, `frontend-static` | **plugin pair** or a build-time frontend variant | Large |

### Order of work

1. **Convert the one verified npm-able patch now.** `subagent-settings-presets` unblocks sessions on every registry installation; it is a path rewrite and one governance entry.
2. **Convert the patches a profile configuration can carry.** Each removal deletes a fork with no behaviour change.
3. **Convert the rest to plugins, one at a time, each with its own PR.**
4. **Delete the source-patch mechanism from the Plus distribution once no patch uses it**, so the distribution cannot silently declare a patch its consumers cannot receive. Keep `dsh-plus apply --dsh-root` for the Desktop installer, which has the checkout.

## Findings this change rests on

Measured on a real release, not assumed:

1. **An official package publishes no \`src/\`.** \`@deepseek-ai/dsh-client-connection@0.1.5-rc.2\` ships \`lib/\`, \`lib/types/\`, and its README. A TypeScript source patch therefore has nowhere to land in a registry installation.
2. **\`@deepseek-ai/dsh-agent-presets\` is the exception**: it publishes \`presets/\` verbatim. Rewriting a source patch's path prefix and applying it to that package **passes** \`git apply --check\`; the same rewrite against \`dsh-client-ui-deliverables\` fails because the file is not published.
3. **Built code imports the official specifier.** \`@sparkelf/dsh-agent-presets\`'s \`lib/index.js\` contains \`from '@deepseek-ai/dsh-tools'\`. Node resolves an import by name, so **the installed location must keep the official name**; a package manifest that renamed its dependencies would point at a name the code never asks for.
4. **\`overrides\` substitutes by name, not by manifest entry.** With \`"@deepseek-ai/dsh-tools": "npm:@sparkelf/dsh-tools@x"\`, pnpm installs our build at \`node_modules/@deepseek-ai/dsh-tools\`, which is the path the import needs. Verified end to end: a consumer of \`@sparkelf/dsh-agent-presets\` printed \`PATCHED-PRESETS uses PATCHED-TOOLS\`.
5. **\`overrides\` belongs in \`pnpm-workspace.yaml\`, not \`package.json\`.** pnpm 10 moved it. Placing it in \`package.json\` is silently ignored — the first attempt did exactly that and resolved the official package instead.
6. **npm rejects an override that names a direct dependency** with \`EOVERRIDE\`. The one package the manifest lists as a dependency (\`dsh-web-app\`) therefore travels as a dependency alias, and the remaining nineteen as overrides.
7. **The patched set is exactly twenty packages.** They form a closed dependency graph: \`dsh-web-app\` depends on fifteen of them, \`api-session-controller\` on four, \`host-frontend-static\` on two, \`agent-presets\` on one. Publishing them together is what lets them resolve; a partial set fails at install because a dependency names a package that is not there.
8. **The official registry serves no second package under an existing name**, so republishing must rename onto our scope. The rename is on the package only: dependencies and imports keep the official names, and the consumer's overrides map one to the other.

## Acceptance criteria

- Every patch the distribution declares is applicable by a registry installation, or the distribution does not declare it.
- `dsh-plus start` on a fresh installation produces a session: the shipped preset mounts.
- A patch that changes only configuration leaves no file patch behind.
- Removing the source-patch delivery from the Plus distribution fails `verify-plus-governance` while any `dsh-source` variant remains declared.

## Alternatives considered

- **Have `dsh-plus start` download and build the official source.** Rejected: it makes a registry installation cost a full checkout, a toolchain, and minutes of building before it can create a session. A user who installed a package should receive a working product from that package.
- **Publish prebuilt patched copies of the twenty official packages under our scope.** **Adopted.** Every upstream release needs a rebuild of twenty packages, but the release is already a build: `dsh-plus apply` produces a checkout with the patches applied and `build:official` compiles it, so the artifact exists before any consumer asks. The alternative — a user downloading that same source and building it — moves the cost to every installation instead of one release, and a registry installation cannot pay it at all without a toolchain. The rebuild is automated, so the per-upstream cost is a workflow run rather than hand work.
- **Keep rebuilding under our scope, but only for the packages a patch touches.** That is what this adopts: twenty of roughly two hundred workspaces. The remaining workspaces keep the official packages, reached through \`overrides\`.
- **Patch the bundled `lib/` output directly.** Rejected: the output is minified, merges sources, and changes shape on every build. A patch against it fails on the next upstream release and cannot be reviewed against the source it came from.
- **Drop the affected capabilities from registry installations.** Rejected as a blanket answer: it would take a working feature from Desktop users to simplify the registry path. It remains the right answer per-patch, when the capability is not worth a plugin.
- **Keep source patches and document that they need Desktop.** Rejected: the distribution declares them for every installation, so the gap is a defect in the declaration, not a limitation to explain.

## Risks

- **A plugin that replaces an official row can drift from it.** The replacement must track the interface it implements; the profile patch that mounts it makes the substitution visible in one file.
- **Plugin conversion is per-patch work.** Twelve conversions are not one change; each needs its own verification against a real installation.
- **Some capabilities may resist conversion.** `web-base-path` touches the served frontend, which is a build product; if it cannot become a plugin pair, that capability stays Desktop-only and the distribution must say so.
- **Every upstream release rebuilds and republishes twenty packages.** \`package-patched-official.mjs\` and \`publish-patched-official.mjs\` automate the step, but it remains a release operation rather than an import.

## Consequences

- **The registry distribution stops claiming what it cannot deliver.** A patch in `dshPlus.patchPackages` becomes a promise that every installation applies it.
- **Fewer patches over time, more plugins.** Plugins are versioned, testable, and independent of the official revision; patches are not.
- **The Desktop installer keeps the source-patch path** for capabilities that genuinely need the official tree, and that path stays exercised by its own release.
