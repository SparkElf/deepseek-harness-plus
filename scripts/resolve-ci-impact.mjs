/** Resolve one fail-open CI plan from Git changes. */
import { appendFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const CLIENT_WEB_TESTS = Object.freeze({
  'ui-agent-preset': ['agent-preset-authoring.e2e.ts', 'agent-preset-selection.e2e.ts'],
  'ui-deliverables': ['produced-file-mentions.e2e.ts', 'produced-files.e2e.ts'],
  'ui-goal': ['goal-bar.e2e.ts', 'goal-command-presentation.e2e.ts', 'goal-multi-turn-actions.e2e.ts'],
  'ui-jobs': ['background-job-list.e2e.ts'],
  'ui-message-feedback': ['feedback-command.e2e.ts', 'message-feedback.e2e.ts', 'message-feedback-layout.e2e.ts'],
  'ui-plan': ['plan-control-row.e2e.ts', 'plan-review.e2e.ts'],
  'ui-settings-backup': ['settings-backup.e2e.ts'],
  'ui-trajectory': ['trajectory-virtualization.e2e.ts'],
  'ui-user-questions': ['question-composer.e2e.ts'],
  'ui-workflow-run': ['workflow-run.e2e.ts'],
})

const DOC_EXTENSIONS = ['.md', '.mdx', '.i18n.yaml']
const DOC_TREES = ['docs/', '.agents/notes/', '.agents/skills/', 'website/', '.github/ISSUE_TEMPLATE/']
const DOC_BASENAMES = new Set(['README.md', 'AGENTS.md', 'CLAUDE.md'])
const CLIENT_FILE = /^packages\/client\/([^/]+)\/(src|tests)\/.+/u
const DIRECT_WEB_TEST = /^apps\/web\/tests\/([^/]+\.(?:e2e|snapshot)\.ts)$/u
const CLIENT_TYPESCRIPT = /\.(?:ts|tsx|mts|cts)$/u

/** @typedef {{ status: string, path: string }} Change */
/** @typedef {'docs' | 'client' | 'full'} ImpactMode */
/** @typedef {'skip' | 'incremental' | 'full'} CoverageMode */
/** @typedef {'skip' | 'web' | 'full'} ConsumerMode */

/**
 * Classify a validated Git change set into the smallest sufficient CI plan.
 * @param {Change[]} changes Git name-status entries with repository-relative paths.
 * @returns {{ mode: ImpactMode, coverage: CoverageMode, consumers: ConsumerMode, nodeCompat: boolean, python: boolean, windows: boolean, webTests: string[], reason: string }}
 */
export function classifyChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) return fullPlan('empty change set')
  for (const change of changes) validateChange(change)
  if (changes.some(change => change.status !== 'A' && change.status !== 'M')) return fullPlan('deleted or structurally changed path')
  if (changes.every(change => documentationPath(change.path))) {
    return { mode: 'docs', coverage: 'skip', consumers: 'skip', nodeCompat: false, python: false, windows: false, webTests: [], reason: 'documentation-only change' }
  }

  const relevant = changes.filter(change => !documentationPath(change.path))
  const directWebTests = []
  const clientPackages = new Set()
  let unitTestImpact = false
  for (const { path } of relevant) {
    const direct = DIRECT_WEB_TEST.exec(path)
    if (direct !== null) {
      directWebTests.push(path)
      continue
    }
    const client = CLIENT_FILE.exec(path)
    if (client === null) return fullPlan('path has no narrow client impact rule')
    if (!Object.hasOwn(CLIENT_WEB_TESTS, client[1])) return fullPlan('client package has no reviewed Web test mapping')
    if (client[2] === 'tests' || CLIENT_TYPESCRIPT.test(path)) unitTestImpact = true
    clientPackages.add(client[1])
  }

  const mappedTests = [...clientPackages].flatMap(name => CLIENT_WEB_TESTS[name].map(file => 'apps/web/tests/' + file))
  const webTests = [...new Set([...directWebTests, ...mappedTests])].sort()
  if (webTests.length === 0) return fullPlan('client change selected no Web test')
  return {
    mode: 'client',
    coverage: unitTestImpact ? 'incremental' : 'skip',
    consumers: 'web',
    nodeCompat: false,
    python: false,
    windows: false,
    webTests,
    reason: 'reviewed client package and Web test mapping',
  }
}

/**
 * Parse null-delimited Git name-status output produced with rename detection disabled.
 * @param {string} output Git output.
 * @returns {Change[]} Parsed changes.
 */
export function parseNameStatus(output) {
  const fields = output.split(String.fromCharCode(0))
  if (fields.at(-1) === '') fields.pop()
  if (fields.length % 2 !== 0) throw new Error('CI impact Git output must contain status/path pairs')
  const changes = []
  for (let index = 0; index < fields.length; index += 2) changes.push({ status: fields[index], path: fields[index + 1] })
  return changes
}

function documentationPath(path) {
  const basename = path.slice(path.lastIndexOf('/') + 1)
  const documentedExtension = DOC_EXTENSIONS.some(extension => path.endsWith(extension))
  return path === 'THIRD_PARTY_NOTICES.md'
    || DOC_BASENAMES.has(basename)
    || (!path.includes('/') && documentedExtension)
    || (documentedExtension && DOC_TREES.some(prefix => path.startsWith(prefix)))
}


function validateChange(change) {
  if (change === null || typeof change !== 'object' || typeof change.status !== 'string' || typeof change.path !== 'string') {
    throw new TypeError('CI impact changes require string status and path fields')
  }
  if (!/^[A-Z][0-9]*$/u.test(change.status)) throw new TypeError('CI impact received an invalid Git status: ' + JSON.stringify(change.status))
  if (change.path.length === 0 || change.path.startsWith('/') || change.path.includes(String.fromCharCode(92))) {
    throw new TypeError('CI impact received an invalid repository-relative path: ' + JSON.stringify(change.path))
  }
}

function fullPlan(reason) {
  return { mode: 'full', coverage: 'full', consumers: 'full', nodeCompat: true, python: true, windows: true, webTests: [], reason }
}

function gitOutput(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error('CI impact git command failed: git ' + args.join(' ') + String.fromCharCode(10) + result.stderr)
  return result.stdout
}

function planFromGit(base, head, forceFull) {
  const mergeBase = gitOutput(['merge-base', base, head]).trim()
  if (mergeBase === '') throw new Error('CI impact could not resolve a merge base')
  const changes = parseNameStatus(gitOutput(['diff', '--name-status', '--no-renames', '-z', mergeBase, head, '--']))
  const impact = forceFull ? fullPlan('forced complete matrix') : classifyChanges(changes)
  return { ...impact, mergeBase, changedCount: changes.length }
}

function writeGitHubOutputs(path, plan) {
  const outputs = {
    mode: plan.mode,
    coverage: plan.coverage,
    consumers: plan.consumers,
    node_compat: String(plan.nodeCompat),
    python: String(plan.python),
    windows: String(plan.windows),
    web_tests: JSON.stringify(plan.webTests),
    merge_base: plan.mergeBase ?? '',
    changed_count: String(plan.changedCount ?? 0),
    reason: plan.reason,
  }
  const lines = Object.entries(outputs).map(([name, value]) => name + '=' + value + String.fromCharCode(10)).join('')
  appendFileSync(path, lines)
}

function main() {
  const { values } = parseArgs({
    options: {
      base: { type: 'string' },
      head: { type: 'string' },
      'changes-json': { type: 'string' },
      'force-full': { type: 'boolean', default: false },
      'github-output': { type: 'string' },
    },
    allowPositionals: false,
  })
  const fixtureChanges = values['changes-json'] === undefined ? undefined : JSON.parse(values['changes-json'])
  const plan = fixtureChanges === undefined
    ? planFromGit(required(values.base, '--base'), required(values.head, '--head'), values['force-full'])
    : { ...classifyChanges(fixtureChanges), changedCount: fixtureChanges.length }
  if (values['github-output'] !== undefined) writeGitHubOutputs(values['github-output'], plan)
  console.log(JSON.stringify(plan))
}

function required(value, name) {
  if (value === undefined || value === '') throw new Error('CI impact requires ' + name)
  return value
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
