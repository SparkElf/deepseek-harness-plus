# Agent Note: Read the failing extension point before choosing a delivery mechanism

Status: proposed

English | [中文](2026-09-16-read-the-extension-point-first.zh.md)

## Problem

A user reported that clicking a produced-file chip (写入 / 读取) opened the sidebar editor with a red failure: the HTML preview route answered `400 fs-error: cannot resolve target "/kayako-saeki.html"`. The session cwd was `/root/projects` and the file sat there; the route had received a workspace-root-relative spelling as if it were filesystem-absolute.

Three delivery mechanisms were proposed in sequence, and the first two were wrong:

1. **Replace the sidebar's viewer.** The plugin service exposes `registerFileViewer`, so a first-party viewer with its own path resolution looked like the "our own plugin" answer. It is not: the builtin `html` viewer's component **is** `TextEditor` — the same component that owns edit mode, save, and the two sandbox settings. Overriding it at a higher priority would have traded this defect for the loss of HTML editing. The registry only offers whole-viewer replacement; it exposes no "resolve the src differently" hook, and `dsh-better-sidebar/client` exports no `TextEditor` to delegate to.
2. **Republish the third party package under our scope.** That is the mechanism for official `@deepseek-ai/*` workspaces, whose built `lib/` cannot express a TypeScript change and which therefore travel as `overrides: npm:@sparkelf/...`. `dsh-better-sidebar` is not that: it is an external npm package already covered by `patchedDependencies`, and the deployment had shipped a patch through that path for months.
3. **One npm-target patch on the published bundle.** Correct, and identical in kind to the `better-sidebar-media-path` patch already in the tree: same package, same file, same class of path defect.

The cost of the two wrong answers was a scaffolded plugin package that was written and then deleted, and a round of user corrections. A third, larger defect surfaced while verifying the fix: the gate that claimed to check npm patch applicability had never checked anything.

## Why it reached the workspace

**The mechanism was chosen from the API surface rather than from the failing code.** `registerFileViewer` was read as "the extension point for this", and the descriptor's `priority` as "we can take it over" — both true, and both silent about what the builtin viewer also owns.

**The existing skill was not loaded.** `.agents/skills/dsh-plugin-ownership-and-distribution/SKILL.md` required, before implementation, to read *"the capability's current Host and Client entries, package manifest, bundle patch, settings and persistence owners"* and to report the owned surface. Its first evidence step alone would have shown `component: LazyTextEditor`.

**Two mechanisms were conflated.** "Patch" was treated as one thing. In this repository it is two: an npm-target patch delivered through the profile's `patchedDependencies` (works for external packages), and a republished first-party package delivered through `overrides` (works for official workspaces). A judgement about one was applied to the other.

## Proposal

**Before adding, moving, or replacing any capability, read the code that currently owns it, and name which of the two delivery mechanisms applies.** Concretely:

1. Open the failing entry point and read what it is — component, handler, or config. For a UI capability, the descriptor that currently matches the target, and every component it can render.
2. List what that owner also provides. Edit mode, persistence, settings, and disposal count as owned surface; taking the id takes them too.
3. Name the delivery mechanism explicitly as one of: profile configuration, our own plugin, **npm-target patch on an external package**, or **republished first-party package**.
4. If the answer is "our own plugin", state which published extension point it mounts on and what it replaces. A replacement that silently drops an owned capability fails step 2.

For UI capabilities, step 2 is the one that is skipped: a viewer registry's `registerFileViewer` reads as an extension point while the builtin it displaces is a full editor.

The Agent Teams dependency change that exposed the vacuous gate is carried by the same rule: the two packages publish with the dsh family, so a runtime may depend on them, and the isolation check now names that distinction instead of rejecting every package under `packages/experimental/`.

## Acceptance criteria

- A capability taken over from another plugin names what that owner also provided, and the replacement does not drop any of it. Reviewing the builtin `html` viewer in `dsh-better-sidebar` names editing, saving, and the two sandbox settings before the replacement is written.
- Every patch decision states one of the four delivery mechanisms by name. A payload against an external npm package reaches a registry installation through the profile's `patchedDependencies`; an official workspace whose built `lib/` cannot express the change travels as a republished package under our scope.
- `verify-plus-governance` rejects a mangled npm payload. Measured: replacing every context line of the `better-sidebar-html-preview-path` payload with `MANGLE-XYZ` fails the gate with `npm patch does not apply to dsh-better-sidebar@0.19.1`, and the unmodified payload passes.
- `check-workspace-constraints` still rejects a runtime dependency on a private experimental package, and accepts one on a published experimental package. The spec covers both: `packages/experimental/prototype` (private) is rejected, `packages/experimental/agent-team` is allowed.

## Alternatives considered

**Replace the builtin viewer at a higher priority.** Rejected: the builtin it displaces is the file type's editor, so the trade is a working preview for the loss of editing, saving, and its settings. The registry also offers no narrower hook and the package exports no editor to delegate to.

**Republish `dsh-better-sidebar` under our scope.** Rejected: that mechanism exists for official workspaces whose built output cannot express a TypeScript change. This package is external and already reaches deployments through `patchedDependencies`, which the media payload has used since it shipped.

**Leave the applicability gate as it was, on the workspace copy.** Rejected: the repository ignores `node_modules`, so `git apply --check` there skipped the file and returned 0 for any payload. The gate named two payloads and checked neither.

**Keep the experimental isolation rule as written and enable Agent Teams outside the distribution.** Rejected by the requirement that a distribution user must be able to run it: the Agent Teams packages publish with the dsh family, so their absence from the release is not what the rule protects against.

## Risks

**A higher-priority viewer is a takeover, not a decoration.** Any future registration on an extension another plugin owns carries the same risk this note describes; the acceptance criterion covers the reviewer's step, not a mechanical one.

**The applicability gate now reaches the network.** `verify-plus-governance` fetches the published tarball for each declared range, so it fails without registry access and slows with it. The alternative was a check that proved nothing.

**Allowing a published experimental package as a runtime dependency widens what a release can carry.** The exception is keyed to the explicit `PUBLIC_EXPERIMENTAL_PACKAGE_DIRECTORIES` list, so a new experimental package stays isolated until someone adds it there deliberately. Agent Teams itself is pre-stable: enabling it in a distribution makes every user's sessions load a team layer the upstream project does not promise to keep compatible.

## Findings this change rests on

1. **The builtin `html` viewer is the editor.** `dsh-better-sidebar/src/client/builtins/viewers.tsx` registers `id: 'html'`, `exts: ['html','htm']`, `component: (props) => <LazyTextEditor {...props} />`; `LazyTextEditor` loads `TextEditor`, whose `ViewMode` carries `preview` and `edit` and which owns `fsWrite`. Three viewers (`md`, `html`, catch-all `code`) share that component.
2. **`registerFileViewer` replaces a viewer; it does not decorate one.** The service in `src/client/service.ts` offers `registerTab`, `registerFileViewer`, `registerFileIcon`, `openTab`, `closeTab`, and `matchFileViewer`; `matchFileViewer` walks descriptors by `priority` desc. No hook narrows a builtin's URL construction.
3. **`dsh-better-sidebar/client` exports only `inject` and `apply`.** An external plugin cannot import `TextEditor` and delegate to it, so a first-party HTML viewer would have to reimplement editing and saving.
4. **The html route fails on a workspace-root-relative path.** `lib/index.js` calls `ensureWorkspacePath(await sessionCwdOf(ctx, sessionId), path, fence)`, where `ensureWorkspacePath` runs `requireAbsolute` then `realpath`. `/kayako-saeki.html` satisfies `isAbsolute` — it is a legal POSIX root — and then fails to resolve. The client reaches that state through `resolveSidebarPath`, whose `isAbsolutePath` accepts a single leading `/` by design, and through `TextEditor`'s use of the tab path verbatim.
5. **The media route had the same defect and was already patched.** `better-sidebar-media-path` bounds the client-supplied path to the session cwd; that patch reaches the installed package, verified by its comment appearing in `node_modules/dsh-better-sidebar/lib/index.js`.
6. **`patchedDependencies` reaches a registry installation.** `apply.ts` writes each npm payload into the profile's `.dsh-plus/patches/` and registers it in `pnpm-workspace.yaml`, and `pnpm install` applies it. No source checkout is involved.
7. **`verify-plus-governance` gated npm patch applicability vacuously, and now does not.** `verifyNpmPatchApplies` resolved the target from the distribution's `node_modules`, which the repository ignores: git skipped the file and exited 0 whatever the payload said. Measured before the fix — a payload with every context line replaced by `MANGLE-XYZ` returned 0 from `git apply --check`, so the gate that named the two payloads never checked either. Measured after — the mangled payload fails with `npm patch does not apply to dsh-better-sidebar@0.19.1`, and the real payloads pass. The check now fetches the published tarball for the declared range, unpacks it, and runs `git apply --check` inside an initialized scratch repository, so it acts on what the registry serves rather than on whatever a local tree happens to hold. A workspace copy is the wrong subject twice over: `dsh-better-sidebar` reaches a deployment through the profile's own install, and a copy left by an earlier experiment held different bytes from the published ones.
