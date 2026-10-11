/**
 * Check that a built profile declares the bundles the standalone manifest names.
 *
 * The profile is created by `plugin add`, which first writes a skeleton manifest from the launcher
 * defaults — a single bundle, `@deepseek-ai/dsh-base` — and then overwrites it with the manifest the
 * distribution generated. When the overwrite does not happen, the profile keeps the skeleton and the
 * build still reports success. Measured 2026-10-11: a release reached `profiles/plus/package.json`
 * with one bundle where the manifest named twenty. The service started, never listened, and its log
 * ended on unrelated compatibility warnings; the incomplete tree had to be repaired by hand.
 *
 * The count is what makes the failure visible, because a missing bundle is silent at every later
 * step: an installed plugin that no bundle names is simply never mounted.
 *
 * Usage: verify-profile-bundles.mjs --profile <dir> --manifest <file>
 */
import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

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

const args = process.argv.slice(2)
const profileOption = option(args, "--profile")
const manifestOption = option(args, "--manifest")
if (profileOption === undefined || manifestOption === undefined) {
  throw new Error("usage: verify-profile-bundles.mjs --profile <dir> --manifest <file>")
}

const profilePath = join(resolve(profileOption), "package.json")
const manifestPath = resolve(manifestOption)
for (const path of [profilePath, manifestPath]) {
  if (!existsSync(path)) throw new Error("verify-profile-bundles: no " + path)
}

const profile = JSON.parse(readFileSync(profilePath, "utf8"))
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
const declared = manifest.dshPlusStandalone?.bundles
if (!Array.isArray(declared)) {
  throw new Error("verify-profile-bundles: " + manifestPath + " declares no dshPlusStandalone.bundles")
}
const actual = profile.dsh?.profile?.bundles
if (!Array.isArray(actual)) {
  throw new Error("verify-profile-bundles: " + profilePath + " declares no dsh.profile.bundles")
}

const missing = declared.filter(name => !actual.includes(name))
const extra = actual.filter(name => !declared.includes(name))

if (missing.length > 0 || extra.length > 0) {
  console.error("verify-profile-bundles: the profile does not mount what the manifest declares")
  console.error("  manifest: " + String(declared.length) + " bundle(s), profile: " + String(actual.length))
  for (const name of missing) console.error("  missing from the profile: " + name)
  for (const name of extra) console.error("  not in the manifest: " + name)
  console.error("")
  console.error("A profile left at the launcher default names only @deepseek-ai/dsh-base, and every")
  console.error("plugin it fails to name is installed but never mounted.")
  process.exit(1)
}
console.log("verify-profile-bundles: the profile mounts all " + String(declared.length) + " declared bundle(s)")
