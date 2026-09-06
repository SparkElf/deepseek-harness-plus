# Agent Note: Composer popovers stay inside the center column

Status: implemented

English | [中文](2026-09-06-composer-popovers-stay-inside-center-column.zh.md)

## Problem

The composer permission and model menus used their trigger and the browser viewport as horizontal placement references. A collapsed navigation rail still occupies the viewport's left edge, so a menu could satisfy the viewport margin while extending across the rail. Breakpoint-specific alignment changes moved a menu to the opposite side of its trigger but did not define the usable horizontal interval or shrink a menu when that interval was narrower than its design width.

## Decision

Portaled composer menus use the center column marked by `data-dsh-center-col` as an optional horizontal placement limit. `Menu` and `useAnchoredPosition` intersect that element's rectangle with the viewport, reserve 12px at both horizontal edges, clamp the measured menu into the remaining interval, and expose that interval as the menu's maximum width. `Menu` also lowers its design minimum width when necessary. Permission and model menus always use fixed body portals; compact mode controls dimensions rather than deciding whether collision handling exists.

The shared primitives continue to use viewport placement when no horizontal limit is supplied, including the feedback editor behavior described by [the feedback popover decision](2026-08-13-feedback-note-editor-popover.md). A `ResizeObserver` tracks a supplied limit so sidebar or column width changes reposition an open menu without waiting for a window resize.

The Plus mobile Web source patch owns the required `ui-primitives`, `ui-conversation`, and `ui-model-selection` changes relative to official revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`.

## Alternatives considered

**Clamp only to the browser viewport.** This prevents off-screen pixels but treats the navigation rail as usable overlay space, which is the visible defect.

**Switch from start alignment to end alignment at a breakpoint.** Alignment chooses an initial side of the trigger; it cannot express the center column's two edges and moves discontinuously when the breakpoint changes.

**Use the composer card as the horizontal limit.** The card has additional content padding and can be much narrower than the available center column, forcing unnecessary menu truncation. The center column is the element whose left edge is the rail boundary and whose right edge is the application boundary.

## Consequences

Menus remain near their triggers when space permits, but the center column takes precedence when a trigger-aligned rectangle would cross either edge. At very narrow widths both menus shrink to the same available interval instead of covering navigation. The shared placement APIs gain an optional element reference and end alignment, while callers that omit the reference retain their viewport behavior.

The Plus Playwright system acceptance opens both composer menus at 390x844 and compares their browser rectangles with the real center column. Console, page, request, and HTTP diagnostics remain enforced by the existing runner.
