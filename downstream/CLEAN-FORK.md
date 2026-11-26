# Clean-fork image evidence

Verified from a shallow clone of `SparkElf/deepseek-harness-plus` on 2026-11-26:

```bash
git clone --depth 1 git@github-sparkelf:SparkElf/deepseek-harness-plus.git /tmp/plus-clean-fork
cd /tmp/plus-clean-fork
CI=true pnpm install --frozen-lockfile
pnpm run build
node downstream/tools/downstream.mjs build-packages
node downstream/tools/downstream.mjs verify --strict-local
node downstream/tools/downstream.mjs image --tag dataops-web-profile:clean-fork --smoke
```

Results:

```text
install              EXIT 0
full build           EXIT 0
build-packages       EXIT 0
verify --strict      EXIT 0
image --smoke        smoke: http=401
image tag            dataops-web-profile:clean-fork
```

The 401 is the DSH auth page: the image boots the CLI, loads the generated
profile, resolves every profile bundle, and listens on 3080. Production
overlays (DataOps gateway, auth, volumes, secrets) remain external.
