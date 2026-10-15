/**
 * Report whether a release directory is the one a running deployment is using.
 *
 * A rebuild starts by removing its target (`dsh-plus-mirror create` does `rm -rf "$mirror"`). Aimed
 * at the tree a live service runs from, that removes the service runtime and every process loaded
 * from it - including, when the command was issued from a session served by that tree, the very tool
 * the command needs to repair its own mistake. Measured 2026-10-11: the rebuild took 3080 to 404 and
 * left the issuing session unable to run any command for five rounds, because the tool runtime and
 * the deployment were the same tree.
 *
 * The check is deliberately conservative: it refuses when it cannot tell. A wrong refusal costs one
 * `--force`; a wrong acceptance costs the running deployment.
 *
 * Usage: release-in-use.mjs --release <dir> [--json]
 */
import { realpathSync } from "node:fs"
import { resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

/**
 * Normalize a path that may not exist yet.
 *
 * A mirror target is created by the command that asks about it, so it usually has no realpath. Plain
 * resolution is enough: the comparison is against directories that do exist, and both sides are
 * absolute.
 * @param path - the path to normalize.
 * @returns its canonical form when it exists, and its resolved form otherwise.
 */
function normalize(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * A release directory: three levels under `releases/`, as `<family>/<release>`.
 *
 * A rebuild removes this whole tree, so the comparison is at this level rather than at the profile
 * or package below it. A trailing quote is stripped because systemd quotes ExecStart arguments.
 */
const RELEASE = /^(\/root\/\.dsh\/releases\/[^\/]+\/[^\/\s"]+)/

/**
 * Every release path a command line names.
 * @param text - one line of `ps` output or `systemctl show` value.
 * @returns the release-rooted paths it contains.
 */
function pathsIn(text) {
  return [...text.matchAll(/\/root\/\.dsh\/releases\/[^\s"]+/gu)].map(match => match[0])
}

/**
 * Every path that currently names a release, from the places a deployment records one.
 *
 * A running process is the strongest evidence available without asking the service: it names the
 * release it was started from in its own argv, and it keeps using that tree for its whole life. The
 * search itself must not match: `ps` reports the command doing the looking, and a pattern in that
 * command names every release it intends to compare. Measured 2026-10-11: without the exclusion,
 * every release the caller asked about came back in use.
 * @returns one entry per observed path, with the source that observed it.
 */
function livePaths() {
  const found = []
  // The profile link is what the launcher resolves at start time. Two names are tried because
  // a deployment may keep either one.
  for (const link of ["/root/.dsh/profiles/plus", "/root/.dsh/profile"]) {
    try {
      found.push({ source: link, path: realpathSync(link) })
    } catch { /* absent is not evidence of anything */ }
  }
  try {
    // Excluded by process id, not by name, and along the whole ancestry rather than one level.
    // The probe carries the release it is testing in its own arguments and so does every shell that
    // wrapped it, because the caller passes the path through them. Measured twice: a name check
    // missed a probe invoked through a link, and a two-entry `{self, parent}` set missed the
    // `bash -c` grandparent, which refused a build into a directory that did not exist yet.
    const listing = execFileSync("ps", ["-eo", "pid,ppid,args"], { encoding: "utf8" })
    const rows = new Map()
    for (const line of listing.split("\n")) {
      const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line)
      if (row === null) continue
      rows.set(row[1], { parent: row[2], args: row[3] })
    }
    const ancestry = new Set()
    for (let pid = String(process.pid); pid !== undefined && pid !== "0" && !ancestry.has(pid);) {
      ancestry.add(pid)
      pid = rows.get(pid)?.parent
    }
    for (const [pid, row] of rows) {
      if (ancestry.has(pid)) continue
      for (const path of pathsIn(row.args)) found.push({ source: "running process", path })
    }
  } catch { /* ps unavailable is not evidence of anything */ }
  // A systemd unit for the service names its release in ExecStart, and it is what will restart it.
  try {
    const units = execFileSync("systemctl", ["list-units", "--all", "--type=service", "--no-legend", "--plain"], { encoding: "utf8" })
    for (const line of units.split("\n")) {
      const unit = /^(\S+)\.service/u.exec(line.trim())
      if (unit === null) continue
      try {
        const show = execFileSync("systemctl", ["show", "-p", "ExecStart", "--value", unit[0] + ".service"], { encoding: "utf8" })
        for (const path of pathsIn(show)) found.push({ source: unit[0] + ".service", path })
      } catch { /* a unit that cannot be read is not evidence of anything */ }
    }
  } catch { /* no systemd is not evidence of anything */ }
  return found
}

/**
 * The release directories this host currently uses, with the sources that named each one.
 * @returns a map from absolute release directory to the sources that reported it.
 */
export function releasesInUse() {
  const unique = new Map()
  for (const entry of livePaths()) {
    const match = RELEASE.exec(entry.path)
    if (match === null) continue
    const release = match[1]
    if (!unique.has(release)) unique.set(release, new Set())
    unique.get(release).add(entry.source)
  }
  return new Map([...unique].map(([release, sources]) => [release, [...sources].sort()]))
}

// Both sides are resolved, because Node realpaths `import.meta.url` for an ES module while
// `process.argv[1]` keeps the path that was typed. A symlinked install - which is how the
// deployment home consumes these files - compares a real path against a link path, so the block
// below never runs and the process exits 0 without checking anything. Measured 2026-10-11: the
// guard went quiet, its caller read exit 0 as "not in use", and the rebuild this check exists to
// refuse removed the release tree serving the session that issued it.
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  const index = args.indexOf("--release")
  const by = index === -1 || args[index + 1] === undefined ? undefined : releasesInUse().get(normalize(args[index + 1]))
  if (args.includes("--json")) {
    console.log(JSON.stringify({ release: index === -1 ? null : args[index + 1], inUse: by !== undefined, evidence: by ?? [], all: [...releasesInUse().keys()].sort() }, null, 2))
    process.exit(0)
  }
  if (index === -1 || args[index + 1] === undefined) throw new Error("usage: release-in-use.mjs --release <dir> [--json]")
  if (by !== undefined) {
    console.log("release-in-use: " + args[index + 1] + " IS IN USE")
    for (const source of by) console.log("  named by: " + source)
  } else {
    console.log("release-in-use: " + args[index + 1] + " is not in use")
  }
  process.exit(by !== undefined ? 1 : 0)
}
