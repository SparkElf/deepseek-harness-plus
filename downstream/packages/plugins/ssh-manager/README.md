# @sparkelf/dsh-ssh-manager

An official right-Sidebar SSH inventory and guarded-operation workbench for DeepSeek Harness 0.1.5.

## Current capabilities

- Clustered host inventory with search, names, descriptions, tags, environments, jump-host references, and known-host fingerprints.
- Password, private-key, passphrase, and SSH-agent metadata flows backed by the shared encrypted Workbench vault.
- Host detail view and sanitized Send to conversation action.
- Host and cluster CRUD Host APIs.
- Non-secret ssh_list_hosts and ssh_get_host model tools.
- ssh_prepare_command creates an explicit-review command request but never executes it.
- Strict SSH connection testing with an explicit OpenSSH SHA256 known-host fingerprint; unknown or changed host keys are rejected and the observed fingerprint is reported.
- Password, private-key/passphrase, and SSH-agent connection configuration through ssh2 1.17.

SSH credentials are stored as cross-session `ssh-manager/host-<digest>` grant records through the DSH `ctx.credentials` service. Existing WorkbenchVault SSH records migrate automatically on first load and are removed after the central record is confirmed. The plugin never returns decrypted credentials to browser state or model tools. A user can run one bounded command directly from the host detail pane; model-initiated `ssh_execute_command` always uses the DSH approval service and executes only after an `allowed-once` decision. Double-clicking a host opens a long-lived xterm terminal with replay, input, resize, reconnect, detach, and explicit close. The Apifox-inspired workspace uses compact SQL-Workbench-aligned typography, viewport-safe portal selects, a collapsible host explorer, a primary terminal surface with tabs and status, and dedicated Files/Tunnels views that adapt to the containing panel width. Host facts use dense horizontal key-value rows rather than tall field cards. The Files tab lists remote directories and supports browser download/upload over SFTP. The Tunnels tab manages local and remote port forwards with lifecycle state and reconnect. Jump-host chains use direct-tcpip forwarding with independent credential and known-host verification at every hop.
