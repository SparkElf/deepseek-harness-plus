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
- Read the owning `AGENTS.md` and, for Plus Desktop, `apps/plus-desktop/README.md` and its preview verifier.

The Plus Desktop renderer is plain HTML, CSS, and JavaScript, so it cannot import React components directly. Reuse the same icon paths, dimensions, state semantics, and token mapping. Do not invent a visually similar second component system.

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

- the 980x780 renderer has no window or workspace overflow
- the centered 1440x900 preview uses the inverse outer canvas and a borderless card with the intended shadow
- light and dark themes keep the same control geometry
- each styled menu opens, selects, closes, returns focus, and reflects dynamic options
- one trailing checkmark appears for the selected option and none for unselected options
- console and network output remain clean
- the Electron package includes changed renderer and main-process files

Wait for entry animations before screenshots. A screenshot is evidence of a visible result, not a substitute for operating the UI. State which native OS behaviors still require Windows or macOS acceptance.

## Review Questions

- Can the user identify the next action without developer-facing explanation?
- Do selected states match the settings component rather than the browser native highlight?
- Are arrows and checks the same icon language as existing Harness UI?
- Does the layout remain stable when options, errors, or custom fields appear?
- Does every border, shadow, gradient, and animation serve hierarchy or state?
- Is the feature using an existing owner and component contract rather than a parallel global style system?
