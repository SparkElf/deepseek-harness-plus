# @sparkelf/dsh-patch-session-history-search

English | [中文](README.zh.md)

This data-only patch makes the official SQLite Session content search usable with retained pre-release history. The v0 migration converts the historical flat pi-ai replay-state v1 record to the current `{ response, blocks }` envelope and promotes subagent descriptor v2 to v3, whose only schema addition was the optional reasoning-effort field. Message content, tool records, titles, and Workspace archive state are unchanged.

Large histories remain on the official JSONL-to-v2 path. Full-log Zstandard decoding reuses the existing multi-frame decoder, combines small outputs into bounded batches, and yields periodically. Session-format snapshots remember only objects already detached and frozen by their owner, so codecs and adjacent migrations can assemble those owned rows without repeatedly copying the same whole log.

SQLite reconciliation writes each changed persisted Session through an attempt savepoint as soon as it is observed, rather than retaining every Session document array until the full corpus has been read. The outer transaction still commits one stable corpus or rolls back it all; a changed source snapshot discards the attempt before retrying.

On the retained 166-Session, 623 MB corpus that exposed the issue, all historical logs migrated without error. The largest source collapsed from 3,500,551 v0 events to 122,575 v2 events in 4:49.86 with a 5.50 GiB peak; indexing all already-migrated Sessions took 58.42 seconds with a 3.64 GiB peak, and a warm content query took 0.74 seconds. These are observations from that corpus, not general performance guarantees.

The target is exact official source revision `d347e703908d0406b7a7ef80e3a0e594d86b2215`. This package contains no runtime JavaScript, alternate history reader, archive mutation, or fallback provider. Retire it when official DSH accepts these historical records and bounds full-corpus reconciliation equivalently.
