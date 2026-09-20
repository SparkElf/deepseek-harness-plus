# Agent Note: A content search whose every hit is filtered out reports failure

Status: proposed

English | [中文](2026-09-20-a-content-search-with-no-eligible-hit-reports-failure.zh.md)

## Problem

After the content-search index was repaired and filled, one query still failed while others of the same shape succeeded on the same deployment:

| query | result | indexed hits | hits eligible after filtering |
|---|---|---|---|
| `systemd` | ok | 1426 | 157 |
| `sqlite` | ok | 1267 | 42 |
| `winget` | ok | 4 | 0 |
| `nvmrc` | **error** | 14 | 0 |

The failure is deterministic — three attempts at `nvmrc` failed at 5.0–7.0 s while `systemd` answered in 10 s — and it is not the index: the deployment's index holds 205 sessions and 164,539 documents, and `nvmrc` matches 14 of them.

Two hypotheses were measured and rejected:

- **A large session in the hit set.** The 206 MB session `32a5b34e` appears in the `nvmrc` hits, but it also appears in the `systemd` and `sqlite` hits, which succeed.
- **A query with no eligible hits.** `winget` also has zero eligible hits and succeeds, and a nonsense string that matches nothing at all succeeds in 6–8 s.

The distinguishing property is in the matched documents' surfaces. Every `nvmrc` hit is a `tool/result` at surface `shadowed`; the queries that succeed carry at least one hit at a surface the search accepts, and the nonsense string carries none at all. So the trigger is not "no results" but the specific combination of the index reporting matches that the authorization step then discards.

## Proposal

**A search that ends with no authorized result reports no matches, not a failure.**

This is a narrowing of the fix in [an-unindexable-session-must-not-fail-the-whole-content-search](2026-09-20-an-unindexable-session-must-not-fail-the-whole-content-search.md), which stopped an unreadable session from ending the pass. The same principle applies one step later: the index's answer and the search's authorized result are different sets, and emptiness in the second is an ordinary outcome that the panel already renders as "no matching sessions".whole-content-search.md), which stopped an unreadable session from ending the pass. The same principle applies one step later: the index's answer and the search's authorized result are different sets, and emptiness in the second is an ordinary outcome that the panel already renders as "no matching sessions".

The failing path needs to be identified before it can be narrowed: the workspace panel reports the generic content-search warning, and the deployment log records nothing for the attempt, so the error currently has no named origin.

## Findings this change rests on

1. **The index is complete and answering.** 205 sessions and 164,539 documents; `nvmrc` matches 14 documents.
2. **The failure is deterministic and term-specific.** `nvmrc` failed on three of three attempts; `systemd`, `sqlite`, `winget`, and two nonsense strings all settled.
3. **Size is not the trigger.** The 206 MB session is in both a failing and two succeeding hit sets.
4. **Empty eligibility is not the trigger by itself.** `winget` has zero eligible hits and succeeds, as does a string matching nothing.
5. **The failing term's hits are all `tool/result` at surface `shadowed`.** Every succeeding term carries hits at other surfaces.

## Acceptance criteria

- A query whose matches are all filtered out settles as no matches, in about the same time as any other query.
- A query that genuinely cannot be answered still fails loudly.
- The failing path names itself in the deployment log.

## Alternatives considered

**Treat the term as special and move on.** Rejected: the deployment reports failure for an ordinary query, and a user typing a term that happens to appear only in shadowed tool output sees content search broken again.

**Blame the index contents.** Rejected by measurement: the documents are indexed, and the same documents' sibling surfaces answer fine in other queries.

## Risks

**The trigger is inferred from four terms on one history.** The surface counts separate the failing term from the succeeding ones, but the specific code path has not been read, so the proposed narrowing may not be the one that removes the failure.
