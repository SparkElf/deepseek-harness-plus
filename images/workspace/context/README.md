# images/workspace/context — Docker build context

This directory is the `docker build` context for all three workspace images. Its layout mirrors
`dataops/infra/docker-workspace` one-to-one so that every `COPY <path>` in the Dockerfiles resolves
without editing the build definitions. The mirror is byte-identical apart from:

- the four large artifacts that stay out of version control (`dsh-src.tar.gz`, the Plus tarball,
  `vendor/*.tgz`, `officecli-bin/officecli-linux-*`), documented by placeholders and
  `../inputs.lock.json`;
- `platform-sidecars/workspace-gateway.mjs`, which the DataOps tree does not track and therefore
  cannot be mirrored (see [the migration gap record](../../../docs/workspace-image-migration-gap.md));
- `.dockerignore`, which excludes the placeholder notes from the image.

Nothing here is a second source of truth during the migration window: DataOps still owns these
files, `scripts/check-parity.sh` compares them by digest, and any edit on either side must land on
both until B-10 retires the DataOps copies.