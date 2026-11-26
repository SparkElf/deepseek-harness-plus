# vendor/ — build-context tarballs (not mirrored)

This directory is a placeholder. `Dockerfile.plus-cli-src` runs `COPY vendor/ /opt/dataops-vendor/`
and asserts exact digests, so the directory must exist but its contents are supplied at build time
rather than committed here. `../../scripts/prepare-inputs.sh` materializes the required six from a
DataOps checkout, the tracked `../../seed/xlsx-0.20.3.tgz` copy, or npm, and verifies each against
`../../inputs.lock.json`; the SheetJS CDN is used only when that seed is missing or mismatched.

| File | Asserted by |
| --- | --- |
| `xlsx-0.20.3.tgz` | `Dockerfile.plus-cli-src` `COPY`, md5 gate and lockfile digest rewrite |
| `sparkelf-dsh-better-sidebar-0.30.1-sparkelf.22.tgz` | `ARG DATAOPS_VENDORED_SIDEBAR_SHA256` in both Plus and Runtime |
| `sparkelf-dsh-dataops-managed-0.4.2.tgz` | `ARG DATAOPS_VENDORED_DATAOPS_MANAGED_SHA256` in Plus |
| `sparkelf-dsh-dataops-managed-0.4.1.tgz` | `ARG DATAOPS_VENDORED_DATAOPS_MANAGED_SHA256` in Runtime |
| `sparkelf-dsh-dataops-im-0.1.2.tgz` | `profile-defaults/plugin-pins.json` tarball pin read by `pin-plus-plugins.mjs` |
| `sparkelf-dsh-group-chat-0.5.12.tgz` | `profile-defaults/plugin-pins.json` tarball pin read by `pin-plus-plugins.mjs` |

The remaining tarballs in a DataOps `vendor/` directory are historical releases. The fast path
copies only the six rows above; a build that supplies them produces the same image, and a wrong
digest fails the `sha256sum -c` gate or the tarball-pin check rather than shipping substituted bytes.

This note is excluded from the image by `../.dockerignore`.