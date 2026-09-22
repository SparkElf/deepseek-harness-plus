# Agent Note: a reduced standalone variant declares what it omits

Status: implemented

English | [中文](2026-09-22-standalone-variants-declare-omissions.zh.md)

## Problem

The DataOps AI workspace image must not run computer-use, the cua driver, or Exa web search, and a compliance scan must not find them either. The image previously built the distribution from pinned source and assembled the profile with `dsh plugin add`, so its exclusions lived as shell `case` statements and `test ! -d` assertions inside the Dockerfile. Nothing tied those to the distribution's own plugin set, and a package the distribution added reached the image unless someone remembered to assert its absence.

Two facts made a package-level reduction impossible through the mechanisms already present:

1. `--omit=optional` cannot express it. The transitive tree also carries platform packages in `optionalDependencies` — `sharp` (`@img/sharp-libvips-*`), `koffi`, `@vscode/ripgrep`, `pg-cloudflare` — and omitting them breaks the image's runtime.

2. npm has no removal override. `overrides` substitutes one package for another and cannot delete one, and a dependency's own `overrides` are ignored: npm reads them only from the install root.

Measured: excluding the three packages from the variant's own `dependencies` left them installed, because `@sparkelf/dsh-plus` declares them and npm installs the whole tree (`npm ls @deepseek-ai/dsh-computer-use` resolved it through `dsh-plus`).

## Decision

**A variant is declared once in the distribution, and the installing package carries the declaration to the profile.**

Three pieces, each owning one fact:

| Piece | Owns |
|---|---|
| `dshPlus.profile.standaloneVariants` | which package name, profile name, and packages a variant reduces |
| `dshPlusStandalone` in the generated manifest | the same facts where npm and the CLI can read them |
| `dshPlusStandalone.omittedPackages` | package name to override spec, applied to the profile workspace |
The distribution declares capabilities as `optionalDependencies`, because the distribution can run them but does not require them. That is what makes an omission expressible: a required dependency states the deployment cannot work without it, which is false for a capability a variant is allowed to drop.

An omitted capability is **substituted, not deleted**: `@sparkelf/dsh-omitted` is a placeholder that exports nothing, and the variant's `omittedPackages` map points each excluded name at it. The substitution is what makes the omission auditable — a scan of the tree finds the placeholder rather than the capability — and the placeholder deliberately has no exports, so mounting it fails loudly instead of silently stubbing a capability.

The CLI reads the declaration by walking out from its own file to the package that installed it (`readStandaloneDeclaration`), which is how one `dsh-plus` build serves both the full and the reduced deployment. It writes the omissions into the profile's `pnpm-workspace.yaml` alongside the distribution's `overrides`, which is the only place pnpm reads them.

## Findings this change rests on

1. **The generator already parameterised the distribution, not the variant.** `--variant` was the missing axis; the reduction is a filter over the facts the generator already reads, so no second generator exists.

2. **The generator rejects a variant that names what the distribution does not declare.** Including `@sparkelf/dsh-mobile-bridge` in the exclusion list failed the build, because that package is absent from the distribution entirely. The list cannot drift away from the set it reduces.

3. **The default manifest is unchanged.** Generating without `--variant` still produces 29 dependencies under `@sparkelf/dsh-plus-standalone`, so a public consumer receives exactly what it received before.

4. **A name-alignment mechanism already exists for replaced packages.** `alignReplacedPackageNames` rewrites a substituted package's declared name to the official name of the directory it occupies, because the client module system requires `name === expectedPackageName`. The placeholder is never mounted as a loader entry, so it is not subject to that requirement.


## Alternatives considered

**Delete the packages from the image after installation.** Rejected: it leaves `package.json` claiming dependencies the tree does not carry, so the next install restores them, and it hides the exclusion in the image build rather than in the distribution that owns the set.

**Keep the exclusions as Dockerfile assertions.** Rejected: that is the arrangement this replaces, and it cannot make the packages absent — only assert that they are.

**Give the distribution a variant-specific manifest per deployment.** Rejected: the distribution's reviewed set is one fact, and a second copy of it would need to be kept identical by hand.

**Stop declaring the capabilities as dependencies at all, and install them on demand when the capability is enabled.** Rejected: an intranet deployment cannot reach a registry on demand, and it would make enabling a capability depend on the network at start time.


## Consequences

- The image can install from the registry with no source checkout and no GitHub access, because the reduced set is published rather than assembled.
- `verify:standalone-variants` runs beside `verify:standalone-manifest` in the shared gate set, so a distribution change that the variant has not accounted for fails the build.
- A capability moved into `optionalDependencies` is still installed for a deployment that keeps it; the default manifest lists it as an ordinary dependency.
- Adding a capability to the distribution requires deciding whether each variant keeps it. The generator's validation makes the omission explicit rather than implicit.
