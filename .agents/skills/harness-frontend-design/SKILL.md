---
name: harness-frontend-design
description: Design and verify Harness Web or Plus Desktop UI with existing tokens, primitives, and settings references before implementation.
---

# Harness Frontend Design

Use this skill for visible Harness Web, Electron, installer, tray, settings, and operational UI. Treat the product as a compact work tool: calm, scannable, and action-oriented. Do not begin from a screenshot approximation or a generic component pattern.

## Read First

- Read `docs/web-styling.md`.
- Read `packages/client/ui-theme/src/styles/` for semantic aliases, typography, motion, shadows, and theme values.
- Read `packages/client/ui-primitives/` for the exact icon, menu, button, focus, and check primitives.
- Read the nearest working settings or model-selection component for dimensions and state treatment.
- For folder selection, read `packages/client/ui-directory-picker-browse` and its browse capability before adding a dialog or native picker.
- Read the owning `AGENTS.md` and, for Plus Desktop, `apps/plus-desktop/README.md` and its preview verifier.

The Plus Desktop renderer is plain HTML, CSS, and JavaScript, so it cannot import React components directly. Reuse the same icon paths, dimensions, state semantics, and token mapping. A directory browser carries the existing browse contract through preload and main-process list, create, and select operations; do not substitute an unverified system dialog. Do not invent a visually similar second component system.

## Repository and GitHub Targets

- Resolve the target repository before any GitHub command. Check `git remote get-url origin` and confirm the community repository with `gh repo view SparkElf/deepseek-harness-plus`.
- Every `gh` command must include `-R SparkElf/deepseek-harness-plus`. Never let the CLI infer a repository when both `origin` and `upstream` exist. Use the explicit target for `gh pr`, `gh workflow`, `gh run`, `gh artifact`, and `gh release` commands.
- Treat Git SSH authentication and the GitHub CLI API token as separate credentials. Check `gh auth status` and repository permissions before diagnosing a PR or workflow failure; do not request token changes until the repository target is confirmed.
- When master is branch-protected, aggregate the work on one branch, create one PR, wait for required checks and artifacts, then merge through the target repository.

### Delivery Checklist

- Read branch rules before pushing with `gh api repos/SparkElf/deepseek-harness-plus/rules/branches/master`. Do not attempt a direct master push when the rules require a PR.
- A new workflow cannot be manually dispatched until GitHub recognizes it on the default branch. Give it a `pull_request` trigger, push one aggregate branch, and create the PR first.
- Include all repository-required PR evidence headings in the initial PR body. Read the failed check log before changing code when an evidence check fails.
- If `gh pr edit` fails on the deprecated Classic Projects GraphQL field, update the PR with `gh api repos/SparkElf/deepseek-harness-plus/pulls/<number> -X PATCH`.
- Distinguish required status checks from unrelated fork failures. Missing upstream GitHub App secrets, external API keys, and release credentials do not invalidate a passing native Windows installer job; record them and do not misdiagnose the product build.
- Query artifact metadata with `gh api repos/SparkElf/deepseek-harness-plus/actions/runs/<run-id>/artifacts`, then download with explicit repository, run ID, and artifact name.
- Build the standard Windows NSIS installer on a native Windows runner. A Linux or WSL host may build a portable Windows executable, but NSIS signing and helper packaging require Wine and are not final Windows installer evidence.

## Repository and GitHub Targets

- Resolve the target repository before any GitHub command. Check `git remote get-url origin` and confirm the community repository with `gh repo view SparkElf/deepseek-harness-plus`.
- Every `gh` command must include `-R SparkElf/deepseek-harness-plus`. Never let the CLI infer a repository when both `origin` and `upstream` exist. Use the explicit target for `gh pr`, `gh workflow`, `gh run`, `gh artifact`, and `gh release` commands.
- Treat Git SSH authentication and the GitHub CLI API token as separate credentials. Check `gh auth status` and repository permissions before diagnosing a PR or workflow failure; do not request token changes until the repository target is confirmed.
- When master is branch-protected, aggregate the work on one branch, create one PR, wait for required checks and artifacts, then merge through the target repository.

### Delivery Checklist

- Read branch rules before pushing with `gh api repos/SparkElf/deepseek-harness-plus/rules/branches/master`. Do not attempt a direct master push when the rules require a PR.
- A new workflow cannot be manually dispatched until GitHub recognizes it on the default branch. Give it a `pull_request` trigger, push one aggregate branch, and create the PR first.
- Include all repository-required PR evidence headings in the initial PR body. Read the failed check log before changing code when an evidence check fails.
- If `gh pr edit` fails on the deprecated Classic Projects GraphQL field, update the PR with `gh api repos/SparkElf/deepseek-harness-plus/pulls/<number> -X PATCH`.
- Distinguish required status checks from unrelated fork failures. Missing upstream GitHub App secrets, external API keys, and release credentials do not invalidate a passing native Windows installer job; record them and do not misdiagnose the product build.
- Query artifact metadata with `gh api repos/SparkElf/deepseek-harness-plus/actions/runs/<run-id>/artifacts`, then download with explicit repository, run ID, and artifact name.
- Build the standard Windows NSIS installer on a native Windows runner. A Linux or WSL host may build a portable Windows executable, but NSIS signing and helper packaging require Wine and are not final Windows installer evidence.

## Design Contract

- Use semantic Harness colors and typography. Keep light and dark themes as deliberate pairs.
- Use existing icons for arrows, chevrons, checks, window controls, and commands. Do not use text glyphs when an existing outline icon exists.
- Match the nearest settings component for control height, padding, radius, menu elevation, option spacing, selected checks, and focus treatment.
- A styled selector has one authoritative value field plus a trigger and listbox. Support click, Enter or Space, ArrowUp or ArrowDown, Escape, outside-click close, focus return, selected state, and dynamic option replacement.
- Keep labels user-facing. Technical architecture, package names, runtime ports, Git, pnpm, and implementation explanations belong in documentation, not the setup path.
- Prefer one clear primary action per step. Do not add explanatory paragraphs when a short label or visible result is sufficient.
- Do not nest page cards. Use framed cards only for repeated items, dialogs, or tools; use full-width bands for page structure.
- Keep stable dimensions for headers, steppers, fields, menus, action bars, and fixed-format previews. Normal content must fit without scrolling when the surface is fixed.
- A frameless Electron window needs a custom header and controls. The product card has no decorative white outline; a preview wrapper may provide shadow and radius only.

## Implementation

1. Define the user goal and the smallest visible path that completes it.
2. Locate the nearest existing Harness component and record its exact icon, spacing, state, and menu rules.
3. Define surface dimensions and overflow before writing CSS.
4. Implement the owner state first. Derive display text, selected state, and menu options from that owner; do not maintain a second selection state.
5. Implement loading, empty, failure, recovery, disabled, hover, focus, keyboard, and success states required by the path.
6. Keep comments contract-focused. Do not record visual trial and error in source comments.

## Verification

Use the project Playwright UI flow for the actual user path. For a fixed desktop installer, verify:

- the 900x680 renderer has no window or workspace overflow
- the centered 1440x900 preview uses the inverse outer canvas and a borderless card with the intended shadow
- light and dark themes keep the same control geometry
- each styled menu opens, selects, closes, returns focus, and reflects dynamic options
- one trailing checkmark appears for the selected option and none for unselected options
- console and network output remain clean
- Windows titlebar controls use Electron `titleBarOverlay`, while Linux and macOS retain native frames; do not reimplement them in renderer DOM
- minimize and maximize require an interactive Windows, macOS, or Linux desktop acceptance check; do not gate CI on hosted-runner window geometry or state events
- the Electron package includes changed renderer and main-process files

Wait for entry animations before screenshots. A screenshot is evidence of a visible result, not a substitute for operating the UI. State which native OS behaviors still require Windows or macOS acceptance.

## Review Questions

- Can the user identify the next action without developer-facing explanation?
- Do selected states match the settings component rather than the browser native highlight?
- Are arrows and checks the same icon language as existing Harness UI?
- Does the layout remain stable when options, errors, or custom fields appear?
- Does every border, shadow, gradient, and animation serve hierarchy or state?
- Is the feature using an existing owner and component contract rather than a parallel global style system?
