#!/usr/bin/env node
/**
 * DSH Plus downstream workspace tool.
 *
 * This is the stable entry point for the monorepo migration. Commands that need
 * the migrated package tree or an image builder fail closed until those pieces
 * exist; they never pretend to have built something.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const downstream = join(root, 'downstream')
const plusManifestPath = join(root, 'packages/bundle/plus/package.json')
const upstreamLockPath = join(downstream, 'upstream.lock.json')
const releaseManifestPath = join(downstream, 'release-manifest.json')

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
const fail = (message) => {
  console.error(`downstream: ${message}`)
  process.exit(2)
}
const plus = () => readJson(plusManifestPath)
const lock = () => readJson(upstreamLockPath)
const release = () => readJson(releaseManifestPath)

const assertConsistent = () => {
  const p = plus()
  const u = lock()
  const r = release()
  const errors = []
  if (u.revision !== p.dshPlus?.sourceBase?.revision) {
    errors.push(`upstream.lock revision ${u.revision} != plus sourceBase ${p.dshPlus?.sourceBase?.revision}`)
  }
  if (u.tag !== `dsh-v${u.compatibility?.dsh?.replace(/^>=/, '')}`) {
    errors.push(`upstream.lock tag ${u.tag} does not match compatibility ${u.compatibility?.dsh}`)
  }
  if (r.plus?.version !== p.version) errors.push(`release-manifest plus ${r.plus?.version} != package ${p.version}`)
  if (r.upstreamLock !== 'upstream.lock.json') errors.push('release-manifest upstreamLock must be upstream.lock.json')
  if (!r.profileDependencies || Object.keys(r.profileDependencies).length === 0) {
    errors.push('release-manifest profileDependencies is empty')
  }
  if (errors.length) fail(errors.join('\n'))
  return { p, u, r }
}

const commands = {
  status() {
    const { p, u, r } = assertConsistent()
    const plugins = r.packages?.plugins?.length ?? 0
    const forks = r.packages?.forks?.length ?? 0
    console.log(`plus          ${p.name}@${p.version}`)
    console.log(`official      ${u.tag} @ ${u.revision}`)
    console.log(`profile       ${r.profile?.name} (${r.profile?.bundles?.length ?? 0} bundles)`)
    console.log(`pins          ${Object.keys(r.profileDependencies ?? {}).length} exact profile dependencies`)
    console.log(`migrated      ${plugins} plugins, ${forks} forks`)
  },
  sync(args) {
    const { u } = assertConsistent()
    const tag = args.find((arg) => !arg.startsWith('--')) || u.tag
    if (tag !== u.tag) fail(`requested tag ${tag} != upstream.lock tag ${u.tag}`)
    if (args.includes('--fetch')) {
      execFileSync('git', ['fetch', '--no-tags', 'upstream-official', `refs/tags/${u.tag}:refs/tags/${u.tag}`], { cwd: root, stdio: 'inherit' })
    }
    let actual = ''
    try {
      actual = execFileSync('git', ['rev-parse', `${u.tag}^{commit}`], { cwd: root, encoding: 'utf8' }).trim()
    } catch {
      fail(`official tag ${u.tag} is not available locally; run \`node downstream/tools/downstream.mjs sync --fetch\``)
    }
    if (actual !== u.revision) fail(`tag ${u.tag} resolves to ${actual}, lock says ${u.revision}`)
    console.log(`sync: ${u.tag} -> ${u.revision} verified`)
  },
  'build-packages'() {
    const packagesRoot = join(downstream, 'packages')
    const manifests = []
    const walk = (dir) => {
      if (!existsSync(dir)) return
      for (const name of readdirSync(dir)) {
        const path = join(dir, name)
        if (!statSync(path).isDirectory()) continue
        if (existsSync(join(path, 'package.json'))) manifests.push(path)
        else walk(path)
      }
    }
    walk(packagesRoot)
    if (!manifests.length) fail('no migrated packages yet; add workspace packages under downstream/packages before running build-packages')
    for (const path of manifests) {
      console.log(`building ${relative(root, path)}`)
      execFileSync('pnpm', ['--dir', path, 'run', 'build'], { cwd: root, stdio: 'inherit' })
    }
  },
  apply() {
    fail('apply is not implemented yet: the core patch queue and profile assembly still live in packages/bundle/plus. See PLUS-MONOREPO-GOVERNANCE.md §1.6.')
  },
  verify() {
    const { r } = assertConsistent()
    for (const [name, spec] of Object.entries(r.profileDependencies ?? {})) {
      if (typeof spec !== 'string' || spec.length === 0) fail(`profile dependency ${name} has no exact spec`)
    }
    execFileSync('pnpm', ['run', 'verify:plus-governance'], { cwd: root, stdio: 'inherit' })
    console.log('verify: upstream lock, release manifest, and Plus governance are consistent')
  },
  image() {
    fail('image is not implemented yet: the image builder must consume release-manifest.json; see PLUS-MONOREPO-GOVERNANCE.md §1.9.')
  },
  publish() {
    fail('publish is intentionally disabled until package migration and npm provenance checks are in place.')
  },
  help() {
    console.log(`Usage: node downstream/tools/downstream.mjs <command>

Commands:
  status          show lock/manifest/package summary
  sync [--fetch]  verify the pinned official tag/revision
  build-packages  build migrated workspace packages (fails until migration)
  apply           assemble patches/profile (pending migration)
  verify          validate lock/manifest and run Plus governance
  image           build the workspace image (pending migration)
  publish         publish migrated packages (intentionally disabled)
  help            show this help`)
  },
}

const [command = 'help', ...args] = process.argv.slice(2)
if (!commands[command]) commands.help()
else commands[command](args)
