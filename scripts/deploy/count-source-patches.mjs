/**
 * Count the source patches the mirror will apply, so the build can compare that to what it applied.
 *
 * The mirror selects patches by globbing `patches/npm/*` and filtering on `target.kind`, and either
 * step can pass over one without failing: a package with no `.patch` file, or a variant whose kind is
 * not the one the filter expects. The applied count cannot reveal that on its own — it is only wrong
 * relative to an expectation — so the expectation is computed here, from the same directory the loop
 * reads, and a mismatch stops the build.
 *
 * Usage: count-source-patches.mjs <repo>
 */
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const repo = process.argv[2]
if (repo === undefined) throw new Error("usage: count-source-patches.mjs <repo>")
const patchRoot = join(repo, "patches/npm")
if (!existsSync(patchRoot)) throw new Error("count-source-patches: no " + patchRoot)

let count = 0
for (const directory of readdirSync(patchRoot)) {
  const manifestPath = join(patchRoot, directory, "package.json")
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  const variant = (manifest.dshPatch?.variants ?? [])[0]
  if (variant?.target?.kind !== "dsh-source") continue
  const payloads = join(patchRoot, directory, "patches")
  if (!existsSync(payloads)) continue
  if (!readdirSync(payloads).some(file => file.endsWith(".patch"))) continue
  count += 1
}

process.stdout.write(String(count))
