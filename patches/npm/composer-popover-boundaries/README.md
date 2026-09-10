# @sparkelf/dsh-patch-composer-popover-boundaries

English | [中文](README.zh.md)

This data-only package keeps the official composer Permission and Model portal menus inside the AppFrame center column. It adds a private center-owner marker, lets the shared Menu intersect viewport placement with an owner boundary, and applies the same calculation to the specialized Model card. Both menus retain 12px horizontal clearance when Sidebar or right-panel widths leave a narrow center.

The target is exact official source revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. The payload contains only the focused production changes, owning package contracts, and existing component and Web user-path coverage; it does not restore the retired Plus mobile layout, Sidebar, Settings, Jobs, Schedule, or responsive-column changes.

Retire this package when an official DSH release contains the center-boundary behavior from the corresponding upstream contribution.
