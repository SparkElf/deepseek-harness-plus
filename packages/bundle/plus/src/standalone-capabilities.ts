import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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

/**
 * Names this module owns in the deployment env file.
 *
 * Only names the loader accepts here: a `DSH_`-prefixed variable is refused in any `.env` because
 * `DSH_HOME` is itself bootstrap-only and the file could otherwise relocate the home it is read
 * from. MinerU's endpoint therefore travels in the profile layer, which is also where the plugin
 * reads it.
 */
const CAPABILITY_ENV_NAMES: readonly string[] = ['EXA_API_KEY']

/**
 * The deployment env file, with one assignment per enabled capability that reaches
 * its service through the launch environment.
 *
 * Exa reads its key from the launch environment, so a capability the user selected is enabled here
 * as well as in the profile layer. Only the names this interview owns are rewritten: a
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
  // Values the file already carries for the names this module owns. Re-running a
  // configured start must not delete a credential the deployment already holds: the
  // interview returns no key when the user says they will add it later, and enabling an
  // unrelated capability still rewrites this whole file. Reading the present value back
  // is what keeps `start` from undoing an earlier answer.
  const carried = new Map<string, string>()
  for (const line of existing.split('\n')) {
    const parsed = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line)
    if (parsed?.[1] !== undefined && owned.has(parsed[1])) carried.set(parsed[1], parsed[2] ?? '')
  }
  const kept = existing.split('\n').filter((line) => {
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    return line.trim() !== '' && !line.trimStart().startsWith('#') && (name === undefined || !owned.has(name))
  })
  const written: string[] = [
    '# Written by dsh-plus start from the capability interview. Enabling or',
    '# disabling a capability rewrites the lines below; other lines are kept.',
  ]
  if (enabled.has('exa')) {
    const key = answers.exaApiKey ?? carried.get('EXA_API_KEY')
    if (key !== undefined && key !== '') written.push('EXA_API_KEY=' + key)
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
  if (enabled.has('officecli')) {
    // The plugin ships inside the mounted bundle and carries its own binary, so the
    // capability needs no host step — but a selection that writes no row mounts nothing,
    // and the capability then reports as ready while the tools stay absent. The row id
    // and package match the plugin's own bundle layer.
    rows.push(
      '    - id: officecli',
      "      name: '@sparkelf/dsh-officecli'",
    )
  }
  // MinerU reads its endpoint from plugin config, not from the environment, and a name prefixed
  // `DSH_` is refused in any .env file because `DSH_HOME` is itself bootstrap-only — the file could
  // otherwise relocate the home it is read from. Writing the endpoint as a profile row is both the
  // plugin's own contract and the only place the loader accepts it.
  if (enabled.has('mineru')) {
    rows.push(
      '    - id: mineru',
      "      name: '@sparkelf/dsh-mineru'",
      '      config:',
      '        endpoint: ' + (answers.mineruEndpoint ?? DEFAULT_MINERU_ENDPOINT),
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
 * The capability record a previous configured run wrote, or `undefined` when none exists.
 *
 * The record is what lets a later run report the deployment's answers instead of asking
 * again. A malformed or unreadable file is treated as absent rather than fatal: it is a
 * convenience cache, and refusing to boot over it would strand a deployment whose record
 * was corrupted by an interrupted write.
 *
 * @param home - the deployment home holding the record.
 * @returns the enabled ids, and the MinerU endpoint when the record carries one.
 */
export function readCapabilityRecord(home: string): CapabilityAnswers | undefined {
  const path = join(home, CAPABILITY_RECORD)
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Absent and unreadable are the same answer here: the caller falls back to the
    // profile and env files, which are the authoritative state a record only mirrors.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { enabled?: unknown; mineruEndpoint?: unknown }
  if (!Array.isArray(record.enabled)) return undefined
  const enabled = record.enabled.filter((id): id is string => typeof id === 'string')
  return {
    enabled,
    ...typeof record.mineruEndpoint === 'string' ? { mineruEndpoint: record.mineruEndpoint } : {},
  }
}

/**
 * The capabilities a deployment actually has mounted, read from the files the loader and
 * the launch environment consume.
 *
 * A record is a cache of an earlier answer and can drift from the deployment — a profile
 * layer edited by hand, a record deleted, a plugin removed from the distribution. What a
 * capability is *doing* is decided by the profile patch rows and the env file, so that is
 * what a report reads.
 *
 * @param profilePatchText - the profile layer's YAML text.
 * @param envText - the deployment env file's text.
 * @returns the ids found in the profile layer and the env names present.
 */
export function detectEnabledCapabilities(
  profilePatchText: string,
  envText: string,
): { readonly mounted: readonly string[]; readonly env: readonly string[] } {
  const mounted: string[] = []
  // Matching the row id is what the loader does; matching a bare package name would also
  // hit a comment or a name mentioned in an unrelated row's config.
  if (/^\s*- id: web-search-exa\s*$/mu.test(profilePatchText)) mounted.push('exa')
  if (/^\s*- id: mineru\s*$/mu.test(profilePatchText)) mounted.push('mineru')
  if (/^\s*- id: officecli\s*$/mu.test(profilePatchText)) mounted.push('officecli')
  if (/^\s*- id: computer-use\s*$/mu.test(profilePatchText)) mounted.push('computer-use')

  const env: string[] = []
  for (const line of envText.split('\n')) {
    const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
    if (name !== undefined && !env.includes(name)) env.push(name)
  }
  return { mounted, env }
}

/**
 * The patch row one capability mounts, as a list of YAML lines, or `undefined` when the
 * capability is turned on by something other than a row this module owns.
 *
 * MinerU is enabled by a row too, but its endpoint is per-deployment, so the caller passes
 * the answers rather than a fixed row.
 *
 * @param id - the capability id.
 * @returns the insert payload lines, without the surrounding `- insert:` entry.
 */
function capabilityRows(id: string): readonly string[] | undefined {
  if (id === 'exa') {
    return [
      '    - id: web-search-exa',
      "      name: '@deepseek-ai/dsh-web-search-exa'",
      '      config:',
      '        searchType: auto',
      '        numResults: 8',
    ]
  }
  if (id === 'officecli') {
    return [
      '    - id: officecli',
      "      name: '@sparkelf/dsh-officecli'",
    ]
  }
  if (id === 'computer-use') {
    return [
      '    - id: computer-use',
      "      name: '@deepseek-ai/dsh-computer-use'",
      '    - id: computer-use-cua-driver-mcp',
      "      name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'",
    ]
  }
  return undefined
}

/** The row ids a capability owns in the profile layer. */
function capabilityRowIds(id: string): readonly string[] {
  if (id === 'exa') return ['web-search-exa']
  if (id === 'officecli') return ['officecli']
  if (id === 'mineru') return ['mineru']
  if (id === 'computer-use') return ['computer-use', 'computer-use-cua-driver-mcp']
  return []
}

/**
 * One capability's effect, added to or removed from an existing profile layer without
 * disturbing the rest of the file.
 *
 * `dsh-plus start` owns the whole layer and rewrites it from the interview's answers, which
 * is correct for an install that answered once and never edits afterwards. A deployment
 * that maintains its own rows in that same layer cannot be served that way: replacing the
 * file drops every row the operator wrote. This edits the rows this module owns and leaves
 * every other entry, comment, and blank line exactly where it was.
 *
 * @param existing - the layer's current YAML text.
 * @param id - the capability to add or remove.
 * @param enable - whether to add the capability.
 * @param mineruEndpoint - the endpoint to write when enabling MinerU.
 * @returns the layer's new text.
 */
export function editCapabilityPatchLayer(
  existing: string,
  id: string,
  enable: boolean,
  mineruEndpoint?: string,
): string {
  const owned = capabilityRowIds(id)
  const withoutRows = dropOwnedRows(existing, owned, id === 'exa')
  const mineruRows = [
    '    - id: mineru',
    "      name: '@sparkelf/dsh-mineru'",
    '      config:',
    '        endpoint: ' + (mineruEndpoint ?? DEFAULT_MINERU_ENDPOINT),
  ]
  const rows = id === 'mineru' && enable ? mineruRows : capabilityRows(id)
  const text = enable && rows !== undefined
    ? insertCapabilityRows(withoutRows, rows, id === 'exa')
    : withoutRows.text
  // Every file this repository writes ends with exactly one newline; an edited layer must
  // not lose that, and the loader's YAML parse is indifferent to it either way.
  const trimmed = text.replace(/\n+$/u, '')
  return trimmed === '' ? '\n' : trimmed + '\n'
}

/**
 * Remove the rows one capability owns, and for Exa the `web` selector row that routes
 * search to it.
 *
 * A row is dropped with the block that belongs to it: the `- id:` line plus its indented
 * continuation lines, and any comment line directly above that documented it. Comment and
 * blank lines separating it from the next entry stay, so the surrounding file keeps its
 * shape.
 *
 * @param existing - the layer's current YAML text.
 * @param ids - the row ids this capability owns.
 * @param withSelector - whether the capability also owns the shared `web` selector row.
 * @returns the remaining text and whether anything was actually removed.
 */
function dropOwnedRows(
  existing: string,
  ids: readonly string[],
  withSelector: boolean,
): { text: string; removed: boolean } {
  const lines = existing.split('\n')
  const out: string[] = []
  let removed = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    const match = /^(\s*)- id:\s*(\S+)\s*$/.exec(line)
    // The `web` selector is shared with the built-in provider: dropping it turns Exa off
    // without touching the row's other keys, because the bundle layer's row reapplies.
    const isSelector = withSelector && match?.[2] === 'web' && match[1] === ''
    if (match === null || (!ids.includes(match[2] ?? '') && !isSelector)) {
      out.push(line)
      continue
    }
    removed = true
    const indent = match[1] ?? ''
    // Drop the comments that documented this row, stopping at a blank line so an unrelated
    // comment above a blank line is not consumed.
    while (out.length > 0) {
      const previous = out[out.length - 1] ?? ''
      if (previous.trimStart().startsWith('#') && previous.trim() !== '') out.pop()
      else break
    }
    // Then the row's own continuation lines: deeper-indented or blank lines until the next
    // entry at the same or a shallower level.
    for (index += 1; index < lines.length; index += 1) {
      const next = lines[index] ?? ''
      if (next.trim() === '') {
        // A blank line inside a row's block keeps it; a blank line starting a new block
        // belongs to the file's spacing and goes back.
        const after = lines[index + 1] ?? ''
        if (after !== '' && (after.startsWith(indent + ' ') || after.startsWith(indent + '\t') || after.trimStart().startsWith('#'))) {
          continue
        }
        index -= 1
        break
      }
      const nextIndent = /^\s*/.exec(next)?.[0] ?? ''
      if (nextIndent.length > indent.length) continue
      index -= 1
      break
    }
  }
  return { text: out.join('\n'), removed }
}

/**
 * Add a capability's rows to the layer, creating the `- insert:` entry when the file has
 * none and appending to the existing one otherwise.
 *
 * The loader indexes inserted rows under the layer that inserted them, so appending to an
 * existing `- insert:` list and adding a second one both work; appending keeps the file
 * readable instead of growing one `- insert:` per capability.
 *
 * @param state - the layer with this capability's own rows already removed.
 * @param rows - the insert payload lines to add.
 * @param withSelector - whether Exa's `web` selector row must also be present.
 * @returns the layer's new text.
 */
function insertCapabilityRows(
  state: { text: string },
  rows: readonly string[],
  withSelector: boolean,
): string {
  const lines = state.text.split('\n')
  const insertIndex = lines.findIndex(line => /^- insert:\s*$/.test(line))
  if (insertIndex >= 0) {
    // Append at the end of the existing insert block: walk past its payload lines.
    let end = insertIndex + 1
    while (end < lines.length) {
      const line = lines[end] ?? ''
      if (line.trim() === '' || /^\s/.test(line)) end += 1
      else break
    }
    while (end > insertIndex + 1 && (lines[end - 1] ?? '').trim() === '') end -= 1
    lines.splice(end, 0, ...rows)
  } else {
    // A layer with no entries is the literal `[]`; replacing it keeps one valid array.
    const emptyIndex = lines.findIndex(line => line.trim() === '[]')
    if (emptyIndex >= 0) lines.splice(emptyIndex, 1, '- insert:', ...rows)
    else {
      const trailing = lines.length > 0 && (lines[lines.length - 1] ?? '') === '' ? lines.pop() ?? '' : undefined
      lines.push('- insert:', ...rows)
      if (trailing !== undefined) lines.push(trailing)
    }
  }
  if (withSelector && !/^\s*- id: web\s*$/mu.test(lines.join('\n'))) {
    // The selector is a top-level row: it patches the bundle layer's own `web` entry, and
    // it must restate `fetchProvider` because a patch replaces the whole `config` object
    // rather than merging into it.
    lines.push(
      '',
      '# Route web_search through Exa rather than the built-in provider.',
      '- id: web',
      '  config:',
      '    searchProvider: exa',
      '    fetchProvider: http',
    )
  }
  return lines.join('\n')
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
