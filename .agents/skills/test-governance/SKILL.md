---
name: test-governance
description: Use when planning or changing Plus behavior. Select evidence that demonstrates the real user result and protects plugin composition, installer, daemon, or runtime contracts.
---

# Test Governance for Plus

Test the behavior users and operators rely on. For normal product flows, use the existing Playwright path through the UI and real application services. For repository governance, run the named verifier that owns the structured metadata.

## Required evidence

- A runtime fix needs a regression that fails before the fix and demonstrates the user-visible result after it.
- An installer or tray workflow needs an end-to-end path through its UI, including validation and recovery.
- A new composition requires `pnpm run verify:plus-governance` and a user-facing path once it becomes installable.
- Documentation-only changes run the applicable link, pairing, and formatting gates.

Do not substitute a smoke check, static source string, mock-only test, or screenshot for user-path evidence. Record commands and outcomes in the PR under `## Test governance`.
