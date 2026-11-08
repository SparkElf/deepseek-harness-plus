# Agent Note: Scoped credentials let a room act for its member

Status: implemented

## Problem

A workspace belongs to one DataOps principal, and every managed call carries that principal's JWT.
A group-chat room breaks that assumption: the room acts for the member who wrote, and the member
may hold fewer permissions than the workspace owner. The base patch `visibility-filters` answers
the disclosure half -- a Session carries an opaque `actor` and plugins hide tools and skills the
actor may not use. Nothing answered the credential half: a room's MCP call still authenticated as
the workspace owner, so the member's identity never reached DataOps.

## Decision

An MCP call carries its Session through `AsyncLocalStorage`
(`packages/plus/mcp-credentials/src/session-scope.ts`), and the credential resolver reads it
immediately before each network request:

```text
Session.actor === undefined  -> DATAOPS_ACCESS_TOKEN            (workspace credential, unchanged)
Session.actor !== undefined  -> DATAOPS_ACCESS_TOKEN_S_<SID>    (scoped, minted by the connector)
                                falling back to the workspace entry when absent
```

The ref alphabet is uppercase underscores, so the Session id is folded into it
(`group-room-<uuid>` becomes `GROUP_ROOM_<UUID>`) by `scopedCredentialRef`. The connector mints
entries with that same function; a divergence would silently fall back to the workspace credential,
which is the defect this note removes.

`runWithSession` sets the identity for exactly one executor invocation. A call without an actor
records nothing, so every ordinary conversation resolves exactly what it resolved before.

## Alternatives considered

**A per-session MCP connection.** It multiplies connections by active rooms and changes reconnect
semantics for a decision that is per request anyway.

**Forwarding the workspace JWT for rooms.** That is the defect itself: the room would act as the
workspace owner.

**Interpreting the actor inside the bridge.** Roles and permissions belong to the connector, per the
single-authorization-principal rule; the bridge only checks that an actor exists.

## Consequences

- A room's credential expires after its TTL; until the connector refreshes the scoped entry, calls
  fall back to the workspace credential rather than failing, so a stale room keeps working with the
  workspace's authority. That is a deliberate availability choice, bounded by the connector's refresh
  window.
- The scoped entry is created by the connector; this package never mints credentials.
- `Session.actor` reaches this package structurally (`{ id, actor? }`) because its dependency may
  predate the base patch; the field is not widened publicly.
