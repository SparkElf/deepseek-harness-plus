# @sparkelf/dsh-patch-session-log-trajectory-toolbar

English | [中文](README.zh.md)

This data-only package places the official Session-log download action immediately before Trajectory search on desktop screens. The action uses the Trajectory toolbar's compact height, typography, colors, hover state, and focus treatment instead of the Session Header capsule. Screens up to 767 px retain the official Header position and styling.

The payload adds one typed Trajectory toolbar utility slot and registers a second presentation of the existing Session-log action into it. Both presentations use the same download controller, request, state, and dialog; the package does not add another export path or archive implementation.

The target is exact official source revision `0a53fb55bea101816fa226bb964ae2bed71c343b`. The payload is applied before that source tree is built. The package has no JavaScript entry, lifecycle script, Cordis plugin, compatibility adapter, or alternate variant.

Retire this package when official DSH exposes an equivalent Trajectory toolbar utility slot and places Session export before search on desktop while retaining the Header action on phones.
