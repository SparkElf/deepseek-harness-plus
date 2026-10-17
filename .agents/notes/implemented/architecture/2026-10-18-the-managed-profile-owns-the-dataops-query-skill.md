# Agent Note: The managed profile owns the DataOps query skill

Status: implemented

English | [中文](2026-10-18-the-managed-profile-owns-the-dataops-query-skill.zh.md)

## Problem

The DataOps query skill shipped inside `@sparkelf/dsh-plugin-dataops`. That package stopped being
composed: it left the profile bundles when DataOps moved to the managed workspace profile, whose
companion mounts `@sparkelf/dsh-dataops-managed`. The removal was deliberate — DataOps tools cross
a distinct trust boundary and a standalone profile owns its own `DSH_HOME` with no DataOps identity
to carry.

Nothing forced a later contributor to notice. The package stayed in the workspace glob, kept a
`tsdown` entry, a `tsconfig.base.json` path mapping, `docs/config-catalog` section, and two
`slot-catalog` entries, so it read as a package still in use. The skill added to it therefore built
and published on every release and reached no catalog. A user asking a data question got no
guidance, and the panel showed the two bundled skills that do resolve.

## Decision

The managed integration owns the skill, because it is the DataOps plugin a deployed profile actually
mounts and a data question is its own subject. `dsh-dataops-managed` declares `dataops-query`
through the `skills` service it already injected, describes it for the catalog without reading the
body, and serves the body from the package on demand. `files` carries the document so it ships in
the tarball beside `lib/`.

`packages/plus/dataops` is removed. The capability owner is one package: keeping an unused layer
that still builds is what let the skill land where nothing composed it.

## Verification

- `pnpm --filter @sparkelf/dsh-dataops-managed run build` succeeds and `lib/index.js` contains the
  registration.
- `npm pack --dry-run` lists `skills/dataops-query/SKILL.md` (3.1 kB) in the tarball.
- The added test activates the plugin and asserts it registers exactly one provider and that the
  provider's document is readable from the package.
- `gen-config-catalog --check` and `gen-client-catalog --check` are clean; `verify-md-links`
  resolves every relative cross-link.

## Consequences

A deployed DataOps workspace now lists the query skill beside the bundled set, and its guidance
reaches the model without a tool call. The skill moves with the integration: any profile that
mounts `dsh-dataops-managed` carries it, and no profile carries it otherwise.

The removal drops the client `DataOpsSection` and `DataOpsExpiryModal` registrations. No deployed
profile mounted them, so no user-visible surface changes; `slot-catalog` regenerates without their
entries and the contract narrows to what ships.

`@sparkelf/dsh-plugin-dataops` is no longer a workspace package, so `tsconfig` path mappings, the
profile fixture list, and the lockfile entry are gone. A future capability that belongs to DataOps
goes into the managed package, which is what a deployed profile composes.

## Alternatives considered

**Re-add the package to the profile bundles.** This restores the skill where it sits, but reverses
the trust-boundary decision that removed it: a standalone profile owns its own `DSH_HOME` and has
no DataOps identity, so mounting the plugin there composes a node the profile cannot use.

**Publish the skill as its own package.** A skill-only package needs no Host or Client half, but it
would still need a profile to mount it, and the managed integration is already that mount point.
It also splits one capability across two release trains for no runtime gain.

**Keep the package and mark it unused in its README.** The build and path mapping would keep the
same false signal that let the skill land there; deleting the package removes the trap.

## Recorded facts

- Two `activation.test.ts` cases fail on `master` before this change: they expect four settings
  routes while the plugin registers `/integrations/dataops/tool-timeout` as a fifth. The failure is
  unrelated to the skill and is left as found.
- `docs/config-catalog.zh.md` had drifted from its English source in three blocks
  (`ui-skill-center` missing `translationRoot`, `permission-presets` saying `never` where the source
  says `allow`, and `user-approval` missing the `'allow'` policy). Regenerating the English side
  surfaced them; both sides are now consistent.
