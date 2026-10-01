# @sparkelf/dsh-patch-session-envelope-ignorable

English | [中文](README.zh.md)

This data-only package lets a log-only event declare the session envelope's `ignorable` marker at `Session.append`.

The envelope has carried `ignorable` since the released session format, and the persistence read path enforces it: an event whose type the reader does not know is refused unless the event is marked ignorable, because skipping an unrecognized required event could reconstruct a wrong session. The marker had no writer. `Session.append` builds the envelope from `type`, `seq`, `time`, `data`, and the surface metadata, so an out-of-repo plugin appending its own event type could only produce records that every reader without that plugin refuses — including the reader that wrote them, once the plugin is unmounted.

The patch adds an `EnvelopeIntent` to `packages/core/session/src/types.ts` and widens `append`'s rest parameter to accept it for non-surface events. The event construction copies `ignorable: true` onto the envelope only when the caller passes exactly `true`, matching the field's own contract: absence means required, and an explicit falsy value would be indistinguishable from a producer that meant the opposite.

The deployment carries three sessions written by `@sparkelf/dsh-image-hoist` before this patch: `session-08bf0cc7-b831-4834-a30f-9153854503fe`, `session-160644ce-0546-4a75-8482-3848a0f2ebc7`, and `session-7dad49d6-1745-4158-b578-8fddf54cb45f`. Their `image/hoist` records are repaired in place by moving the marker to the envelope. This package is the writer-side change, moved from a mirror stash into a reviewed patch so a rebuild cannot drop it.
