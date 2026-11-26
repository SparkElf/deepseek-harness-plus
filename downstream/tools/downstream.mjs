#!/usr/bin/env node
/**
 * DSH Plus downstream workspace tool.
 *
 * This is the stable entry point for the monorepo migration. Commands that need
 * the migrated package tree or an image builder fail closed until those pieces
 * exist; they never pretend to have built something.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
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


/** Run a built image and require the DSH auth page to answer on 3080. */
function smokeImage(tag) {
  const name = `dataops-web-smoke-${process.pid}`
  try {
    execFileSync('docker', ['run', '-d', '--name', name, tag], { cwd: root, stdio: 'inherit' })
    let probe = ''
    for (let attempt = 0; attempt < 20; attempt += 1) {
      execFileSync('sleep', ['1'], { cwd: root })
      try {
        probe = execFileSync('docker', ['exec', name, 'node', '-e', "fetch('http://127.0.0.1:3080/').then(r=>{console.log(r.status);process.exit(r.status===401||r.status===200?0:1)}).catch(()=>process.exit(1))"], { cwd: root, encoding: 'utf8' }).trim()
        break
      } catch { /* not ready yet */ }
    }
    if (probe !== '401' && probe !== '200') fail(`image smoke probe did not answer: ${probe || 'no response'}`)
    console.log(`smoke: http=${probe}`)
  } finally {
    try { execFileSync('docker', ['rm', '-f', name], { cwd: root, stdio: 'ignore' }) } catch {}
  }
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
    const local = Object.values(r.localPackages ?? {})
    const mismatches = local.filter((entry) => entry.profilePinStatus === 'mismatch')
    const active = local.filter((entry) => entry.override !== 'disabled')
    console.log(`local packages ${local.length} workspace packages, ${active.length} active overrides, ${mismatches.length} profile pin mismatches`)
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
  inventory() {
    const path = join(downstream, 'migration-inventory.json')
    if (!existsSync(path)) fail('missing downstream/migration-inventory.json')
    const inventory = readJson(path)
    const pending = inventory.packages.filter((item) => item.status !== 'migrated' && item.status !== 'excluded')
    const excluded = inventory.packages.filter((item) => item.status === 'excluded')
    console.log(`inventory     ${inventory.packages.length} source packages, ${pending.length} pending, ${excluded.length} excluded`)
    for (const item of pending) console.log(`  pending     ${item.name}@${item.version} -> ${item.targetPath}`)
    for (const item of excluded) console.log(`  excluded    ${item.name}@${item.version}: ${item.excludedReason ?? ''}`)
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
  apply(args) {
    const dshRootIndex = args.indexOf('--dsh-root')
    const dshRoot = dshRootIndex >= 0 ? args[dshRootIndex + 1] : undefined
    if (!dshRoot) fail('usage: downstream apply --dsh-root <official-dsh-root>')
    const bin = join(root, 'packages/bundle/plus/lib/bin.js')
    if (!existsSync(bin)) fail('missing packages/bundle/plus/lib/bin.js; run `pnpm --filter @sparkelf/dsh-plus run build` first')
    try {
      execFileSync(process.execPath, [bin, 'apply', ...args], { cwd: root, stdio: 'inherit' })
    } catch (error) {
      process.exitCode = typeof error?.status === 'number' ? error.status : 1
    }
  },
  verify(args = []) {
    const { r } = assertConsistent()
    for (const [name, spec] of Object.entries(r.profileDependencies ?? {})) {
      if (typeof spec !== 'string' || spec.length === 0) fail(`profile dependency ${name} has no exact spec`)
    }
    const profilePackagePath = join(downstream, 'profiles/dataops-web/package.json')
    if (!existsSync(profilePackagePath)) fail('missing generated profile package: downstream/profiles/dataops-web/package.json')
    const profilePackage = readJson(profilePackagePath)
    for (const file of ['cordis.yml', 'cordis.patch.yml', 'compatibility.json']) {
      if (!existsSync(join(downstream, 'profiles/dataops-web', file))) fail(`missing profile runtime file: ${file}`)
    }
    if (JSON.stringify(profilePackage.dsh?.profile?.bundles) !== JSON.stringify(r.profile.bundles)) fail('profile package dsh.profile.bundles differs from release manifest')
    for (const [name, spec] of Object.entries(r.profileDependencies ?? {})) {
      const actual = profilePackage.dependencies?.[name]
      const expected = r.localPackages?.[name]?.override === 'enabled' ? 'workspace:*' : spec
      if (actual !== expected) fail(`profile dependency ${name} is ${String(actual)}, expected ${expected}`)
    }
    const mismatches = []
    for (const [name, entry] of Object.entries(r.localPackages ?? {})) {
      if (!existsSync(join(root, entry.path))) fail(`local package ${name} path is missing: ${entry.path}`)
      const pkg = readJson(join(root, entry.path, 'package.json'))
      if (pkg.name !== name || pkg.version !== entry.version) fail(`local package ${name} manifest drifted from release manifest`)
      if (entry.profilePinStatus === 'mismatch' && entry.override !== 'disabled') mismatches.push(`${name}: local ${entry.version}, profile ${entry.profileSpec}`)
    }
    if (mismatches.length) {
      console.warn('verify: local/profile version mismatches:')
      for (const line of mismatches) console.warn('  ' + line)
      if (args.includes('--strict-local')) fail('local/profile version mismatches are not allowed in strict mode')
    }
    execFileSync('pnpm', ['run', 'verify:plus-governance'], { cwd: root, stdio: 'inherit' })
    console.log('verify: upstream lock, release manifest, and Plus governance are consistent')
  },
  'image-plan'() {
    const r = release()
    const u = lock()
    const plan = {
      schemaVersion: 1,
      upstream: { repository: u.repository, tag: u.tag, revision: u.revision },
      plus: r.plus,
      profile: r.profile,
      packages: r.packages,
      profileDependencies: r.profileDependencies,
      localPackages: r.localPackages ?? {},
      localPackagePolicy: r.localPackagePolicy ?? { mode: 'prefer-local', onVersionMismatch: 'use-profile-pin' },
    }
    const body = JSON.stringify(plan, null, 2) + '\n'
    const digest = createHash('sha256').update(body).digest('hex')
    const output = join(downstream, 'image-plan.json')
    writeFileSync(output, body)
    console.log(`image-plan: ${relative(root, output)}`)
    console.log(`digest: sha256:${digest}`)
    console.log(`inputs: ${Object.keys(plan.profileDependencies ?? {}).length} exact profile dependencies`)
  },
  doctor() {
    const problems = []
    const warnings = []
    for (const file of ['BUILD.md', 'downstream/upstream.lock.json', 'downstream/release-manifest.json', 'downstream/migration-inventory.json', 'downstream/profiles/dataops-web/package.json', 'downstream/profiles/dataops-web/profile.json']) {
      if (!existsSync(join(root, file))) problems.push(`missing required file: ${file}`)
    }
    const p = plus()
    const u = lock()
    const r = release()
    const profile = readJson(join(downstream, 'profiles/dataops-web/profile.json'))
    for (const [name, path] of Object.entries(profile.localPackages ?? {})) {
      if (!existsSync(join(root, path))) problems.push(`profile local package missing: ${name} -> ${path}`)
    }
    try { execFileSync('git', ['rev-parse', `${u.tag}^{commit}`], { cwd: root, stdio: 'ignore' }) }
    catch { problems.push(`official tag is not available locally: ${u.tag}`) }
    if (p.dshPlus?.sourceBase?.revision !== u.revision) problems.push('plus sourceBase differs from upstream.lock.json')
    if (!existsSync(join(root, 'pnpm-lock.yaml'))) problems.push('missing root pnpm-lock.yaml')
    const downstreamDirs = [join(root, 'downstream/packages'), join(root, 'downstream/profiles')]
    for (const dir of downstreamDirs) {
      if (!existsSync(dir)) continue
      const walk = (current) => {
        for (const name of readdirSync(current)) {
          const path = join(current, name)
          if (!statSync(path).isDirectory()) {
            if (name === 'pnpm-lock.yaml' || name === 'pnpm-workspace.yaml') problems.push(`nested ${name}: ${relative(root, path)}`)
            continue
          }
          if (name === 'node_modules' || (name === 'lib' && existsSync(join(current, 'package.json')))) {
            warnings.push(`build artifact in workspace: ${relative(root, path)}`)
            continue
          }
          walk(path)
        }
      }
      walk(dir)
    }
    if (problems.length) {
      for (const problem of problems) console.error(`problem      ${problem}`)
      fail(`${problems.length} reproducibility problem(s)`)
    }
    for (const warning of warnings) console.warn(`warning      ${warning}`)
    console.log(`doctor: ${relative(root, 'downstream/release-manifest.json')} is reproducible-sane; ${warnings.length} warning(s)`)
  },
  image(args = []) {
    const tagIndex = args.indexOf('--tag')
    const tag = tagIndex >= 0 ? args[tagIndex + 1] : 'dataops-web-profile:local'
    if (args.includes('--smoke-only')) {
      smokeImage(tag)
      return
    }
    const context = mkdtempSync(join('/tmp', 'dataops-web-image-'))
    const profileDir = join(context, 'profile')
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' })
    const cacheKey = createHash('sha256')
      .update(readFileSync(releaseManifestPath))
      .update(readFileSync(join(downstream, 'migration-inventory.json')))
      .update(readFileSync(join(root, 'pnpm-lock.yaml')))
      .update(dirty)
      .digest('hex').slice(0, 16)
    const cacheDir = join(downstream, '.artifacts/image-cache', cacheKey)
    const cachedProfile = join(cacheDir, 'profile')
    const cachedPlus = join(cacheDir, 'plus.tgz')
    const refresh = args.includes('--refresh')
    if (!refresh && existsSync(join(cachedProfile, 'package.json')) && existsSync(cachedPlus)) {
      cpSync(cachedProfile, profileDir, { recursive: true })
      cpSync(cachedPlus, join(context, 'plus.tgz'))
      console.log(`image cache: ${cacheKey}`)
    } else {
      commands.profile(['--out', profileDir])
      execFileSync('pnpm', ['--filter', '@sparkelf/dsh-plus', 'pack', '--pack-destination', context], { cwd: root, stdio: 'inherit' })
      const tarball = readdirSync(context).find((name) => name.endsWith('.tgz'))
      if (!tarball) fail('dsh-plus pack produced no tarball')
      cpSync(join(context, tarball), join(context, 'plus.tgz'))
      rmSync(cacheDir, { recursive: true, force: true })
      mkdirSync(cacheDir, { recursive: true })
      cpSync(profileDir, cachedProfile, { recursive: true })
      cpSync(join(context, 'plus.tgz'), cachedPlus)
      console.log(`image cache: ${cacheKey} (refreshed)`)
    }
    cpSync(join(root, 'downstream/image/Dockerfile'), join(context, 'Dockerfile'))
    for (const name of ['dsh-plugin-backup', 'dsh-image-hoist']) {
      cpSync(join(root, 'packages/bundle/plus/node_modules/@sparkelf', name), join(context, name), { recursive: true, dereference: true })
    }
    execFileSync('docker', ['build', '-t', tag, context], { cwd: root, stdio: 'inherit' })
    if (args.includes('--smoke')) smokeImage(tag)
    console.log(`image: ${tag}`)
  },
  archive(args = []) {
    if (!args.includes('--dry-run')) fail('archive is fail-closed: pass --dry-run; actual repository archival needs explicit approval')
    const plan = readJson(join(downstream, 'archive-plan.json'))
    const r = release()
    if ((r.packages?.plugins ?? []).length < 26) fail('archive prerequisite failed: fewer than 26 migrated packages')
    for (const repo of plan.repositories ?? []) {
      console.log(`${repo.status.padEnd(8)} ${repo.name}${repo.reason ? ` — ${repo.reason}` : ''}`)
    }
    const ready = (plan.repositories ?? []).filter(repo => repo.status === 'ready').length
    console.log(`archive dry-run: ${ready}/${plan.repositories.length} repositories ready`)
  },
  profile(args = []) {
    const outIndex = args.indexOf('--out')
    const out = outIndex >= 0 ? args[outIndex + 1] : join(root, 'downstream/.artifacts/dataops-web-profile')
    if (!out) fail('usage: downstream profile [--out <directory>]')
    execFileSync('pnpm', ['--filter', '@sparkelf/dataops-web-profile', 'deploy', '--prod', '--legacy', out], { cwd: root, stdio: 'inherit' })
    for (const file of ['package.json', 'profile.json']) {
      if (!existsSync(join(out, file))) fail(`profile deploy did not produce ${file}`)
    }
    console.log(`profile: ${out}`)
  },
  publish(args = []) {
    const dryRun = args.includes('--dry-run')
    if (!dryRun) {
      fail('publish is fail-closed: use `publish --dry-run` to validate migrated artifacts; remote publication requires a separate release approval')
    }
    const { r } = assertConsistent()
    const entries = r.packages?.plugins ?? []
    if (!entries.length) fail('no migrated plugin packages to publish')
    const failures = []
    for (const entry of entries) {
      const dir = join(root, entry.path)
      const manifest = readJson(join(dir, 'package.json'))
      if (manifest.name !== entry.name || manifest.version !== entry.version) {
        failures.push(`${entry.name}: manifest name/version drifted`)
        continue
      }
      const targets = [manifest.main, ...Object.values(manifest.exports ?? {}).flatMap((value) => {
        if (typeof value === 'string') return [value]
        if (value && typeof value === 'object') return Object.values(value).filter((item) => typeof item === 'string')
        return []
      })].filter((value) => typeof value === 'string' && value.endsWith('.js'))
      for (const target of targets) {
        const path = join(dir, target)
        if (!existsSync(path)) failures.push(`${entry.name}: missing built target ${target}`)
      }
      console.log(`ready        ${entry.name}@${entry.version} (${relative(root, dir)})`)
    }
    if (failures.length) {
      for (const failure of failures) console.error(`not-ready    ${failure}`)
      fail(`${failures.length} publish readiness failure(s)`)
    }
    console.log(`publish dry-run: ${entries.length} package(s) ready; nothing published`)
  },
  help() {
    console.log(`Usage: node downstream/tools/downstream.mjs <command>

Commands:
  status          show lock/manifest/package summary
  sync [--fetch]  verify the pinned official tag/revision
  inventory       list dsh-plugins-plus packages and migration status
  build-packages  build migrated workspace packages (fails until migration)
  apply           assemble patches/profile via the built dsh-plus apply
  verify          validate lock/manifest and run Plus governance
  profile         deploy the generated DataOps web profile to a directory
  archive         dry-run old-repository archive readiness
  image           build the local DataOps web smoke image from profile + dsh-plus
  doctor          check clean-fork reproducibility prerequisites
  image-plan      write a deterministic image input plan from the release manifest
  publish         validate migrated packages with --dry-run; remote publish is fail-closed
  help            show this help`)
  },
}

const [command = 'help', ...args] = process.argv.slice(2)
if (!commands[command]) commands.help()
else commands[command](args)
