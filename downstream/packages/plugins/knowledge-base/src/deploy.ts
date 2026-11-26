/**
 * Idempotent deployment recipes for the knowledge base.
 *
 * Every step here is a *plan*: a named sequence of shell commands plus the
 * predicate that decides whether the step already ran. The Settings panel shows
 * each step, runs it over the {@link RemoteRunner} seam, and reports the output.
 *
 * Rules these recipes must satisfy:
 * - Re-runnable. Clicking twice must not install twice, start two servers, or
 *   fail because something already exists.
 * - Read-only probes first. A status step never mutates anything.
 * - The commands are quoted for a POSIX shell and never interpolate untrusted
 *   input without quoting.
 *
 * @module @sparkelf/dsh-knowledge-base/deploy
 */

/**
 * MinerU deployment tiers this plugin can prepare.
 *
 * MinerU 4.x recognises exactly these two (`mineru/types.py`: `DEPLOYMENT_TIERS`), and
 * `models download --tier` validates against that tuple. The `flash` name that also exists in
 * MinerU is a *quality* tier for the parsers that need no local weights, not a deployment
 * tier, so it cannot be prepared and is not offered here.
 */
export type MineruTier = 'basic' | 'standard'

/** Small-model backend for MinerU. */
export type MineruBackend = 'onnx' | 'torch'

/** One step of a deployment plan. */
export interface DeployStep {
  /** Stable id used by the UI. */
  id: string
  /** Human-facing label key. */
  label: string
  /**
   * Commands to run in order. Each is a complete shell line.
   * `{{...}}` placeholders are substituted from {@link DeployPlanContext}.
   */
  commands: string[]
  /** How long this step may take; model downloads are slow. */
  timeoutMs: number
}

/** Values substituted into command templates. */
export interface DeployPlanContext {
  /** Absolute path of the authoritative knowledge tree. */
  actualRoot: string
  /** Absolute path of the per-user view tree. */
  viewRoot: string
  /** Tier to deploy. */
  tier: MineruTier
  /** Small-model backend. */
  backend: MineruBackend
  /** TCP port the MinerU API listens on. */
  port: number
  /** Client hosts allowed to mount the NFS export, as an exports spec. */
  permitted: string
  /** Host serving the export, as `address` or `address:/path` (the pseudo root). */
  server: string
  /** Where the client mounts the export, i.e. the browsable knowledge tree. */
  mountPoint: string
  /** Memory ceiling in MiB for the MinerU service; clamped to half the host's RAM. */
  memoryMaxMiB?: number
  /**
   * How a remote deployment reaches its share.
   *
   * Decides which transport steps {@link deploymentPlan} emits. Absent means `nfs`, the
   * shape this plan had before the protocol existed.
   */
  protocol?: 'nfs' | 'sshfs'
  /** SSHFS: remote host. */
  sshHost?: string
  /** SSHFS: login user on the remote host. */
  sshUser?: string
  /** SSHFS: TCP port the SSH daemon listens on. */
  sshPort?: number
  /**
   * SSHFS: path of the private key on the HOST, when the credential store resolves to a
   * file. Optional: an ssh-agent-managed key needs no `-i`.
   */
  sshKeyPath?: string
  /** SSHFS: absolute path of the shared directory on the remote host. */
  sshRemotePath?: string
  /** SSHFS: extra `-o` options, appended to the ones the step requires. */
  sshMountOptions?: string
}

/**
 * Memory ceiling for the MinerU service when the config names none.
 *
 * The `basic` tier peaked at 1.86 GB resident while parsing a one-page PDF (measured
 * 2026-10-15), so a ceiling near the steady-state size leaves `MemoryHigh` no headroom. On a
 * host without swap that reads as a stalled parse rather than a slow one, because throttling
 * has nowhere to spill. The service step clamps this to half of RAM, so the number only has to
 * be generous on a roomy machine.
 */
export const DEFAULT_MINERU_MEMORY_MAX_MIB = 4096

/** Rotate a single-quoted shell string safely. */
export function shquote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`
}

/** Substitute `{{name}}` placeholders; unknown names are left intact. */
export function renderCommand(template: string, context: DeployPlanContext): string {
  return template.replace(/\{\{(\w+)\}\}/gu, (whole, name: string) => {
    const value = (context as unknown as Record<string, unknown>)[name]
    if (value === undefined) return whole
    if (typeof value === 'number') return String(value)
    return shquote(String(value))
  })
}

/** Marker the image keeps so a redeploy can prove which tier is present. */
export const KB_STATE_FILE = '/var/lib/dataops-kb/state.json'

/**
 * Read-only environment probe.
 *
 * Establishes which install path is available so the UI can disable the steps
 * that cannot work: a host without Python cannot take the pip path.
 * @returns the probe step.
 */
export function probeStep(): DeployStep {
  return {
    id: 'probe',
    label: 'probe',
    timeoutMs: 60_000,
    commands: [
      'set -e',
      'echo "== os ==";    cat /etc/os-release 2>/dev/null | head -2 || true',
      'echo "== arch ==";  uname -m',
      'echo "== python =="; python3 --version 2>&1 || echo "python3 missing"',
      'echo "== pip ==";    python3 -m pip --version 2>&1 | head -1 || echo "pip missing"',
      'echo "== uv ==";     uv --version 2>&1 || echo "uv missing"',
      'echo "== docker =="; docker version --format "{{.Server.Version}}" 2>/dev/null || echo "docker missing"',
      'echo "== gpu ==";    (nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "no nvidia gpu")',
      'echo "== mineru =="; mineru-kit --version 2>&1 || echo "mineru missing"',
      'echo "== disk ==";   df -h / | tail -1',
    ],
  }
}

/**
 * Install the MinerU package and download the selected tier's models.
 *
 * The base package (`mineru>=4.0,<5`) is the CPU path: it brings ONNX and
 * llama.cpp but not vLLM, which needs a GPU this environment does not have.
 * @param context - deployment values.
 * @returns the install step.
 */
export function mineruInstallStep(context: DeployPlanContext): DeployStep {
  return {
    id: 'mineru-install',
    label: 'mineruInstall',
    // A model download dominates this step; allow a long window.
    timeoutMs: 3_600_000,
    commands: [
      'set -e',
      // Idempotent: a working mineru-kit short-circuits the install.
      'if mineru-kit --version >/dev/null 2>&1; then',
      '  echo "mineru already installed:"; mineru-kit --version',
      'else',
      '  if command -v uv >/dev/null 2>&1; then',
      '    uv pip install -U "mineru>=4.0,<5"',
      '  else',
      '    python3 -m pip install -U "mineru>=4.0,<5"',
      '  fi',
      'fi',
      // Only the selected tier and backend are fetched.
      `mineru-kit models download --tier ${context.tier} --small-backend ${context.backend} --source auto`,
      `mineru-kit models verify --tier ${context.tier} --small-backend ${context.backend}`,
      'mineru-kit models show || true',
    ],
  }
}

/**
 * Install a systemd unit that serves the MinerU HTTP API.
 *
 * A unit rather than a bare background process so the service survives logout
 * and can be restarted by the same click.
 * @param context - deployment values.
 * @returns the service step.
 */
export function mineruServiceStep(context: DeployPlanContext): DeployStep {
  // The heavy tier needs a GPU and is not what this host runs; `basic` parses on CPU and holds
  // roughly a gigabyte of ONNX weights resident. A cap keeps a pathological document from
  // exhausting a host that is also serving other work: the kernel kills the parse inside its
  // own cgroup instead of choosing a victim process-wide, and the unit restarts on the next
  // request. `MemoryMax` is a hard ceiling, so a document that needs more fails rather than
  // trading the host's stability for one parse.
  const memoryMax = context.memoryMaxMiB ?? DEFAULT_MINERU_MEMORY_MAX_MIB
  const unit = [
    '[Unit]',
    'Description=MinerU document parsing API',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=/bin/sh -c 'exec mineru-kit api-server --host 0.0.0.0 --port ${String(context.port)}'`,
    // Without a swap device a spike is fatal rather than slow, so the cap is what makes the
    // failure mode a killed parse instead of a killed host.
    `MemoryMax=${String(memoryMax)}M`,
    'MemoryHigh=' + String(Math.floor(memoryMax * 0.85)) + 'M',
    'Restart=on-failure',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ].join('\\n')
  return {
    id: 'mineru-service',
    label: 'mineruService',
    timeoutMs: 180_000,
    commands: [
      'set -e',
      'if ! command -v systemctl >/dev/null 2>&1; then echo "systemd unavailable; start mineru-kit api-server manually"; exit 0; fi',
      // A cap larger than the machine cannot protect it, so it is clamped to what the host
      // actually has rather than trusted as configured.
      'TOTAL_MB=$(awk \'/MemTotal/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || echo 0)',
      'AVAIL_MB=$(awk \'/MemAvailable/{printf "%d", $2/1024}\' /proc/meminfo 2>/dev/null || echo 0)',
      'echo "host memory: total=${TOTAL_MB}MB available=${AVAIL_MB}MB"',
      `WANT_MB=${String(memoryMax)}`,
      'if [ "$TOTAL_MB" -gt 0 ] && [ "$WANT_MB" -gt $((TOTAL_MB / 2)) ]; then',
      '  WANT_MB=$((TOTAL_MB / 2))',
      '  echo "clamping the MinerU memory cap to half of RAM: ${WANT_MB}MB"',
      'fi',
      `printf '%b' ${shquote(unit)} > /etc/systemd/system/mineru-api.service`,
      'sed -i "s/^MemoryMax=.*/MemoryMax=${WANT_MB}M/; s/^MemoryHigh=.*/MemoryHigh=$((WANT_MB * 85 / 100))M/" /etc/systemd/system/mineru-api.service',
      'systemctl daemon-reload',
      // Idempotent: enable is safe to repeat; restart picks up the new unit.
      'systemctl enable mineru-api.service >/dev/null 2>&1 || true',
      'systemctl restart mineru-api.service',
      'sleep 3',
      'systemctl --no-pager --lines=0 status mineru-api.service || true',
      // Report the cap that actually took effect, not the one that was asked for.
      'systemctl show mineru-api.service -p MemoryMax -p MemoryHigh --no-pager || true',
    ],
  }
}

/**
 * Verify the MinerU API actually answers.
 *
 * This is the check that catches the parameter-compatibility question: the
 * plugin posts multipart form fields while MinerU 4.x reads a request body, so
 * a pass here is the evidence that the two agree.
 * @param context - deployment values.
 * @returns the verification step.
 */
export function mineruVerifyStep(context: DeployPlanContext): DeployStep {
  return {
    id: 'mineru-verify',
    label: 'mineruVerify',
    timeoutMs: 120_000,
    commands: [
      'set -e',
      `BASE="http://127.0.0.1:${String(context.port)}"`,
      'echo "== health =="; curl -fsS --max-time 10 "$BASE/v1/health" || echo "health endpoint unavailable"',
      'echo "== tiers ==";  curl -fsS --max-time 10 "$BASE/v1/tiers"  || echo "tiers endpoint unavailable"',
      'echo "== parse smoke test =="',
      'TMP=$(mktemp -d); trap "rm -rf \\"$TMP\\"" EXIT',
      // A minimal one-page PDF carrying extractable text, so a pass means text really came
      // back rather than that the endpoint merely answered.
      'cat > "$TMP/smoke.pdf" <<\'PDF\'',
      '%PDF-1.4',
      '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
      '4 0 obj<</Length 60>>stream',
      'BT /F1 12 Tf 10 50 Td (knowledge base test) Tj ET',
      'endstream',
      'endobj',
      '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
      'trailer<</Size 6/Root 1 0 R>>',
      '%%EOF',
      'PDF',
      // `tier` must be named explicitly. The server defaults to `standard`, which measured 17.8 s
      // against the 2.0 s of `basic` on the same one-page PDF (2026-10-15), so an unqualified
      // request silently takes the slow path even on a host that only downloaded basic weights.
      // `output_formats` has no default either, so it is named for the same reason.
      `if curl -fsS --max-time 300 -F "files=@$TMP/smoke.pdf" "$BASE/v1/file_parse?tier=${context.tier}&output_formats=markdown" -o "$TMP/out.json"; then`,
      '  echo "parse endpoint answered:"; head -c 400 "$TMP/out.json"; echo',
      'else',
      '  echo "parse endpoint returned an error (see above)"; exit 1',
      'fi',
      // The endpoint answering is not evidence the request was understood: a body carrying the
      // wrong fields is rejected with a JSON error and HTTP 400, and a body carrying no `tier`
      // quietly parses at another tier. Both are caught here by reading the response.
      'grep -q \'"status"\' "$TMP/out.json" || { echo "the parse response is not a task result; the request shape is wrong"; exit 1; }',
      'grep -q \'"markdown"\' "$TMP/out.json" || { echo "the parse returned no markdown output"; exit 1; }',
      `grep -q '"tier":"${context.tier}"' "$TMP/out.json" || { echo "the parse did not run at the requested tier ${context.tier}; the server defaulted instead"; exit 1; }`,
      'grep -q "knowledge base test" "$TMP/out.json" || { echo "the parsed text is missing; the document was not actually parsed"; exit 1; }',
      'echo "parse smoke test: ok"',
    ],
  }
}

/**
 * Deploy the NFS export of the knowledge tree.
 *
 * Uses the container image rather than host packages: Docker is already present
 * on the target, the image carries the userspace tools, and its default export
 * template already includes `no_root_squash`, which hardlinking across NFS
 * requires.
 * @param context - deployment values.
 * @returns the NFS step.
 */
export function nfsDeployStep(context: DeployPlanContext): DeployStep {
  const share = context.actualRoot.slice(0, context.actualRoot.lastIndexOf('/')) || '/'
  return {
    id: 'nfs-deploy',
    label: 'nfsDeploy',
    timeoutMs: 300_000,
    commands: [
      'set -e',
      'if ! command -v docker >/dev/null 2>&1; then echo "docker is required to deploy the NFS export"; exit 1; fi',
      'if ! modinfo nfsd >/dev/null 2>&1 && ! grep -qw nfsd /proc/filesystems 2>/dev/null; then',
      '  echo "kernel has no nfsd module; the NFS server cannot run on this host"; exit 1',
      'fi',
      'if docker inspect dataops-kb-nfs >/dev/null 2>&1; then',
      '  echo "reusing the existing dataops-kb-nfs container"',
      '  docker rm -f dataops-kb-nfs >/dev/null 2>&1 || true',
      'fi',
      'docker pull itsthenetwork/nfs-server-alpine:latest',
      // The image writes its export list with `sed -i "s/{{PERMITTED}}/"${PERMITTED}"/g"`,
      // whose delimiter is a slash, so any value carrying one (a CIDR such as
      // 192.168.2.0/24) makes that sed fail and leaves the literal {{PERMITTED}}
      // placeholder behind. The container still reports "Startup successful" while
      // exporting nothing, so the failure is silent. Measured 2026-10-15 against
      // itsthenetwork/nfs-server-alpine:latest.
      //
      // The image is therefore started with a loopback-only client list, which needs no
      // slash, and the real list is written below through the container's own shell.
      // Starting on loopback rather than on '*` keeps the export closed during the gap
      // instead of briefly admitting every host on the network.
      `docker run -d --name dataops-kb-nfs --restart unless-stopped --privileged -p 2049:2049 -v ${shquote(share)}:/nfs-share -e SHARED_DIRECTORY=/nfs-share -e PERMITTED=127.0.0.1 -e KB_PERMITTED=${shquote(context.permitted)} itsthenetwork/nfs-server-alpine:latest`,
      'sleep 5',
      // `$KB_PERMITTED` is expanded by the container shell from its own environment, so the
      // value never passes through a shell parser here and needs no escaping beyond the
      // single quotes that keep it out of this one.
      //
      // The option group is repeated per host because `exportfs` applies a group only to the
      // host it follows. A line like `/nfs-share a b(rw,...)` gives `b` the options and
      // leaves `a` on the defaults, which are `ro` and `root_squash` -- a read-only export
      // that cannot host a hardlink. Measured 2026-10-15 on tokensfree.
      //
      // One line per host is the canonical form. Folding them onto a single line also
      // exports correctly, but `exportfs` logs `Invalid IP address /nfs-share` for each
      // repeated path while parsing it, so the clean form is the one worth writing.
      'docker exec dataops-kb-nfs sh -c \'opts="rw,fsid=0,async,no_subtree_check,no_auth_nlm,insecure,no_root_squash,insecure_locks"; : > /etc/exports; for h in $KB_PERMITTED; do printf "/nfs-share\\t%s(%s)\\n" "$h" "$opts" >> /etc/exports; done\'',
      'docker exec dataops-kb-nfs exportfs -ra',
      'docker ps --filter name=dataops-kb-nfs --format "{{.Status}}"',
      // The export list is the only trustworthy proof the client list landed: the image
      // leaves the placeholder in place when its substitution fails, and `exportfs`
      // then reports nothing exported.
      'docker exec dataops-kb-nfs exportfs -v',
      'if docker exec dataops-kb-nfs exportfs -v 2>/dev/null | grep -q "{{PERMITTED}}"; then',
      '  echo "the export list still holds the unresolved placeholder; the client list was not applied"; exit 1',
      'fi',
      'if ! docker exec dataops-kb-nfs exportfs -v 2>/dev/null | grep -q "/nfs-share"; then',
      '  echo "nothing is exported; the NFS server started but serves no share"; exit 1',
      'fi',
      'docker logs --tail 15 dataops-kb-nfs 2>&1 || true',
    ],
  }
}

/**
 * Prove hardlinks work across the NFS export.
 *
 * Creating a hard link between the authoritative tree and a view directory is
 * the single operation the whole permission model depends on, and it is also
 * the operation most likely to fail (wrong export scope, `root_squash`, split
 * filesystems). A pass here is the acceptance test for the storage side.
 * @param context - deployment values.
 * @returns the storage verification step.
 */
export function nfsVerifyStep(context: DeployPlanContext): DeployStep {
  return {
    id: 'nfs-verify',
    label: 'nfsVerify',
    timeoutMs: 60_000,
    commands: [
      'set -e',
      `A=${shquote(context.actualRoot)}`,
      `V=${shquote(context.viewRoot)}`,
      'DA=$(stat -c %d "$A" 2>/dev/null || echo missing)',
      'DV=$(stat -c %d "$V" 2>/dev/null || echo missing)',
      'echo "device(actual)=$DA device(view)=$DV"',
      'if [ "$DA" = "missing" ] || [ "$DV" = "missing" ]; then echo "one of the paths does not exist"; exit 1; fi',
      'if [ "$DA" != "$DV" ]; then echo "paths are on different filesystems; hardlinks cannot work"; exit 1; fi',
      'echo "same filesystem: ok"',
      'PROBE="$A/__kb_probe__"; mkdir -p "$V"',
      'echo probe > "$PROBE"',
      'if ln "$PROBE" "$V/__kb_probe__" 2>/dev/null; then',
      '  echo "hardlink across actual/view: ok"',
      '  rm -f "$V/__kb_probe__"',
      'else',
      '  echo "hardlink failed"; rm -f "$PROBE"; exit 1',
      'fi',
      'rm -f "$PROBE"',
    ],
  }
}

/**
 * Mount the exported share at the mount point, with the option this deployment needs.
 *
 * `noresvport` is not decorative here. This host runs WSL2 with
 * `networkingMode=mirrored`, where an NFS mount without it hangs until timeout
 * (`mount.nfs: Connection timed out`) while `rpcinfo`, `showmount -e` and a plain TCP
 * connect to 2049 all still succeed. Measured 2026-10-16 against a server that mounts
 * fine from its own kernel, and A/B verified: without the option the mount fails, with
 * it the mount succeeds, repeatably. Microsoft documents the same failure for mirrored
 * networking (WSL issue 12508), which is still open.
 *
 * The NFS client normally opts into a reserved source port, which requires a reply the
 * mirrored networking stack does not deliver; `noresvport` drops that requirement.
 *
 * @param context - Deployment paths and the export address.
 * @returns The mount step.
 */
export function nfsMountStep(context: DeployPlanContext): DeployStep {
  const options = [
    'vers=4.1',
    'proto=tcp',
    'port=2049',
    'timeo=15',
    'retrans=2',
    // Without this, a mirrored-networking host hangs instead of failing.
    'noresvport',
  ].join(',')
  return {
    id: 'nfs-mount',
    label: 'nfsMount',
    timeoutMs: 120_000,
    commands: [
      'set -e',
      `M=${shquote(context.mountPoint)}`,
      `SERVER=${shquote(`${context.server}:/`)}`,
      'mkdir -p "$M"',
      'if mountpoint -q "$M"; then',
      '  echo "already mounted at $M"',
      'else',
      `  mount -t nfs4 -o ${options} "$SERVER" "$M"`,
      '  echo "mounted $SERVER at $M"',
      'fi',
      // A mount that returns but serves nothing is worse than one that fails loudly.
      'if ! ls "$M" >/dev/null 2>&1; then echo "mount point is not readable"; exit 1; fi',
      'echo "mount verified: $(ls -A "$M" | wc -l) entries visible"',
    ],
  }
}

/**
 * Mount a remote directory over SSHFS on the HOST.
 *
 * The same shape as {@link nfsMountStep}, for a host that cannot mount NFS: the container
 * has no `CAP_SYS_ADMIN` and cannot mount anything itself, so this runs on the Host and the
 * resulting directory is bound in at `mountPoint` like any other.
 *
 * Two details are not incidental:
 * - `StrictHostKeyChecking=accept-new` is limited to this invocation. Accepting an unknown
 *   host key globally would silence the one warning that catches a swapped host, so the
 *   trust-on-first-use decision is scoped to the connection whose key the operator is
 *   establishing.
 * - The reconnect options are not optional here. An SSHFS mount whose connection drops
 *   returns EIO to every reader until someone unmounts it; `reconnect` plus a keepalive is
 *   what makes a transient network blip a stall instead of a broken knowledge base.
 * @param context - transport and target paths from the deployment config.
 * @returns the mount step.
 */
export function sshfsMountStep(context: DeployPlanContext): DeployStep {
  const remote = `${context.sshUser ?? ''}@${context.sshHost ?? ''}:${context.sshRemotePath ?? ''}`
  const baseOptions = [
    'reconnect',
    'ServerAliveInterval=15',
    'ServerAliveCountMax=3',
    'StrictHostKeyChecking=accept-new',
    'BatchMode=yes',
  ]
  const extra = (context.sshMountOptions ?? '').trim()
  const optionString = extra === '' ? baseOptions.join(',') : baseOptions.join(',') + ',' + extra
  const identity = context.sshKeyPath === undefined || context.sshKeyPath === ''
    ? []
    : [`IDENTITY=${shquote(context.sshKeyPath)}`, 'test -r "$IDENTITY" || { echo "private key not readable at $IDENTITY"; exit 1; }']
  const port = context.sshPort ?? 22
  return {
    id: 'sshfs-mount',
    label: 'sshfsMount',
    timeoutMs: 120_000,
    commands: [
      'set -e',
      // Refuse to build a command from an incomplete set: `@:` would mount nothing and
      // the failure would surface much later as an empty tree.
      `[ -n ${shquote(context.sshHost ?? '')} ] || { echo "sshHost is not configured"; exit 1; }`,
      `[ -n ${shquote(context.sshUser ?? '')} ] || { echo "sshUser is not configured"; exit 1; }`,
      `[ -n ${shquote(context.sshRemotePath ?? '')} ] || { echo "sshRemotePath is not configured"; exit 1; }`,
      `M=${shquote(context.mountPoint)}`,
      `REMOTE=${shquote(remote)}`,
      `OPTIONS=${shquote(optionString)}`,
      'mkdir -p "$M"',
      'if mountpoint -q "$M"; then',
      '  echo "already mounted at $M"',
      'else',
      ...identity,
      `  sshfs -p ${String(port)} ${context.sshKeyPath === undefined || context.sshKeyPath === '' ? '' : '-i "$IDENTITY" '}-o "$OPTIONS" "$REMOTE" "$M"`,
      '  echo "mounted $REMOTE at $M over SSHFS"',
      'fi',
      // A mount that returns but serves nothing is worse than one that fails loudly.
      'if ! ls "$M" >/dev/null 2>&1; then echo "mount point is not readable; check the remote path and the key"; exit 1; fi',
      'echo "sshfs mount verified: $(ls -A "$M" | wc -l) entries visible"',
    ],
  }
}

/**
 * Verify the SSHFS mount is present, readable, and actually a FUSE mount.
 *
 * Separate from the mount step because "the command exited 0" and "the reader will see
 * files" are different claims: a stale empty directory satisfies the first and not the
 * second, and the filesystem type is what tells them apart.
 * @param context - transport and target paths from the deployment config.
 * @returns the verification step.
 */
export function sshfsVerifyStep(context: DeployPlanContext): DeployStep {
  return {
    id: 'sshfs-verify',
    label: 'sshfsVerify',
    timeoutMs: 60_000,
    commands: [
      'set -e',
      `M=${shquote(context.mountPoint)}`,
      'mountpoint -q "$M" || { echo "nothing is mounted at $M"; exit 1; }',
      'mount | grep -F " $M " | grep -q sshfs || { echo "the mount at $M is not SSHFS"; mount | grep -F " $M " || true; exit 1; }',
      'echo "sshfs mount present at $M"',
      'ls -A "$M" | wc -l | xargs -I{} echo "{} entries visible"',
      'DIR=$(find "$M" -maxdepth 1 -type d ! -path "$M" | head -n 1)',
      'if [ -n "$DIR" ]; then ls -A "$DIR" >/dev/null 2>&1 || { echo "subdirectory $DIR is not readable"; exit 1; }; echo "reads verified under $DIR"; else echo "no subdirectory to read; top level verified"; fi',
    ],
  }
}

/** The full ordered plan the Settings panel presents. */
export function deploymentPlan(context: DeployPlanContext): DeployStep[] {
  const mineru = [
    probeStep(),
    mineruInstallStep(context),
    mineruServiceStep(context),
    mineruVerifyStep(context),
  ]
  // The transport half of the plan is the only part the protocol decides; MinerU is
  // reached over the network either way and prepares identically.
  if ((context.protocol ?? 'nfs') === 'sshfs') {
    return [...mineru, sshfsMountStep(context), sshfsVerifyStep(context)]
  }
  return [...mineru, nfsDeployStep(context), nfsVerifyStep(context), nfsMountStep(context)]
}

/** Look up one step by id. */
export function findStep(id: string, context: DeployPlanContext): DeployStep | undefined {
  return deploymentPlan(context).find(step => step.id === id)
}
