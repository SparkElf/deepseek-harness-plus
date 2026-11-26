#!/usr/bin/env node
/**
 * Write and verify the workspace image release binding.
 *
 * A candidate build records the three facts that make an image traceable: the official source
 * revision, the Plus distribution version, and the candidate image digest. It also records one
 * digest over every build input a clean clone has to supply, so a later build can prove it
 * consumed the same bytes instead of only claiming the same version strings.
 *
 * Only a candidate repository is accepted. The production repository is deliberately rejected:
 * a binding written against an unpushed local image would look like release evidence while the
 * tag it names is not what production runs.
 *
 * Usage:
 *   node scripts/release-binding.mjs write --tag <repo>:<tag> [--path <file>] [--created-at <iso>]
 *   node scripts/release-binding.mjs verify [--path <file>] [--image <tag>]
 *        [--require-inputs] [--require-image]
 *   node scripts/release-binding.mjs print [--path <file>]
 *
 * Environment:
 *   RELEASE_BINDING_PATH  default path when --path is omitted
 *
 * The verifier recomputes the input digest only when the artifacts exist; a clean checkout can
 * still verify the structural contract and the recorded digests. `--require-inputs` turns a
 * missing artifact into a failure, and the build entry uses that form after a build.
 */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const workspaceDir = resolve(scriptDir, '..')
const repoRoot = resolve(workspaceDir, '../..')
const ctx = join(workspaceDir, 'context')

const DEFAULTS = {
  path: process.env.RELEASE_BINDING_PATH ?? join(workspaceDir, 'acceptance', 'release-binding.json'),
}
const CANDIDATE_PATTERN = /(^|[-_./])candidate([-_.:]|$)/i
const PRODUCTION_REPOSITORIES = new Set(['dataops-ai-workspace'])

class BindingError extends Error {}

/** Read one dot-path from a JSON file, failing instead of falling back to a default. */
function jsonValue(path, ...keys) {
  let value = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of keys) {
    if (value === null || typeof value !== 'object' || !(key in value)) {
      throw new BindingError(`${path}: missing ${keys.join('.')}`)
    }
    value = value[key]
  }
  return value
}

/** Hash a file with SHA-256. */
async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

/** Hash one UTF-8 string. */
function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Reject an image reference whose repository is not a candidate namespace. */
function assertCandidateReference(tag) {
  const repository = tag.replace(/:[^/:]+$/, '')
  if (!tag.includes(':') || repository === '') {
    throw new BindingError(`image reference needs an explicit tag, got: ${tag}`)
  }
  if (PRODUCTION_REPOSITORIES.has(repository)) {
    throw new BindingError(`refusing to bind the production repository ${repository}; use a *candidate* repository`)
  }
  if (!CANDIDATE_PATTERN.test(repository)) {
    throw new BindingError(`refusing to bind ${repository}: the repository name does not carry "candidate"`)
  }
}

/** Read the pinned source revision and Plus version that a binding must agree with. */
function readPins() {
  return {
    source: {
      repository: jsonValue(join(repoRoot, 'downstream', 'upstream.lock.json'), 'repository'),
      revision: jsonValue(join(repoRoot, 'downstream', 'upstream.lock.json'), 'revision'),
      tag: jsonValue(join(repoRoot, 'downstream', 'upstream.lock.json'), 'tag'),
    },
    plus: {
      name: jsonValue(join(repoRoot, 'packages', 'bundle', 'plus', 'package.json'), 'name'),
      version: jsonValue(join(repoRoot, 'packages', 'bundle', 'plus', 'package.json'), 'version'),
    },
  }
}

/** Return the vendor tarballs the build context carries, sorted by path. */
function vendorFiles() {
  const dir = join(ctx, 'vendor')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.tgz'))
    .sort()
    .map(name => ({ path: `context/vendor/${name}`, absolute: join(dir, name) }))
}

/** List the recipe files under context/, excluding the artifacts hashed separately. */
function contextFiles() {
  const rows = []
  const plusName = `sparkelf-dsh-plus-${readPins().plus.version}.tgz`
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}/${entry.name}`
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (relative === 'context/officecli-bin') continue
        walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      if (relative === 'context/dsh-src.tar.gz' || relative === `context/${plusName}`) continue
      if (relative.startsWith('context/vendor/') && relative.endsWith('.tgz')) continue
      rows.push({ path: relative, absolute })
    }
  }
  walk(ctx, 'context')
  for (const name of ['build-workspace-final.sh', 'prepare-inputs.sh']) {
    rows.push({ path: `scripts/${name}`, absolute: join(workspaceDir, 'scripts', name) })
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path))
}

/** Hash every artifact a build must supply and fold them into one stable digest. */
async function computeInputs({ requireArtifacts }) {
  const inputsLock = join(workspaceDir, 'inputs.lock.json')
  const dshSource = join(ctx, 'dsh-src.tar.gz')
  const plusTarball = join(ctx, `sparkelf-dsh-plus-${readPins().plus.version}.tgz`)
  const required = [
    ['inputs.lock.json', inputsLock],
    ['context/dsh-src.tar.gz', dshSource],
    [`context/sparkelf-dsh-plus-${readPins().plus.version}.tgz`, plusTarball],
  ]
  const recipes = []
  for (const entry of contextFiles()) recipes.push({ path: entry.path, sha256: await sha256File(entry.absolute) })
  const contextDigest = sha256Text(JSON.stringify(recipes))
  const missing = required.filter(([, path]) => !existsSync(path) || statSync(path).size === 0).map(([label]) => label)
  if (missing.length > 0 && requireArtifacts) {
    throw new BindingError(`build inputs are missing (${missing.join(', ')}); run scripts/prepare-inputs.sh first`)
  }
  if (missing.length > 0) {
    return { complete: false, missing, contextDigest, contextFileCount: recipes.length }
  }

  const vendor = []
  for (const entry of vendorFiles()) {
    if (!existsSync(entry.absolute) || statSync(entry.absolute).size === 0) {
      if (requireArtifacts) throw new BindingError(`vendor tarball is missing: ${entry.path}`)
      return { complete: false, missing: [entry.path] }
    }
    vendor.push({ path: entry.path, sha256: await sha256File(entry.absolute) })
  }
  const value = {
    inputsLockSha256: await sha256File(inputsLock),
    dshSourceTarballSha256: await sha256File(dshSource),
    plusTarballSha256: await sha256File(plusTarball),
    vendorTarballs: vendor,
    contextDigest,
  }
  return {
    complete: true,
    ...value,
    digest: sha256Text(JSON.stringify(value)),
    vendorTarballCount: vendor.length,
    contextFileCount: recipes.length,
  }
}

/** Inspect one local image and return the fields a binding records. */
function inspectImage(tag) {
  let raw
  try {
    raw = execFileSync('docker', ['image', 'inspect', tag], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    const detail = error instanceof Error && 'stderr' in error ? String(error.stderr).trim() : String(error)
    throw new BindingError(`docker image inspect ${tag} failed: ${detail}`)
  }
  const [image] = JSON.parse(raw)
  return {
    tag,
    imageId: image.Id,
    repoDigests: Array.isArray(image.RepoDigests) ? image.RepoDigests : [],
    sizeBytes: image.Size,
    createdAt: image.Created,
  }
}

/** Fail when a required binding field is absent, empty, or the wrong primitive type. */
function assertNonEmpty(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BindingError(`release binding field is empty: ${label}`)
  }
  return value
}

/** Build the binding object from the pinned locks, the supplied inputs, and one local image. */
async function buildBinding({ tag, createdAt, aliases = [] }) {
  assertCandidateReference(tag)
  const pins = readPins()
  const image = inspectImage(tag)
  const inputs = await computeInputs({ requireArtifacts: true })
  const digest = image.repoDigests.length > 0 ? image.repoDigests[0] : image.imageId
  return {
    schemaVersion: 1,
    kind: 'workspace-image-release-binding',
    createdAt,
    productionSwitch: false,
    candidateOnly: true,
    source: { ...pins.source, revision: pins.source.revision },
    plus: { ...pins.plus, tarballSha256: inputs.plusTarballSha256 },
    image: {
      ...image,
      aliases: [...new Set(aliases)].sort(),
      digest,
      // Docker reports a local `<repo>@sha256:<config>` pseudo-digest for an image that was never
      // pushed. Record that fact instead of letting the field read as registry evidence.
      digestSource: image.repoDigests.length > 0 ? 'repo-digest' : 'image-id',
      digestKind: image.repoDigests.length > 0 ? 'local-repo-digest' : 'local-image-id',
      pushed: false,
    },
    buildInputs: inputs,
    build: {
      script: 'scripts/build-workspace-final.sh',
      repository: tag.replace(/:[^/:]+$/, ''),
      profileDefaults: process.env.DATAOPS_PROFILE_DEFAULTS ?? 'cordis.patch.yml',
    },
  }
}

/** Validate a parsed binding object. Returns a list of failures rather than throwing once. */
function validateBinding(binding) {
  const failures = []
  const check = (fn, label) => {
    try {
      fn()
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  check(() => {
    if (binding.schemaVersion !== 1) throw new Error(`unsupported schemaVersion ${String(binding.schemaVersion)}`)
  }, 'schemaVersion')
  check(() => {
    if (binding.kind !== 'workspace-image-release-binding') throw new Error('wrong kind')
  }, 'kind')
  check(() => {
    if (binding.candidateOnly !== true) throw new Error('candidateOnly must be true')
  }, 'candidateOnly')
  check(() => {
    if (binding.productionSwitch !== false) throw new Error('productionSwitch must be false')
  }, 'productionSwitch')
  for (const [value, label] of [
    [binding.source?.revision, 'source.revision'],
    [binding.plus?.version, 'plus.version'],
    [binding.image?.tag, 'image.tag'],
    [binding.image?.imageId, 'image.imageId'],
    [binding.image?.digest, 'image.digest'],
    [binding.buildInputs?.digest, 'buildInputs.digest'],
  ]) {
    check(() => assertNonEmpty(value, label), label)
  }
  check(() => {
    if (!/^[0-9a-f]{64}$/.test(binding.buildInputs.digest)) throw new Error('not a SHA-256 hex digest')
  }, 'buildInputs.digest')
  check(() => {
    if (!/^(?:[^@\s]+@)?sha256:[0-9a-f]{64}$/.test(binding.image.digest)) throw new Error('not an image digest')
  }, 'image.digest')
  check(() => {
    if (binding.image.pushed !== false) throw new Error('this writer only records unpushed local images')
  }, 'image.pushed')
  check(() => {
    if (!/^[0-9a-f]{40}$/.test(binding.source.revision)) throw new Error('not a 40-hex revision')
  }, 'source.revision')
  check(() => assertCandidateReference(binding.image.tag), 'image.tag')
  return failures
}

/** Compare the recorded pins and input digest with the current checkout. */
async function validateAgainstCheckout(binding, { requireInputs }) {
  const failures = []
  const pins = readPins()
  if (binding.source.revision !== pins.source.revision) {
    failures.push(`source.revision ${binding.source.revision} != upstream.lock ${pins.source.revision}`)
  }
  if (binding.plus.version !== pins.plus.version) {
    failures.push(`plus.version ${binding.plus.version} != package.json ${pins.plus.version}`)
  }
  const inputs = await computeInputs({ requireArtifacts: requireInputs })
  if (inputs.contextDigest !== binding.buildInputs.contextDigest) {
    failures.push(`buildInputs.contextDigest ${binding.buildInputs.contextDigest} != recomputed ${inputs.contextDigest}`)
  }
  if (inputs.complete) {
    if (inputs.digest !== binding.buildInputs.digest) {
      failures.push(`buildInputs.digest ${binding.buildInputs.digest} != recomputed ${inputs.digest}`)
    }
  } else if (requireInputs) {
    failures.push(`build inputs unavailable: ${inputs.missing.join(', ')}`)
  }
  return { failures, inputs }
}

/** Persist one binding atomically so an interrupted write cannot leave a partial record. */
function writeBinding(path, binding) {
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(binding, null, 2)}\n`)
  renameSync(temporary, path)
}

/** Parse the small command line this script owns. */
function parseArguments(argv) {
  const [command = 'verify', ...rest] = argv
  const options = { command, path: DEFAULTS.path }
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index]
    const next = rest[index + 1]
    switch (key) {
      case '--path':
        if (next === undefined) throw new BindingError('--path needs a value')
        options.path = resolve(next)
        index += 1
        break
      case '--tag':
      case '--image':
        if (next === undefined) throw new BindingError(`${key} needs a value`)
        options.image = next
        index += 1
        break
      case '--created-at':
        if (next === undefined) throw new BindingError('--created-at needs a value')
        options.createdAt = next
        index += 1
        break
      case '--alias':
        if (next === undefined) throw new BindingError('--alias needs a value')
        options.aliases = [...(options.aliases ?? []), next]
        index += 1
        break
      case '--require-inputs':
        options.requireInputs = true
        break
      case '--require-image':
        options.requireImage = true
        break
      case '-h':
      case '--help':
        options.help = true
        break
      default:
        throw new BindingError(`unknown option: ${key}`)
    }
  }
  return options
}

function usage() {
  process.stdout.write(
    'usage: release-binding.mjs <write|verify|print> [--tag <image>] [--path <file>]\n'
    + '       write  --tag <candidate-image-reference> [--alias <tag>]... [--created-at <iso>]\n'
    + '       verify [--image <candidate-image-reference>] [--require-inputs] [--require-image]\n',
  )
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    usage()
    return 0
  }
  if (options.command === 'write') {
    if (options.image === undefined) throw new BindingError('write needs --tag <candidate-image-reference>')
    const binding = await buildBinding({
      tag: options.image,
      createdAt: options.createdAt ?? new Date().toISOString(),
      aliases: options.aliases,
    })
    const failures = validateBinding(binding)
    if (failures.length > 0) throw new BindingError(`refusing to write an invalid binding:\n  - ${failures.join('\n  - ')}`)
    writeBinding(options.path, binding)
    process.stdout.write(`wrote ${options.path}\n`)
    process.stdout.write(`  source ${binding.source.revision}\n`)
    process.stdout.write(`  plus   ${binding.plus.name}@${binding.plus.version}\n`)
    process.stdout.write(`  image  ${binding.image.imageId} (${binding.image.digestSource} ${binding.image.digest})\n`)
    process.stdout.write(`  inputs ${binding.buildInputs.digest} (${binding.buildInputs.vendorTarballCount} vendor tarballs, ${binding.buildInputs.contextFileCount} recipe files)\n`)
    return 0
  }

  if (!existsSync(options.path)) throw new BindingError(`release binding not found: ${options.path}`)
  const binding = JSON.parse(readFileSync(options.path, 'utf8'))
  const failures = validateBinding(binding)
  const checkout = await validateAgainstCheckout(binding, { requireInputs: options.requireInputs === true })
  failures.push(...checkout.failures)

  if (options.image !== undefined) {
    const image = inspectImage(options.image)
    if (image.imageId !== binding.image.imageId) {
      failures.push(`image.imageId ${binding.image.imageId} != ${options.image} ${image.imageId}`)
    }
  } else if (options.requireImage) {
    const image = inspectImage(binding.image.tag)
    if (image.imageId !== binding.image.imageId) {
      failures.push(`image.imageId ${binding.image.imageId} != ${binding.image.tag} ${image.imageId}`)
    }
  }

  if (options.command === 'print') {
    process.stdout.write(`${JSON.stringify(binding, null, 2)}\n`)
    return failures.length > 0 ? 1 : 0
  }
  if (failures.length > 0) {
    process.stderr.write(`release binding failed (${options.path}):\n`)
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`)
    return 1
  }
  process.stdout.write(
    `release binding ok: ${binding.image.tag} ${binding.image.digest}\n`
    + `  inputs ${checkout.inputs.complete ? 'recomputed' : 'not present (structural check only)'}\n`,
  )
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
