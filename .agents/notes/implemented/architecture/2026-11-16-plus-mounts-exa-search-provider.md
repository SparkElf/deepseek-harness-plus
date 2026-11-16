# Agent Note: Plus mounts Exa as its search provider

Status: implemented

English | [中文](2026-11-16-plus-mounts-exa-search-provider.zh.md)

## Problem

The Plus distribution could mount `@deepseek-ai/dsh-web-search-exa`, but no deployment received a working Exa search path. The package was declared only as a distribution dependency for the install-time capability interview, so `dsh-plus apply` never wrote it into the profile's dependency table, and neither the team nor the intranet-team edition listed it among the packages it installs. The intranet-team edition additionally named the package in `omit`, which the projection turns into a pnpm override onto `@sparkelf/dsh-omitted`; an image that removed its own omission assertion still installed a placeholder that declares nothing. The bundle patch also mounted no provider row and left `web.searchProvider` at the official `deepseek-search-api` default, so even an installed package was never selected.

The version the manifest carried, `0.1.6-alpha.1`, belonged to the previous runtime generation. The npm `latest` tag for the package is older still (`0.0.1-rc.1`) and declares peers on `@deepseek-ai/dsh-environment` and `@deepseek-ai/dsh-invariants`, which the 0.2.2 runtime replaced; using it would make the row fail to resolve its imports. The `next` tag carries `0.2.2-rc.1`, the newest published release. Its exact `@deepseek-ai/dsh-web` and `@deepseek-ai/dsh-launch-environment` peers name `0.2.2-rc.1`, so the app-boot preflight compared them with the `0.2.2-rc.2` runtime and disabled the row before importing it.

## Decision

The distribution owns Exa as a default provider for the runtime it targets:

- `dshPlus.profile.dependencies` pins `@deepseek-ai/dsh-web-search-exa` at `0.2.2-rc.1`, the newest published version, so `dsh-plus apply` and `dsh-plus install` write it into the profile manifest.
- `dshPlus.profile.compatibility` declares `@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1`, and every profile materialization merges that grant into `compatibility.json` with the declared runtime `0.2.2-rc.2`. The grant is the app-boot preflight's own exact-version mechanism; the alternative was a peer range the upstream build does not publish.
- The `team` and `intranet-team` editions list the package in `packages`, and `intranet-team.omit` no longer names it, so no edition substitutes the omission placeholder.
- `cordis.patch.yml` inserts the `web-search-exa` row and patches `web.searchProvider` with `process.env.EXA_API_KEY ? 'exa' : 'deepseek-search-api'`. The row restates `fetchProvider: http` because a patch replaces the row's whole config object.
- The install-time capability interview keeps the Exa question and the `EXA_API_KEY` prompt, but the answer writes only the deployment env file. Writing a row there as well created a second loader entry with the same id, and both activations registered the same `exa` provider id.

The provider mounts unconditionally. Its plugin reports itself unavailable with an empty key, so a deployment without `EXA_API_KEY` keeps the official search provider and the row has no model-visible effect. `writeProfileCompatibility` merges the grant into an existing `compatibility.json` instead of replacing it, because the same file can hold a grant a deployment added for another plugin.

## Alternatives considered

**Use the `latest` tag (`0.0.1-rc.1`).** Rejected because its peers name packages the 0.2.2 runtime no longer ships; the row would fail to import and the capability would be dead on arrival.

**Keep the capability interview as the only mount path.** Rejected because `dsh-plus apply` composes the profile from `dshPlus.profile.dependencies` and the editions, not from the interview, and image builds never run the interview.

**Pin `web.searchProvider: exa` unconditionally.** Rejected because a deployment without a key would have no usable search provider at all; the configuration must fall back to the official provider.

**Make the bundle row conditional on `EXA_API_KEY`.** Rejected because the row would still need a stable id and the capability layer's row would keep colliding; an inert provider row is simpler and keeps the installed package's cost bounded to its own code.

## Consequences

The `team` and `intranet-team` profiles install the Exa package, and the intranet-team profile no longer rewrites it to `@sparkelf/dsh-omitted`. `sharedOfficials` also carries every `@deepseek-ai/dsh*` profile dependency into the editions that do not mount the Plus patch layer, so those profiles install the package without mounting a row. A deployment with `EXA_API_KEY` in its launch environment routes `web_search` through Exa; one without it keeps `deepseek-search-api`. The capability record and the `dsh-plus capabilities` report read Exa from the env file, because the profile row is no longer written into the user layer.

## Verification

`vitest run packages/bundle/plus/tests` passes 69 tests across 9 files, including the capability layer's new no-row assertion for Exa, the edit path that removes a legacy row without re-adding it, and the compatibility file's merge behavior. `pnpm run verify:plus-governance` accepts the new profile dependency, the compatibility grant, the edition package lists, and the patch row's ownership. The release gate packs the tarball and `verify-packed-install` installs it; the published tarball's `package.json` and `cordis.patch.yml` carry the dependency, the `intranet-team.packages` membership, the absence from `omit`, the provider row, and the `EXA_API_KEY` selector. A materialized profile carries `compatibility.json` granting `@deepseek-ai/dsh-web-search-exa@0.2.2-rc.1` on `0.2.2-rc.2`.