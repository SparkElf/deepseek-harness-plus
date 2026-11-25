---
kind: package-readme
---

# @sparkelf/dsh-group-chat

Human-agent group chat for DataOps-managed DSH workspaces.

A room is a message bus shared by its members. Every member's workspace keeps its own
copy of every message, and each member's agent is a **local subscriber** that acts
only on its own instructions:

| Situation | What happens |
| --- | --- |
| Any member posts anything | Broadcast to every member; each workspace appends it to the room's session, so each agent can read the whole conversation |
| A member mentions **themselves** | That member's own agent runs a turn |
| A member mentions someone else | Ordinary message — recorded and read, never executed |
| `@everyone`, or no mention | Ordinary message — no agent runs |

## Why the mention rule is this narrow

One rule decides every case: **a message runs an agent only when its sender
mentioned themselves.** Everything else is recorded and read, never executed.

That is a deliberate trade, and it is what makes the design safe and simple:

- **Nobody can drive someone else's agent.** A mention never reaches another
  member's container, so it can never spend their model budget or reach their files.
- **No fan-out.** `@everyone` is an ordinary message, so it does not start N agent
  runs.
- **Visibility is not gated, only execution.** Every message still enters every
  agent's context, so an agent answering later has read the whole conversation.

The trade is that a room has no shared intelligence — only each member's own agent
plus a shared transcript. In exchange, no cross-container coordination protocol,
consensus algorithm, or distributed transaction is needed.

## Architecture

```
   DataOps backend            ← identity, global order, storage, routing
     ↑ POST (ack)  ↓ pull (cursor)
   workspace container         ← one DSH per member
     agent + session log
```

- **Uplink** is an awaited POST. The backend assigns the globally ordered id and
  returns the finalized event; the event is appended locally **only after** that
  acknowledgement, so a rejected message never enters the append-only log.
- **Downlink** is a cursor pull. The backend is the only cross-container
  intersection point, so it is also the only authority on order; a cursor is the
  entire synchronization state and survives a restart.
- **Idempotency** is `source.rpcId` — the identity DSH already mints for reconciling
  optimistic and durable messages — enforced by a unique index, so a retried or
  double-clicked send produces one message.
- **Only the turn's final `assistant/message` is published.** Intermediate steps,
  file reads, and tool output never leave the member's own workspace.

## Configuration

The plugin reads the workspace identity DataOps already injects into the container.
It mints no credential of its own:

| Variable | Purpose |
| --- | --- |
| `DATAOPS_AI_WORKSPACE_INTERNAL_TOKEN` | Credential the backend verifies |
| `DATAOPS_AI_WORKSPACE_USER_ID` | The account this workspace belongs to |
| `DATAOPS_AI_WORKSPACE_BACKEND_BASE_URL` | Backend origin |
| `DATAOPS_AI_WORKSPACE_MOUNT_PATH` | Workspace root, used as the room session's `cwd` |

**On any DSH where those are absent — a developer's own installation, for
instance — the plugin registers nothing at all:** no route, no listener, no timer.
Ordinary sessions are byte-identical with and without it installed. This is asserted
by a test whose context throws on every property read.

## Rooms and sessions

One room maps to one DSH session, named `group-room-<roomId>`. The binding lives in
the session id because `SessionHeader` carries no free-form metadata field. An
ordinary session never matches that prefix, which is the second half of how this
plugin stays out of the way.

Opening a room is a **resolve-or-create**: the plugin resolves the persisted session
first and only calls the controller's create path when the session does not exist. A
create call is not a create-or-reuse call — once the named session has run a turn the
controller mints a fresh `session-<uuid>` instead — so calling it on every host restart
would leave a throwaway session directory behind. Older builds did exactly that; a
room could grow to thousands of directories and slow the shell's `session/list`.

A workspace upgraded from such a build can report or remove the leftovers for one room:

```bash
# Report (default; no writes)
curl -sS -X POST http://127.0.0.1:3080/dsh-group-chat/api/rooms/<roomId>/sessions/cleanup \
  -H 'content-type: application/json' -d '{}'

# Archive: mark them hidden from grouping surfaces, keep the files
curl -sS -X POST .../rooms/<roomId>/sessions/cleanup \
  -H 'content-type: application/json' -d '{"dryRun":false}'

# Purge: delete the throwaway directories (canonical room session and subagent children are kept)
curl -sS -X POST .../rooms/<roomId>/sessions/cleanup \
  -H 'content-type: application/json' -d '{"dryRun":false,"purge":true,"confirm":"<roomId>"}'
```

The canonical `group-room-<roomId>` session is never a cleanup candidate, so the
room's history stays openable. If a room has already been dissolved and is no longer
listed by the backend, pass its project directory explicitly with `"directory": "..."`.

## Known limits

- **Display names are not authentication.** The backend verifies *who* a caller is
  (a workspace-scoped HMAC binds the credential to one account); it does not verify
  what they type as their name.
- **A member's nickname is a snapshot.** It is copied at write time so a later
  rename cannot rewrite history.
- **Offline members catch up by cursor.** A workspace that stays unreachable keeps a
  gap in its local copy; the plugin does not fabricate a completeness marker for it.
