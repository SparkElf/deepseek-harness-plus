# officecli-bin/ — engine binaries (not mirrored)

This directory is a placeholder for the two OfficeCLI engine assets. `Dockerfile` copies
`officecli-bin/` into the `officecli-engine` stage and, for the target architecture, prefers a
context binary over the network download.

`SHA256SUMS` (copied from the DataOps context) is the digest authority:

| Asset | Bytes | SHA-256 |
| --- | --- | --- |
| `officecli-linux-x64` | 35,349,925 | `e8bfe04f670139f526fe4e81f11acc1bc8629e421a20c5ba7a6e25f7a54a31f7` |
| `officecli-linux-arm64` | 34,766,343 | `f90c734722fd2f41ae76e72878329f033ed36c132aa741ec44dc3827066c55b9` |

A build without these files is still valid: the stage downloads the asset named by
`OFFICECLI_ENGINE_URL` and verifies it against `OFFICECLI_ENGINE_SHA256_amd64` /
`OFFICECLI_ENGINE_SHA256_arm64`. Supplying the binaries only removes that download.

This note is excluded from the image by `../.dockerignore`.