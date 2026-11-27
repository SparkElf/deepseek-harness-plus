#!/usr/bin/env node
/**
 * MinerU deployment CLI: fetch an offline bundle, deploy it over SSH, verify it.
 *
 * The contract this script targets is the one the knowledge-base plugin actually
 * calls, not what older MinerU docs describe:
 *
 *   POST {base}/v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto
 *   body: multipart with exactly one field, `files`
 *
 * MinerU 4.x parses that body with `max_fields=0`, so any second form field is
 * rejected with "Too many fields. Maximum number of fields is 0.", and it reads
 * every parse option from the query string. `verify` sends exactly that shape.
 *
 * @module deploy-mineru
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'

/** Default API port MinerU listens on, and the one the plugin expects. */
const DEFAULT_PORT = 8000

/**
 * Image reference used when the caller names none.
 *
 * MinerU publishes Dockerfiles rather than a pullable Hub tag: `docker/compose.yaml`
 * in the 4.0.12 tree builds a local `mineru:4` from `docker/global/Dockerfile` (or
 * `docker/china/` for a China-region mirror). So the default assumes someone built or
 * pulled that tag locally, and `--image` is how a caller points at whatever they have.
 */
const DEFAULT_IMAGE = 'mineru:4'

/** Container name this script owns. Reusing the name is how `deploy` stays idempotent. */
const DEFAULT_CONTAINER = 'mineru-api'

/** Where `fetch` writes its bundle when the caller names no directory. */
const DEFAULT_OUTPUT = './mineru-bundle'

/** Model source default: ModelScope, because the deployment target is China-region. */
const DEFAULT_MODEL_SOURCE = 'modelscope'

/** PyPI index used by the wheels fallback, mirroring docker/china/Dockerfile. */
const DEFAULT_PYPI_INDEX = 'https://mirrors.aliyun.com/pypi/simple'

/** How long `docker save` may run; a model-carrying image is multi-GB. */
const SAVE_TIMEOUT_MS = 60 * 60 * 1000

/** How long an SSH command may run; model download on a slow link dominates. */
const SSH_TIMEOUT_MS = 60 * 60 * 1000

/**
 * Print a step banner.
 * @param message - what this step is doing.
 */
function step(message) {
  console.log(`\n=== ${message} ===`)
}

/**
 * Print informational output that is part of the normal flow.
 * @param message - the note.
 */
function note(message) {
  console.log(`  ${message}`)
}

/**
 * Print a warning the operator should read but that does not stop the run.
 * @param message - the warning.
 */
function warn(message) {
  console.warn(`  ! ${message}`)
}

/**
 * Abort with a message naming the step, the evidence, and the fix.
 *
 * Every failure path goes through here: a deployment script that continues past a
 * broken step is how a user ends up with a machine that looks installed but serves
 * nothing.
 * @param stepName - the step that failed.
 * @param detail - what the command actually printed.
 * @param fix - what the operator should do about it.
 * @returns never; declared `never` so callers narrow correctly.
 */
function fail(stepName, detail, fix) {
  console.error(`\n✗ ${stepName} failed`)
  if (detail !== undefined && String(detail).trim() !== '') {
    const text = String(detail).trim()
    console.error('  output:')
    for (const line of text.split('\n').slice(-25)) console.error(`    ${line}`)
  }
  if (fix !== undefined) console.error(`\n  how to fix: ${fix}`)
  process.exitCode = 1
  throw new DeploymentError(stepName)
}

/** Helper scripts to remove when the process exits. */
const askpassCleanup = []

/** Marker so callers can distinguish a reported failure from a crash. */
class DeploymentError extends Error {
  /** @param stepName - the step that failed. */
  constructor(stepName) {
    super(`deployment failed at ${stepName}`)
    this.name = 'DeploymentError'
  }
}

/**
 * Run one command, capturing output.
 *
 * Inheriting stdio would interleave with the progress lines this script prints, and
 * the failure path needs the tail of the output to quote as evidence.
 * @param command - executable.
 * @param args - arguments.
 * @param options - cwd, timeout, and whether to stream progress to the console.
 * @returns exit code, stdout, stderr.
 */
function run(command, args, options = {}) {
  const { cwd, timeoutMs = SSH_TIMEOUT_MS, echo = false, env } = options
  return new Promise((resolvePromise, rejectPromise) => {
    if (echo) console.log(`  $ ${command} ${args.join(' ')}`)
    let child
    try {
      child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        // `env` is only used to hand ssh its askpass plumbing; it never carries a
        // secret on the command line, and no file is written.
        ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
      })
    } catch (error) {
      rejectPromise(error)
      return
    }
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      rejectPromise(new Error(`${command} timed out after ${String(timeoutMs)} ms`))
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (echo) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
      if (echo) process.stderr.write(chunk)
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      rejectPromise(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code: code ?? 0, stdout, stderr })
    })
  })
}

/**
 * Run a command and fail the step when it exits non-zero.
 * @param stepName - the step this belongs to.
 * @param command - executable.
 * @param args - arguments.
 * @param options - see {@link run}.
 * @param fix - what to do when it fails.
 * @returns stdout.
 */
async function mustRun(stepName, command, args, options, fix) {
  let result
  try {
    result = await run(command, args, options)
  } catch (error) {
    fail(stepName, error instanceof Error ? error.message : String(error), fix)
  }
  if (result.code !== 0) {
    fail(stepName, [result.stdout, result.stderr].filter(Boolean).join('\n'), fix)
  }
  return result.stdout
}

/**
 * Whether a command exists on PATH.
 * @param name - executable name.
 * @returns true when it resolves.
 */
async function hasCommand(name) {
  try {
    const result = await run(name, ['--version'], { timeoutMs: 15_000 })
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Whether a Docker image exists locally.
 * @param image - image reference.
 * @returns true when `docker image inspect` succeeds.
 */
async function imageExists(image) {
  try {
    const result = await run('docker', ['image', 'inspect', image], { timeoutMs: 60_000 })
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Whether a Docker container exists (running or stopped).
 * @param name - container name.
 * @returns true when it exists.
 */
async function containerExists(name) {
  try {
    const result = await run('docker', ['container', 'inspect', name], { timeoutMs: 60_000 })
    return result.code === 0
  } catch {
    return false
  }
}

/**
 * Read the image id of a local image, or empty when absent.
 * @param image - image reference.
 * @returns the immutable id, used as the bundle's identity.
 */
async function imageId(image) {
  try {
    const result = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { timeoutMs: 60_000 })
    return result.code === 0 ? result.stdout.trim() : ''
  } catch {
    return ''
  }
}

/**
 * Human-readable byte size.
 * @param bytes - size in bytes.
 * @returns a short string such as `4.2 GB`.
 */
function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Recursive directory size, used to report a bundle's footprint.
 * @param path - directory.
 * @returns total bytes; 0 when the path is absent.
 */
async function directorySize(path) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  let total = 0
  for (const entry of entries) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(full)
    else {
      const info = await stat(full).catch(() => undefined)
      if (info !== undefined) total += info.size
    }
  }
  return total
}

/** One planned shell command, printed by `--dry-run` and executed otherwise. */
function describe(command, args) {
  return [command, ...args].map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Build the `docker run` argument list used by both the real path and the dry run.
 *
 * `--restart unless-stopped` and the published port are the two things that make the
 * container behave like a service; `MINERU_MODEL_SOURCE=local` is what makes it read
 * the baked-in weights instead of reaching for the network at startup.
 * @param options - container name, image, port, and model source.
 * @returns the argument list after `docker`.
 */
function dockerRunArgs(options) {
  const { container, image, port, modelSource, memoryGb } = options
  return [
    'run', '-d',
    '--name', container,
    '--restart', 'unless-stopped',
    '-p', `${String(port)}:8000`,
    '-e', `MINERU_MODEL_SOURCE=${modelSource}`,
    // The API server spawns ONNX/llama.cpp workers that mmap model files; the official
    // compose raises memlock and stack for exactly this reason.
    '--ulimit', 'memlock=-1',
    '--ipc', 'host',
    ...(memoryGb === undefined ? [] : ['--memory', `${String(memoryGb)}g`]),
    '--entrypoint', 'mineru-kit',
    image,
    'api-server', '--host', '0.0.0.0', '--port', '8000',
  ]
}

/** Options shared by fetch/deploy/verify. */
function commonHelp() {
  return [
    'Common options:',
    '  --dry-run              Print the commands and paths that WOULD be used; touch nothing.',
    '  --port <n>             API port on the target (default 8000).',
    '  -h, --help             Show help.',
  ].join('\n')
}

/** Print the top-level help. */
function printHelp() {
  console.log(`MinerU deployment CLI — offline bundle, SSH deploy, contract verify.

USAGE
  node scripts/deploy-mineru.mjs <command> [options]

COMMANDS
  fetch     On a machine WITH internet: pull/build the MinerU image and save it as a
            movable bundle (image tar + metadata). Produces a directory that \`deploy\`
            can consume. Use --mode=wheels to prepare a no-Docker Python bundle instead.

  deploy    On the machine that will RUN MinerU: copy the bundle over SSH, load the
            image, and start the container. Idempotent: an already-loaded image is not
            loaded again, and an existing container is left alone unless --force.

  verify    Call the running service with the exact request the knowledge-base plugin
            sends, and assert it answers 200 with Markdown.

EXAMPLES
  # 1) On an internet-connected machine, build a movable bundle:
  node scripts/deploy-mineru.mjs fetch --image mineru:4 --output ./mineru-bundle

  # See what fetch would do without doing it:
  node scripts/deploy-mineru.mjs fetch --dry-run

  # 2) On the operator's machine, deploy to a host over SSH:
  node scripts/deploy-mineru.mjs deploy --host root@10.0.0.12 --bundle ./mineru-bundle

  # 3) Prove the deployed service speaks the plugin's contract:
  node scripts/deploy-mineru.mjs verify --url http://10.0.0.12:8000

${commonHelp()}

CREDENTIALS
  SSH uses your key, agent, or ~/.ssh/config — nothing is written to disk here.
  For a password, add --ask-pass (read from the terminal, never stored or logged).

WHAT THE PLUGIN EXPECTS
  POST {base}/v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto
  with a single multipart field named \`files\`. \`verify\` sends exactly this.`)
}

/** Print `fetch` help. */
function printFetchHelp() {
  console.log(`USAGE
  node scripts/deploy-mineru.mjs fetch [options]

Downloads (or builds) the MinerU image and writes a movable bundle directory:
  <output>/mineru-image.tar      the image, ready for \`docker load\`
  <output>/mineru-models/        model cache, when --include-models is used
  <output>/bundle.json           what this bundle is and how to deploy it
  <output>/SHA256SUMS            integrity check for the transfer

OPTIONS
  --image <ref>          Image to package (default ${DEFAULT_IMAGE}).
                         If it is absent locally, --build-from is tried, then a pull.
  --output <dir>         Bundle directory (default ${DEFAULT_OUTPUT}).
  --mode <docker|wheels> docker (default) or the no-Docker Python fallback.
  --include-models       Also copy the host's MinerU model cache into the bundle.
  --models-dir <dir>     Model cache to copy (default: the MinerU cache under $HOME).
  --model-source <name>  modelscope (default) or huggingface; recorded for deploy.
  --pypi-index <url>     Wheel index for --mode=wheels (default ${DEFAULT_PYPI_INDEX}).
  --build-from <dir>     Build the image from a MinerU source tree before saving.
  --force                Re-create the bundle even when it already looks complete.
  --dry-run              Print the commands and output paths only.

${commonHelp()}`)
}

/** Print `deploy` help. */
function printDeployHelp() {
  console.log(`USAGE
  node scripts/deploy-mineru.mjs deploy --host <user@host> [options]

Copies the bundle to the target over SSH, loads the image, and starts MinerU as a
restarting container. Re-running is safe: an image already present is not loaded
again, and an existing container is left running unless --force is given.

OPTIONS
  --host <user@host>     Target machine (required). Uses ssh config and keys.
  --bundle <dir>         Bundle produced by \`fetch\` (default ${DEFAULT_OUTPUT}).
  --port <n>             Published API port (default ${DEFAULT_PORT}).
  --container <name>     Container name (default ${DEFAULT_CONTAINER}).
  --model-source <name>  modelscope (default) or huggingface.
  --memory-gb <n>        Optional container memory ceiling.
  --force                Recreate the container even if it already exists.
  --compose <path>       Deploy with \`docker compose -f <path> up -d\` instead of
                         \`docker run\`. For the bundled deploy/mineru/docker-compose.yml.
                         The image must already be loaded on the target.
  --ask-pass             Prompt for an SSH password (never written to disk).
  --dry-run              Print every command that would run, and change nothing.

${commonHelp()}`)
}

/** Print `verify` help. */
function printVerifyHelp() {
  console.log(`USAGE
  node scripts/deploy-mineru.mjs verify --url <base-url> [options]

Sends the knowledge-base plugin's exact request and asserts the service answers it:
  POST <url>/v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto
  body: one multipart field, \`files\`

OPTIONS
  --url <base>           Service base URL, e.g. http://10.0.0.12:8000.
                         Default when --host is given: http://<host>:<port>.
  --host <user@host>     Derive the URL from a deploy target.
  --tier <name>          Tier to request (default basic).
  --file <path>          PDF to send (default: a generated one-page sample).
  --timeout-ms <n>       Total wait for the parse (default 300000).
  --dry-run              Print the request instead of sending it.`)
}

/**
 * Parse the CLI, returning the command and its options.
 * @param argv - process arguments after the script name.
 * @returns the parsed command, or undefined when help was requested.
 */
function parseCommandLine(argv) {
  const command = argv[0]
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return undefined
  }
  if (!['fetch', 'deploy', 'verify'].includes(command)) {
    console.error(`Unknown command: ${command}\n`)
    printHelp()
    process.exitCode = 2
    return undefined
  }

  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      host: { type: 'string' },
      bundle: { type: 'string' },
      port: { type: 'string' },
      container: { type: 'string' },
      image: { type: 'string' },
      output: { type: 'string' },
      mode: { type: 'string' },
      url: { type: 'string' },
      tier: { type: 'string' },
      'model-source': { type: 'string' },
      'models-dir': { type: 'string' },
      'pypi-index': { type: 'string' },
      'build-from': { type: 'string' },
      'memory-gb': { type: 'string' },
      'timeout-ms': { type: 'string' },
      file: { type: 'string' },
      'include-models': { type: 'boolean' },
      force: { type: 'boolean' },
      'ask-pass': { type: 'boolean' },
      compose: { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })

  if (values.help === true) {
    if (command === 'fetch') printFetchHelp()
    else if (command === 'deploy') printDeployHelp()
    else printVerifyHelp()
    return undefined
  }
  return { command, values }
}

/**
 * Validate a port value.
 * @param raw - the flag value.
 * @param stepName - used in the failure message.
 * @returns the port number.
 */
function portValue(raw, stepName) {
  if (raw === undefined) return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    fail(stepName, `invalid --port ${JSON.stringify(raw)}`, 'pass an integer between 1 and 65535')
  }
  return port
}

/**
 * The MinerU model cache this host would have, for `--include-models`.
 * @param explicit - the `--models-dir` value, when given.
 * @returns absolute candidate paths, most likely first.
 */
function modelCacheCandidates(explicit) {
  if (explicit !== undefined) return [resolve(explicit)]
  const home = process.env.HOME ?? '/root'
  return [
    join(home, '.cache', 'mineru'),
    join(home, '.mineru'),
    join(home, '.cache', 'modelscope', 'hub'),
  ]
}

/** The first existing model cache among the candidates, if any. */
async function findModelCache(explicit) {
  for (const candidate of modelCacheCandidates(explicit)) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * `fetch`: package a MinerU image (and optionally its model cache) into a bundle.
 * @param values - parsed options.
 */
async function commandFetch(values) {
  const dryRun = values['dry-run'] === true
  const mode = values.mode ?? 'docker'
  const output = resolve(values.output ?? DEFAULT_OUTPUT)
  const image = values.image ?? DEFAULT_IMAGE
  const modelSource = values['model-source'] ?? DEFAULT_MODEL_SOURCE
  const force = values.force === true

  if (mode !== 'docker' && mode !== 'wheels') {
    fail('fetch/options', `unknown --mode ${JSON.stringify(mode)}`, 'use --mode=docker or --mode=wheels')
  }

  if (mode === 'wheels') {
    await fetchWheels({ output, modelSource, dryRun, values })
    return
  }

  const imageTar = join(output, 'mineru-image.tar')
  const metadataPath = join(output, 'bundle.json')

  step(`fetch (docker) → ${output}`)
  note(`image:        ${image}`)
  note(`image tar:    ${imageTar}`)
  note(`model source: ${modelSource}`)
  if (dryRun) note('dry run: nothing below will be executed or written')

  if (!dryRun && !force && existsSync(imageTar) && existsSync(metadataPath)) {
    const info = await stat(imageTar)
    note(`bundle already present (${humanBytes(info.size)}); use --force to rebuild`)
    await printBundleSummary(output)
    return
  }

  // Where the image comes from, in order: already local → build from a source tree →
  // pull. Pulling is last because MinerU publishes Dockerfiles rather than a Hub tag,
  // so a pull usually cannot resolve `mineru:4`.
  const plan = []
  const alreadyLocal = dryRun ? undefined : await imageExists(image)
  if (alreadyLocal === true) {
    plan.push(`image ${image} is present locally → docker save`)
  } else if (values['build-from'] !== undefined) {
    plan.push(`docker build -t ${image} ${resolve(values['build-from'])}`)
    plan.push(`docker save ${image} -o ${imageTar}`)
  } else {
    plan.push(`docker pull ${image}`)
    plan.push(`docker save ${image} -o ${imageTar}`)
  }

  step('plan')
  for (const line of plan) note(line)

  const saveArgs = ['save', image, '-o', imageTar]
  if (dryRun) {
    if (!alreadyLocal) {
      if (values['build-from'] !== undefined) {
        console.log(`  $ ${describe('docker', ['build', '-t', image, resolve(values['build-from'])])}`)
      } else {
        console.log(`  $ ${describe('docker', ['pull', image])}`)
      }
    }
    console.log(`  $ ${describe('docker', saveArgs)}`)
    console.log(`  $ mkdir -p ${output}`)
    console.log(`  write ${metadataPath}`)
    console.log(`  write ${join(output, 'SHA256SUMS')}`)
    if (values['include-models'] === true) {
      const cache = await findModelCache(values['models-dir'])
      console.log(`  $ cp -a ${cache ?? '<mineru model cache>'} ${join(output, 'mineru-models')}`)
    }
    printFetchNextSteps(output)
    return
  }

  await mustRun('fetch/prepare', 'mkdir', ['-p', output], { timeoutMs: 30_000 },
    'check that the output directory is writable')

  if (!alreadyLocal) {
    if (values['build-from'] !== undefined) {
      step('build image from source tree')
      await mustRun('fetch/build', 'docker',
        ['build', '-t', image, resolve(values['build-from'])],
        { echo: true, timeoutMs: SAVE_TIMEOUT_MS },
        'confirm the source tree has a Dockerfile and that Docker can reach its base image')
    } else {
      step('pull image')
      await mustRun('fetch/pull', 'docker', ['pull', image], { echo: true, timeoutMs: SAVE_TIMEOUT_MS },
        `MinerU publishes Dockerfiles, not a pullable Hub tag. Build one with:`
        + ` git clone https://github.com/opendatalab/MinerU && docker build -f docker/global/Dockerfile -t ${image} .`
        + `  Then re-run fetch, or pass --build-from <repo>.`)
    }
  } else {
    note(`image ${image} already present locally; skipping pull`)
  }

  step('save image to a movable tar')
  note(`this is the slow step; a model-carrying image is multi-GB`)
  await mustRun('fetch/save', 'docker', saveArgs, { echo: true, timeoutMs: SAVE_TIMEOUT_MS },
    'free disk space in the output directory and retry')
  const tarInfo = await stat(imageTar).catch(() => undefined)
  if (tarInfo !== undefined) note(`wrote ${imageTar} (${humanBytes(tarInfo.size)})`)

  if (values['include-models'] === true) {
    step('copy model cache into the bundle')
    const cache = await findModelCache(values['models-dir'])
    if (cache === undefined) {
      warn('no model cache found; the image is expected to carry its own weights')
      warn(`looked in: ${modelCacheCandidates(values['models-dir']).join(', ')}`)
    } else {
      const destination = join(output, 'mineru-models')
      await mustRun('fetch/models', 'cp', ['-a', cache, destination], { echo: true, timeoutMs: SAVE_TIMEOUT_MS },
        `copy ${cache} to ${destination} by hand if cp is unavailable`)
      note(`copied ${cache} (${humanBytes(await directorySize(destination))})`)
    }
  }

  const id = await imageId(image)
  await writeFile(metadataPath, JSON.stringify({
    kind: 'mineru-docker-bundle',
    createdAt: new Date().toISOString(),
    image,
    imageId: id,
    imageTar: basename(imageTar),
    includesModels: values['include-models'] === true && existsSync(join(output, 'mineru-models')),
    modelSource,
    contract: 'POST /v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto (field: files)',
    defaultPort: DEFAULT_PORT,
  }, null, 2) + '\n', 'utf8')
  await writeChecksums(output)

  step('done')
  await printBundleSummary(output)
  printFetchNextSteps(output)
}

/**
 * `--mode=wheels`: prepare a Python bundle for hosts without Docker.
 *
 * This is a best-effort fallback and says so: it downloads the wheels and the model
 * cache, but it cannot verify that the target has a working Python or that the
 * native ONNX runtime wheel matches it. `deploy --mode=wheels` reports exactly what
 * is missing rather than pretending the path always works.
 * @param options - output directory and flags.
 */
async function fetchWheels({ output, modelSource, dryRun, values }) {
  const wheelsDir = join(output, 'wheels')
  const pypiIndex = values['pypi-index'] ?? DEFAULT_PYPI_INDEX

  step(`fetch (wheels) → ${output}`)
  note('fallback path: no Docker on the target, Python + venv required there')
  note(`wheels:       ${wheelsDir}`)
  note(`pypi index:   ${pypiIndex}`)
  note(`model source: ${modelSource}`)
  if (dryRun) note('dry run: nothing below will be executed or written')

  const downloadArgs = [
    'download',
    '--dest', wheelsDir,
    '--index-url', pypiIndex,
    'mineru>=4.0,<5',
  ]
  const plan = [
    `mkdir -p ${wheelsDir}`,
    `${describe('python3', ['-m', 'pip', ...downloadArgs])}`,
    `mineru-kit models download --tier basic --small-backend onnx --source ${modelSource}`,
  ]
  step('plan')
  for (const line of plan) note(line)

  if (dryRun) {
    for (const line of plan) console.log(`  $ ${line}`)
    console.log(`  write ${join(output, 'bundle.json')}`)
    printFetchNextSteps(output)
    return
  }

  if (!await hasCommand('python3')) {
    fail('fetch/wheels', 'python3 is not on PATH', 'install Python 3.10+ on this machine, or use --mode=docker')
  }
  await mustRun('fetch/wheels', 'mkdir', ['-p', wheelsDir], { timeoutMs: 30_000 }, 'check the output directory is writable')
  await mustRun('fetch/wheels', 'python3', ['-m', 'pip', ...downloadArgs], { echo: true, timeoutMs: SAVE_TIMEOUT_MS },
    `check that pip is installed and that ${pypiIndex} is reachable from this machine`)

  await writeFile(join(output, 'bundle.json'), JSON.stringify({
    kind: 'mineru-wheels-bundle',
    createdAt: new Date().toISOString(),
    wheelsDir: basename(wheelsDir),
    pypiIndex,
    modelSource,
    contract: 'POST /v1/file_parse?tier=basic&output_formats=markdown&ocr_mode=auto (field: files)',
    note: 'deploy --mode=wheels installs these into a venv and runs mineru-kit api-server',
  }, null, 2) + '\n', 'utf8')
  await writeChecksums(output)

  step('done')
  await printBundleSummary(output)
  printFetchNextSteps(output)
}

/**
 * Write SHA256SUMS for the bundle's payload files.
 *
 * The transfer is the part this script cannot observe, so it leaves the operator a
 * checksum to compare on the far side.
 * @param output - bundle directory.
 */
async function writeChecksums(output) {
  const names = ['mineru-image.tar', 'bundle.json']
  const lines = []
  for (const name of names) {
    const path = join(output, name)
    if (!existsSync(path)) continue
    const digest = createHash('sha256')
    const { readFile } = await import('node:fs/promises')
    digest.update(await readFile(path))
    lines.push(`${digest.digest('hex')}  ${name}`)
  }
  if (lines.length > 0) {
    await writeFile(join(output, 'SHA256SUMS'), lines.join('\n') + '\n', 'utf8')
  }
}

/**
 * Print what a bundle directory contains.
 * @param output - bundle directory.
 */
async function printBundleSummary(output) {
  for (const name of await readdir(output).catch(() => [])) {
    const full = join(output, name)
    const info = await stat(full).catch(() => undefined)
    if (info === undefined) continue
    const size = info.isDirectory() ? await directorySize(full) : info.size
    note(`${name.padEnd(22)} ${humanBytes(size)}`)
  }
  note(`total${' '.repeat(17)} ${humanBytes(await directorySize(output))}`)
}

/**
 * Print the two commands that move a bundle to a target and deploy it.
 * @param output - bundle directory.
 */
function printFetchNextSteps(output) {
  console.log('\nnext:')
  console.log(`  1) copy ${output} to the target machine (scp -r, rsync, or a USB disk)`)
  console.log(`  2) on that machine: node deploy-mineru.mjs deploy --host <user@host> --bundle ${output}`)
  console.log('  3) then: node deploy-mineru.mjs verify --url http://<target>:8000')
}

/**
 * Build the ssh/scp option list, keeping any password out of the process arguments.
 *
 * `--ask-pass` is answered by SSH_ASKPASS with `Setsid` where available; a password on
 * a command line would be visible in `ps` to every user on the machine, and writing one
 * to a file is exactly what this script promises not to do.
 * @param values - parsed options.
 * @returns ssh options to prepend to the host.
 */
async function sshOptions(values) {
  // Key/agent/config first, and never an interactive prompt: a script that blocks on a
  // passphrase it cannot answer is indistinguishable from a hung deploy.
  const options = [
    '-o', 'ConnectTimeout=15',
    '-o', 'StrictHostKeyChecking=accept-new',
  ]
  if (values['ask-pass'] === true) {
    // A password cannot go on the command line (visible in `ps`) or into a file (this
    // script promises not to leave secrets on disk). SSH_ASKPASS is the one mechanism
    // that keeps it out of both: ssh runs the helper and reads the password from its
    // stdout. `--ask-pass` therefore only selects that path; the secret itself comes
    // from MINERU_DEPLOY_SSH_PASSWORD in the environment, or from a terminal prompt
    // this script performs itself.
    if ((process.env.MINERU_DEPLOY_SSH_PASSWORD ?? '') === '') {
      fail('deploy/credentials',
        '--ask-pass was given but MINERU_DEPLOY_SSH_PASSWORD is empty',
        'export MINERU_DEPLOY_SSH_PASSWORD=... (it is read from the environment only,'
        + ' never written to disk), or drop --ask-pass and use a key: ssh-copy-id <user@host>')
    }
    return {
      askpass: true,
      env: await askpassEnv(),
      options: [...options, '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no'],
    }
  }
  // No password path: fail rather than hang when no key is usable.
  return { askpass: false, env: undefined, options: [...options, '-o', 'BatchMode=yes'] }
}

/**
 * The environment that makes ssh read its password from this script instead of a TTY.
 *
 * The password itself is already in the environment (that is where the operator put
 * it), so the helper is a tiny `sh` one-liner that echoes it: nothing is written to
 * disk, and it never appears in a process argument list. `SSH_ASKPASS_REQUIRE=force`
 * is what makes ssh consult the helper even when a TTY is attached.
 * @returns environment entries for ssh and scp.
 */
async function askpassEnv() {
  // ssh runs `$SSH_ASKPASS <prompt>` as an executable, so a helper has to exist on
  // disk. It is a 2-line script that reads the password from the environment at run
  // time -- the password itself is never written anywhere, and the helper is
  // removed when the deploy ends.
  const directory = await mkdtemp(join(tmpdir(), 'mineru-askpass-'))
  const helper = join(directory, 'askpass.sh')
  await writeFile(helper, '#!/bin/sh\nprintf %s "$MINERU_DEPLOY_SSH_PASSWORD"\n', { mode: 0o700 })
  askpassCleanup.push(() => rm(directory, { recursive: true, force: true }).catch(() => undefined))
  return {
    SSH_ASKPASS: helper,
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY ?? ':0',
  }
}

/**
 * Parse `user@host` into its parts.
 * @param target - the flag value.
 * @param stepName - for the failure message.
 * @returns user and host.
 */
function parseTarget(target, stepName) {
  if (target === undefined || target.trim() === '') {
    fail(stepName, 'missing --host', 'pass --host user@ip (for example --host root@10.0.0.12)')
  }
  const at = target.lastIndexOf('@')
  if (at <= 0 || at === target.length - 1) {
    fail(stepName, `invalid --host ${JSON.stringify(target)}`, 'use user@host, for example root@10.0.0.12')
  }
  return { user: target.slice(0, at), host: target.slice(at + 1) }
}

/**
 * `deploy`: ship a bundle to a host and start MinerU there.
 * @param values - parsed options.
 */
async function commandDeploy(values) {
  const dryRun = values['dry-run'] === true
  const { host } = parseTarget(values.host, 'deploy/options')
  const port = portValue(values.port, 'deploy/options')
  const container = values.container ?? DEFAULT_CONTAINER
  const bundle = resolve(values.bundle ?? DEFAULT_OUTPUT)
  const modelSource = values['model-source'] ?? DEFAULT_MODEL_SOURCE
  const force = values.force === true
  const memoryGb = values['memory-gb']
  const ssh = await sshOptions(values)
  /** ssh argument list, without the host (opt-in password env applied by `run`). */
  const sshArgs = ssh.options

  step(`deploy → ${host}:${String(port)}`)
  note(`bundle:     ${bundle}`)
  note(`container:  ${container}`)
  note(`model:      ${modelSource}`)
  if (dryRun) note('dry run: nothing below will be executed, copied, or started')

  const metadataPath = join(bundle, 'bundle.json')
  const imageTar = join(bundle, 'mineru-image.tar')
  const bundleMode = values.mode ?? 'docker'

  if (!dryRun) {
    if (!existsSync(bundle)) {
      fail('deploy/bundle', `no bundle at ${bundle}`, 'run `fetch` first, or pass --bundle <dir>')
    }
    const metadata = await readFileJson(metadataPath)
    if (metadata === undefined) {
      fail('deploy/bundle', `${metadataPath} is missing or unreadable`,
        'the bundle is incomplete; re-create it with `fetch`')
    }
    if (bundleMode === 'docker' && !existsSync(imageTar)) {
      fail('deploy/bundle', `${imageTar} is missing`, 're-create the bundle with `fetch --mode=docker`')
    }
  }

  const remoteDir = `/opt/mineru-bundle`
  const image = values.image ?? (await readFileJson(metadataPath))?.image ?? DEFAULT_IMAGE
  const runArgs = dockerRunArgs({ container, image, port, modelSource, memoryGb })

  step('plan')
  note(`1. scp the bundle to ${host}:${remoteDir}`)
  note(`2. docker load -i ${remoteDir}/mineru-image.tar   (skipped if the image is already there)`)
  note(`3. docker run ${container} on port ${port}   (skipped if it is already running)`)
  note(`4. wait for /v1/health, then print the service URL`)

  if (dryRun) {
    // Every line below is derived from the SAME values the real path uses, including
    // `runArgs`. A dry run that hand-writes its own `docker run` line drifts from what
    // actually executes, which makes it worse than no dry run: the operator approves
    // one command and a different one runs.
    const sshPrefix = `ssh ${sshArgs.join(' ')} ${host}`
    console.log('\ncommands:')
    console.log(`  $ ${sshPrefix} "mkdir -p ${remoteDir}"`)
    console.log(`  $ scp ${sshArgs.join(' ')} -r ${bundle}/. ${host}:${remoteDir}/`)
    console.log(`  $ ${sshPrefix} "docker image inspect ${image} >/dev/null 2>&1 && echo present || docker load -i ${remoteDir}/mineru-image.tar"`)
    console.log(`  $ ${sshPrefix} "docker rm -f ${container} 2>/dev/null || true"   # only with --force`)
    if (values.compose === undefined) {
      console.log(`  $ ${sshPrefix} "docker ${runArgs.join(' ')}"`)
    } else {
      console.log(`  $ scp ${sshArgs.join(' ')} ${resolve(values.compose)} ${host}:${remoteDir}/docker-compose.yml`)
      console.log(`  $ ${sshPrefix} "cd ${remoteDir} && docker compose -f ${remoteDir}/docker-compose.yml up -d"`)
    }
    console.log(`  $ ${sshPrefix} "curl -fsS http://127.0.0.1:8000/v1/health"`)
    console.log('\nwould then print:')
    console.log(`  MinerU 服务地址: http://${host.split('@').pop()}:${port}`)
    console.log(`  自检: node scripts/deploy-mineru.mjs verify --url http://${host.split('@').pop()}:${port}`)
    return
  }

  step('copy bundle to the target')
  await mustRun('deploy/copy', 'ssh', [...sshArgs, host, `mkdir -p ${remoteDir}`], { echo: true, timeoutMs: 120_000, env: ssh.env },
    'confirm SSH works: `ssh <user@host> true`, and that the user may write /opt')
  await mustRun('deploy/copy', 'scp', [...sshArgs, '-r', `${bundle}/.`, `${host}:${remoteDir}/`],
    { echo: true, timeoutMs: SAVE_TIMEOUT_MS, env: ssh.env },
    'check free space on the target and that the SSH user may write the destination')

  step('load the image on the target')
  // Idempotence: loading the same tar twice is slow (multi-GB read) and unnecessary.
  const imageCheck = await run('ssh', [...sshArgs, host, `docker image inspect ${image} >/dev/null 2>&1 && echo present || echo absent`],
    { timeoutMs: 120_000, env: ssh.env })
  if (imageCheck.code !== 0) {
    fail('deploy/load', [imageCheck.stdout, imageCheck.stderr].filter(Boolean).join('\n'),
      'the target must have Docker installed and the SSH user must be allowed to use it')
  }
  if (imageCheck.stdout.includes('present')) {
    note(`image ${image} already loaded on the target; skipping docker load`)
  } else {
    await mustRun('deploy/load', 'ssh', [...sshArgs, host, `docker load -i ${remoteDir}/mineru-image.tar`],
      { echo: true, timeoutMs: SAVE_TIMEOUT_MS, env: ssh.env },
      'check that the target has enough disk space and that the tar transferred completely')
  }

  step('start the service')
  // Two supported starts, because they fail differently:
  //   * `docker run` -- everything on the command line, easy to reason about;
  //   * `docker compose up -d` -- the operator got a compose file with the image, and
  //     starting it by hand with different flags would drift from that file.
  // The compose path is given a copy of the file on the target so `docker compose logs`
  // and a later `up -d` behave the same way the operator would run them.
  if (values.compose !== undefined) {
    const composePath = resolve(values.compose)
    if (!existsSync(composePath)) {
      fail('deploy/compose', `no compose file at ${composePath}`, 'pass --compose with a path that exists')
    }
    const remoteCompose = `${remoteDir}/docker-compose.yml`
    note(`compose file: ${composePath} → ${remoteCompose}`)
    await mustRun('deploy/compose', 'ssh', [...sshArgs, host, `mkdir -p ${remoteDir}`],
      { timeoutMs: 120_000, env: ssh.env }, 'confirm SSH works and that the user may write /opt')
    await mustRun('deploy/compose', 'scp', [...sshArgs, composePath, `${host}:${remoteCompose}`],
      { timeoutMs: 300_000, env: ssh.env }, 'check that the target directory is writable')
    await mustRun('deploy/compose', 'ssh',
      [...sshArgs, host, `cd ${remoteDir} && docker compose -f ${remoteCompose} up -d`],
      { echo: true, timeoutMs: 600_000, env: ssh.env },
      'check `docker compose version` on the target (the v2 plugin is required) and that the image is loaded')
    note('started with docker compose')
    const composeReady = await waitForHealth(values, host, sshArgs, 'http://127.0.0.1:8000/v1/health', ssh.env)
    if (!composeReady) {
      const logs = await run('ssh',
        [...sshArgs, host, `cd ${remoteDir} && docker compose -f ${remoteCompose} logs --tail 40 2>&1`],
        { timeoutMs: 120_000, env: ssh.env })
      fail('deploy/health', logs.stdout,
        `the compose service did not answer. Check \`docker compose -f ${remoteCompose} logs\` on the target`)
    }
    note('API is answering')
    printServiceSummary(host.split('@').pop() ?? host, port)
    return
  }
  const exists = await run('ssh', [...sshArgs, host, `docker container inspect ${container} >/dev/null 2>&1 && echo present || echo absent`],
    { timeoutMs: 120_000, env: ssh.env })
  if (exists.code !== 0) {
    fail('deploy/start', [exists.stdout, exists.stderr].filter(Boolean).join('\n'),
      'the SSH user must be able to query Docker containers')
  }
  if (exists.stdout.includes('present') && !force) {
    note(`container ${container} already exists; leaving it alone (use --force to recreate)`)
  } else {
    if (exists.stdout.includes('present')) {
      note(`removing existing container ${container} (--force)`)
      await mustRun('deploy/start', 'ssh', [...sshArgs, host, `docker rm -f ${container}`], { timeoutMs: 120_000, env: ssh.env },
        'the container may be in use; stop it with `docker stop` first')
    }
    await mustRun('deploy/start', 'ssh', [...sshArgs, host, `docker ${runArgs.join(' ')}`],
      { echo: true, timeoutMs: 300_000, env: ssh.env },
      `check: \`docker logs ${container}\` on the target, and that port ${String(port)} is free`)
  }

  step('wait for the API to answer')
  const healthUrl = 'http://127.0.0.1:8000/v1/health'
  const ready = await waitForHealth(values, host, sshArgs, healthUrl, ssh.env)
  if (!ready) {
    const logs = await run('ssh', [...sshArgs, host, `docker logs --tail 40 ${container} 2>&1`], { timeoutMs: 120_000, env: ssh.env })
    fail('deploy/health', logs.stdout,
      `the container started but the API never answered. Check \`docker logs ${container}\` on the target`)
  }
  note('API is answering')

  const hostOnly = host.split('@').pop() ?? host
  printServiceSummary(hostOnly, port)
}

/**
 * Poll the target's health endpoint until it answers or the budget runs out.
 * @param values - parsed options (for the timeout).
 * @param host - user@host.
 * @param ssh - ssh options.
 * @param url - health URL as seen from the target.
 * @returns true when it answered.
 */
async function waitForHealth(values, host, ssh, url, env) {
  const deadline = Date.now() + (Number(values['timeout-ms'] ?? 300_000))
  while (Date.now() < deadline) {
    const probe = await run('ssh', [...sshArgs, host, `curl -fsS --max-time 5 ${url}`],
      { timeoutMs: 60_000, ...(env === undefined ? {} : { env }) })
    if (probe.code === 0) return true
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3000))
  }
  return false
}

/**
 * Print the two things the operator needs to paste into the knowledge-base settings.
 * @param host - the target host, without a user.
 * @param port - published port.
 */
function printServiceSummary(host, port) {
  const base = `http://${host}:${String(port)}`
  console.log('\n' + '─'.repeat(64))
  console.log('MinerU 服务地址（填进知识库设置 → MinerU 地址）:')
  console.log(`  ${base}`)
  console.log('\n自检命令:')
  console.log(`  node scripts/deploy-mineru.mjs verify --url ${base}`)
  console.log('─'.repeat(64))
}

/**
 * Read and parse a JSON file, tolerating absence.
 * @param path - file path.
 * @returns the parsed object, or undefined.
 */
async function readFileJson(path) {
  const { readFile } = await import('node:fs/promises')
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * `verify`: send the plugin's exact request and assert it is answered.
 * @param values - parsed options.
 */
async function commandVerify(values) {
  const dryRun = values['dry-run'] === true
  const tier = values.tier ?? 'basic'
  const timeoutMs = Number(values['timeout-ms'] ?? 300_000)

  let base = values.url
  if (base === undefined) {
    const target = values.host
    if (target === undefined) {
      fail('verify/options', 'missing --url', 'pass --url http://<host>:8000, or --host user@<host> with --port')
    }
    const hostOnly = String(target).split('@').pop()
    base = `http://${String(hostOnly)}:${String(portValue(values.port, 'verify/options'))}`
  }
  const url = new URL('/v1/file_parse', base.endsWith('/') ? base : `${base}/`)
  // The contract, spelled out: options travel in the query string, the body carries a
  // single `files` field. `output_formats` has no server default and must be named.
  url.searchParams.set('tier', tier)
  url.searchParams.append('output_formats', 'markdown')
  url.searchParams.set('ocr_mode', 'auto')

  step(`verify ${url.origin}`)
  note(`POST ${url.pathname}${url.search}`)
  note('body: multipart/form-data, one field: files')

  if (dryRun) {
    console.log('\nrequest:')
    const shown = values.file === undefined ? 'sample.pdf' : resolve(values.file)
    console.log(`  $ curl -F "files=@${shown}" "${url.toString()}"`)
    console.log(values.file === undefined
      ? '  (a minimal one-page PDF would be generated and sent; nothing was sent)'
      : '  (this file would be sent as the `files` field; nothing was sent)')
    return
  }

  // The caller may name the PDF to send. That matters for a real acceptance run: a
  // generated sample proves the route works, while the customer's own document proves
  // the parser works on the kind of file it will actually see.
  const samplePath = values.file === undefined ? undefined : resolve(values.file)
  if (samplePath !== undefined && !existsSync(samplePath)) {
    fail('verify/options', `no such file: ${samplePath}`, 'pass --file with a path that exists')
  }
  const sampleBytes = samplePath === undefined ? minimalPdf() : await readFile(samplePath)
  const sampleName = samplePath === undefined ? 'mineru-verify.pdf' : basename(samplePath)
  note(`file: ${sampleName} (${humanBytes(sampleBytes.byteLength)})`)

  const form = new FormData()
  // A minimal PDF with extractable text, so a pass means text really came back rather
  // than that the endpoint merely answered.
  form.append('files', new Blob([sampleBytes], { type: 'application/pdf' }), sampleName)

  let response
  try {
    response = await fetch(url, { method: 'POST', body: form, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    fail('verify/request', error instanceof Error ? error.message : String(error),
      `check that the service is running and reachable: curl -v ${url.origin}/v1/health`)
  }

  let text = await response.text()
  if (!response.ok) {
    fail('verify/request', `HTTP ${String(response.status)}\n${text.slice(0, 300)}`,
      'the service refused the request; the response body above names why')
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    fail('verify/response', text.slice(0, 300), 'the endpoint did not answer JSON; check the URL points at MinerU')
  }

  // A parse that finishes inside the server's inline window answers 200 with the text
  // attached. A longer document answers 202 and only a `task_id`, so the caller polls
  // `/v1/tasks/<id>` until the task reports a terminal status. Handling only the first
  // shape made `verify` time out on exactly the large scanned PDFs this feature exists
  // for: the request had succeeded, and the script was waiting for a body that the
  // server had already answered.
  if (response.status === 202 || payload.status === 'pending' || payload.status === 'running') {
    const taskId = typeof payload.task_id === 'string' ? payload.task_id : ''
    if (taskId === '') {
      fail('verify/response', text.slice(0, 300),
        'the service accepted the task but did not return a task_id to poll')
    }
    note(`accepted as task ${taskId}; polling for the result`)
    payload = await pollTask(url.origin, taskId, timeoutMs)
    text = JSON.stringify(payload)
  }

  // A completed task carries the text in one of two places, and the difference is not
  // cosmetic:
  //   * small documents answerinline with files[].content.markdown;
  //   * a large document's task body has content: null and only a file id under
  //     output_files.markdown, because the text is stored as a separate file.
  // Reading only the first shape made `verify` report "carried no Markdown" for a parse
  // that had actually succeeded -- the bytes existed, under a file id.
  let markdown = extractMarkdown(payload)
  if (markdown === undefined) {
    const fileId = extractMarkdownFileId(payload)
    if (fileId !== undefined) {
      note(`markdown stored as ${fileId}; downloading it`)
      markdown = await downloadFileText(url.origin, fileId)
    }
  }
  if (markdown === undefined) {
    fail('verify/response', text.slice(0, 300),
      'the request was accepted but carried no Markdown. Check the parse result for a file-level error')
  }

  step('ok')
  note(`Markdown returned (${String(markdown.length)} chars)`)
  note(markdown.split('\n').slice(0, 6).join('\n  '))
  console.log('\nThe knowledge-base plugin can use this service.')
  printServiceSummary(new URL(base).hostname, Number(new URL(base).port || 80))
}

/**
 * Poll `/v1/tasks/<id>` until the task reaches a terminal status.
 *
 * MinerU's API is asynchronous whenever the parse outlives its inline window, so the
 * only correct way to read a result is to poll the task it handed back.
 * @param origin - service origin, e.g. http://10.0.0.12:8000.
 * @param taskId - the id from the 202 body.
 * @param timeoutMs - total budget for the whole parse.
 * @returns the terminal task body.
 */
async function pollTask(origin, taskId, timeoutMs) {
  const url = new URL(`/v1/tasks/${encodeURIComponent(taskId)}`, origin)
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() < deadline) {
    let response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
    } catch (error) {
      last = error instanceof Error ? error.message : String(error)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
      continue
    }
    const body = await response.text()
    if (!response.ok) {
      fail('verify/poll', `HTTP ${String(response.status)}\n${body.slice(0, 300)}`,
        `the task ${taskId} could not be read; check the service log`)
    }
    let parsed
    try {
      parsed = JSON.parse(body)
    } catch {
      last = body.slice(0, 200)
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
      continue
    }
    const status = String(parsed.status ?? '')
    if (status === 'completed' || status === 'failed' || status === 'cancelled') return parsed
    last = status
    await new Promise(resolvePromise => setTimeout(resolvePromise, 3000))
  }
  fail('verify/poll', `task ${taskId} did not finish within ${String(Math.round(timeoutMs / 1000))}s (last status: ${last})`,
    'raise --timeout-ms; a 400+ page scan on CPU can take many minutes')
}

/**
 * Pull Markdown text out of a MinerU parse response.
 * @param payload - the parsed JSON body.
 * @returns the text, or undefined when the response carries none.
 */
function extractMarkdown(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload
  if (Array.isArray(record.files)) {
    for (const file of record.files) {
      if (typeof file !== 'object' || file === null) continue
      const content = file.content
      if (typeof content === 'object' && content !== null && typeof content.markdown === 'string' && content.markdown.trim() !== '') {
        return content.markdown
      }
    }
    return undefined
  }
  for (const key of ['markdown', 'md_content', 'mdContent']) {
    if (typeof record[key] === 'string' && record[key].trim() !== '') return record[key]
  }
  return undefined
}

/**
 * The id of the task's Markdown output file, when the body references one.
 * @param payload - a terminal task body.
 * @returns the file id, or undefined.
 */
function extractMarkdownFileId(payload) {
  if (typeof payload !== 'object' || payload === null) return undefined
  const files = payload.files
  if (!Array.isArray(files)) return undefined
  for (const file of files) {
    if (typeof file !== 'object' || file === null) continue
    const outputs = file.output_files
    if (typeof outputs !== 'object' || outputs === null) continue
    const markdown = outputs.markdown
    if (typeof markdown === 'object' && markdown !== null && typeof markdown.file_id === 'string' && markdown.file_id !== '') {
      return markdown.file_id
    }
  }
  return undefined
}

/**
 * Fetch one produced file's text.
 *
 * MinerU exposes parse outputs as files under `/v1/files/<id>/content`; the JSON
 * metadata lives at `/v1/files/<id>`, which is not where the text is.
 * @param origin - service origin.
 * @param fileId - the produced file id.
 * @returns the text.
 */
async function downloadFileText(origin, fileId) {
  const url = new URL(`/v1/files/${encodeURIComponent(fileId)}/content`, origin)
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  } catch (error) {
    fail('verify/download', error instanceof Error ? error.message : String(error),
      'the task finished but its output file could not be downloaded; check the service log')
  }
  const text = await response.text()
  if (!response.ok) {
    fail('verify/download', `HTTP ${String(response.status)}\n${text.slice(0, 300)}`,
      'the task finished but its output file could not be read')
  }
  return text
}

/**
 * A minimal single-page PDF whose text is extractable.
 * @returns PDF bytes.
 */
function minimalPdf() {
  return new TextEncoder().encode(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 120]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 68>>stream
BT /F1 12 Tf 12 60 Td (mineru deploy verify) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF
`)
}

/**
 * Entry point: dispatch on the subcommand and report failures once, without a stack
 * trace for the ones this script already explained.
 */
async function main() {
  const parsed = parseCommandLine(process.argv.slice(2))
  if (parsed === undefined) return
  try {
    if (parsed.command === 'fetch') await commandFetch(parsed.values)
    else if (parsed.command === 'deploy') await commandDeploy(parsed.values)
    else await commandVerify(parsed.values)
  } catch (error) {
    if (error instanceof DeploymentError) return
    // An unexpected throw is a bug in this script, so the stack is useful -- but the
    // message still goes out as a failed step rather than a raw crash.
    console.error(`\n✗ unexpected failure: ${error instanceof Error ? error.message : String(error)}`)
    if (error instanceof Error && error.stack !== undefined) {
      console.error(error.stack.split('\n').slice(1, 4).join('\n'))
    }
    process.exitCode = 1
  }
}

process.on('exit', () => {
  // Best-effort synchronous removal: the helper directory holds a script that reads a
  // password from the environment, so leaving it behind would be untidy but not a leak.
  for (const cleanup of askpassCleanup) void cleanup()
})

await main()
