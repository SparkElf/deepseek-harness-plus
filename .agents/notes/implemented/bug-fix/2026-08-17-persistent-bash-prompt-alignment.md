# Agent Note: Persistent Bash reasserts the terminal backend's controlled prompt

Status: implemented

English | [中文](2026-08-17-persistent-bash-prompt-alignment.zh.md)

## Problem

Under the minimal preset, every bash call took about 3.5 seconds to return no matter how fast the command finished — even commands that complete in about 1ms — and the first call on a fresh shell took about 7 seconds. The same commands return in milliseconds through the standard and sandbox one-shot executors. Upstream reports: deepseek-ai/deepseek-harness discussions #2175 and #2656.

The minimal preset composes `dsh-terminal`, `dsh-terminal-bash`, and `dsh-tool-bash-persistent`: commands run in a resident interactive PTY shell, and the backend decides when a send settles. The backend's prompt path (`stdin_read`) matches only text that exactly equals its controlled prompt `dsh> ` after the private OSC marker. The persistent tool's initialization overrode `PS1` with its own marker-style prompt `__DSH_PERSISTENT_BASH_PROMPT__ `, so the prompt path could never match and every send fell back to the silence window: `idleSilenceMs` (3000) plus `handoffGraceMs` (500).

## Decision

The tool's initialization reasserts the backend's controlled prompt as `PS1`, and the alignment is pinned by tests. The stub composition asserts the initialization send is exactly `stty -echo; PS1=$'<CONTROLLED_PROMPT>'`, importing `CONTROLLED_PROMPT` from `dsh-terminal-bash`. A REAL Loader composition keeps the shipped silence defaults and bounds a fast `pwd` far below them, so prompt drift fails the suite instead of shipping as latency.

The value still lives in two packages: the consumer imports nothing from the provider at runtime, and the seam boundary stays between the tool and `ctx.terminals`.

## Alternatives considered

- Changing `dsh-terminal-bash`'s `CONTROLLED_PROMPT` to the tool's long marker (the fix discussion #2656 proposes). The backend owns the readiness protocol, and the same constant drives `dsh-tool-terminal` sessions where the prompt is part of the visible terminal output; adopting a consumer's marker there would change an unrelated surface.
- Wiring the tool's END marker into a consumer-completion settlement (discussion #2175's proposal). That is a wider seam change — a new service operation plus wait reason — for roughly 25ms of improvement over the prompt path, which does not justify it today; deferred until a consumer needs completion evidence the prompt path cannot give.
- Lowering the `idleSilenceMs` default. That trades truncation risk for genuinely quiet commands against latency, and masks the mismatch instead of fixing it.

## Consequences

Fast commands settle on the `stdin_read` prompt path in tens of milliseconds instead of about 3.5 seconds, and the first call on a fresh shell loses its extra silence window too. Model-visible results are unchanged: the prompt was already stripped from results, and the marker pair still delimits output. `dsh-tool-terminal` sessions and the one-shot shell executors are unaffected.

## Testing

- The stub contract test pins the initialization send to the backend's controlled prompt.
- The REAL Loader composition keeps the shipped `idleSilenceMs`/`handoffGraceMs` defaults and bounds a fast `pwd` to 2s; with the old prompt the same test measures about 7.6s and fails.
- The `persistent-tools` snapshot replays unchanged.
