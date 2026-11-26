# Splitting `apply-plus.sh` into source-build and profile phases

Status: implemented (G6, 2026-11-26). The production DataOps build stays untouched; this page
describes the monorepo implementation and the measurements taken against local candidate images.

## Phase contract

`dsh-plus apply` used to own four phases in one call: profile workspace setup and `pnpm install`,
source patch application, `pnpm install` in the source tree, and `pnpm run build:official`. The
CLI now accepts `--skip-build`, which keeps the profile work and refuses to touch the source
build:

| Phase | Owner | Command |
| --- | --- | --- |
| Source patches, source `pnpm install`, `build:official`, marker | `dsh-plus apply` (full) | `apply-plus.sh --phase source` |
| Profile install, patch materialization, profile link, lock | `dsh-plus apply --skip-build` | `apply-plus.sh --phase profile` |
| Both, in the original order | `apply-plus.sh` default | `apply-plus.sh` / `--phase full` |

`--skip-build` does not run `pnpm install` in the source tree and does not invoke
`build:official`. It still runs the profile half: `prepareSelection` installs profile dependencies,
`applySelectedPatches` materializes the profile patch set, and `linkOfficialPackages` rebuilds the
profile's `@deepseek-ai` scope.

## Build marker

A full apply writes `/opt/dsh-source/.dataops-official-build.json` after `build:official`
succeeds:

```json
{
  "sourceRevision": "<40-hex git HEAD>",
  "patchsetDigest": "<sha256 over the selected source patch ids, files, base revisions and bytes>",
  "builtAt": "<ISO-8601>"
}
```

The digest is the same row list `scripts/apply-plus-preflight.sh` computes, sorted by patch id.
`--skip-build` fails closed unless all four facts hold:

1. every selected source patch is already applied (the CLI marks them applied after a full run);
2. the marker revision equals `git rev-parse HEAD`;
3. the marker digest equals the digest of the patch files the installed distribution selects now;
4. `apps/cli/lib/bin.js` and `packages/client/ui-chat/lib/client.js` exist.

The CLI writes the marker because it already owns the selection and the build; an external writer
would have to duplicate the digest and could drift. `scripts/apply-plus-preflight.sh` stays the
read-only check: it reports `skip-build-safe` only when the marker matches.

`--skip-build` authenticates with the marker instead of re-probing each patch with `git apply`.
The build's existing cleanup removes `tests/`, `docs/` and other paths that some patches touch, so
per-patch reverse application cannot classify those patches after the source phase even though the
built tree is exact. A re-run of the *full* apply on an already-cleaned image still fails for that
reason; the staged entry avoids it by running `--phase source` before cleanup and `--phase profile`
afterward with the marker.

## Script phases

`context/apply-plus.sh` accepts `--phase full|source|profile`, `--skip-build`, and the environment
forms `APPLY_PLUS_PHASE` and `APPLY_PLUS_SKIP_BUILD`. The default remains `full`, so the existing
single-call semantics are unchanged.

- `source` runs the workspace setup, the source-level text patches, a full `dsh-plus apply`,
  the compiled-bundle repair, and the build-only cleanup. It does not run the profile-only repairs.
- `profile` runs the workspace setup, `dsh-plus apply --skip-build`, the compiled-bundle repair
  (idempotent), the edition bundle restore, the lock assertion, and the slots flatten.
- `full` runs both sets in the original order.

## Docker stages

`context/Dockerfile.plus-cli-src` now has:

```text
plus-inputs   Plus tarball metadata edits, global install, profile dependency rewrite
  -> source-build   apply-plus.sh --phase source   (patches + build + marker + cleanup)
  -> plus-build     apply-plus.sh --phase profile  (profile install/link + repairs)
                    plus the rest of the existing layer
```

The final stage keeps the name `plus-build`, so `docker build --target plus-build`, the bake
`plus` target and `scripts/build-workspace-final.sh` keep their existing entry and tags. The new
intermediate target is `source-build` in both the Dockerfile and `docker-bake.hcl`;
`scripts/build-plus-staged.sh` builds the two stages separately and prints each stage's wall time.

## Acceptance

```bash
cd images/workspace

# 1. A pre-G6 image: expect full-build-required and no marker.
./scripts/apply-plus-preflight.sh --image <candidate> --json /tmp/preflight-before.json

# 2. After a full or source phase: the marker must match and the verdict must be skip-build-safe.
./scripts/apply-plus-preflight.sh --image <source-build-image> --json /tmp/preflight-after.json

# 3. Profile phase: it must not invoke build:official or a source pnpm install.
docker run --rm --entrypoint sh <source-build-image> -c \
  'PATH=/tmp/pnpm-shim:$PATH bash /usr/local/bin/apply-plus.sh --phase profile'

# 4. Negative: change one patch file's bytes; --skip-build must fail with a digest mismatch.
# 5. Default chain: build without a phase flag; the log must still contain the official build and
#    verify-runtime-paths.sh must pass with the same bundle count.
```

The pin-only target of five minutes is still unmeasured. A pin-only change edits the Plus tarball,
which is a `COPY` input of the source stage, so the source stage re-runs even though the patch bytes
are unchanged. Isolating patch bytes in a separate extraction stage is a second change; stage
timings from `build-plus-staged.sh` are the evidence to decide whether to make it.