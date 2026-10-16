# Agent Note: a platform-module name a plugin cannot resolve blanks its panel

Status: implemented

English | [中文](2026-10-16-unresolvable-platform-module-name-blanks-a-panel.zh.md)

# A platform-module name a plugin cannot resolve blanks its panel

## Problem

The host application statically bundles `@deepseek-ai/dsh-client-ui-primitives` as a platform
module (`packages/client/web/src/platform.ts`), so a plugin's
`require('@deepseek-ai/dsh-client-ui-primitives')` resolves to the host's copy, not the one in the
plugin's own tree. The two copies name the same glyphs differently: this repository's source uses
the drawn size (`IconSearchOutline16`), and the published line uses the weight
(`IconSearchOutlineRegular`).

A plugin built against this repository's source therefore compiles against a name the served host
copy may not export. The import evaluates to `undefined`, React throws error #130 ("element type is
invalid"), the slot entry unmounts, and the panel renders as an empty region. Measured 2026-10-16:
a Skill Center build importing `IconSearchOutline16` passed `tsc`, `tsdown`, and
`verify-client-ui-i18n`, then blanked the panel on deploy. The deployed host bundle exported
`IconSearchOutlineRegular` and not the `16` spelling.

No type check can see this. The compile-time module resolves through tsconfig paths to this
repository's `src`, where the name exists; only the serving bundle decides whether it exists at
runtime. The repository already carries the bridging aliases for four names
(`packages/client/ui-primitives/src/icons/index.tsx`), so the failure mode is a missing alias, not
a missing mechanism.

## Decision

`scripts/check-browser-platform-module-exports.mjs` reads the platform module's export table out of
the host bundle that will serve a plugin and reports every name the plugin's built `lib/client.js`
references but that bundle does not export. It resolves the served bundle by following
`$DSH_HOME/profiles/<profile>` into its release (`--served`), because several releases sit side by
side with identical filenames and only the linked one is served.

The check refuses to report a pass without a named plane. This repository's own `apps/web/dist`
exports the drawn-size and published spellings side by side, so a run against it succeeds whatever
the plugins reference; a result from that plane cannot show the mismatch the check exists to find.

Its default corpus is the `@sparkelf` family this fork publishes, selected by the manifest's own
scope. A package outside it is built and shipped by the distribution's own line, so its `lib/` here
is a different artifact from the one a deployment serves, and judging it against a deployment's
bundle reports the difference between two builds rather than a defect in this repository.

`scripts/check-skill-center-panel.mjs` opens the panel in a real browser and asserts the outcome
that matters: cards render, no React #130 or crashed slot entry reaches the console, the search box
is the shared Input atom with a brand-coloured focus ring and narrows and restores the list, every
card carries exactly one line of copy, the detail dialog renders the skill body with its frontmatter
stripped, and no translation batch is left incomplete. The panel is hidden at a complete batch by
design, so the check asserts the absence of a partial count rather than the presence of the bar.

Both are exposed as `pnpm run verify:platform-module-exports` and
`pnpm run verify:skill-center-panel`. Neither is registered in `scripts/run-gates.ts`: the export
check reads a deployment's profile link, which a CI runner does not have, so registration would
produce an unrunnable gate rather than a finding. They are deployment-time checks.

## Consequences

A missing alias is now caught before a deploy instead of by a blank panel, and the same check
found a second instance of the class: `packages/plus/subagent-settings` imported
`IconChevronDownOutline14` while the served bundle exports `IconChevronDownOutlineRegular`. That
package was not installed, so it had not failed yet.

The check reports a name mismatch, not a rendering defect: a plugin can pass it and still be
miswired in another way. The browser check covers that, and it needs a running deployment, so
neither replaces a real lookup of the panel.

Reading an export table out of a minified bundle is structural and would need revisiting if the
bundler emitted the platform module differently. The check throws when it finds no table rather
than passing, so that change surfaces as a failure to read rather than a silent pass.

## Alternatives considered

**A declaration file for the runtime JavaScript check.** The repository pairs no `.mjs` script with
a `.d.mts`, and the established arrangement for a scripts spec importing runtime JavaScript is a
stated `@ts-expect-error` (`scripts/python-snapshot-workflow-order.spec.ts`). Adding the first
declaration pair to satisfy one import would establish a second convention for the same problem.

**Asserting on the repository's own build.** It is the cheapest plane to reach, and it is the one
that cannot fail for the reason the check exists: it is built from the source the plugins compile
against.

**Registering the checks in the gate runner.** CI has no deployment, so the export check would fail
on a missing profile link rather than on a plugin defect, and a gate that cannot run is worse than a
documented manual step.
