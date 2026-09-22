import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The optional capabilities a Plus installation can enable, and the interview that
 * decides which ones to set up.
 *
 * A standalone installation works without any of them: the agent runs, the shell
 * runs, and files are read and written. Each entry here adds a capability whose
 * backing service lives outside npm — a search provider that needs a key, a PDF
 * parser that needs a local server, an Office toolchain that needs a runtime — so
 * the choice is offered once, at install time, rather than left to a user who has
 * no way to know what the deployment is missing.
 *
 * Every capability is selected by default. A user who wants the plain harness
 * deselects them; a user who accepts the defaults ends up with a deployment whose
 * features work, which is the state the interactive question exists to reach.
 *
 * Enabling a capability has to mean the feature works, so each entry carries both
 * halves of that: the profile row that mounts it and the service it needs. A
 * capability that only asked a question and then dropped the answer would report
 * success while the deployment stayed exactly as it was.
 *
 * @module @sparkelf/dsh-plus/standalone-capabilities
 */

/** One optional capability a deployment can enable. */
export interface Capability {
  /** Stable key used on the command line and in the profile. */
  readonly id: string
  /** One-line name shown in the interview. */
  readonly title: string
  /** What the deployment gains, shown beside the name. */
  readonly detail: string
  /** Whether the backing service needs an address the user must supply. */
  readonly needsEndpoint: boolean
}

/** Capabilities offered at install time, in interview order. */
export const CAPABILITIES: readonly Capability[] = [
  {
    id: 'exa',
    title: 'Web search (Exa)',
    detail: 'Search the web through Exa instead of the built-in provider; needs an API key',
    needsEndpoint: false,
  },
  {
    id: 'mineru',
    title: 'PDF parsing (MinerU)',
    detail: 'Parse uploaded PDFs locally; the service is installed and started here',
    needsEndpoint: true,
  },
  {
    id: 'officecli',
    title: 'Office documents (OfficeCLI)',
    detail: 'Create and open DOCX, XLSX, and PPTX deliverables',
    needsEndpoint: false,
  },
  {
    id: 'computer-use',
    title: 'Windows desktop control (computer-use)',
    detail: 'Drive the Windows desktop from WSL through the cua driver',
    needsEndpoint: false,
  },
]

/** The answers one interview produced. */
export interface CapabilityAnswers {
  /** Capability ids the user kept selected. */
  readonly enabled: readonly string[]
  /** Exa API key when web search was enabled and the user supplied one. */
  readonly exaApiKey?: string
  /** MinerU endpoint to write; defaults to the local service this command starts. */
  readonly mineruEndpoint?: string
}

/** Where this command starts MinerU when the capability is enabled. */
export const DEFAULT_MINERU_ENDPOINT = 'http://127.0.0.1:8000/file_parse'

/** File under the deployment home recording which capabilities were enabled. */
export const CAPABILITY_RECORD = 'capabilities.json'

/** Deployment env file the launcher reads as its `user-env` layer. */
export const CAPABILITY_ENV_FILE = '.env'

/** Comment that identifies a profile layer this interview wrote. */
export const CAPABILITY_MARKER = 'Written by dsh-plus start from the capability interview.'

/** One prompt on the terminal, resolving the trimmed line the user typed. */
function ask(question: string): Promise<string> {
  return new Promise((resolveAnswer) => {
    process.stdout.write(question)
    process.stdin.once('data', (chunk: Buffer | string) => {
      resolveAnswer(String(chunk).trim())
    })
  })
}

/** Ask one yes/no question, defaulting to yes. */
async function confirmDefaultYes(question: string): Promise<boolean> {
  const answer = (await ask(question + ' [Y/n] ')).toLowerCase()
  return answer === '' || answer === 'y' || answer === 'yes'
}

/**
 * Interview the user about the optional capabilities.
 *
 * Each is offered on its own line and defaults to enabled, so pressing Enter
 * through the interview produces a deployment whose features work. The answers are
 * returned rather than applied, so a caller can report what it will do before it
 * touches the profile.
 *
 * @param interactive - when false, every capability is enabled without asking.
 * @returns the ids to enable and the values the enabled ones need.
 */
export async function interviewCapabilities(interactive: boolean): Promise<CapabilityAnswers> {
  if (!interactive) return { enabled: CAPABILITIES.map(capability => capability.id) }

  console.log('')
  console.log('Optional capabilities. Press Enter to accept the default (all enabled),')
  console.log('or answer n for any you do not want.')
  console.log('')

  const enabled: string[] = []
  for (const capability of CAPABILITIES) {
    if (await confirmDefaultYes('  Enable ' + capability.title + '? (' + capability.detail + ')')) {
      enabled.push(capability.id)
    }
  }

  let exaApiKey: string | undefined
  if (enabled.includes('exa')) {
    console.log('')
    console.log('  Exa needs an API key. Create one at https://dashboard.exa.ai/api-keys')
    const typed = await ask('  Exa API key (leave empty to add it later): ')
    if (typed !== '') exaApiKey = typed
  }

  let mineruEndpoint: string | undefined
  if (enabled.includes('mineru')) {
    // The service is installed and started by this command on the local port, so the
    // default is the address it will answer on; a user running MinerU elsewhere
    // overrides it here rather than editing the profile afterwards.
    const typed = await ask('  MinerU endpoint [' + DEFAULT_MINERU_ENDPOINT + ']: ')
    mineruEndpoint = typed === '' ? DEFAULT_MINERU_ENDPOINT : typed
  }

  return {
    enabled,
    ...exaApiKey === undefined ? {} : { exaApiKey },
    ...mineruEndpoint === undefined ? {} : { mineruEndpoint },
  }
}

/** Names this module owns in the deployment env file. */
const CAPABILITY_ENV_NAMES: readonly string[] = ['DSH_MINERU_ENDPOINT', 'EXA_API_KEY']

/**
 * The deployment env file, with one assignment per enabled capability that reaches
 * its service through the launch environment.
 *
 * MinerU is switched on by the presence of its endpoint and Exa reads its key from
 * the launch environment, so a capability the user selected is enabled here as well
 * as in the profile layer. Only the names this interview owns are rewritten: a
 * deployment that keeps its own assignments in the same file keeps them, and
 * deselecting a capability removes the assignment that turned it on.
 *
 * @param answers - the interview's answers.
 * @param existing - the file's current text, when it already exists.
 * @returns the environment file's text.
 */
export function capabilityEnvironment(answers: CapabilityAnswers, existing = ''): string {
  const enabled = new Set(answers.enabled)
  const owned = new Set(CAPABILITY_ENV_NAMES)
  const kept = existing.split('\n').filter((line) => {
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    return line.trim() !== '' && !line.trimStart().startsWith('#') && (name === undefined || !owned.has(name))
  })
  const written: string[] = [
    '# Written by dsh-plus start from the capability interview. Enabling or',
    '# disabling a capability rewrites the lines below; other lines are kept.',
  ]
  if (enabled.has('mineru')) {
    written.push('DSH_MINERU_ENDPOINT=' + (answers.mineruEndpoint ?? DEFAULT_MINERU_ENDPOINT))
  }
  if (enabled.has('exa') && answers.exaApiKey !== undefined) {
    written.push('EXA_API_KEY=' + answers.exaApiKey)
  }
  return [...written, ...kept].join('\n') + '\n'
}

/**
 * The profile patch layer that turns the selected capabilities on.
 *
 * The file is data the profile's loader merges, so enabling a capability writes a
 * row rather than editing the deployment. An empty selection still writes the file,
 * because a layer that exists and mounts nothing is how a previously enabled
 * capability is turned back off.
 *
 * The profile's own layer is a separate file with its own name: a deployment that
 * configured something by hand keeps it, and the capability rows are rewritten
 * whole on every start.
 *
 * @param answers - the interview's answers.
 * @returns the patch layer's YAML text.
 */
export function capabilityPatchLayer(answers: CapabilityAnswers): string {
  const enabled = new Set(answers.enabled)
  const rows: string[] = []

  if (enabled.has('exa')) {
    rows.push(
      '    - id: web-search-exa',
      "      name: '@deepseek-ai/dsh-web-search-exa'",
      '      config:',
      '        searchType: auto',
      '        numResults: 8',
    )
  }
  if (enabled.has('computer-use')) {
    rows.push(
      '    - id: computer-use',
      "      name: '@deepseek-ai/dsh-computer-use'",
      '    - id: computer-use-cua-driver-mcp',
      "      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'",
    )
  }

  const lines = [
    '# ' + CAPABILITY_MARKER + ' Enabling or disabling a capability',
    '# rewrites this file; edits here are replaced.',
  ]
  // The loader requires a top-level YAML array, so a selection that mounts nothing
  // still has to produce one. Comments alone parse as `null`, and the profile then
  // refuses to boot with "must be a top-level YAML array of loader patch entries" —
  // which is the whole deployment, not just the missing capability.
  if (rows.length > 0) {
    lines.push('- insert:', ...rows)
  } else {
    lines.push('[]')
  }
  if (enabled.has('exa')) {
    lines.push(
      '',
      '# Route web_search through Exa rather than the built-in provider.',
      '- id: web',
      '  config:',
      '    searchProvider: exa',
    )
  }
  return lines.join('\n') + '\n'
}

/** Run one command, reporting a failure rather than throwing. */
function runStep(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, [...args], { stdio: 'inherit' })
  return result.status === 0
}

/**
 * Install and start the backing services the selected capabilities need.
 *
 * Enabling a capability means the deployment expects its service to answer, so the
 * command that offers the choice is also the command that provides it. Each step
 * reports what it is doing and, on failure, the command a user can run by hand —
 * a missing runtime is a fact about the host, not a reason to abandon the install.
 *
 * @param answers - the interview's answers.
 * @param home - the deployment home, where generated service units are recorded.
 * @returns the ids whose service is ready.
 */
export async function installCapabilityServices(
  answers: CapabilityAnswers,
  home: string,
): Promise<readonly string[]> {
  const enabled = new Set(answers.enabled)
  const ready: string[] = []
  // The record lets a later run name the capabilities this deployment enabled
  // instead of interviewing again, and gives doctor something to check against.
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, CAPABILITY_RECORD), JSON.stringify({
    enabled: [...answers.enabled],
    ...answers.mineruEndpoint === undefined ? {} : { mineruEndpoint: answers.mineruEndpoint },
  }, null, 2) + '\n')

  if (enabled.has('mineru')) {
    console.log('')
    console.log('  MinerU: installing the parser and starting its service...')
    const installed = installMineru(home)
    if (installed && startMineru(home)) {
      ready.push('mineru')
      console.log('  MinerU: ready at ' + (answers.mineruEndpoint ?? DEFAULT_MINERU_ENDPOINT))
    } else {
      console.log('  MinerU: not installed. Install it later with:')
      console.log('    pip install -U "mineru[core]"')
      console.log('    mineru-api --host 127.0.0.1 --port 8000')
    }
  }

  if (enabled.has('officecli')) {
    // OfficeCLI ships inside the mounted bundle and carries its own binary, so the
    // capability needs no host step; the profile row is what turns it on.
    ready.push('officecli')
  }

  if (enabled.has('computer-use')) {
    if (desktopDriverAvailable()) {
      ready.push('computer-use')
    } else {
      console.log('')
      console.log('  computer-use: the cua driver was not found on PATH. The plugin is')
      console.log('  still mounted, so it starts once the driver is installed:')
      console.log('    install the cua-driver release for this architecture, then restart')
    }
  }

  return ready
}

/**
 * Install MinerU when it is absent and start its API service.
 *
 * MinerU is a Python package whose API server answers on a local port; the profile
 * points at that port. The parser is installed into a virtual environment under the
 * deployment home and an existing one is upgraded rather than skipped, so enabling
 * the capability keeps the parser current without touching the system interpreter.
 *
 * @param home - the deployment home that owns the venv.
 * @returns whether the package is installed; not whether it answered.
 */
function installMineru(home: string): boolean {
  const python = pythonInterpreter()
  if (python === undefined) {
    console.log('  MinerU: no Python interpreter found on PATH.')
    return false
  }
  // The venv keeps MinerU's torch and model dependencies away from the system
  // interpreter, which is also what PEP 668 requires: a system pip refuses the install
  // outright, and `--break-system-packages` would put a multi-gigabyte torch tree into
  // the OS packages. `all` is the extra both the 3.x and 4.x lines publish; `core`
  // existed only through 3.x and installing it on 4.x silently drops the extras.
  const venv = join(home, '.mineru-venv')
  if (!runStep(python, ['-m', 'venv', venv])) return false
  const venvPython = join(venv, 'bin', 'python')
  return runStep(venvPython, ['-m', 'pip', 'install', '-U', 'mineru[all]'])
}

/**
 * Start the MinerU API server as a background service when none answers yet.
 *
 * The service has to outlive the install command, so it is registered with the
 * host's service manager when one is available and otherwise started detached.
 *
 * @returns whether the server is running after this call.
 */
function startMineru(home: string): boolean {
  const api = mineruApiBinary(home)
  if (api === undefined) return false
  if (mineruAnswers()) return true
  if (spawnSync('systemctl', ['--version'], { stdio: 'ignore' }).status === 0) {
    writeFileSync('/etc/systemd/system/mineru-api.service', [
      '[Unit]',
      'Description=MinerU document parsing API for DeepSeek Harness Plus',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      'User=root',
      'ExecStart=' + api + ' --host 127.0.0.1 --port 8000',
      'Restart=on-failure',
      'RestartSec=2',
      'TimeoutStopSec=15',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n'))
    spawnSync('systemctl', ['daemon-reload'], { stdio: 'ignore' })
    return spawnSync('systemctl', ['enable', '--now', 'mineru-api.service'], { stdio: 'ignore' }).status === 0
  }
  console.log('  MinerU: start the API server with:')
  console.log('    ' + api + ' --host 127.0.0.1 --port 8000')
  return false
}

/** The Python interpreter to install MinerU with, preferring python3. */
function pythonInterpreter(): string | undefined {
  return ['python3', 'python'].find(candidate => spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0)
}

/**
 * The MinerU API entry point, wherever the install placed it.
 *
 * The venv this command creates comes first: it is the interpreter the parser was
 * installed into, so its `mineru-api` is the one that can import MinerU. A binary on
 * PATH is a fallback for a deployment that installed MinerU some other way.
 *
 * @param home - the deployment home that owns the venv.
 * @returns the command to run, or `undefined` when none answers.
 */
function mineruApiBinary(home: string): string | undefined {
  const candidates = [join(home, '.mineru-venv', 'bin', 'mineru-api'), 'mineru-api']
  return candidates.find(candidate => spawnSync(candidate, ['--help'], { stdio: 'ignore' }).status === 0)
}

/** Whether a MinerU API server already answers on the default port. */
function mineruAnswers(): boolean {
  const probe = spawnSync('curl', ['-sf', '-o', '/dev/null', '--max-time', '3', 'http://127.0.0.1:8000/docs'], { stdio: 'ignore' })
  return probe.status === 0
}

/** Whether the Windows-side desktop driver answers from this shell. */
function desktopDriverAvailable(): boolean {
  const probe = spawnSync('cua-driver', ['--version'], { stdio: 'ignore' })
  return probe.status === 0
}
