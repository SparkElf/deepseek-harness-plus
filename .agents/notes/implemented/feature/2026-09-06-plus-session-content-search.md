# Agent Note: Plus keeps a durable Session content index

Status: implemented

English | [中文](2026-09-06-plus-session-content-search.zh.md)

## Problem

Official DSH ships the SQLite Session query provider with full-text search disabled. The Plus sidebar therefore falls back to title and Workspace matching even though canonical compressed JSONL history remains present. Users cannot recall an older conversation by words that occur only in its messages.

## Decision

The Plus profile overrides the existing `session-query-sqlite` row with `openAt: first-search` and the dedicated path `$DSH_HOME/storages/session-query.sqlite`. The official provider reconciles that derived FTS5 database from live Sessions and persisted JSONL when the first content query arrives, then incrementally refreshes it on later searches. Compressed JSONL remains the sole authoritative history; the SQLite file may be deleted and rebuilt. The temporary `@sparkelf/dsh-patch-session-history-search` source patch accepts two evidenced pre-release record shapes, bounds reconciliation memory by writing one observed Session at a time inside the same stable-corpus transaction, and lets cold seeded branches retain current or predecessor title hints after restart without reading their bodies.

This is the deployment opt-in anticipated by the [content-search opt-in decision](../architecture/2026-08-13-session-content-search-opt-in.md), not a replacement provider or an official-default change. Archive visibility remains separate: archived Sessions do not enter sidebar results until their Workspace archive state is restored.

The Plus Web system flow creates a Session whose second turn contains a term absent from its first-turn title, starts another Session, searches the unique term through the sidebar, and reopens the original conversation from the content result.

## Alternatives considered

**Keep title-only matching.** Rejected because the reported conversation exists on disk but cannot be recalled from remembered message text.

**Use `:memory:`.** Rejected because every Supervisor restart would rescan the full history corpus before the first useful result. A durable derived database retains completed reconciliation while remaining disposable.

**Open at startup.** Rejected because history reconciliation should not delay ordinary 3080 readiness for users who do not search. `first-search` permits an explicit post-deployment warm-up without adding that work to every boot.

**Add a Plus search provider.** Rejected because the official JSONL-aware FTS5 provider already owns literal search, ranking, paging, and incremental reconciliation. An exact temporary source patch is required because the retained corpus proved that two historical record shapes block official migration and that holding every changed Session document array until commit exceeds practical memory.

## Consequences

- Sidebar content search becomes available after its first-query initialization and remains warm across normal restarts.
- The derived database adds local disk use and one-time reconciliation work proportional to retained history.
- The patch does not skip malformed Sessions or add an alternate reader; it migrates only the two evidenced historical shapes and preserves official failure reporting for other unsupported records.
- Archive state continues to hide a Session independently of whether its messages are indexed.
