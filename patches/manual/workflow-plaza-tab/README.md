# Manual patch: 「工作流广场」 tab in the automation-task page

## What this adds

A fourth tab, `工作流广场` / *Workflow plaza*, inside the existing automation-task page
(`ui-schedule`'s `TaskManagerPage`). The tab is a **template shelf**: it lists built-in
workflow definitions and turns one click into an ordinary DSH Schedule. The label follows the
client language, so the same tab reads `Workflow plaza` under `en`.

The seat is declared as a child slot of the page:

```
schedule.manager.tabs   kind: single   scope: root
```

A contributing plugin registers into it; the page renders that contribution as the fourth
tab's body. Two properties matter and are preserved deliberately:

1. **Backward compatible.** The tab button is appended only when
   `props.plazaAvailable?.() === true`, and that probe reads the live slot table
   (`ctx.slots.entriesOfSlot("schedule.manager.tabs")`). With nobody contributing the button
   is never rendered: three tabs, same order, same styles, same behaviour.
2. **Minimal.** The three status tabs' `map(...)` is untouched; the plaza button is
   *appended* to that children array with `.concat(...)`, and the search/list block is only
   wrapped in a conditional so it can be skipped when the plaza tab is selected. No other
   line of the page changes.

## Why it is manual

`ui-schedule` ships as a built bundle inside the runtime tree the deployment serves. The
profile's patch set cannot reach a source build, and the package ships `lib/` only (no
`src/`), so — like every other entry under `patches/manual/` — this patch edits the built
`lib/client.js`.

## Base version

Confirmed against:

- `@deepseek-ai/dsh-client-ui-schedule@0.2.1-rc.2` (the rc.2 line the workspace image now
  ships). The anchors are located by content, not by line number, and the same three anchors
  exist in the 0.2.1-alpha.2 build this patch was first derived from.

## Apply

```sh
patches/manual/apply-manual-patches.sh <profile-or-release-root>
```

or by hand, from the package directory:

```sh
cd <root>/node_modules/@deepseek-ai/dsh-client-ui-schedule
patch -p1 --fuzz=0 < /path/to/workflow-plaza-tab.patch
```

`apply.py` is the same transformation expressed as a script, for the case where the bundle
has drifted far enough that a textual patch no longer applies; it is content-anchored and
idempotent (marker: `task-manager-plaza-body`). Both produce byte-identical output on the rc.2
bundle.

## Image integration

The workspace image applies this patch at build time, to **both** served trees, before the
profile marker is computed (the marker's digest is what makes a runtime re-copy the template):

```
dataops/infra/docker-workspace/workflow-plaza-patches.py
  /opt/dataops-dsh-install            -> copied to /opt/dsh-plus in the final stage
  /opt/dataops-dsh-profile-template   -> what the browser loads
```

The image copy carries the same transformation; keep it identical to `apply.py` when editing.

A restart of the DSH service is required after patching an on-disk copy: the `/plugins/??…`
aggregate is assembled at boot from the profile tree, so a file edited under a running server
is not what the browser receives (measured: patched copy + restart → the served aggregate
carries `statusFilter.plaza`; without the restart the old bytes keep being served).

## Gate

```sh
python3 gate.py <stock-client.js> <patched-client.js>
```

Checks the properties the browser depends on: the stock three-tab strip survives unchanged and
in order, the appended button is guarded (an unguarded `.concat([button])` fails the gate), the
seat and its `renderSlot` body exist, both locale dictionaries carry the label, and the
empty-state / `CatalogFeedback` blocks are gated off under the plaza. Exit 0 prints one line;
any failure prints `FAIL <check>: <detail>`.

## When upgrading `ui-schedule`

This patch touches three places, each identifiable in the next version:

1. the `children:` table of the `main` slot registration — add the `schedule.manager.tabs`
   entry again;
2. the `inject` of that registration — pass `plazaAvailable: () => ctx.slots.entriesOfSlot(...)`
   alongside the existing props;
3. `TaskManagerPage` — the tab union gains `'plaza'`, the strip gains one conditionally
   appended button, and the body gains one conditional. If the page is rewritten, port these
   three edits rather than the diff.

Also re-check the `statusFilter.plaza` key exists in both dictionaries of
`task-manager-locales.ts` (or wherever the next version keeps the task-manager copy). The
`/sidebar/html` style class names are not involved here; this patch has no hash-dependent
anchor.