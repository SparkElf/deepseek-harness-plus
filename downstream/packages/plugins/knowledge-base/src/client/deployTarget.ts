/**
 * Whether a deployment has anything the deployment wizard could act on.
 *
 * Its own module rather than a helper inside the settings component because the
 * component imports CSS modules, and a test that wants to CALL this decision cannot
 * load them. Keeping the predicate dependency-free means the rule is exercised
 * directly instead of being matched as text in the file that happens to use it --
 * an assertion on source text cannot notice an inverted branch.
 *
 * @module @sparkelf/dsh-knowledge-base/client
 */

/**
 * Decide whether to render the deployment wizard.
 *
 * Every step in the plan executes ON A REMOTE HOST: the Host's `deploy.run` route
 * refuses a request without a `hostId` ("Steps mutate a remote host"), and the MinerU
 * steps are shell run there too -- they read the remote `/etc/os-release`, remote
 * `uv`, remote `docker`. So the wizard is not an NFS-only block that a local
 * deployment skips in part; with no SSH host configured it has nothing that can run,
 * and seven disabled buttons are seven dead controls.
 *
 * A configured host is what makes the block meaningful, so that is the primary test.
 * The deployment's own declared mode is the fallback: a `remote` deployment is one
 * that intends to sync, so it keeps the wizard even before a host row exists -- the
 * host list may be empty for a reason the reader can fix, and hiding the wizard would
 * remove the only place that says so.
 *
 * A missing or unrecognised mode counts as `local`: the conservative direction,
 * because local is the shape where the buttons would be a lie.
 * @param hosts - the configured SSH hosts, as `deploy.hosts` reports them.
 * @param storageMode - the deployment's declared mode, as `status` reports it.
 * @returns true when the wizard has a remote target to act on.
 */
export function hasDeployTarget(
  hosts: readonly unknown[],
  storageMode: 'local' | 'remote' | undefined,
): boolean {
  return hosts.length > 0 || storageMode === 'remote'
}
