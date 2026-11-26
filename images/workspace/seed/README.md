# seed/ — tracked copies of build inputs

The workspace build context keeps large artifacts out of version control. `xlsx-0.20.3.tgz` is the
one exception: the public path used to depend on `cdn.sheetjs.com` for the upstream tarball and
then repack it, and that CDN can truncate or stall. Committing the already-repacked artifact makes
the public path network-independent for this input.

| File | Bytes | SHA-256 | MD5 |
| --- | --- | --- | --- |
| `xlsx-0.20.3.tgz` | 2412635 | `275220ad69ba7721886e274d3a635ef5b04a9404cf0019f631bc19b8faa05c2a` | `5ab9436a1aabeae822c3ed26dd1465d9` |

`scripts/prepare-inputs.sh --public` copies this file to `context/vendor/xlsx-0.20.3.tgz` after
checking it against the `vendorTarballs` row in `../inputs.lock.json`, and reports the source as
`repo-seed`. When the seed is absent or does not match, the script falls back to the SheetJS CDN
and the recorded `source.fallback.recipe`.

The file is byte-identical to `dataops/infra/docker-workspace/vendor/xlsx-0.20.3.tgz` at
`source.commit` in `../inputs.lock.json`. Refresh both the file and the row digests together when
the pinned SheetJS version changes; `seed/` is outside the Docker build context, so it is copied
in rather than sent to the daemon.
