---
description: "Registry entry point for a DataOps AI workspace: pins the runtime and the reviewed plugins without the capabilities an intranet deployment must not run."
kind: "package-reference"
---

# @sparkelf/dsh-dataops-standalone

English | [中文](README.zh.md)

Install a DataOps AI workspace from the registry and reach the browser UI without a source checkout, a build, or git.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Summary

One `npm install` brings the official runtime, the Plus distribution, and the reviewed plugins a DataOps workspace runs. `dsh-dataops start` writes the `dataops-web` profile, picks a free port, starts the server, and prints the URL. The remaining commands cover what the launcher leaves to the user: stop, status, update, and doctor.

This package is the **DataOps variant** of `@sparkelf/dsh-plus-standalone`, generated from the distribution's `dshPlus.profile.standaloneVariants.dataops` declaration. It installs strictly less: the capabilities an intranet workspace must not run are absent from its dependency set rather than merely unmounted, so a scan of the image does not find them.

## Use this package

```sh
npm install -g @sparkelf/dsh-dataops-standalone
dsh-dataops start
```

| Command | Effect |
|---|---|
| `dsh-dataops start` | Writes the profile on first run, picks a free port, starts the server, prints the URL |
| `dsh-dataops stop` | Ends a background server within its grace period |
| `dsh-dataops status` | Reports whether the server is running and on which port |
| `dsh-dataops update` | Moves to a newer published release; `--check` reports without installing |
| `dsh-dataops doctor` | Checks Node, the distribution, the profile, and the port |

### Capabilities this variant omits

| Omitted package | Capability |
|---|---|
| `@deepseek-ai/dsh-computer-use` | Drive the Windows desktop |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | The cua driver behind that capability |
| `@deepseek-ai/dsh-web-search-exa` | Route web search through Exa |

`@sparkelf/dsh-mobile-bridge` is absent from the whole distribution, so it is absent here too.

## Dev Note

- `src/bin.ts` forwards every command to the `@sparkelf/dsh-plus` CLI, which reads this package's `dshPlusStandalone` declaration to materialize the `dataops-web` profile and to apply the omission overrides. The [distribution Agent Note](../../../.agents/notes/implemented/architecture/2026-08-29-ranged-plus-patchset-distribution.md) records why the distribution owns the reviewed set.
- No runtime invariant companion is published because this package only declares a dependency set and forwards every command to the CLI; the profile it materializes is observed by that CLI, not here.

```sh
tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus \
  --out packages/standalone/dataops-standalone/package.json \
  --runtime-version <dsh version> --variant dataops
```

## Model Experience

### DataOps variant installation

#### What the model sees

Nothing of its own. `@sparkelf/dsh-dataops-standalone` selects the runtime and the plugins a `dataops-web` profile mounts; it registers no tool, prompt section, or Session event. The model meets only what the mounted plugins expose, and the omitted capabilities' tools are not registered at all.

#### Token effect

Zero. The package adds no model-request tokens. It removes the omitted capabilities' tools, so a session carries fewer tool schemas than a full Plus deployment.

#### KV Cache effect

None. It contributes no prompt content, so it cannot shift a cache prefix.

## Known Limitations and Deferred Work

- The exclusion list restates facts the distribution owns. A package the distribution adds is not excluded here until the variant names it. The generator fails the build when a variant names a package the distribution does not declare, so the two cannot drift silently in the other direction.
- The variant is generated, not hand-written. Regenerate with `--variant dataops` after a distribution change rather than editing the manifest.
