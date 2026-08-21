# Agent Note: Phone navigation stays half-width

Status: implemented

English | [中文](2026-08-20-phone-navigation-half-width.zh.md)

## Problem

The manually expanded main navigation reused the 280px desktop preference on phone frames. At a 412px viewport it occupied about 68% of the screen, leaving the conversation too narrow for repeated work. Automatically closing it after choosing a Session or adding a Workspace would recover space but interrupt follow-up navigation that the user had explicitly opened.

## Decision

AppFrame now owns the `data-dsh-frame` marker used to observe and integrate its rendered grid. At frame widths up to 640px, it resolves a manually expanded main navigation column to exactly half the measured frame width. The collapsed state remains the 56px control rail and details remains closed. Because the phone width is derived rather than a stored drag preference, AppFrame does not render the sidebar drag handle in this mode. Frames from 641px through the existing narrow breakpoint retain their current stored-width behavior.

The navigation remains expanded across Session selection and Add Workspace completion. Those operations continue to own only their Session or Workspace result; only the main shell toggle mutates `narrowExpanded` and collapses the navigation.

## Alternatives considered

- **Keep the 280px desktop preference on phones.** Rejected because it leaves only 132px at Pixel 7 width and forces conversation controls into unusable compression.
- **Auto-collapse after every Session or Workspace choice.** Rejected because users often perform several navigation actions in sequence and explicitly opened the navigation to do so.
- **Make the phone half-width column draggable.** Rejected because the rendered half width is a responsive rule rather than the persisted desktop preference; a handle that cannot retain its result is misleading.

## Consequences

An expanded phone navigation and conversation each receive half the frame. Users can select multiple Sessions, add a Workspace, search, or continue other navigation actions without reopening it. The conversation receives the full frame only after the user activates the collapse control. Desktop drag widths and tablet narrow behavior are unchanged.

## Testing

The AppFrame tests pin 412px expansion to 206px, preserve the 56px rail, omit the phone drag handle, and retain the 980px behavior. The Pixel 7 system flow selects a started Session and completes Add Workspace while asserting the navigation remains half-width, then activates Collapse sidebar and verifies the rail settles before testing Better Sidebar and composer geometry.
