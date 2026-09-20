# Agent Note: The skill center is our package, built on the official skill registry

Status: proposed

English | [中文](2026-09-20-the-skill-center-is-our-package.zh.md)

## Problem

The sidebar skill center came from a third-party package, `@linxin666/dsh-client-ui-skill-explorer`. It worked, but it did not belong to the shell:

- **Its row and page did not match the panels beside them.** The entry drew its own inline SVG rather than the shared icon set, the page packed its styles into the bundle, and it carried no row glyph, subtitle, or group count where the official Plugins panel has all three.
- **It reached the desktop by injecting DOM.** Its own header records the reason: "dsh's sidebar shell exposes no slot an external plugin can register into, so ... the entry row is injected between the shell's New Session button and the workspace browser." That machinery self-heals through a mutation observer.
- **It carried telemetry.** `src/client/telemetry.ts` posts each plugin's name, version, and install channel to `https://dsh-market.com/api/telemetry/event` under an anonymous visitor id it mints and keeps in localStorage.
- **Its host half scanned the filesystem itself.** A second scanner beside the harness's own, with its own grouping rules.

The user asked for the panel to match the official one and for the package to become ours.

## Proposal

**Replace it with `@sparkelf/dsh-client-ui-skill-center`, a package we own, keeping the same feature set.**

The sidebar row registers through the official `sidebar.panellist` slot and the page through the keyed `main` slot, exactly as the official Plugins panel does, so the shell owns the row, label, and selected state. The glyph is `IconSkillOutline16` from the shared primitives, and the page reuses the official panel's measurements: the 28px inset, 20px title with a 13px intro, a filled primary action, group headings carrying their count, a 48px hairline-framed glyph per row, and borderless rows whose hover surface reaches 8px past the content.

**Reading goes through the official registry; only the writes are ours.** `ctx.skills` supplies the catalog, its provider precedence, and its hot reload, and the routes read it rather than scanning disk. The registry's summaries deliberately omit file paths — they are invocation-neutral metadata — so a write resolves its path through `ctx.skills.get()` when it needs one. `collect()` caches the catalog those calls share, so the resolve is not a second scan.

The registry is read-only, so the three writes have no official equivalent and stay here: enable/disable rewrites `disable-model-invocation` in the YAML frontmatter in place, create writes a standard `SKILL.md`, and delete moves the skill into a `.trash` sibling.

No telemetry of any kind ships: the reporter is deleted rather than disabled.

## Findings this change rests on

1. **The sidebar slot the third-party entry says does not exist does exist.** `sidebar.panellist` is declared in `packages/client/ui-sidebar/src/client/contract/slots.ts` and read by `entriesOfSlot` in that package's client plugin, which is how the official Plugins entry registers.
2. **The old package ships no source, only a bundle with an inline source map.** Eleven real TypeScript files recover from it, which is what made a faithful replacement possible rather than a rewrite from behaviour alone.
3. **Its telemetry endpoint and visitor key are literals in that recovered source.**
4. **The registry's summaries carry no path.** `toSummary` destructures seven fields and path is not among them, so the write routes must resolve it.
5. **The isolated instance renders the panel in Chinese with zero console errors**, registers the row beside the official "Plugins" entry, and lists the loaded skills grouped by source.
6. **All three writes work against a running instance**, verified by creating a skill, disabling it (the file gains `disable-model-invocation: true`), and deleting it (it moves into `.trash`).

## Acceptance criteria

- The sidebar entry registers through `sidebar.panellist` and the page through `main`; no DOM injection and no mutation observer.
- The row glyph comes from `@deepseek-ai/dsh-client-ui-primitives`.
- No string in the published bundle reaches a third-party endpoint; no telemetry module exists.
- The catalog comes from `ctx.skills`; a user skill in `~/.dsh/skills` or a project root appears without a second scanner.
- Grouping, search, enable/disable, create, and delete behave as before.
- The panel matches the official panel's measurements on the same page.

## Alternatives considered

**Patch the third-party package's bundle.** It has no source to patch, the change is a rewrite of its presentation layer, and the result would be our edits inside someone else's artifact on every release.

**Keep the DOM injection and only restyle the row.** Rejected: the shell owns the row through a slot, so restyling an injected row preserves the mechanism the official panels do not need.

**Disable the telemetry reporter instead of deleting it.** Rejected: a deployment should not carry a reporting path it never uses, and the reviewer of the next change would have to re-establish that it is off.

**Teach the new package to scan the filesystem like the old one.** Rejected: it duplicates the harness's discovery, loses hot reload, and its grouping would drift from the registry's.

## Risks

**A skill the registry does not list cannot be managed.** The panel shows what `ctx.skills` reports, so a skill file the registry declines to load is invisible here; the old scanner would have shown it.

**A write needs the registry to resolve the skill's path.** A skill registered without a file path — a virtual or runtime-registered skill — cannot be toggled or deleted, and the panel reports that rather than acting.

**The old package's users lose its extras.** Its source carries a filter module and a telemetry channel beyond what this package reproduces; the feature set the deployment used — browse, search, toggle, create, delete — is what was carried over.
