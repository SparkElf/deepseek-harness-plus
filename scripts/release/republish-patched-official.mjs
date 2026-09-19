/**
 * Repackage the patched official workspaces, verify them, and publish them.
 *
 * One command, because the steps must not be separated: every defect a consumer saw was
 * a package that packaged cleanly, verified against a list its author had written, and
 * published. Verification here compares the packaged output with the workspace it came
 * from, and it runs between the two steps rather than beside them.
 *
 * Usage:
 *   node scripts/release/republish-patched-official.mjs --source <built-checkout> [--version <semver>] [--dry-run]
 *
 * \`--version\` defaults to the source checkout's own version, which is what a consumer
 * should receive. Pass an explicit prerelease when republishing a correction under the
 * same upstream revision.
 */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sourceVersion } from './package-patched-official.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

/** Run one node script in this directory and fail with its own output on error. */
function run(script, args, label) {
  const result = spawnSync(process.execPath, [join(here, script), ...args], { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(label + ' failed with exit code ' + String(result.status))
}

function main() {
  const argv = process.argv.slice(2)
  let source
  let version
  let dryRun = false
  let skipPublish = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--source') { source = argv[index + 1]; index += 1; continue }
    if (argv[index] === '--version') { version = argv[index + 1]; index += 1; continue }
    if (argv[index] === '--dry-run') { dryRun = true; continue }
    if (argv[index] === '--skip-publish') { skipPublish = true; continue }
    throw new Error('unknown option: ' + argv[index])
  }
  if (source === undefined) {
    throw new Error('usage: republish-patched-official.mjs --source <built-checkout> [--version <semver>] [--dry-run]')
  }
  const built = resolve(source)
  const target = process.env.DSH_PLUS_PACKAGE_DIR ?? mkdtempSync(join(tmpdir(), 'dsh-plus-patched-'))
  console.log('republish-patched-official: source ' + built)
  console.log('republish-patched-official: version ' + (version ?? sourceVersion(built) + ' (from the checkout)'))
  console.log('republish-patched-official: output ' + target)

  run('package-patched-official.mjs', ['--source', built, '--out', target]
    .concat(version === undefined ? [] : ['--version', version]), 'packaging')
  // Verification is not optional and not separable: it compares the packaged output with
  // the workspace it came from, which is the check the manifest itself cannot give.
  run('verify-patched-official.mjs', ['--source', built, '--dir', target], 'verification')
  // A publication that stops on the first version the registry already carries leaves the
  // later tarballs unpacked: the already-published set is the normal case when a release
  // adds a workspace to the patched list. --skip-publish packages and verifies only, so a
  // caller can publish the additions and leave the existing versions alone.
  if (!skipPublish) {
    run('publish-patched-official.mjs', ['--dir', target].concat(dryRun ? ['--dry-run'] : []), 'publication')
  } else {
    console.log('republish-patched-official: skipping publication, ' + target + ' holds the verified tarballs')
  }
  if (process.env.DSH_PLUS_PACKAGE_DIR === undefined) rmSync(target, { recursive: true, force: true })
  console.log('republish-patched-official: done')
}

if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  main()
}
