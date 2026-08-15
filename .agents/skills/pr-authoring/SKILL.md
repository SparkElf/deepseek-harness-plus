---
name: pr-authoring
description: Use before creating or materially rewriting a Plus pull request. Write a visually clear, beginner-friendly teaching document that explains the user result, evidence, risks, and review decision without exposing internal reasoning.
---

# Beginner-Friendly PR Authoring

A pull request is a teaching document for a reader who did not watch the work happen. Write it so a first-time contributor can answer four questions without reading the diff first:

1. What user problem does this change solve?
2. What can a user do differently after it merges?
3. What evidence shows that claim is true?
4. What is deliberately not included or still needs a decision?

Do not narrate hidden reasoning, tool calls, retries, private prompts, or implementation diary entries. Explain the result and the decision a reviewer needs to make.

## Reader-first order

Use this order unless the repository template requires a stricter heading:

1. **At a glance**: one short paragraph naming the user, the problem, and the outcome.
2. **Why it matters**: explain the concrete friction in plain language.
3. **What changes for the user**: describe the visible workflow in before-and-after terms.
4. **How it works**: give a short guided walkthrough of the main pieces. Define unfamiliar words on first use.
5. **What proves it**: connect each important claim to a command, CI run, artifact, or real UI path.
6. **What is not included**: list deferred work, release limits, assumptions, and recovery boundaries.
7. **Review decision**: state exactly what a reviewer is approving and what remains for a later PR.

When the project template has required evidence sections, preserve them and write the reader-first walkthrough before or within those sections. Never delete required governance evidence to make the PR shorter.

## Plain-language rules

- Lead with the user result, never package names, file paths, or framework terminology.
- Introduce a technical term only when it changes a reader's decision. Explain it in one plain sentence the first time.
- Prefer "the desktop helper starts the local Harness page" over "Electron main process owns daemon lifecycle". Keep the latter only in the architecture section when it matters.
- Replace vague claims such as "improves reliability" with an observable result such as "the selected model now reaches child agents".
- Do not call planned work available. Use explicit labels: **Available now**, **Verified in CI**, **In development**, **Deferred**, or **Needs human approval**.
- Do not make a release sound ready when signing, approval, platform verification, credentials, or distribution work remains.

## Markdown layout

Use GitHub Markdown as a teaching surface:

- Use short headings with an emoji only when it helps scanning. Do not decorate every line.
- Use a two- or three-column table for compact comparisons such as before/after, platform/artifact/status, or claim/evidence.
- Use bullet lists for steps and decisions; keep each bullet to one idea.
- Put long command output, raw logs, and low-level file inventories inside a `<details>` block with a useful summary.
- Link directly to CI runs, artifacts, relevant files, Agent Notes, and diff records.
- Include an image only when it lets a reader inspect a real user-facing state, such as an installer step or a visual change. Give it descriptive alt text. Do not use decorative images as evidence.
- A screenshot supports explanation; it never replaces a functional result or verification command.

## Evidence map

For every material claim, give the smallest useful proof:

| Claim type | Good evidence |
| --- | --- |
| User workflow changed | A real UI path with visible before-and-after result |
| Core behavior changed | Focused regression coverage and the affected diff record |
| Installer package exists | CI artifact name, target platform, and package-format inspection |
| Public release is ready | Required checks, human approval, signing/distribution status, and release link |
| Planned capability | A clear deferred label and a link to its proposal or roadmap |

Do not present a passing syntax check as evidence that a user workflow works. Do not present an image as evidence that an installer, release, preset, or deployment exists.

## Synchronize existing PRs before changing PR topology

An aggregate or review branch is an integration workspace, not automatically a new pull-request boundary. Before creating, closing, replacing, or consolidating a PR, compare the complete accepted local change with every live PR head and classify each missing change by the PR that owns its user result.

When the user has identified existing PRs as the desired review units and the aggregate branch contains later completed or accepted work, treat a remote PR that lacks that work as stale. Update the original PR branch with the complete owned implementation, tests, documentation, and follow-up fixes. Preserve its PR number, review history, base, and purpose; use a lease-protected rewrite when its history must be rebuilt. Remote lag is a synchronization defect, not evidence that the accepted local work needs a replacement PR.

Do not close an existing PR, substitute an aggregate PR, change the PR split, or create a competing release line unless the user explicitly asks to change that topology. Before opening any new PR, prove that no existing user-selected PR owns the change.

## Plus-specific PR guidance

Describe Plus in the language users care about:

- **Timely fixes** for upstream bugs that block real work.
- **Early feature access** for optional experimental capabilities.
- **Practical extensions and presets** for concrete workflows.

Treat upstream tracking, core/community diff records, plugin composition rules, and governance as the reason these promises remain understandable and maintainable. They are supporting context, not the opening pitch.

For a release PR, make the decision explicit:

- Which operating systems and artifact formats are actually being released.
- Which package is only a CI artifact and why.
- Whether signing, notarization, or an approval gate still blocks distribution.
- Whether a maintainer must use a bypass and why that bypass is auditable.

## Final author checklist

- A new contributor can summarize the PR after reading only the first two sections.
- Existing user-selected PRs contain every completed local change they own; no stale remote head was replaced merely because an aggregate branch was newer.
- Every release or availability claim matches the current repository state.
- Each required template heading is present and populated.
- Evidence links are readable without searching the repository.
- Deferred work is visible and not buried in a log block.
- The PR contains no secret, hidden prompt, personal workspace path, or internal reasoning transcript.
