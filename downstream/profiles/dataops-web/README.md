# DataOps web profile

Generated from `downstream/release-manifest.json`.

- `package.json` pins every profile dependency; packages with `override=enabled` use `workspace:*`.
- `profile.json` lists the bundle composition and local package paths.
- Do not hand-edit dependency versions: update the release manifest first.
- The image builder must consume `profile.json` plus `release-manifest.json`; it must not read a running profile's `node_modules`.
