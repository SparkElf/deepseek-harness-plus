# Deployment scripts

These run against a live deployment under the DSH home. They live here as the record of the
procedure; the deployment home holds the copies that execute.

| Script | Purpose |
|---|---|
| `dsh-plus-switch <mirror>` | Move the served release to another mirror. Validates the target before touching the service, records each step in a phase file, and rolls back on failure. |

## Why the step order matters

A running supervisor rewrites its manifest on every progress phase: `announce()` calls
`writeStatus()`, not only `stop()`. A manifest written before a multi-second acceptance step is
therefore the supervisor's own older copy by the time the reload reads it. Measured: the manifest
named the new mirror, `profile-guard accept` ran for seconds, and the reload adopted the previous
mirror — a promotion that reports success while serving the old release.

The order that holds is `link → accept → manifest → reload → verify`.

The switch also runs itself through `systemd-run` before touching the unit: started from a
session inside the runtime unit, its `systemctl stop` would kill the very process issuing it.
