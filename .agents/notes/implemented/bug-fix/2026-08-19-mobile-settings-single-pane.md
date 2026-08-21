# Agent Note: Mobile Settings uses a list-to-detail panel

Status: implemented

English | [中文](2026-08-19-mobile-settings-single-pane.zh.md)

## Problem

The Settings dialog keeps a 188px navigation rail inside an 800px desktop panel. At a phone viewport, the panel shrank to the viewport minus 48px while the rail kept its desktop width, leaving roughly 150px for every section. Labels wrapped one character per line, controls overlapped their copy, and the inset rounded panel spent additional space without helping navigation.

Settings contains more sections than a stable horizontal tab row can carry. Showing the complete navigation and one usable form at the same time is therefore not a valid phone layout.

## Decision

The Settings overlay portals to document.body so the Sidebar's containing block cannot inset a supposedly full-screen panel. At viewport widths up to 640px, Settings fills the dynamic viewport without a card edge or shadow and presents one task at a time. Opening the dialog shows the complete section list. Selecting a row replaces the list with that section at full width; the detail header carries a back control, the selected section label, and the always-available close control. The section body owns vertical scrolling and cannot widen the page.

The existing local active-section id also owns list-to-detail navigation. An undefined id means the list on mobile while desktop continues to derive and render the first section. A section opened by onboarding supplies its id and enters detail directly. No viewport store, resize subscription, duplicate route, or mobile-only section implementation exists.

Desktop retains the fixed navigation rail and content column. The breakpoint changes presentation and navigation depth, not section registration, settings data, or plugin ownership.

## Alternatives considered

- **Stack navigation above the active section.** The section list consumes most of a phone screen and makes every settings change start below a long, unrelated menu.
- **Use a horizontally scrolling tab strip.** Seven or more independently registered sections hide offscreen and require users to discover horizontal scrolling before they can navigate.
- **Keep both columns and reduce type or icons.** The content deficit is structural; smaller text would remain cramped and reduce touch and reading quality.

## Consequences

The mobile dialog has a predictable list and detail depth while every feature continues to register the same settings.section entry. The close button remains focusable in both views, the back control is named by the Settings heading, and the selected section label remains visible in detail. Desktop behavior and plugin section APIs do not change.

## Testing

The project Mobile Bridge Playwright command pairs a Pixel 7 through the deployed relay, opens the real Harness Settings dialog, verifies full-viewport navigation without horizontal overflow, enters General, verifies its label remains horizontal at full content width, returns to the section list, and checks browser console and network health.
