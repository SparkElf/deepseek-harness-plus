# DataOps web image

The builder combines three inputs:

1. the generated `dataops-web` profile artifact (`downstream profile`);
2. the local `@sparkelf/dsh-plus` package tarball;
3. the pinned DSH CLI (`@deepseek-ai/dsh@0.2.3-alpha.2`).

The image runs `dsh --profile dataops-web --no-open` from `/opt/dataops-web/profile`.
It is a smokeable DSH installation, not a published production image: deployment-specific
network, volumes, secrets, and the DataOps workspace gateway remain external.
