# officecli-pdf

OfficeCLI exporter plugin (`kind: exporter`, extensions: `.pdf`) for
`@sparkelf/dsh-officecli`. It converts `.docx`, `.xlsx`, and `.pptx` to PDF through the
DSH officeKit service, never through a second rendering engine.

```text
officecli view report.docx pdf --out report.pdf
  → officecli-pdf export /workspace/report.docx --out /workspace/report.pdf
  → POST http://127.0.0.1:<port>/internal/office-kit/convert
  → ctx.officeKit.convert() (LibreOffice Kit)
  → report.pdf
```

## Protocol surface

| Invocation | Behaviour |
|---|---|
| `officecli-pdf --info` | Prints the manifest from `plugin.json` and exits 0. |
| `officecli-pdf export <source> --out <target> [--options <json>] [--force] [--quiet]` | Converts one file. Diagnostics on stderr; heartbeats `{"heartbeat":true}` every 10 s. |

Exit codes follow the plugin protocol: `0` success, `2` corrupt input, `3` unsupported
format, `65` invalid data, `66` missing input, `69` bridge unavailable, `70` internal,
`73` cannot create target, `75` temporary failure, `77` permission. The OfficeCLI host
surfaces the last stderr line, prefixed with `officecli-pdf:`, as
`Exporter plugin 'officecli-pdf' failed (exit N)`.

Existing targets are refused unless `--force` (or `{"force":true}` in `--options`) is
passed. This mirrors the OfficeCLI host's own contract: `--out` alone never overwrites.

## Bridge configuration

The sidecar reads, in order:

1. `OFFICE_KIT_BRIDGE_CONFIG` (explicit path)
2. `$DSH_HOME/office-kit-bridge.json`
3. `/workspace/.dataops/dsh/office-kit-bridge.json`
4. `$HOME/.dsh/office-kit-bridge.json`

`OFFICE_KIT_BRIDGE_URL` + `OFFICE_KIT_BRIDGE_TOKEN` override the file (tests only).
The URL must be loopback; the token is sent as `X-DataOps-Internal-Token`.

The DSH plugin writes that file with mode `0600`. It contains the static internal token,
the loopback port, the workspace roots, and the conversion limits. The token has no
expiry: rotating it means replacing the file and restarting the sidecar's next call.

## Install

```sh
./install.sh                       # /opt/officecli/plugins + standard discovery links
./install.sh --prefix /opt/officecli/plugins --bin-dir /usr/local/bin
./install.sh --user                # ~/.officecli/plugins only (no root)
```

`install.sh` is idempotent. It places the executable and manifest under
`<prefix>/officecli-pdf/`, then links the standard discovery path
`<officecli-exe-dir>/plugins/exporter/pdf/plugin` (falling back to
`~/.officecli/plugins/exporter/pdf/plugin`) and `<bin-dir>/officecli-pdf`.
Verify with:

```sh
officecli plugins list | grep officecli-pdf
officecli plugins info officecli-pdf
```

## Failure semantics

Every failure is explicit; none falls back to python-docx, LibreOffice direct, or any other
converter:

| Bridge error | Sidecar exit | Host `--json` code |
|---|---|---|
| bridge config missing / not listening | 69 | `plugin_failed` (`office_kit_bridge_unavailable`) |
| source outside workspace | 77 | `plugin_failed` (`path_outside_workspace`) |
| unsupported extension | 3 | `unsupported_feature` |
| target exists | 73 | `plugin_failed` (`target_exists`) |
| officeKit `timeout` | 75 | `plugin_failed` (`timeout`) |
| officeKit `invalid-document` | 2 | `corrupt_input` |
| exporter not installed at all | — | `exporter_not_found` (from OfficeCLI core) |

## Licence

MIT. Part of `@sparkelf/dsh-officecli`.