# Agent Note: Backup scans the Harness home, not the profile directory

Status: implemented

English | [中文](2026-10-05-backup-archives-the-harness-home.zh.md)

## Problem

The Backup plugin derived the directory it archives from the Settings document:
`dirname(ctx.settings.documentPath)`. That document is the profile's `cordis.patch.yml`, so the
archived root was the profile directory. Every planned entry is looked up by name in that one
directory, and the profile holds none of the user data: Session logs, attachments, Workspace
storage, `.credentials.yaml`, and `.anonymous-user-id` are written under the Harness home. The
only planned name present beside the document is the patch file itself.

The lookup is silent when a name is absent, so exports reported success while carrying almost
nothing. Measured on a deployment whose profile directory holds six files: a `sessions` export
produced an archive containing one entry, its manifest, and an `all` export contained two. Session
restore was therefore impossible from any archive the deployment could produce.

A configuration export carried the profile patch file, which `dsh-plus` rewrites whole on every
start. A deployment whose model providers are declared in `$DSH_HOME/cordis.patch.yml` — the
layer the loader applies last, and the location the promotion guide recommends because nothing
rewrites it — exported no provider at all. Importing that archive restored no model, which is
how the defect surfaced: a user moved a configuration between two deployments and found the
models missing.

## Decision

`apply` roots the archive at `resolveDshHome()`, the directory the loader reads as `$DSH_HOME`
and the one holding every archived kind of user data. The manifest's `settingsFile` remains the
Settings document basename, because import compares that against the receiving profile's
document.

`resolveDshHome` comes from `@deepseek-ai/dsh-home-paths`, added as a peer and dev dependency
with the tsconfig reference the repository convention requires.

## Alternatives considered

Deriving the root from the Settings document and treating the profile directory as the home was
the previous behavior; it is only correct where a deployment keeps its user data beside the
document, which no deployment does because the loader writes Sessions and storage under the
Harness home.

Archiving the profile layer in addition to the Harness home would carry a file the profile
owner rewrites on every start, so an import could reintroduce stale capability rows. The layer
that survives is the Harness home's own patch file, which is already archived as an ordinary
top-level entry.

## Tests

Two specs cover the two halves the fix touches. `archive.spec.ts` asserts the planner's entries
per scope and that the archived bytes come from the scanned root; `index.spec.ts` asserts the
root `apply` chooses, since the planner takes that root as an argument and cannot observe it.
Reverting the root fails `index.spec.ts` with the profile path. The package previously had no
tests, which is why a root that archived almost nothing went unnoticed.
