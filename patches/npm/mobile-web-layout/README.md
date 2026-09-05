# @sparkelf/dsh-patch-mobile-web-layout

English | [中文](README.zh.md)

This data-only package completes the responsive official Web shell. At AppFrame widths up to 640px, a user-expanded main navigation column owns exactly half the measured frame, the conversation owns the other half, details stays closed, and the sidebar drag handle is absent. Composer controls compact in stages, while permission and model popovers stay inside the center column with 12px clearance from the collapsed rail and right edge; when that interval is narrower than the menu, the menu shrinks to fit. The collapsed 56px rail, tablet behavior, desktop drag preference, Session selection, and Workspace addition remain official and unchanged.

The target is the exact official source base `d347e703908d0406b7a7ef80e3a0e594d86b2215`. The payload owns the responsive AppFrame, composer controls, shared popover placement primitives, model menu, and permission menu required by this behavior. The package has no JavaScript entry, lifecycle script, or fallback variant.

Retire this package when official Web ships equivalent phone navigation, compact composer controls, and center-column popover placement.
