# vendor/ — build-context tarballs (not mirrored)

This directory is a placeholder. `Dockerfile.plus-cli-src` runs `COPY vendor/ /opt/dataops-vendor/`
and then checks exact digests, so the directory must exist but its contents are supplied at build
time rather than committed here (13 tarballs, about 39 MB, several of them duplicated releases).

Populate it from the DataOps mirror `dataops/infra/docker-workspace/vendor/` or from the release
that published them. The digest table in `../../inputs.lock.json` is the authority; the digest
arguments inside the Dockerfiles repeat the three that the image asserts.

Files the two Plus/Runtime Dockerfiles actually require:

| File | Asserted by |
| --- | --- |
| `xlsx-0.20.3.tgz` | `Dockerfile.plus-cli-src` `COPY` + lockfile digest rewrite |
| `sparkelf-dsh-better-sidebar-0.30.1-sparkelf.22.tgz` | `ARG DATAOPS_VENDORED_SIDEBAR_SHA256` in both Plus and Runtime |
| `sparkelf-dsh-dataops-managed-0.4.2.tgz` | `ARG DATAOPS_VENDORED_DATAOPS_MANAGED_SHA256` in Plus |
| `sparkelf-dsh-dataops-managed-0.4.1.tgz` | `ARG DATAOPS_VENDORED_DATAOPS_MANAGED_SHA256` in Runtime |

The remaining tarballs are historical releases kept by the DataOps context. A build that supplies
only the four rows above produces the same image; a build that supplies a wrong digest fails at the
`sha256sum -c` gate rather than shipping substituted bytes.

This note is excluded from the image by `../.dockerignore`.