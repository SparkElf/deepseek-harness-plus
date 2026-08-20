# Agent Note: Mobile composer preserves command controls

Status: implemented

English | [中文](2026-08-20-mobile-composer-command-controls.zh.md)

## Problem

On phone viewports, the composer trailing group kept its desktop intrinsic width. A long selected model and reasoning label could extend beneath the context indicator and send button, and the model menu was clipped by that slot after opening. Touch activation also left focus Tooltips visible above command buttons, covering the compact composer after the command had already run. The active-session transcript fade looked like a glow behind the docked composer, while the new-session hero headline wrapped and its intended blue glow followed the outer stack instead of the input card.

## Decision

The composer keeps command, context, and primary controls in stable tracks at widths up to 640px. The model slot alone takes the remaining width: its trigger label truncates there while its floating menu remains visible outside the slot. No model text, mode state, or command is hidden. Active sessions omit the desktop transcript fade at these widths. The new-session headline uses one fixed mobile type size and never wraps; its glow follows the actual input-card width and increases ellipse alpha only at the mobile breakpoint.

`Tooltip` distinguishes commands from explanations through the anchor's existing `onClick`. Command bubbles dismiss after activation while focus remains on the command. Anchors without a command keep their focus bubble, so an `aria-disabled` mobile control can still explain why it is unavailable. Consumers may explicitly opt out through `dismissOnClick={false}`.

## Alternatives considered

- **Hide model or reasoning labels on phones.** Rejected because the selected route is necessary context before sending and truncation preserves more information without covering commands.
- **Shrink every trailing control.** Rejected because send/stop and context progress require stable touch and reading dimensions.
- **Dismiss every focus Tooltip on touch.** Rejected because unavailable controls such as Better Sidebar rely on focus to explain their requirement.
- **Remove the transcript fade at every width.** Rejected because desktop transcript and composer geometry still use the established fade; only the narrow active-session presentation creates the false glow.
- **Hide the Preview badge on phones.** Rejected because preview status remains product information and the headline can fit as one row with a fixed mobile type scale.

## Consequences

Long model names truncate before the context and primary controls instead of overlapping them, and opening the model selector exposes its complete menu. Activating command, stop, or send removes its Tooltip, while keyboard focus styling remains. Explanatory Tooltips for controls with no command remain available to touch and keyboard users. Active mobile sessions keep a quiet docked composer; the mobile new-session view retains a card-aligned blue glow and presents the brand mark, headline, and Preview badge on one row.

## Testing

The Mobile Bridge Playwright flow opens a real conversation at Pixel 7 width, verifies the visible model and primary controls do not intersect, opens the model menu through a touchscreen gesture, and verifies the complete menu is visible. It focuses the command control to expose its Tooltip, activates it through touch, and verifies the Tooltip closes. The paired phone starts a new session and verifies the localized headline occupies one line beside the Preview badge before returning to a real conversation. The same flow keeps console, page-error, failed-request, and unexpected server-error collection active.
