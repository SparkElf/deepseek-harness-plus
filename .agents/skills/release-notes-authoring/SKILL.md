---
name: release-notes-authoring
description: Use before creating, publishing, or materially rewriting any Plus GitHub Release. Produce complete user-facing release notes from the exact tag, artifacts, accepted functionality, compatibility, and verification evidence.
---

# User-Focused Release Notes

Release notes are the complete user-facing record of one shipped version. They help a reader decide whether to install or upgrade, understand every material change, use the new behavior, and recognize the release limits without reading pull requests or source code. Public Plus releases are bilingual in Chinese and English so both audiences receive the same complete account.

## Start from the release boundary

Establish the exact tag, commit, assets, merged pull requests, and verification evidence before writing. For a historical release, reconstruct facts from that release's tag and contemporaneous records. Do not describe later functionality as if it shipped earlier, and do not use the current branch as a substitute for the tagged version.

Before finalizing that boundary, complete the human upstream-tracking confirmation and report required by [the npm release sequence decision](../../notes/implemented/process/2026-08-10-npm-release-sequences.md). When tracking proceeds, the release notes name the upstream release and commit plus every user-visible compatibility or migration effect; when it is declined, they record the opt-out and the newest upstream target known at that decision.

## Separate the summary from the details

Open with one short paragraph that states the release theme and practical value. The opening is orientation, not the feature list. A Highlights section, when useful, remains brief and never replaces the complete changes below it.

After the opening, document every material user-facing change in full. A release note is incomplete when the reader must inspect PRs to discover shipped functionality.

## Describe changes through user experience

For each material change, explain:

- the user need or friction it addresses;
- where the user encounters it;
- what the user can do after upgrading;
- the normal interaction or workflow;
- meaningful platform or deployment differences;
- how it relates to existing behavior;
- any limitation that affects use.

Lead with observable results. Include module or protocol names only when they help the reader understand ownership, compatibility, configuration, or troubleshooting.

## Bilingual publication

Write one complete Chinese section followed by one complete English section, separated clearly in the same GitHub Release. Keep headings, feature coverage, workflows, platform information, compatibility, limitations, evidence, artifact metadata, and links equivalent across languages. Neither language may be a summary of the other. Translate for natural reading without adding claims or changing release scope.

## Default template

Start from [TEMPLATE.md](TEMPLATE.md) for every new or rewritten release. Keep its bilingual section order so releases remain comparable over time. Replace every placeholder, add one subsection per material change in both languages, and delete a section only when it genuinely does not apply to either language. Do not replace either language's complete feature section with Highlights.

## Required sections

Use the template headings appropriate to the release, while covering these subjects:

1. **Version summary**: one concise statement of the release's value.
2. **Who should install or upgrade**: practical audience and upgrade reasons.
3. **Complete feature and behavior changes**: one substantial subsection per material change.
4. **User workflow or migration**: first-run, upgrade, configuration, or changed interaction steps when applicable.
5. **Downloads and platform support**: exact artifact names, supported platforms, and links.
6. **Compatibility and limits**: unchanged contracts, unsupported platforms, deferred capabilities, and operational constraints.
7. **Not included**: nearby roadmap items that a reader could reasonably mistake as shipped.
8. **Verification evidence**: real UI results, focused checks, packaging results, and public asset validation.
9. **Related changes**: relevant PRs, migration guides, or tagged source links.

Do not force an empty section when it does not apply. Do not omit a subject that affects install, upgrade, use, or expectation.

## Completeness check

Build a private inventory from the tagged diff, merged PRs, release artifacts, and accepted user walkthroughs. Map every material item into the release notes or classify it as internal-only. Reconcile the final notes against that inventory before publishing.

A broad theme does not count as coverage for its individual features. For example, calling a release a desktop-workflow update does not replace documenting its settings, lifecycle, recovery, platform, and operator-facing changes when those are independently useful to users.

## Evidence and claims

Match each availability claim to evidence at the same level:

- a user workflow uses real UI or end-to-end acceptance evidence;
- a platform package uses a built artifact from the matching platform;
- a public download uses the final release URL and a successful retrieval;
- compatibility claims use the tagged implementation and durable records;
- deferred work is labeled plainly and is not presented as partially available.

Do not turn test counts into the main story. Put evidence after the functional explanation so it supports the release instead of replacing it.

## Writing quality

- Write for users and operators, not only maintainers.
- Prefer concrete outcomes and steps over slogans.
- Define unavoidable technical terms on first use.
- Use tables for platform downloads, before/after comparisons, or compact compatibility information.
- Keep the opening concise and the feature sections complete.
- Avoid implementation diaries, hidden reasoning, raw command logs, and speculative edge cases.
- Keep limitations visible rather than burying them at the end of a long paragraph.

## Historical release rewrites

When improving an existing release description:

1. Read the current release and its assets.
2. Inspect the exact tag, original PRs, release-time docs, and verification records.
3. Reconstruct what users actually received at that version.
4. Rewrite the complete document using the same standard as a new release.
5. Preserve valid checksums, artifact names, dates, links, and limitations.
6. Verify the edited release online after publication.

Never rewrite history to match current behavior. Later releases may be named only to clarify that a capability was not yet included.

## Final publishing checklist

- The notes started from [TEMPLATE.md](TEMPLATE.md), preserve its applicable bilingual section order, and contain no placeholders.
- Chinese and English contain equivalent features, workflows, compatibility, limitations, evidence, artifact metadata, and links.
- The opening in each language is a concise summary, not a compressed substitute for the body.
- Every material user-facing change has a complete subsection.
- A reader can decide whether and how to upgrade without opening a PR.
- Artifact names, links, sizes, checksums, platforms, and signing status are accurate where included.
- Compatibility, limitations, and excluded roadmap items are explicit.
- Verification supports all material claims.
- Historical notes match their tag rather than the current branch.
- The published GitHub Release was read back and checked after editing.
