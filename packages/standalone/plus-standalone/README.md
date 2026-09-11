---
description: "Registry installation entry point for DeepSeek Harness Plus: pins the runtime and every reviewed plugin, and carries the generated mount order."
kind: "package-reference"
---

# @sparkelf/dsh-plus-standalone

English | [中文](README.zh.md)

Install DeepSeek Harness Plus from the registry and reach the browser UI without a source checkout, a build, or git.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

## Summary

One `npm install` brings the official runtime, the Plus distribution, and every reviewed plugin. `dsh-plus start` then writes the profile the launcher boots, picks a free port, starts the server, and prints the URL. The remaining commands cover what the launcher leaves to the user: stop, status, update, and a doctor check. The package is a manifest whose dependencies and bundle order are generated from the distribution, so a plugin added there cannot reach this package without reaching its mount order too.

## Use this package

```sh
npm install -g @sparkelf/dsh-plus-standalone
dsh-plus start
```

| Command | Effect |
|---|---|
| `dsh-plus start` | Writes the profile on first run, picks a free port, starts the server, prints the URL |
| `dsh-plus stop` | Ends a background server within its grace period |
| `dsh-plus status` | Reports whether the server is running and on which port |
| `dsh-plus update` | Moves to a newer published release; `--check` reports without installing |
| `dsh-plus doctor` | Checks Node, the distribution, the profile, and the port |

## Model Experience

### Standalone installation

#### What the model sees

Nothing. `@sparkelf/dsh-plus-standalone` selects the runtime and the plugins a profile mounts; it registers no tool, prompt section, or Session event of its own. The model meets only what the mounted plugins expose.

#### Token effect

Zero. The package adds no model-request tokens.

#### KV Cache effect

None. It contributes no prompt content, so it cannot shift a cache prefix.

## Known Limitations and Deferred Work

No invariant companion is published because this package selects other packages and observes no relation of its own.

- `dsh-plus update` changes the profile and reinstalls, but a running server keeps the version it started with; restart to load the new release.
- The manifest carries peer overrides for three published plugins whose declared ranges cannot match the shipped runtime. The overrides are derived and disappear once a plugin fixes its range, but until then that plugin's own declared range stays unsatisfied.

### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above, the package code, and the linked Agent Note.

- The [standalone distribution Agent Note](../../../.agents/notes/proposed/feature/2026-09-11-standalone-distribution.md) owns the installation decision; `package.json` and the `dsh-plus` command in [`packages/bundle/plus/`](../../bundle/plus/README.md) own current behavior.
- Regenerate this manifest with `pnpm exec tsx scripts/standalone/generate-manifest.ts --distribution packages/bundle/plus --out packages/standalone/plus-standalone/package.json --runtime-version <version>`; it rewrites the derived fields and leaves the identity fields in place.

</details>
