# Agent Note: Authorize Univer template files by source ownership

Status: implemented

English | [中文](2026-09-02-univer-authorized-template-sources.zh.md)

## Problem

A model can create a new Univer file from a user-owned template or from a read-only asset distributed by another trusted Host plugin. Restricting every source to the session workspace forces asset plugins to add staging tools, while accepting arbitrary absolute paths exposes unrelated local files. The output must remain workspace-owned in both cases.

## Decision

The Plus patch backports `univer_new.templateFile` to `dsh-univer-office@0.2.12`. A model-supplied target remains inside the current session workspace and is never overwritten. A template source is accepted when its real path is inside that workspace or inside a read-only root registered through `ctx.univer.registerTemplateRoot` by a trusted Host plugin.

The Univer Provider owns source authorization. It stages a registered-root template inside the workspace, delegates final file creation to the existing Gateway, and removes the staged file after the Gateway returns. Asset plugins register roots through Cordis effects and need no model-facing staging tool. Domain templates and skills remain outside the core patch.

The same generic behavior is contributed to upstream `dsh-univer-office`; the Plus package remains an exact alpha.2 backport until a released upstream version contains both alpha.2 compatibility and authorized template creation.

## Alternatives considered

- **Allow arbitrary absolute template paths.** Rejected because copying a template grants full read access to its content.
- **Require every asset plugin to expose a staging tool.** Rejected because each plugin would duplicate workspace copying, cleanup, and error behavior.
- **Use template IDs and a metadata registry.** Rejected for this scope because trusted directory registration preserves direct paths without introducing another user-facing identifier system.

## Consequences

- User and Agent templates already in the workspace continue to use direct paths.
- Trusted asset plugins can remain asset-and-skill plugins with one reversible root registration and no Tool.
- Gateway remains the only owner of final `.univer` creation and non-overwrite semantics.
- Registered source directories must contain only assets intended for model-readable template use.
