# @sparkelf/dsh-patch-image-offload-hoist-replay

English | [中文](README.zh.md)

This patch makes a session readable when its `image/offload` decisions were recorded against image positions that only exist while `image/hoist` is mounted.

`image/hoist` is an out-of-repo request-time projection: it moves tool-result images onto an earlier user-role carrier without rewriting the durable message. A later `image/offload` counts image occurrences depth-first in the message the deciding request actually saw — the *projected* one. Those indexes therefore describe a carrier that already holds the tool images, and they stop resolving as soon as a reader folds the same log without the hoist projection.

`offloadMessageImages` treated an unresolvable index as fatal (`image/offload: image index 0 does not exist`), so one partially-valid payload aborted the whole fold. The visible symptom was a session that could never be opened again:

```
failed to read referenced session: invalid session surface:
image/offload: image index 0 does not exist
```

Once that happens, three separate paths break — every `session-query` cold read (`listEvents`, `readSurface`, `search documents`, `traceEvent`), the sqlite content index, and `readSession`'s replay validation. Unmounting the plugin made it *worse*, not better, because the catalog-only read then had no way to interpret the positions at all.

## What the patch changes

Two independent layers, each sufficient for a different operator:

1. **Lenient replay keyed on the log, not on the reader.** `offloadMessageImages` gains `positionsAreAuthoritative`. The projection sets it from the fold window itself: a log carrying any `image/hoist` row has projection-dependent positions, so unresolvable indexes are skipped and an already-offloaded index is a no-op. A log with *no* hoist row folds identically everywhere, so there an unresolvable selection stays a hard error — the writer-bug case is still loud.

2. **Detached reads replay with the mounted projections.** `SessionQueryEngine` resolves `ctx.sessions.messageProjections` per call and threads it through `eventRecords`, `currentSurfaceEvents`, `traceEvent`, `buildSessionEventSearchDocuments`, `buildSessionEventRecords`, and `Session.create`. The query service previously hardcoded the first-party catalog (`[imageOffloadProjection]`) at all three fold sites while the live session store registered the full mounted set — so a live session and its own cold read could disagree about the same log. Catalog definitions stay first; a live contribution of an already-covered event type is dropped, because the fold rejects duplicate ownership anyway.

Layer 2 also fixes the general divergence: any plugin-owned projection, not just this one, now applies to cold reads the way it applied when the rows were written. Layer 1 keeps a log readable on a host that does not mount the writing plugin at all.

## Why tolerate rather than repair the log

Rewriting committed session generations is not an option: migration may add a version-named successor but never moves, overwrites, or deletes committed generations. Tolerating an unresolvable position leaves at most one image unsuppressed for a host without the hoist plugin — strictly better than making the entire session unreadable, and the same trade `image/hoist` itself already makes for a target whose endpoint a compaction removed.

The `image/hoist` rows are recorded with the envelope's `ignorable: true`, which is exactly the marker that says a reader without the event's owning plugin may skip the record. Before this patch only the *skip* was safe; the offload row that depended on those moves still refused the log.

## Verification

Folded the deployed kujiale session (`session-1f4dcf0f-c707-484a-8fb4-5f81a7fad594`, 4222 events, 56 hoist rows, 1 offload row at seq 4134):

| Read path | catalog-only before | after |
|---|---|---|
| `listEvents` | throws `image index 0 does not exist` | 4222 records |
| `readSurface` | throws | 844 current nodes |
| `search documents` | throws | 1963 documents |
| `traceEvent(4134)` | throws | resolves |
| `Session.create` replay | throws | validates |

With the hoist projection mounted, the 17 originally-selected occurrences still replay as offloaded on seqs 1394 and 1846 in both configurations. `pkgs/compaction/compaction-image-offload` (40 tests) and `packages/session-query/*` (169 tests) pass, including two new cases pinning the strict/tolerant split.
