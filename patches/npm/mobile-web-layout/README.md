# @sparkelf/dsh-patch-mobile-web-layout

English | [中文](README.zh.md)

This data-only package adds the remaining responsive gap in the official Web shell: at AppFrame widths up to 640px, a user-expanded main navigation column owns exactly half the measured frame, the conversation owns the other half, details stays closed, and the sidebar drag handle is absent. The collapsed 56px rail, tablet behavior, desktop drag preference, Session selection, and Workspace addition remain official and unchanged.

The target is the exact official source base `d347e703908d0406b7a7ef80e3a0e594d86b2215`. Later official composer-control and model-menu mobile fixes are inherited and are not duplicated in this payload. The package has no JavaScript entry, lifecycle script, or fallback variant.

Retire this package when official AppFrame ships equivalent phone half-width navigation.
