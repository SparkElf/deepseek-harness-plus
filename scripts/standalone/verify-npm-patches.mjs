/**
 * Check that every npm patch in this repository can apply to the version it declares.
 *
 * pnpm refuses an inexact patch. GNU patch and `git apply --3way` both reconcile one, so a patch
 * whose hunk headers drifted from its target keeps passing every build that does not use pnpm.
 * Measured: a hunk header from the previous version survived a retarget at 0.25.0, the mirror build
 * reported success, and only the image build failed - thirty minutes in, with ERR_PNPM_PATCH_FAILED.
 *
 * The check is applied to the package actually installed when one is available, because that is the
 * bytes pnpm will patch. When no install is present the patch is still checked against itself: a
 * hunk header that disagrees with its own hunk is rejected by pnpm wherever it is applied, and that
 * is the form the retarget produced.
 *
 * Usage: verify-npm-patches.mjs [--repo <root>] [--modules <node_modules>]
 */
import { readdirSync, readFileSync, existsSync, mkdtempSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

/**
 * Read one option value, or undefined when it is absent.
 * @param args - the argument list.
 * @param name - the option to look for.
 * @returns the value that follows it, if present.
 */
function option(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

/**
 * Compare each hunk header with the lines the hunk actually holds.
 *
 * A unified diff states its line counts twice, once in the header and once as the lines under it.
 * pnpm rejects a patch where the two disagree; a retarget that shifts the starting line but leaves
 * the counts alone is still exact and still applies, which is why the counts are what is compared.
 * @param text - the patch text.
 * @returns one problem description per disagreeing hunk.
 */
function headerProblems(text) {
  const problems = []
  // A trailing newline would otherwise contribute an empty entry, and an empty line is a context
  // line in this format. Measured: counting it made every well-formed patch look three lines off.
  const lines = text.replace(/\n$/u, "").split("\n")
  let file = null
  for (let i = 0; i < lines.length; i += 1) {
    const named = /^\+\+\+ b\/(.+)$/u.exec(lines[i])
    if (named !== null) file = named[1]
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(lines[i])
    if (hunk === null) continue
    // An omitted count means one line, which is the unified-diff convention.
    const claimedOld = hunk[2] === undefined ? 1 : Number(hunk[2])
    const claimedNew = hunk[4] === undefined ? 1 : Number(hunk[4])
    let old = 0
    let added = 0
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j]
      if (line.startsWith("@@") || line.startsWith("diff --git")) break
      // A line carries its own marker. A patch generated against a file whose last line has no
      // newline ends the hunk with a backslash annotation, which counts as neither side.
      if (line.startsWith("+")) added += 1
      else if (line.startsWith("-")) old += 1
      else if (line.startsWith(" ")) { old += 1; added += 1 }
      else if (line.startsWith("\\")) continue
      else if (line === "") { old += 1; added += 1 }
    }
    if (claimedOld !== old || claimedNew !== added) {
      problems.push(
        (file ?? "(unknown file)") + " at patch line " + String(i + 1) + ": the header claims " +
        String(claimedOld) + " old and " + String(claimedNew) + " new lines, and the hunk holds " +
        String(old) + " and " + String(added) + ". pnpm rejects a patch whose counts disagree.",
      )
    }
  }
  return problems
}

const args = process.argv.slice(2)
const repo = option(args, "--repo") ?? process.cwd()
const patchesDir = join(repo, "patches", "npm")
if (!existsSync(patchesDir)) throw new Error("verify-npm-patches: no patches/npm under " + repo)

// The install is optional. Searching beside the repository covers CI; the release tree covers this
// host, where the served profile is the install that matters.
// An explicit --modules is authoritative, including when it names nothing: that is how the header
// check is exercised without an install. Only the discovery path tolerates a missing candidate.
const requested = option(args, "--modules")
const candidates = requested === undefined
  ? [join(repo, "node_modules"), "/root/.dsh/releases/plus/plus-021a2/profiles/plus/node_modules"]
  : [requested]
const modules = candidates.find(candidate => existsSync(join(candidate, "dsh-better-sidebar")))
if (requested !== undefined && modules === undefined) {
  console.error("verify-npm-patches: no " + "dsh-better-sidebar" + " under " + requested + "; checking patches alone")
}

const scratch = mkdtempSync(join(tmpdir(), "verify-npm-patches-"))
let checked = 0
let applied = 0
const problems = []

for (const entry of readdirSync(patchesDir).sort()) {
  const manifestPath = join(patchesDir, entry, "package.json")
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  for (const variant of manifest.dshPatch?.variants ?? []) {
    if (variant.target?.kind !== "npm") continue
    const file = join(patchesDir, entry, "patches", variant.id + ".patch")
    if (!existsSync(file)) {
      problems.push(entry + ": declares an npm variant but ships no " + variant.id + ".patch")
      continue
    }
    checked += 1
    const text = readFileSync(file, "utf8")
    if (!text.startsWith("diff --git ")) {
      problems.push(entry + ": does not begin with a diff --git line, which pnpm requires")
    }
    // The counts are checked wherever this runs, because they are a property of the patch alone.
    for (const problem of headerProblems(text)) problems.push(entry + ": " + problem)

    const installed = modules === undefined ? undefined : join(modules, variant.target.name)
    if (installed === undefined || !existsSync(installed)) continue
    // pnpm patches a copy of the package, so this does too, one directory per patch.
    const work = join(scratch, variant.id)
    execFileSync("cp", ["-a", installed, work])
    try {
      execFileSync("patch", ["-p1", "--fuzz=0", "--forward", "--silent", "-i", file], { cwd: work, stdio: "pipe" })
      applied += 1
    } catch (error) {
      const detail = String(error.stdout ?? "") + String(error.stderr ?? "")
      const reason = /Reversed|previously applied/u.test(detail) ? "is already applied" : "does not apply at fuzz 0"
      problems.push(entry + ": " + variant.target.name + " " + reason + ", so pnpm will reject it")
    }
  }
}

execFileSync("rm", ["-rf", scratch])
if (checked === 0) throw new Error("verify-npm-patches: no npm variant found under " + patchesDir)
if (problems.length > 0) {
  for (const problem of problems) console.error("verify-npm-patches: " + problem)
  console.error("verify-npm-patches: " + String(problems.length) + " problem(s) in " + String(checked) + " patch(es)")
  process.exit(1)
}
const against = applied > 0 ? ", " + String(applied) + " applied to the installed target" : ""
console.log("verify-npm-patches: " + String(checked) + " npm patch(es) are exact" + against)
