# Agent Note: Mobile composer preserves command controls

Status: implemented

English | [中文](2026-08-20-mobile-composer-command-controls.zh.md)

## Problem

On phone viewports, the composer trailing group kept its desktop intrinsic width. A long selected model and reasoning label could extend beneath the context indicator and send button. Touch activation also left focus Tooltips visible above command buttons, covering the compact composer after the command had already run.

## Decision

The composer keeps command, context, and primary controls in stable tracks at widths up to 640px. The model slot alone takes the remaining width, and its existing label ellipsis applies inside that width. No model text, mode state, or command is hidden.

`Tooltip` distinguishes commands from explanations through the anchor's existing `onClick`. Command bubbles dismiss after activation while focus remains on the command. Anchors without a command keep their focus bubble, so an `aria-disabled` mobile control can still explain why it is unavailable. Consumers may explicitly opt out through `dismissOnClick={false}`.

## Alternatives considered

- **Hide model or reasoning labels on phones.** Rejected because the selected route is necessary context before sending and truncation preserves more information without covering commands.
- **Shrink every trailing control.** Rejected because send/stop and context progress require stable touch and reading dimensions.
- **Dismiss every focus Tooltip on touch.** Rejected because unavailable controls such as Better Sidebar rely on focus to explain their requirement.

## Consequences

Long model names truncate before the context and primary controls instead of overlapping them. Activating command, stop, or send removes its Tooltip, while keyboard focus styling remains. Explanatory Tooltips for controls with no command remain available to touch and keyboard users.

## Testing

The Mobile Bridge Playwright flow opens a real conversation at Pixel 7 width, verifies the visible model and primary controls do not intersect, focuses the command control to expose its Tooltip, activates it through a touchscreen gesture, and verifies the Tooltip closes. The same flow keeps console, page-error, failed-request, and unexpected server-error collection active.
