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

/** Where this command starts MinerU when the capability is enabled. */
export const DEFAULT_MINERU_ENDPOINT = 'http://127.0.0.1:8000/file_parse'

/** File under the deployment home recording which capabilities were enabled. */
export const CAPABILITY_RECORD = 'capabilities.json'

/**
 * The profile patch layer that turns the selected capabilities on.
 *
 * The file is data the profile's loader merges, so enabling a capability writes a
 * row rather than editing the deployment. An empty selection still writes the file,
 * because a layer that exists and mounts nothing is how a previously enabled
 * capability is turned back off.
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

  const lines = [
    '# Written by dsh-plus start from the capability interview. Enabling or',
    '# disabling a capability rewrites this file; edits here are replaced.',
  ]
  if (rows.length > 0) lines.push('- insert:', ...rows)
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
    const installed = installMineru()
    if (installed) {
      ready.push('mineru')
      console.log('  MinerU: ready at ' + (answers.mineruEndpoint ?? DEFAULT_MINERU_ENDPOINT))
    } else {
      console.log('  MinerU: not installed. Install it later with:')
      console.log('    pip install -U "mineru[core]"')
      console.log('    mineru-api --host 127.0.0.1 --port 8000')
    }
  }

  if (enabled.has('officecli')) {
    // OfficeCLI ships as a profile dependency, so enabling the capability installs it
    // through the profile rather than a host-level tool. It is reported as ready once
    // the profile install has run; see writeCapabilityPatch for the dependency.
    ready.push('officecli')
  }

  if (enabled.has('computer-use')) {
    const readyNow = desktopDriverAvailable()
    if (readyNow) {
      ready.push('computer-use')
    } else {
      console.log('')
      console.log('  computer-use: the cua driver was not found on the Windows side.')
      console.log('  Install it from Windows, then run dsh-plus start again:')
      console.log('    the cua-driver release for this architecture, on the Windows host')
    }
  }

  return ready
}

/**
 * Install MinerU when it is absent and start its API service.
 *
 * MinerU is a Python package whose API server answers on a local port; the profile
 * points at that port. An existing installation is upgraded rather than skipped, so
 * enabling the capability keeps the parser current.
 *
 * @returns whether the service is installed; not whether it answered.
 */
function installMineru(): boolean {
  const python = ['python3', 'python'].find((candidate) => {
    const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' })
    return probe.status === 0
  })
  if (python === undefined) {
    console.log('  MinerU: no Python interpreter found on PATH.')
    return false
  }
  // Prefer a user install: it needs no elevated shell, and MinerU brings its own
  // model files. A system interpreter under PEP 668 refuses a plain install, which
  // the fallback covers.
  if (!runStep(python, ['-m', 'pip', 'install', '--user', '-U', 'mineru[core]'])) {
    if (!runStep(python, ['-m', 'pip', 'install', '--break-system-packages', '-U', 'mineru[core]'])) {
      return false
    }
  }
  return true
}

/** Whether the Windows-side desktop driver answers from this shell. */
function desktopDriverAvailable(): boolean {
  const probe = spawnSync('cua-driver', ['--version'], { stdio: 'ignore' })
  return probe.status === 0
}
