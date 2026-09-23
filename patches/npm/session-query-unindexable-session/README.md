# @sparkelf/dsh-patch-session-query-unindexable-session

English | [中文](README.zh.md)

## Summary

Keeps content search working when a session's stored log cannot be migrated, and
keeps an interrupted first index pass from starting over.

## Why it is needed

Content search reads every session log to build its index. Two behaviours made
that fail permanently on a history of 200+ sessions:

**A session the migration refuses ends the whole pass.** The v2→v3 session-format
migration will not transform a message whose content kind is `document`, so the
cold read throws `SessionFormatUnsupportedError`. That throw escapes the
observation loop, so one session stops every other session from being indexed —
and because it is read early on every attempt, the index never fills:

```
format v2 agent/inbox/spliced at seq 4 data.inserted[0].content[0]:
cannot safely transform unclassified message content kind "document"
name=SessionFormatUnsupportedError aborted=false
```

**The write sits after the entire read.** Nothing is published until every log
has been read, so an interruption discards all the work. On this history the
first pass reads 214 sessions and takes minutes.

Measured before the patch: the index held **zero rows** after every search, and
every search failed in 20–38 seconds. After it: 210 sessions and 202,803
documents indexed, later searches answering in about a second.

## What it changes

| Behaviour | Before | After |
|---|---|---|
| A session whose log cannot be migrated | fails the whole search | skipped and named; others still indexed |
| When a session is written | after the whole corpus is read | as soon as it is read |
| Commit shape | one transaction per pass | bounded batches |

## Install

The patch carries no code of its own; the profile supervisor applies it to
`@deepseek-ai/dsh-session-query-sqlite` when the package is installed.

## Known Limitations and Deferred Work

**A skipped session is invisible to content search.** A term that appears only in
a skipped session's body is not found, and the search surface reports nothing.
The skip is named in the deployment log; surfacing it in the UI is deferred.

**The migration refusal itself is left alone.** Teaching the v2→v3 migration to
transform the `document` kind would make those sessions searchable, but that is
an upstream decision about what the transformed value should be.
