# @sparkelf/dsh-patch-mobile-journal-generation

English | [中文](README.zh.md)

This data-only package keeps a replaced Mobile Bridge journal generation closed until its opening snapshot arrives. Buffered live entries from the new carrier cannot replace the published Session window before that snapshot establishes the generation cursor.

The target is exact official source revision `5dda764ed3aa172535a7967b06ff95d9cbfe536a`. The payload changes the API Gateway journal stream and its existing Client test only; responsive layout, Sidebar, Composer, and Mobile Bridge transport remain in their current owners.

Retire this package when official DSH ships the replacement-generation ordering behavior.
