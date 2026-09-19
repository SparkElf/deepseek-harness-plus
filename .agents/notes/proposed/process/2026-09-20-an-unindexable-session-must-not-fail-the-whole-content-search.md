# Agent Note: An unindexable session must not fail the whole content search

Status: proposed

English | [中文](2026-09-20-an-unindexable-session-must-not-fail-the-whole-content-search.zh.md)

## Problem

Content search never worked on this deployment. Every attempt ended with the sidebar reporting that content search is unavailable, and the SQLite index stayed at **zero rows** after every search while its schema existed:

```
persisted_sessions  0
persisted_docs      0
```

Measured across the deployment and an isolated instance seeded from the same history (214 sessions):

| run | result | index after |
|---|---|---|
| first search | CONTENT-ERROR ~20–38 s | 0 rows |
| second search | CONTENT-ERROR ~1 s | 0 rows |
| third search | CONTENT-ERROR ~1 s | 0 rows |

**The repeating failure was not a timeout**, and treating it as one — extending the tool budget to fifteen minutes — changed nothing: the search still failed in about twenty seconds.

## Why it happened

Tracing the observation pass named the cause on the first attempt:

```
reading session-2bc1778f-236a-41fa-9377-bdc988a3fbff
CAUGHT: format v2 agent/inbox/spliced at seq 4 data.inserted[0].content[0]:
        cannot safely transform unclassified message content kind "document";
        source v2 artifact remains unchanged
        name=SessionFormatUnsupportedError  aborted=false
```

The session carries an `agent/inbox/spliced` event whose inserted content is kind `document` — an attached Word file:

```
"attachment": {
  "mediaType": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "name": "公安项目202608进度报告 (2).docx"
}
```

The v2→v3 session-format migration refuses to transform that kind, so the cold read throws. **The throw is not caught**, so one session ends the entire observation pass, and the index is never written.

Two sessions in this history carry that kind — measured over both the deployment and the isolated copy:

```
sessions with a v2 artifact: 184
carrying kind "document":      2
```

They are always read early, so **every** search failed at the same place. Excluding them by hand made the index fill to 210 sessions and content search answer in one second, which isolated the cause: a session that cannot be indexed was making every other session unindexable too.

## Proposal

**A session whose stored log cannot be migrated is skipped, not fatal.**

The observation loop already tolerates a session it declines to index; it must also tolerate one the persistence layer refuses to read:

```js
let loaded
try {
  loaded = await readColdSessionLog(persistence, entry.header.id, signal)
} catch (readError) {
  if (readError?.name !== 'SessionFormatUnsupportedError') throw readError
  // Leave it out of this pass; every other session still gets indexed.
  continue
}
```

**Index each session as it is read, rather than after the whole corpus.** The write currently sits after the observation loop, so nothing is published until every log has been read. On a large history a first pass takes minutes, and any interruption discards all of it. Committing per session keeps progress, and the revision check skips what is already indexed on the next attempt.

Both changes are needed: the skip lets the pass finish, and the per-session write keeps an interrupted pass from starting over.

## Findings this change rests on

1. **The failure is a refused migration, not a timeout.** The trace names `SessionFormatUnsupportedError` with `aborted=false`; raising the tool budget to 900 s left the ~20 s failure unchanged.
2. **The refusal is per session and deterministic.** The same two session ids fail on every attempt, in both the deployment and an isolated copy of the same history.
3. **One refusal fails the whole pass.** The throw escapes the observation loop, so the write that follows never runs.
4. **Excluding the two sessions makes the index fill.** Measured: 210 sessions and 202,803 documents indexed, first search 185 s, later searches 2.0 s, content hits returned for terms that appear only in message bodies.
5. **Both deployments carry the same two sessions.** A scan of the deployment's 184 v2 artifacts finds exactly the same two ids.

## Acceptance criteria

- A history containing a session whose log cannot be migrated still builds a complete index for the others.
- The skipped session is named in the diagnostic rather than silently dropped.
- Content search answers within about a second once the index exists.
- An interrupted first pass keeps the sessions it already indexed.

## Alternatives considered

**Fix the v2→v3 migration to accept the `document` kind.** That is the complete fix and belongs upstream, but the refusal is deliberate — the migration cannot safely transform the content — so teaching it to accept the kind means deciding what the transformed value should be. Skipping is the correct behavior for the index regardless: a session the deployment cannot read cannot be indexed, and it must not make the rest unreadable.

**Raise the timeout.** Measured and rejected: the failure is not a deadline. The budget was raised to 900 s and the search still failed in ~20 s.

**Delete the offending sessions.** Rejected: they are real conversation history containing a delivered document. The index should tolerate them, not the data be removed to suit the index.

## Risks

**A skipped session is invisible to content search.** A term that appears only in a skipped session's body will not be found, and the deployment reports nothing at the search surface. Naming the skip in the log is the mitigation; surfacing it in the UI is not part of this change.

**The per-session write increases transaction count.** One transaction per session instead of one per pass. Measured cost on 210 sessions: the first pass took 185 s including all cold reads, so the write overhead is not the dominant term.
