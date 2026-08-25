---
name: dsh-distill-user-corrections
description: Use when the owner asks to "distill", "remember", "learn this", or behave differently next time, including 沉淀、记住、下次, or when repeated feedback exposes a reusable agent failure. Convert the correction into the smallest durable instruction and enforcement without duplicating existing policy.
---

# DSH Distill User Corrections

Turn a correction into behavior that works on the next similar task, not a record of the current conversation. The rationale is recorded in [user correction distillation](../../notes/implemented/process/2026-08-25-user-correction-distillation.md).

## Distill The Rule

1. Write one invariant in this form: **When `<trigger>`, do `<action>`; completion requires `<evidence>`.** Preserve the owner's correction, not the agent's earlier framing.
2. Test the invariant against one adjacent case that was not discussed. Broaden named examples only to the smallest category that handles both cases.
3. Search existing instructions, skills, Agent Notes, and verifiers before adding anything. Update an existing matching workflow; create a new skill only for a distinct reusable trigger.
4. Keep one authoritative home per fact. Use a skill for actions, an Agent Note for rationale or system state, a verifier or test for enforceable structure, and working style only to route the trigger. Link instead of repeating details.
5. Add the smallest mechanical counterexample when enforcement is possible. Otherwise state the remaining judgment explicitly.

## Check The Learning

Before claiming the lesson is persisted, verify all of these:

- A future agent can recognize when the rule applies without knowing this conversation.
- The rule handles fixes, extensions, and adjacent new cases rather than only the example that prompted it.
- The completion evidence distinguishes implementation from planning, intent, or a chat promise.
- Existing guidance is condensed or linked so the new rule does not create competing instructions.
- Relevant format, link, policy, and focused behavior checks pass.

## Report

Report only the learned invariant, its authoritative location, its mechanical gate when one exists, and any judgment that cannot be automated. Do not retell the correction sequence or claim durable learning from a conversational promise alone.
