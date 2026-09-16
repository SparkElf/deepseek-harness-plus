# @sparkelf/dsh-patch-session-format-legacy-restart

English | [中文](README.zh.md)

This data-only package admits the released interrupted-turn restart pattern by default when v0 sessions are migrated.

Official `46196d6f95` added the pattern behind `legacyInterruptedTurnRestart`: a `turn/start` whose immediately preceding event is an `agent/inbox/spliced` targeting `next-turn` belongs to a turn that already ended, so the migration closes the open turn and advances `nextTurn`. The flag gates the admission; the shipped `RELEASED_V2_RELATIONSHIP_EXTENSIONS` never sets it, so the pattern is rejected unless a caller opts in.

The patch changes the gate in two ways. The extension becomes `boolean` rather than `true`, and the condition becomes `!== false` rather than `=== true`. Together these make the admission the default and give a caller that needs the strict reading an explicit `false`. The predecessor lookup also changes from an array index to a search by `seq`, because sequence numbers are not guaranteed to be dense across remapping.

The deployment carries a session that needs this: `session-f6ab795c-0a7b-4287-b3e5-19229e412024` holds an `agent/inbox/spliced` insert targeting `next-turn`, and the strict gate refuses its `turn/start`. This package is that deployment change, moved from a mirror stash into a reviewed patch so a rebuild cannot drop it.

The target is the exact official source base `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`. The Plus apply command verifies the base ancestry and payload before applying it. This package has no JavaScript entry, Cordis lifecycle, install script, or capability implementation.

Retire this package when official session-format migrations admit the interrupted-turn restart pattern by default, or when the sessions it serves no longer exist.
