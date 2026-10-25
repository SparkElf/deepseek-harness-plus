# Handoff: 工作流广场 (workflow plaza) — state at handoff

## Done and verified

### Knowledge-base plugin (contributing side)

| Path | What |
|---|---|
| `src/client/workflows/registry.ts` | 3 built-in definitions + `workflowMarker()` |
| `src/client/workflows/cron.ts` | shortcut mapping + 5-field shape check only |
| `src/client/workflows/dedupe.ts` | already-subscribed test (marker OR id/title) |
| `src/client/workflows/subscribe.ts` | subscribe state machine, fully injected |
| `src/client/workflows/deps.ts` | Host wiring over `remote.schedule.catalog/delete` |
| `src/client/workflows/WorkflowPlaza.tsx` | cards + subscribe dialog |
| `src/client/workflows/WorkflowPlaza.module.css` | card/plaza styling |
| `src/client/locales.ts` | ~38 `workflow*` keys (en + zh) |
| `src/client/index.ts` | `schedule.manager.tabs` registration + `createWorkflowPlazaDeps` |
| `tests/workflows.spec.ts` | 34 tests |

Numbers: **716 passed / 27 files**; `tsc` clean for every file above.

The three built-ins: `kb-organize-personal` (weekly, tidy personal bucket),
`kb-index-personal` (daily, fill in missing Markdown text copies),
`kb-archive-stale` (monthly, archive documents untouched for 90 days).

### Why subscribing goes through a Session

DSH exposes Schedules to the browser as **read and delete only**; creation is the
`schedule_create` **agent tool**. The task manager page documents this as intentional
("The page deliberately has no creation form of its own"). So subscribing creates a
Session, prompts the model to call `schedule_create` with the chosen cron and the
workflow's standing instruction, then **verifies** by re-reading the catalog. A prompt
that was merely delivered is not reported as success.

### Duplicate protection (three layers)

1. **Synchronous ref lock** in the dialog — a double click cannot reach the
   orchestration before the first attempt has awaited.
2. **Pre-flight catalog read** inside `subscribeWorkflow` — an existing subscription
   short-circuits before a Session is created (asserted: `createSession` not called).
3. **Card state always comes from the catalog**, never from component memory, so a page
   refresh cannot resurrect the Subscribe button.

Recognition is deliberately generous: the `[workflow:<id>]` marker **or** the id
appearing in the task's prompt/name counts. A false "already subscribed" is a much
smaller problem than a duplicate nightly job over someone's documents.

## Done, but not observable

### `ui-schedule` patch

`patches/manual/workflow-plaza-tab/` — patch + `apply.py` + `README.md` (upgrade notes),
wired into `apply-manual-patches.sh` (`patch_targets` + `patch_marker`).

Applied to all three on-disk copies and `node --check` clean on each:

```
/opt/dsh-plus/node_modules/@deepseek-ai/dsh-client-ui-schedule/lib/client.js
/opt/dataops-dsh-profile-template/node_modules/@deepseek-ai/dsh-client-ui-schedule/lib/client.js
/workspace/.dataops/dsh/profiles/dataops-web/node_modules/@deepseek-ai/dsh-client-ui-schedule/lib/client.js
```

Backups: `/tmp/*-client.bak` inside the runtime container.

## The one open gap

**The running server does not serve the patched `ui-schedule`.**

Proof, not inference — the served bundle was captured and compared:

| Check | Result |
|---|---|
| `task-manager-plaza-tab` in the served aggregate | **absent** |
| `schedule.manager.tabs` in the served aggregate | **absent** |
| `}, value))` (the *original* tab map) in that same bundle | **present** |
| `onNewTask: () => {` (original inject) | **present** |
| Appending a unique marker to `client.js` on disk, then re-fetching | marker **absent** |
| Appending to that file and comparing the URL's `rev=` | `rev` **unchanged** |

So the aggregate (`/plugins/??…&rev=…`, `cache-control: public, max-age=31536000,
immutable`) is produced from a source that is **not** any of the three `node_modules`
copies. `ui-schedule` *is* inside it (its `task-manager-page` test id and
`statusFilter.all` are present), so it is built from some other copy of the same
version — most likely a prebuilt application artifact whose build step is upstream of
the profile tree.

Searches run, all negative: `find / -name "*.js" -size +5M -newer /etc/hostname`;
`grep -rl task-manager-plaza-tab /opt /usr/local /workspace | grep -v node_modules`;
`grep -rl '}, value))' /opt /usr/local /workspace` (only the three known copies).

**What unblocks it:** rebuild the artifact that the aggregate comes from, with this
patch applied — the same class of fix as the earlier "plugin page grouping lost" issue,
where editing `node_modules` also did nothing and the fix had to go into the template
plus the build output.

## Resolution (rc.2, 2026-10-23)

The conclusion above was a measurement artifact: the aggregate is not built from a different
tree, it is assembled **at boot** from the profile tree. Re-measured in a throwaway container of
the rc.2 image and then on the live admin workspace:

1. patch the profile copy under
   `/workspace/.dataops/dsh/profiles/dataops-web/node_modules/@deepseek-ai/dsh-client-ui-schedule/lib/client.js`;
2. `dataops-dsh-service stop` then `ensure`;
3. fetch the `/plugins/??…` aggregate that carries `dsh-client-ui-schedule/client.js`.

With the restart the aggregate carries `statusFilter.plaza`; without it the old bytes keep being
served. That is why editing `node_modules` under a running server looked ineffective.

Live acceptance on the admin workspace (`ui-schedule@0.2.1-rc.2`, knowledge-base installed),
before → after the same page:

| Check | Before | After |
|---|---|---|
| tab strip | All / Enabled / Inactive | All / Enabled / Inactive / Workflow plaza (`task-manager-plaza-tab`) |
| plaza body | absent | `task-manager-plaza-body` with three cards: Tidy up my personal knowledge base (`0 9 * * 1`), Tidy document text copies (`0 9 * * *`), Archive stale personal documents (`0 9 1 * *`) |
| empty state under the plaza | n/a | absent |
| `pageerror` | none | none |

Screenshot: `evidence/plaza-after.png`. The tab renders `Workflow plaza` in an `en` client; the
`zh` dictionary carries 工作流广场.

The patch is applied at image build time by `dataops/infra/docker-workspace/workflow-plaza-patches.py`
(both served trees, before the profile marker is computed), so it survives a container recreate.
The running profile copy was patched by hand for this verification and has a `client.js.plaza-bak`
backup.

## Acceptance still to run (five checks)

1. The automation-task page shows a fourth tab, 工作流广场 / Workflow plaza. — **done** (§Resolution)
2. Opening it lists three cards. — **done** (§Resolution)
3. Subscribing opens a dialog with the cron prefilled; confirming puts the task in
   「已开启」/Enabled with the chosen schedule.
4. The card turns 已订阅 / Subscribed, and clicking again creates nothing.
5. Unsubscribing restores the Subscribe button.

A 34-test unit suite already covers the logic behind 3–5; only the wiring into the
served page is unverified.

## Note for the `initialize.ts` owner

`src/index.ts` now supplies `InitIo.isStorageReady` (marked `TEMPORARY
(lead-approved)`), implemented as:

```ts
isStorageReady: async () => (await classifyMount(config)) !== 'absent'
```

Rationale: `InitIo.isStorageReady`'s own doc says it answers whether **the storage the
root lives in** is attached — not whether the root exists, since provisioning creates
it. `classifyMount` already answers exactly that and distinguishes "share attached" from
"share attached, pointer not built yet". Reusing it avoids a second definition of "the
share is there" that could disagree with the status route. **Please confirm this is the
semantics intended**; if `isStorageReady` was meant to gate on something narrower, the
implementation belongs beside `classifyMount`, not in the call site.
