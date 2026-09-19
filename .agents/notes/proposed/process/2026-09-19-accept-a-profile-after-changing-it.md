# Agent Note: Accept a profile after changing it, or systemd refuses the restart

Status: proposed

English | [中文](2026-09-19-accept-a-profile-after-changing-it.zh.md)

## Problem

The systemd unit that runs the Plus supervisor executes a guard before the supervisor starts:

```
ExecStartPre=.../profile-guard.mjs guard --state /root/.dsh/supervisor/accepted-profile.json
```

The guard fingerprints the profile's runtime closure and compares it against the state accepted earlier. **Any change to that closure refuses the start**, and because the unit declares `Restart=on-failure`, a restart then fails repeatedly and leaves the deployment down:

```
profile-guard: accepted Plus profile runtime closure was modified
profile-guard: after changing the profile, record it with
               'profile-guard.mjs accept --profile <dir> --profile-link <link> --manifest <file> --state <state>'
deepseek-harness-plus.service: Failed with result 'exit-code'.
```

Measured on this host: three failed starts 11 seconds apart, and the service stayed down until the profile was accepted by hand.

**Nothing announces the requirement at the moment it is needed.** The guard prints its hint to the journal, which nobody reads until the service is already down. A change reaches the profile through several ordinary routes — a plugin install, a link repair, a patch application — and each of them silently invalidates the acceptance.

## What happened

Repairing the release scope (`relink-release.mjs --profile`) added links to the production profile's `node_modules`, which is exactly the closure the guard fingerprints. A restart followed, and systemd refused it three times. Recovery was a hand-run `accept`.

The repair itself was correct and necessary; what was missing was the acceptance step between the change and the restart.

## Proposal

**A profile change and the restart that follows both belong to one sequence, and that sequence owns the acceptance.**

`dsh-change` runs the six steps in order and exits at the first gate that fails, leaving the running service untouched:

1. **Relink the release scope.** A release resolves `@deepseek-ai` names from its own `node_modules` as well as the profile's, and an install inside the release rewrites the first down to whatever it declared. The running service keeps working, so this failure is invisible until a restart.
2. **Run the command** — an install, a link, a patch.
3. **Relink again**, because that command may have rewritten the scope.
4. **Verify on a spare port** (`dsh-verify`). A profile that cannot boot is then a failed check, not an outage.
5. **Accept the profile** with the guard. Reaching this step means step 4 already showed the profile boots.
6. **Restart the unit and confirm** that it is active and its own port answers.

**The rehearsal unit exists so the sequence can be practised.** `dsh-rc30-staging.service` runs the same release on another port with its own `DSH_HOME` and its own guard state, so the whole six steps run against a service whose failure costs nothing.

## Findings this change rests on

1. **The guard fingerprints the closure, not the manifest.** `fingerprintProfile` hashes every runtime file under each package directory, so adding a symlink changes it.
2. **A failed start repeats.** `Restart=on-failure` with `RestartSec=2` produced three attempts and then `Start request repeated too quickly`.
3. **The acceptance is per profile link.** The state records `profileLink` and `acceptedProfile`, so a rehearsal instance needs its own state file rather than the production one.
4. **The guard needs a manifest.** `accept` reads `runtime.json` for the runtime configuration it records; a rehearsal instance needs its own copy.
5. **Step 6 must read the unit's port.** A literal `3080` in the confirmation reported the wrong service when the same sequence ran against the rehearsal unit.

## Acceptance criteria

- A command that changes a profile is followed by an acceptance before any restart.
- A profile that cannot boot fails the sequence before the unit is touched.
- The sequence exits non-zero at the first failing gate and names it.
- The confirmation reports the port the restarted unit actually serves.
- The rehearsal instance runs the same sequence without affecting the running deployment.

## Alternatives considered

**Accept automatically inside the relink helper.** Rejected: acceptance asserts that the closure is intended, and the helper cannot know that. It is the operator's statement, made once, after the profile has been shown to boot.

**Disable the guard.** Rejected: it is what caught a profile whose closure had drifted from what was accepted. The gap is the missing acceptance step, not the check.

**Change the profile and restart in one command without verification.** Rejected: this is what caused the outage. Step 4 exists so the restart is the second time the profile boots, not the first.

## Risks

**The sequence requires a spare port.** Verification starts a real instance, so a deployment with no free port cannot verify before restarting.

**An accepted profile that boots can still be wrong.** The guard and the verification check that the closure loads, not that the change was the intended one; a plugin installed by mistake is accepted and served.
