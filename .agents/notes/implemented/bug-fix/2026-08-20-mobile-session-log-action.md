# Agent Note: Compact mobile Session log action

Status: implemented

English | [中文](2026-08-20-mobile-session-log-action.zh.md)

## Problem

The desktop Session log capsule consumed 111px in the phone header. Combined with session actions and tabs, it compressed the title and left the download action visually detached from the mobile sidebar control at the upper-right edge.

## Decision

The export package keeps its 111×32 text-and-border capsule above 640px. At phone widths it owns a borderless 28×28 download icon with the same `Session log` accessible name and the same download controller. While Better Sidebar is collapsed, the icon follows its fixed control geometry: `top: calc(3px + env(safe-area-inset-top))`, `right: 42px`, and `z-index: 45`. Better Sidebar's 28×28 expand button sits at `right: 10px`, leaving a stable 4px gap.

The slot assignment does not change: Session log remains a `conversation.session.header.utilities` contribution. The export package owns both its responsive chrome and its collapsed-shell alignment; when Better Sidebar is open, the button returns to ordinary Header utility flow.

## Alternatives considered

- **Remove the Session log action on phones.** Rejected because exporting a conversation remains a valid mobile workflow.
- **Move the action into the tab row.** Rejected because download is a Session utility, not a view, and would make tab geometry depend on an optional plugin.
- **Keep the icon in ordinary Header flow.** Rejected because Better Sidebar's 78px reservation covers a possible two-button cluster, while the narrow layout renders one button and leaves a measured 34px visual gap.

## Consequences

The mobile header regains 83px of horizontal room, while the download command remains one tap away beside the upper-right sidebar control. Desktop presentation, ZIP generation, dialogs, and the `/export` command remain unchanged.

## Testing

The Pixel 7 system flow verifies the visible Session log button remains accessible, no wider than 28px, and within 6px of Better Sidebar's expand control, then captures the active header and composer controls. Existing GUI and Web replay suites continue to cover export behavior and desktop accessibility.
