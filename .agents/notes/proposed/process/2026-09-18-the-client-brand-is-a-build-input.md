# Agent Note: A mirror's client brand comes from the build profile, not the checkout

Status: proposed

English | [中文](2026-09-18-the-client-brand-is-a-build-input.zh.md)

## Problem

The mirror built for dsh 0.1.6-alpha.2 served a sidebar whose brand read "DSH 本地构建" where the previous mirror read "deepseek HARNESS". The Web client answered, every patch was present, and the plugin list was complete; only the brand was wrong.

The brand is not read from the checkout at runtime. It is compiled in.

## Why it happened

**Two commands build the client, and only one sets the brand.**

```
scripts/client-build-environment.ts
  OFFICIAL_CLIENT_BUILD_ENVIRONMENT = {
    DSH_CLIENT_BUILD_PROFILE: 'official',
    DSH_CLIENT_TITLE: 'DeepSeek Harness',
  }

scripts/build.ts
  const profile = values.profile ?? process.env[CLIENT_BUILD_PROFILE_SELECTOR]
  const clientEnvironment = resolveClientBuildEnvironment(repositoryEnvironment, profile)
```

`pnpm run build --profile official` reaches that injection. `pnpm run build:web`, which is `pnpm --filter @deepseek-ai/dsh-web-frontend run build`, does not - it runs Vite directly.

**The brand plugin fails silently without it.** `packages/client/ui-brand-official/src/client/index.ts` opens with:

```ts
if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'official') return
```

Returning without registering the sidebar brand slots is not an error. The sidebar then renders the locale fallback, `brand.localBuild`, which is "DSH 本地构建" in Chinese and "DSH Local Build" in English.

**I ran the filter because I was building one piece.** The mirror needed its Web bundle after a client-only rebuild, and `build:web` is the command named for that. It produces a working client; it does not produce an official one.

## Proposal

**Build a mirror with one script that runs the official profile and verifies the result.**

`/root/.dsh/dsh-plus-build <mirror-path>` runs, in order:

1. `pnpm install --no-frozen-lockfile`, twice.
2. `pnpm run build --profile official`.
3. Three checks, each exiting non-zero on failure:
   - `.dsh-build/client-build-environment.json` exists - its absence is what proves the official profile did not run.
   - That record's `DSH_CLIENT_BUILD_PROFILE` is `official`.
   - Every workspace declaring dependencies has a `node_modules` directory.

## Findings this change rests on

1. **The missing record is the tell.** plus-rc29 carries `.dsh-build/client-build-environment.json` with `DSH_CLIENT_BUILD_PROFILE: official`; plus-rc30 built with `build:web` had no such file.
2. **The artifact count differs.** `build:web` logged 240 client artifacts; `build --profile official` logged 248 and "4 public value(s)".
3. **The guard is a silent return.** `ui-brand-official` returns when the variable is absent rather than throwing, so a mis-built client is indistinguishable from a correctly built one except by its brand text.
4. **The fallback is locale-owned.** `packages/client/locale/src/locales/zh.ts` defines `'brand.localBuild': 'DSH 本地构建'`, which is the string the mis-built mirror rendered.
5. **The install must run twice when a patch adds a dependency.** The second run creates the workspace-local links for dependencies a patch appended to a manifest. Measured: a single install left `packages/experimental/agent-team/node_modules` absent and the Agent Teams plugins failed with `ERR_MODULE_NOT_FOUND` for `@deepseek-ai/schemastery`.

## Acceptance criteria

- A mirror is built by `dsh-plus-build`, never by a package filter.
- The build fails when `DSH_CLIENT_BUILD_PROFILE` is not `official` in the build record.
- The build fails when a workspace that declares dependencies has no link directory.
- A promoted mirror's sidebar brand reads "deepseek HARNESS", checked before the port is switched.

## Alternatives considered

**Set `DSH_CLIENT_BUILD_PROFILE=official` by hand around `build:web`.** Rejected: it duplicates the injection the build script owns, and the next client-only rebuild would have to remember it again.

**Check the rendered string in the bundle.** Rejected as the primary check: the brand renders through components rather than a literal, so the build record is the reliable signal. The rendered brand stays as the final acceptance check on the promoted port.

**Rebuild only the client.** Rejected: the record is written by the full build, and a client-only rebuild would leave it describing a different artifact set than the one being served.

## Risks

**The script is slower than the filter it replaces.** It runs the full build, which is the point, and takes minutes rather than seconds.

**The dependency check walks every workspace manifest.** It costs seconds and must run against the mirror being promoted.

**A brand regression can still ship if the check is skipped.** The check reads the build record, so a mirror built by another path reaches the port with no record and no verification; the promotion script is what has to call this one.
