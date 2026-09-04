import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface ProfilePackageEvidence {
  readonly version: string
  readonly fingerprint: string
  readonly directory: string
}

export interface ProfileEvidence {
  readonly bundles: readonly string[]
  readonly packages: Readonly<Record<string, ProfilePackageEvidence>>
}

export interface ProfileProbe {
  readonly file: string
  readonly contains: readonly string[]
}

export interface ProfilePackagePolicy {
  readonly mode: 'preserve' | 'replace'
  readonly version: string
  readonly baselineSha256: string
  readonly candidateSha256: string
  readonly probes?: readonly ProfileProbe[]
}

export interface PlusProfileUpgradePolicy {
  readonly formatVersion: 1
  readonly name: string
  readonly requiredBundles: readonly string[]
  readonly packages: Readonly<Record<string, ProfilePackagePolicy>>
}

export interface ProfileDiffRow {
  readonly name: string
  readonly baseline?: Pick<ProfilePackageEvidence, 'version' | 'fingerprint'>
  readonly candidate?: Pick<ProfilePackageEvidence, 'version' | 'fingerprint'>
}

const RUNTIME_FILE = /(?:^package\.json$|^cordis\.patch\.ya?ml$|\.(?:[cm]?js|css|json|ya?ml|wasm)$)/u
const NON_RUNTIME_FILE = /(?:\.map$|\.d\.ts$|\.tsbuildinfo$)/u
const SHA256 = /^[0-9a-f]{64}$/u

function runtimeFiles(root: string, directory = root): string[] {
  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') files.push(...runtimeFiles(root, path))
      continue
    }
    if (!entry.isFile() || NON_RUNTIME_FILE.test(entry.name)) continue
    const name = relative(root, path).replaceAll('\\', '/')
    if (RUNTIME_FILE.test(name)) files.push(name)
  }
  return files.sort()
}

export function fingerprintPackage(directory: string): string {
  const digest = createHash('sha256')
  for (const file of runtimeFiles(directory)) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(directory, file)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function packageDirectories(profile: string): string[] {
  const modules = join(profile, 'node_modules')
  if (!existsSync(modules)) throw new Error('profile has no node_modules: ' + modules)
  const directories: string[] = []
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    const path = join(modules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of readdirSync(path, { withFileTypes: true })) {
        if (!child.name.startsWith('.')) directories.push(join(path, child.name))
      }
    } else {
      directories.push(path)
    }
  }
  return directories.filter((directory) => {
    try {
      const stat = lstatSync(directory)
      return stat.isDirectory() || stat.isSymbolicLink()
    } catch {
      return false
    }
  })
}

export function inspectProfile(profilePath: string): ProfileEvidence {
  const profile = resolve(profilePath)
  const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(value => typeof value === 'string')) {
    throw new Error('profile has no string dsh.profile.bundles: ' + profile)
  }
  const packages: Record<string, ProfilePackageEvidence> = {}
  for (const link of packageDirectories(profile)) {
    const directory = realpathSync(link)
    const packageFile = join(directory, 'package.json')
    if (!existsSync(packageFile)) continue
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown; version?: unknown }
    if (typeof pkg.name !== 'string' || typeof pkg.version !== 'string') continue
    packages[pkg.name] = { version: pkg.version, fingerprint: fingerprintPackage(directory), directory }
  }
  return { bundles, packages }
}

function compact(evidence: ProfilePackageEvidence): Pick<ProfilePackageEvidence, 'version' | 'fingerprint'> {
  return { version: evidence.version, fingerprint: evidence.fingerprint }
}

export function profileDiff(baseline: ProfileEvidence, candidate: ProfileEvidence): ProfileDiffRow[] {
  const names = [...new Set([...Object.keys(baseline.packages), ...Object.keys(candidate.packages)])].sort()
  return names.flatMap((name) => {
    const before = baseline.packages[name]
    const after = candidate.packages[name]
    if (before?.version === after?.version && before?.fingerprint === after?.fingerprint) return []
    return [{
      name,
      ...(before === undefined ? {} : { baseline: compact(before) }),
      ...(after === undefined ? {} : { candidate: compact(after) }),
    }]
  })
}

function parsePolicy(file: string): PlusProfileUpgradePolicy {
  const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid Plus profile policy object: ' + file)
  }
  const policy = value as Record<string, unknown>
  if (policy.formatVersion !== 1 || typeof policy.name !== 'string' || policy.name === '') {
    throw new Error('invalid Plus profile policy header: ' + file)
  }
  if (!Array.isArray(policy.requiredBundles) || policy.packages === null || typeof policy.packages !== 'object') {
    throw new Error('invalid Plus profile policy body: ' + file)
  }
  return value as PlusProfileUpgradePolicy
}

export function verifyProfileUpgrade(
  baseline: ProfileEvidence,
  candidate: ProfileEvidence,
  policy: PlusProfileUpgradePolicy,
): { readonly changed: readonly string[]; readonly verified: readonly string[] } {
  const violations: string[] = []
  const changed = profileDiff(baseline, candidate).map(row => row.name)
  for (const name of changed) {
    if (policy.packages[name] === undefined) violations.push(name + ': runtime payload changed without a policy entry')
  }
  for (const bundle of policy.requiredBundles) {
    if (!candidate.bundles.includes(bundle)) violations.push('candidate profile is missing required bundle ' + bundle)
  }
  for (const [name, expected] of Object.entries(policy.packages)) {
    const before = baseline.packages[name]
    const after = candidate.packages[name]
    if (before === undefined) { violations.push(name + ': missing from baseline profile'); continue }
    if (after === undefined) { violations.push(name + ': missing from candidate profile'); continue }
    if (!SHA256.test(expected.baselineSha256) || !SHA256.test(expected.candidateSha256)) {
      violations.push(name + ': policy fingerprints must be lowercase SHA-256')
      continue
    }
    if (before.version !== expected.version) violations.push(name + ': baseline version ' + before.version + ' != ' + expected.version)
    if (after.version !== expected.version) violations.push(name + ': candidate version ' + after.version + ' != ' + expected.version)
    if (before.fingerprint !== expected.baselineSha256) violations.push(name + ': baseline fingerprint drifted to ' + before.fingerprint)
    if (after.fingerprint !== expected.candidateSha256) violations.push(name + ': candidate fingerprint drifted to ' + after.fingerprint)
    if (expected.mode === 'preserve' && before.fingerprint !== after.fingerprint) {
      violations.push(name + ': preserve policy forbids runtime payload changes')
    }
    if (expected.mode === 'replace' && before.fingerprint === after.fingerprint) {
      violations.push(name + ': replace policy requires an intentional runtime payload change')
    }
    for (const probe of expected.probes ?? []) {
      const path = join(after.directory, probe.file)
      if (!existsSync(path)) { violations.push(name + ': probe file is missing: ' + probe.file); continue }
      const payload = readFileSync(path, 'utf8')
      for (const marker of probe.contains) {
        if (!payload.includes(marker)) violations.push(name + ': ' + probe.file + ' is missing capability marker ' + JSON.stringify(marker))
      }
    }
  }
  if (violations.length > 0) {
    throw new Error('Plus production profile closure rejected:\n' + violations.map(value => '- ' + value).join('\n'))
  }
  return { changed, verified: Object.keys(policy.packages).sort() }
}

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = process.argv[index + 1]
  if (index < 0 || value === undefined || value.startsWith('--')) throw new Error('missing ' + name + ' PATH')
  return value
}

function main(): void {
  const baselinePath = argument('--baseline')
  const candidatePath = argument('--candidate')
  const baseline = inspectProfile(baselinePath)
  const candidate = inspectProfile(candidatePath)
  if (process.argv.includes('--report')) {
    console.log(JSON.stringify({
      baseline: basename(resolve(baselinePath)),
      candidate: basename(resolve(candidatePath)),
      changed: profileDiff(baseline, candidate),
    }, null, 2))
    return
  }
  const policyFile = resolve(argument('--policy'))
  const policy = parsePolicy(policyFile)
  const result = verifyProfileUpgrade(baseline, candidate, policy)
  console.log('verify-plus-profile-upgrade: ' + policy.name + ': ' + String(result.verified.length) + ' critical packages verified; ' + String(result.changed.length) + ' declared runtime change(s).')
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
