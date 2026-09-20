---
description: "Sidebar skill center: browse loaded skills by source, toggle model invocation, create and delete skills."
kind: "package-reference"
---

# @sparkelf/dsh-client-ui-skill-center

English | [中文](README.zh.md)

## Summary

A skill center for the dsh Web sidebar: browses loaded skills grouped by source, enables or disables model invocation, creates skills, and deletes them into a recoverable trash.

## What it does

- **Sidebar entry** "Skill Center" opens a panel, registered through the official `sidebar.panellist` slot and the keyed `main` page slot — the same slots the Plugins panel uses, so the shell owns the row, label, and selected state.
- **Skills list**: skills grouped by discovery source (bundled / runtime / `~/.agents/skills` / `~/.dsh/skills` / project `.agents/skills` / project `.dsh/skills` / custom roots), with a search box that filters by name, description, or when-to-use.
- **Enable / disable**: rewrites `disable-model-invocation` in the skill's YAML frontmatter. The field is edited in place rather than re-serialized, so comments, key order, and the body survive.
- **Create**: writes a standard `SKILL.md` under the user or project root.
- **Delete**: moves the skill into a `.trash` sibling directory, where it can be restored.

## Table of Contents

- [What it does](#what-it-does)
- [Design](#design)
- [Install](#install)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

## Design

Reading goes through the official `ctx.skills` registry, so the catalog and its hot reload are the harness's rather than a second scanner's. The registry's summaries deliberately omit file paths — they are invocation-neutral metadata — so a write resolves the path through `ctx.skills.get()` when an action actually needs to touch a file. `collect()` caches the catalog those calls share, so the resolve is not a second scan.

The three writes have no official equivalent; the registry is read-only.

Every colour, border, and label weight comes from the shared alias tokens (`--dsw-alias-*`), and the sidebar glyph is `IconSkillOutline16` from `@deepseek-ai/dsh-client-ui-primitives`, so the panel and its row match the official panels beside them.

## Install

The host half mounts the `/api/dsh-skill-center` route family; the client half registers the sidebar entry and page. Mount both through a profile composition.

## Model Experience

None, as this package is a Web GUI surface: it registers a sidebar entry and a panel, and contributes no tool, no system-prompt section, and no session event.

#### KV Cache effect

None; no string this package owns reaches a model request, so a request's cacheable prefix is unaffected by anything the panel does.

## Known Limitations and Deferred Work

No runtime invariant companion is published. The package owns no durable package-local state: the route handlers read the skill registry and write skill files, and every observable outcome is covered by the route tests.

- **Deletion refuses a symlinked skill**: a skill discovered through a symlink has no single owning directory to move, so the delete action is withheld for it.
- **The list omits file paths**: whether a skill can be deleted is therefore not known until the delete is attempted, which then reports it.
- **Grouping follows the discovery source label, not the file path**: a provider that reports an unrecognized source lands in the custom group.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers, click to expand</summary>

This Dev Note is working context for maintainers; shipped behavior, limits, and rationale live in the sections above.

- Host routes live under `src`, and the panel lives under `src/client`. The host half reads the catalog through `ctx.skills` and resolves a file path only when a write needs one, because the registry's summaries are invocation-neutral and carry no path.
- No runtime invariant companion is published because the package owns no durable package-local state; the route tests observe the reads and writes directly.

</details>
