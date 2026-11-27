# @sparkelf/dsh-dataops-model-default

Keep a top-level Session's model choice as the composition default, so the next new
Session opens on the model the user last picked.

## The gap this closes

A Session's model is a durable event: `model/selection`. The selector on the new-session
surface does not read that event — it reads `agentDefaultModel.currentSelection()`, which
is the `agent-default-model` profile entry (`provider` / `model` / `reasoningEffort`).
The two documents only meet when something writes the entry.

The shipped `session-controller` does forward an explicit `selectModel` call to
`agentDefaultModel.saveSelection()`, and that write goes through `configEditor` into the
profile patch. That path is silently inert in two situations, and both look identical to
the user ("the selector does not stick"):

- the composition mounts no `configEditor` (the base bundle disables `config-editor` and
  `settings` together when there is no `profileContext`), so `saveSelection()` returns
  without writing; or
- the composed value for `agent-default-model` is shadowed by another patch layer, so
  `configEditor.edit()` refuses the write.

This plugin listens to the durable event instead of to one RPC entry point. Every
`model/selection` append on a **top-level** Session schedules a profile write of the same
triple; a Session carrying `parentSession` in its header (subagent or fork child) is
ignored, so delegated work never rewrites the user's default.

## Behaviour

| Situation | Result |
|---|---|
| User picks a model in any top-level Session | after a 1 s quiet window, `provider` / `model` / `reasoningEffort` are written to `agent-default-model` |
| Burst of picks (model then effort, or rapid switches) | one write, last selection wins |
| Selection already equals the live default | no write (the controller's own save usually got there first) |
| Subagent / fork child session | ignored |
| `agentDefaultModel.saveSelection()` leaves the default unchanged | falls back to `settings.update('agent-default-model', …)`, the other accepted path to the same entry |
| No configuration editor at all | one warning per distinct selection; the Session keeps working |
| Plugin disposal | listener and pending timer are removed |

The write lands in the active profile's `cordis.patch.yml` as the `agent-default-model`
row:

```yaml
- id: agent-default-model
  config:
    provider: dashscope
    model: deepseek-v4.1-flash-1017
    reasoningEffort: max
```

Because that file is the profile's own patch (not a command-line overlay), a later start
keeps it: the DataOps profile seed only fills a missing default and leaves an existing one
alone.

## Mounting

The package is a self-mounting bundle: `dsh.bundle.patch` points at `cordis.patch.yml`,
which inserts the entry.

```yaml
- insert:
    - id: dataops-model-default
      name: '@sparkelf/dsh-dataops-model-default'
```

In a DataOps workspace image, ship the tarball through the build's extra-plugins channel:

```bash
node dataops/infra/docker-workspace/build-and-verify.mjs \
  --extra-plugins /root/projects/extra-plugins-out/model-default
```

`assemble-registry-profile.mjs` adds the package to the profile `dependencies` and to
`dsh.profile.bundles`; the bundle patch above does the mounting, so no profile row is
hand-written.

## Verifying by hand

1. Restart the managed DSH (`dataops-dsh-service stop`, then `ensure`) so the plugin mounts.
2. Check the composed entry (`--dump-config | grep -A2 'id: dataops-model-default'`) and, after
   a pick, the DSH log line `dataops-model-default: default model is now …`.
3. In a new Session pick another model and send one message.
4. Read the profile patch's `agent-default-model` row — it must name the picked triple.
5. Open a second new Session: the selector must show the picked model; reload the page and
   check again.
6. Confirm a subagent turn does not change the row.

## Failure containment

All writes are fire-and-forget from the event listener (the listener itself only schedules,
never writes: `session/event` runs inside the appending Session's publication window, where
a nested append throws). A failed write is logged once per distinct selection and never
blocks the next one.