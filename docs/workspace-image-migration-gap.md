# Workspace image migration gaps

English | [中文](workspace-image-migration-gap.zh.md)

Status: migration record for task B-08, 2026-11-26. It records what the monorepo skeleton at [images/workspace](../images/workspace/README.md) does not yet have, so a later task can close each item instead of rediscovering it. Retire this record when B-10 flips image ownership.

## Scope

The skeleton mirrors the DataOps build context byte-for-byte and resolves the build plan. It does not build an image: eight inputs are absent by design, and one of them cannot be mirrored because DataOps does not track it. The record below separates inputs that a build needs, build semantics that were never finished, and evidence that does not exist yet.

## Gap inventory

| ID | Gap | Evidence | Effect | Next step |
| --- | --- | --- | --- | --- |
| G1 | `dsh-src.tar.gz` is not in version control | `dataops/.gitignore:109` ignores `infra/docker-workspace/dsh-src*.tar.gz`; the file is 112,053,351 bytes, SHA-256 `beb37625…2c41` | A clean clone cannot run `source-deps`; re-cutting the tarball from another commit moves every source-patch anchor | Publish the tarball as a release artifact bound to `DSH_SOURCE_REVISION`, or fetch and verify it in a preflight step |
| G2 | `platform-sidecars/workspace-gateway.mjs` is untracked | `git status` reports `?? infra/docker-workspace/platform-sidecars/workspace-gateway.mjs`; 2,327 bytes, SHA-256 `8bb74de4…7afab`; `Dockerfile.runtime-cli:41` copies it | The runtime build stops at that `COPY`; a plus-only build ships three sidecars instead of four, and the entrypoint's default `combined` mode execs the same missing file, so such an image would boot without its gateway | Commit the file in DataOps. A mirror cannot invent the combined gateway, and a stub would hide the failure |
| G3 | The gateway protocol build context belongs to DataOps | `build-workspace-final.sh` passes `--build-context workspace-web-gateway-protocol=…/packages/workspace-web-gateway-protocol`; `backend/src/ai/ai-workspace-web-gateway.service.ts` imports the same package; the monorepo has no such package | A monorepo build needs a second checkout, and the wire contract has no single owner | Decide contract ownership: move the protocol into the monorepo and have DataOps consume it, or pin a DataOps revision in a lock and check its digests |
| G4 | The Plus tarball and `vendor/` tarballs are not in version control | `dataops/.gitignore:112`; `vendor/` holds 13 tarballs, about 39MB, of which 4 are referenced by digest in the Dockerfiles | A clean clone cannot run `plus-build`; `npm pack` needs registry credentials at build time | Store them as release artifacts, or fetch them in preflight and verify against [inputs.lock.json](../images/workspace/inputs.lock.json) |
| G5 | Two older build entries contradict the three-layer chain | `build-image.ps1` builds `Dockerfile` with no `--target` and tags the result `local`; the last stage of that file is `workspace-base`. `build-plus-cli.sh` builds `Dockerfile.plus-cli`, the registry-install chain with no `source-deps` and no `apply`. `dataops/AGENTS.md` still names `build-image.ps1` as the full rebuild entry | A reviewer can publish a base image as `final`, or a plus image without source patches | Mark both deprecated in DataOps and keep `build-workspace-final.sh` as the only entry |
| G6 | "Change one pin, rebuild in 5 minutes" is not reachable | `apply-plus.sh:103` runs one `dsh-plus apply` that patches, builds and installs the profile; the resulting layer is 1.11–1.68GB. The design says the split needs a `--skip-build` mode | An acceptance run against that target fails, and the pressure to pass it invites a rushed semantic change | Split `source-build` and `profile`, or restate the target as "`source-deps` hits, `apply` still runs" until the split lands |
| G7 | Runtime pruning was never implemented | No `pnpm deploy --prod` or `pnpm prune --prod` in the three Dockerfiles or in `apply-plus.sh`; the production image keeps `/opt/dsh-source` at 2.9GB, `/opt/dsh-home` at 804MB, the template at 804MB and the live profile at 804MB; profile packages symlink into `/opt/dsh-source` | The 2–4GB runtime target cannot be reached by deleting directories, and a naive prune breaks profile resolution | Prove which paths DSH resolves at runtime, then prune only those, as a separate change with its own acceptance |
| G8 | No bake definition, registry cache or multi-architecture build | No `docker-bake.hcl`; six host-local BuildKit cache ids; every image is amd64 | A different machine starts cold: 2.46GB install plus 1.11GB apply; CI cannot share the cache | Add bake targets and a registry cache behind an explicit flag, and measure a second host against the cold baseline |
| G9 | Image digest and release binding do not exist | `RepoDigests` carries only a local pseudo-digest; nothing was ever pushed. The production image has an empty `DATAOPS_DSH_SOURCE_REF` while its profile ref is set | A deployed image cannot be traced to the build that produced it | Record source ref, Plus version and image digest in one manifest, and assert non-empty values at build time |
| G10 | Two legitimate baselines disagree by 1.3GB | Production `final-20261125-sdkfix` is 13.2GB with Debian LibreOffice 7.4 plus the TDF extract; `local` is 11.9GB with the TDF apt install and the prune | "No regression" has no single meaning | Compare candidates against both rows; [baseline-20261126.json](../images/workspace/acceptance/baseline-20261126.json) records both |
| G11 | The writable-layer measurement is contaminated at runtime | `docker ps -s` reports 2.2GB, of which about 2.09GB is four `/tmp/dsh-workspace-changes-*` snapshots created by the running container | The `<50MB` target fails no matter how small the image is | Measure after excluding runtime `/tmp`, and investigate the snapshot producer separately |
| G12 | The skeleton keeps DataOps filenames instead of the design layout | This change stores `Dockerfile`, `Dockerfile.plus-cli-src` and `Dockerfile.runtime-cli` unchanged under `context/`; the ownership design names `Dockerfile.base`, `Dockerfile.plus` and `Dockerfile.runtime` | The tree differs from the design target until the rename happens | Rename together with the entry-script rewrite, and update the parity check in the same change |
| G13 | A clean-clone build has never been demonstrated | B-07 recorded the durations, digests and clean-clone build as unmeasured; the current build needs host paths, local images and credentials | "Reproducible" is a claim, not evidence | After G1–G4, build from a fresh clone on a fresh host and record the image digest and per-stage timing |

## Decisions this skeleton makes

- Mirror rather than rewrite: the three Dockerfiles and every copied input stay byte-identical, so [check-parity.sh](../images/workspace/scripts/check-parity.sh) can prove equivalence and a reviewer can diff without translation.
- Do not invent artifacts: placeholders and `inputs.lock.json` name what is missing. The missing gateway file stays missing so the runtime build fails at `COPY` instead of shipping a gateway-less image.
- Fail closed: the build entry prints the resolved plan with `--print` and exits non-zero with the full input list when a real build is requested. The only cross-repository path is an explicit environment variable.
- Keep the `dataops-ai-workspace` tag namespace during migration, because a candidate must be comparable with the recorded baseline. Renaming belongs to the release-manifest work.
- Record acceptance data as JSON with explicit nulls, not prose. An unmeasured number stays `null` with a reason.

## Next steps

| Task | Work | Done when |
| --- | --- | --- |
| B-08 residual | Commit `workspace-gateway.mjs` in DataOps; publish the DSH source and Plus tarballs; decide the gateway protocol owner | `check-parity.sh` passes and `--print` reports no missing input |
| B-09 | Build a candidate under a new tag on an independent host; run `verify-workspace-image.mjs`; record size, per-stage timing and runtime versions; drill the 3000 switch and rollback | Candidate meets the production row, the runtime probe matches, and rollback to `final-20261125-sdkfix` is demonstrated |
| B-10 | Deprecate the DataOps build implementation, point the deployment at a digest, retire the duplicate context | DataOps keeps only the deployment reference, and this record is deleted |

The repository requires an Agent Note for a non-trivial change. This task forbids committing, so the note lands with the PR that adopts the skeleton, not with these files.

## What must not happen before the switch

- Do not delete or rewrite the DataOps build files before the 3000 switch and rollback drill succeeds.
- Do not prune or retag `final-20261125-sdkfix`; it is the only rollback target, and `local` is not the production image.
- Do not treat `local` as the baseline; it is 1.3GB smaller than what production runs.
- Do not prune the runtime image to reach the 2–4GB target before proving which paths DSH resolves.

## Provenance

Source tree `dataops` at commit `e5c411e68e83cd3e03897af3c0a6cefca50d3e39`, captured 2026-11-26. The three Dockerfile digests match the B-07 baseline (`413bbee8…`, `bada4021…`, `0fc4b5eb…`). File-level digests and the expected artifact digests are in [inputs.lock.json](../images/workspace/inputs.lock.json); measurements and targets are in [baseline-20261126.json](../images/workspace/acceptance/baseline-20261126.json).