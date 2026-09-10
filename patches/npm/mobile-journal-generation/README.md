# @sparkelf/dsh-patch-mobile-journal-generation

English | [中文](README.zh.md)

This data-only package keeps a replaced Mobile Bridge journal generation closed until its opening snapshot arrives. Buffered live entries from the new carrier cannot replace the published Session window before that snapshot establishes the generation cursor.

The target is exact official source revision `183f08e9c6dde7e36cd2318eaee70b0da08fb35e`. The payload changes the API Gateway journal stream and its existing Client test only; responsive layout, Sidebar, Composer, and Mobile Bridge transport remain in their current owners.

Retire this package when official DSH ships the replacement-generation ordering behavior.
