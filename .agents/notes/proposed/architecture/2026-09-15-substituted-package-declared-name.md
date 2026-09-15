# Agent Note: A substituted package must declare the name of its location

Status: proposed

English | [中文](2026-09-15-substituted-package-declared-name.zh.md)

## Problem

The Plus distribution replaces twenty official packages with our builds by mapping each official name onto ours in the profile's `overrides`. pnpm installs our build at the official path, so the import specifier a consumer's code already contains resolves to our code.

That worked for resolution and failed for registration. The client module system resolves a loader entry's declared name and then requires the manifest it finds to declare that same name:

```ts
// packages/client/modules
if (typeof name === 'string' && (expectedPackageName === undefined || name === expectedPackageName)) {
  return { path: candidate, packageName: name }
}
// no match: keep walking toward the declaring package root, then give up
```

Our build declares `@sparkelf/dsh-client-ui-settings-models` while sitting at `@deepseek-ai/dsh-client-ui-settings-models`, so the comparison failed and the package owned no browser module at all. Twenty packages therefore loaded nothing, and every panel they render — the model selector, the settings panels, the deliverables view — silently never appeared. The packages installed, the server started, and no error was reported.

## Proposal

**Align each replaced package's declared name with the location it occupies, during profile installation.**

The package keeps our version and our code; only the `name` field changes to the official name of the directory it was installed into. The rewrite replaces the manifest file rather than writing through it.

## Findings this change rests on

1. **The comparison is exact and unqualified.** `name === expectedPackageName` admits no scope alias, so a package under the official path that declares any other name is invisible to the module system.
2. **The failure is silent.** Nothing reports it: the package is at the right path, declares `dsh.client`, appears in `cordis.patch.yml`, and resolves by name. Measured on a real installation, the served module table carried 54 entries; renaming the six affected manifests took it to 60 and rendered the panels.
3. **pnpm hard-links a manifest into its content-addressed store.** Measured: the profile's `package.json` shared an inode with the store entry and reported link count 2. Writing through that link would edit every profile sharing the store entry, so the rewrite creates a new file and moves it into place — after which the link count is 1 and the store is untouched.
4. **The alignment belongs to installation, not packaging.** A published package cannot declare the official name: the registry serves one package per name, and our build must publish under our scope to be installable at all. The name is therefore a property of where the package is installed, which only the installer knows.

## Acceptance criteria

- A fresh `dsh-plus start` produces a profile whose replaced packages each declare the official name of their directory.
- The served client module table includes the modules of every replaced package that declares `dsh.client`.
- The rewrite leaves the pnpm store's copy of the manifest unmodified.
- A package that already declares the right name is not rewritten.

## Alternatives considered

- **Publish our builds under the official names.** Rejected: the registry serves no second package under an existing name, so the official packages cannot be replaced there.
- **Patch the client module comparison to accept an alias.** Rejected: it changes official behavior for one consumer's benefit, and the substitution is ours to express correctly.
- **Copy the packages into the profile instead of installing them.** Rejected in an earlier decision: a copy is not an installation, and the profile needs a real dependency tree for its own resolution.

## Risks

- **The rewrite assumes the official directory name is the intended identity.** A package installed under a scope it does not belong to would be renamed to that scope. The alignment only touches `@deepseek-ai`, which the distribution's overrides own.
- **A future module system may compare more than the name.** The alignment makes the manifest consistent with its location, which is the property the comparison tests.

## Consequences

- **A substituted package is indistinguishable from the official one at the path it occupies**, which is what a substitution has to mean for code that resolves it by name.
- **The alignment runs on every profile installation**, so a package installed by a later release is aligned without a separate step.
