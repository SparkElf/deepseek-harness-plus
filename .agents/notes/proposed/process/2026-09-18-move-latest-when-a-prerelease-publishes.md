# Agent Note: Move latest when a prerelease publishes

Status: proposed

English | [中文](2026-09-18-move-latest-when-a-prerelease-publishes.zh.md)

## Problem

Every package in the Plus family published under `next` and left `latest` where it was. Measured on `@sparkelf/dsh-plus-standalone` after the 0.2.0-rc.7 release:

```
latest   0.1.0-rc.35   2026-09-15
next     0.2.0-rc.7    2026-09-18
```

The README's install line is `npm install -g @sparkelf/dsh-plus-standalone`, which resolves `latest`. A user following it received a build from before the distribution took its present form - different plugins, an older supervisor, and none of the patches added since. All twenty-two members were affected, each stuck at whichever version was current when its `latest` was last set.

## Why it stayed invisible

**The tag policy is deliberate and correct on its own.** `PlusFamily.distTagForVersion` returns `next` for a version containing a hyphen, so a prerelease never claims `latest` by accident. That is the right rule: a consumer asking for `latest` should not receive a release candidate because it happened to publish last.

**Nothing ever promoted one.** Every version this repository has published carries a prerelease suffix, so the rule fired every time and `latest` was never written after its first setting. The policy has no graduation step, and the release sequence documented in [npm release sequences](../../implemented/process/2026-08-10-npm-release-sequences.md) does not mention one.

**The failure mode is silent from every side the release watches.** Publishing succeeded, the mirror synced, every integrity check passed, and the version was installable by name. Only a consumer who omitted the tag got the wrong build, and their install succeeded too.

## Proposal

**Promote `latest` after publication, as a pass of its own.**

`scripts/release/publish.ts` gains `promoteLatest` and `promoteFamilyLatest`, called at the end of a publish run and available alone through `--promote-latest`.

- A member whose `distTagForVersion` is `latest` is skipped: it already published there.
- The current tag is compared first, so an already-correct tag is not rewritten.
- Promotion runs after the publish loop rather than inside it. The set is complete and consistent at that point, so a failure leaves a published release with stale tags - recoverable by re-running with `--promote-latest` - instead of a half-published one.
- A promotion failure names the package and the version it could not move, and does not report the publication as failed.

## Findings this change rests on

1. **All twenty-two members were stale, not just the entry point.** The audit read `dist-tags` for every tarball in `dist/npm`; each named an older version, most at `0.1.0-rc.35` and some at `0.2.0-rc.2`, `0.2.0-rc.4`, or `0.2.0-rc.5`.
2. **The rule is what prevents accidental promotion.** `distTagForVersion` returning `next` for a hyphenated version is correct; the gap is the absence of a deliberate promotion, not the presence of the rule.
3. **`--promote-latest` alone is safe and idempotent.** Measured against the published rc.7 set: 22 tags moved, and a second run would find each already correct and move none.
4. **The README command works once the tags are right.** A clean install of `@sparkelf/dsh-plus-standalone` with no tag installed 1011 packages and reported `0.2.0-rc.7`; before the promotion the same command resolved `0.1.0-rc.35`.
5. **`npm dist-tag add` is a separate write with its own failure mode.** It needs the version to exist, so it belongs after publication and cannot be folded into the publish call.

## Acceptance criteria

- A publish run leaves `latest` on the version it published, for every member.
- `--promote-latest` moves only the tags that trail their member's version, and is safe to run repeatedly.
- A member published under `latest` is not re-tagged.
- A promotion failure names the package and exits non-zero without reporting the publication as failed.
- Installing a member with no tag installs the version the release published.

## Alternatives considered

**Publish prereleases to `latest` directly.** Rejected: it makes a consumer asking for `latest` receive a release candidate the moment one publishes, which is the outcome the existing rule exists to prevent.

**Drop the prerelease suffix so versions publish to `latest` by the normal rule.** Rejected: the suffix is how a consumer distinguishes a candidate from a settled release, and it is what the version scheme is built on.

**Promote inside the publish loop.** Rejected: the loop already handles a member's publication idempotently, and adding a second registry write per member would make an interrupted run harder to reason about rather than easier.

**Promote by hand when someone remembers.** Rejected: this is what happened. The tags were stale for four days across three releases.

## Risks

**Promotion makes a release candidate the default install.** That is the intent for this repository, whose only releases are candidates, and it is why the promotion is a named step rather than a side effect of publishing. A repository that also ships settled releases would want the promotion conditional on the version having no suffix.

**A promotion failure after a successful publication is a new failure shape.** The release is complete but its tags are not, and finishing it needs `--promote-latest` rather than a full re-publish. The message names that command's effect; it does not name the command.

**The tag is read before it is written.** A concurrent publisher moving the same tag between the read and the write would be overwritten. Nothing else publishes this scope.
