# Agent Note: A projection-dependent image/offload selection made sessions permanently unreadable

Status: implemented

English | [中文](2026-10-19-image-offload-recorded-against-hoisted-positions.zh.md)

# Agent Note: A projection-dependent image/offload selection made sessions permanently unreadable

## Problem

`image/offload` stores a durable decision as depth-first image *occurrence indexes* into a message. Those indexes are counted in the message the deciding request actually carried — the **projected** message, not the durable one. The out-of-repo `@sparkelf/dsh-image-hoist` plugin moves tool-result images onto an earlier user-role carrier at request time (`image/hoist`), so on a hoisted session the counts describe a carrier that already holds the tool images.

`offloadMessageImages` treated a selection it could not resolve as fatal:

```
image/offload: image index 0 does not exist
```

One partially-resolvable payload therefore aborted the whole surface fold, and the session could never be read again. Observed on the deployed kujiale session `session-1f4dcf0f-c707-484a-8fb4-5f81a7fad594`: seq 4134 records 17 occurrences on seqs 1394 and 1846, but those two events are text-only in the durable log — the images live on earlier carriers only after the hoist projection runs. Every reader without that projection threw, including the user's own reference read:

```
failed to read referenced session: invalid session surface:
image/offload: image index 0 does not exist
```

Three independent paths break at once, because all three fold the log: every `session-query` cold read (`listEvents`, `readSurface`, `filterEvents`, `traceEvent`), the sqlite content index, and `readSession`'s replay validation. Unmounting the hoist plugin made it worse rather than better, because a catalog-only reader then had no interpretation of the positions at all.

A second, quieter defect shared the same root: `session-query` hardcoded `currentSessionMessageProjections` (`[imageOffloadProjection]`) at all three of its fold sites, while the live store registered the full mounted set. A live session and its own cold read could therefore disagree about the same log for *any* plugin-owned projection, not just this one.

## Decision

Two layers, each sufficient for a different deployment shape.

**Replay decides strictness from the log, not from the reader.** `offloadMessageImages` gains `positionsAreAuthoritative`, and the projection derives it from the fold window: a log containing any `image/hoist` event has projection-dependent positions, so an unresolvable index is skipped and an already-offloaded index is a no-op. A log with no hoist event folds identically everywhere, so there an unresolvable selection stays a hard error — the writer-bug case still fails loudly instead of silently under-suppressing. This is what makes a session readable on a host that does not mount the writing plugin.

**Detached reads replay with the mounted projections.** `SessionQueryEngine` resolves `ctx.sessions.messageProjections` per call and threads it through `eventRecords`, `currentSurfaceEvents`, `traceEvent`, `buildSessionEventSearchDocuments`, `buildSessionEventRecords`, `Session.create`, and the sqlite observe paths. The accessor is `protected` so a backend can pass it on without re-deriving it. Catalog definitions stay first and a live contribution of an already-covered event type is dropped, because the fold rejects duplicate ownership.

Tolerating a skipped occurrence was chosen over repairing the log because committed session generations cannot be rewritten: migration may add a version-named successor but never moves, overwrites, or deletes a generation. The cost of tolerance is at most one unsuppressed image on a host without the plugin — strictly better than an unreadable session, and the same trade `image/hoist` already makes for a target whose endpoint a compaction removed. The `image/hoist` rows already carry the envelope's `ignorable: true`, which is precisely the marker saying a reader without the owning plugin may skip the record; before this change the *skip* was safe but the dependent offload row still refused the log.

## Alternatives considered

**Repair the log in place.** Rewriting the 17 recorded indexes into durable positions would make the selection reader-independent, but committed session generations cannot be rewritten: migration may add a version-named successor but never moves, overwrites, or deletes a committed generation. It would also need to re-derive positions that only the hoist projection knows.

**Mount the hoist projection inside the catalog.** Making `image/hoist` a first-party catalog definition would let every detached reader replay it. This was rejected as the primary mechanism because the catalog is the first-party detached-replay surface and must stay browser-safe and plugin-free; a catalog that hardcodes an out-of-repo plugin's event type inverts the ownership rule the plugin system exists to enforce. Threading the mounted set through the query service achieves the same effect without that coupling, and the log-derived tolerance still covers hosts that mount nothing.

**Drop the offload decision when it does not resolve.** Discarding the row would have made the log readable, but it silently unsuppresses up to 17 images on every request — the opposite of what the decision recorded. Skipping individual occurrences keeps the decision's intent for every position that does still resolve.

## Consequences

Cold reads of a hoisted session no longer throw, and a live session and its own detached read now agree about the same log for every plugin-owned projection rather than only the first-party catalog.

A host that mounts no projection now reads such a session with the tool-result images in their durable positions, which is the un-hoisted shape — correct for that host's request shape, but it means the projected view is a property of the reader's plugin set rather than of the log alone. That is inherent to a request-time projection and is now documented on both sides.

The tolerant path can leave one image unsuppressed when a selection only partially resolves; that is visible as a slightly larger request rather than as an error, and the strict path still catches a genuinely bad selection on any log without hoist rows.

`offloadMessageImages` now takes a third argument; its one caller in `projection.ts` supplies it from the fold window, so a new caller that omits it gets the strict behavior.

## Verification

Folding the kujiale log (4222 events, 56 hoist rows, one offload row at seq 4134):

| Read path | catalog-only before | after |
|---|---|---|
| `listEvents` | throws `image index 0 does not exist` | 4222 records |
| `readSurface` | throws | 844 current nodes |
| search documents | throws | 1963 documents |
| `traceEvent(4134)` | throws | resolves |
| `Session.create` replay | throws | validates |

With the hoist projection mounted the 17 selected occurrences still replay as offloaded on seqs 1394 and 1846, identically in both configurations. Two new cases in `tests/projection.spec.ts` pin the strict/tolerant split. `packages/compaction/*`, `packages/session-query/*`, and `packages/core/session` pass in full (45 files, 1035 tests).

This landed out-of-repo as `@sparkelf/dsh-patch-image-offload-hoist-replay` and `@sparkelf/dsh-image-hoist` 0.1.5, which additionally fixed the hoist projection dropping all but the last image when several targets share one carrier.
