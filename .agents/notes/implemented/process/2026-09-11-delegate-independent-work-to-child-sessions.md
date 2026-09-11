# Agent Note: Delegate independent work to child sessions

Status: implemented

English | [中文](2026-09-11-delegate-independent-work-to-child-sessions.zh.md)

## Problem

A session that holds one objective sometimes meets work that is independent of it: a defect in another project, a long-running verification, a bounded investigation. Running that work inline serializes it behind the current objective and burns the primary session's context on a second problem. The session already owns the mechanism to avoid this, and an agent that does not reach for it will either serialize the work or report the capability missing.

## Decision

Reach for a child session before serializing independent work.

- `ralph` runs a fresh child session per round with **no parent conversation and no prior child session**: the shared workspace is the only memory between rounds, and one bounded structured report crosses each round. Use it for a self-contained task in another project, and put every fact the child needs into the objective text plus a durable file in that project, because the child cannot see this conversation.
- `list_agents` reports children by durable id and status (`running` / `idle` / `ready`), where `ready` means resumable rather than finished.
- `send_message` steers a running child or starts a turn for an idle or ready one.
- `interrupt_agent` stops a child's current turn without discarding the child.

Do it as a background job when the work outlasts one tool call. `ralph` is foreground: a round that outlives the enclosing call's ceiling still completes in the child, so confirm the child's output through the files it wrote rather than assuming the call's timeout cancelled it.

## Alternatives considered

**Run the work inline.** Rejected for work in another project: it serializes a second problem behind the current objective and spends this session's context on it. It stays correct when the work is a small edit inside the current objective.

**Report the capability as unavailable.** Rejected because the mechanism exists and this session owns it; reporting it unavailable turns a usage gap into a false blocker.

## Consequences

A second project's defect gets fixed without consuming the primary objective's context, and the primary session keeps working meanwhile. The cost is that the child starts blind: an objective that omits the target path, the evidence, or the constraint produces a plausible change in the wrong place. A decision that belongs to this session stays in this session.

## Verification

On 2026-09-11 this session found a DataOps backend crash (an unhandled database error from an interval tick exited the process) that was outside its own objective. It wrote the root cause, two reproductions, and acceptance criteria into `/root/projects/dataops/.trellis/tasks/backend-database-unreachable-crash.md`, then started a `ralph` child with that path in the objective. The child modified only `backend/src/ai/ai-agent-scheduler.service.ts` on that day, added `tests/unit/ai-agent-scheduler-database-unreachable.test.ts`, and left the six unrelated modified files in that repository untouched. Its four tests pass with the fix and two of the four fail when the added `catch` is removed, so the test holds the regression.
