import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'

type RecordValue = Record<string, unknown>

const root = resolve(import.meta.dirname, '..')
const issues: string[] = []

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function expectRecord(value: unknown, location: string): RecordValue | null {
  if (isRecord(value)) return value
  issues.push(location + ': expected an object')
  return null
}

function expectText(value: unknown, location: string): string | null {
  if (typeof value === 'string' && value.trim()) return value
  issues.push(location + ': expected a non-empty string')
  return null
}

function expectList(value: unknown, location: string): unknown[] | null {
  if (Array.isArray(value) && value.length) return value as unknown[]
  issues.push(location + ': expected a non-empty list')
  return null
}

function readYaml(relativePath: string): RecordValue | null {
  const path = resolve(root, relativePath)
  if (!existsSync(path)) {
    issues.push(relativePath + ': file does not exist')
    return null
  }
  return expectRecord(load(readFileSync(path, 'utf8')), relativePath)
}

function verifyDiffRegistry(relativePath: string): void {
  const registry = readYaml(relativePath)
  if (!registry) return
  const records = expectList(registry.records, relativePath + '.records')
  if (!records) return
  const ids = new Set<string>()
  for (const [index, value] of records.entries()) {
    const location = relativePath + '.records[' + String(index) + ']'
    const record = expectRecord(value, location)
    if (!record) continue
    const id = expectText(record.id, location + '.id')
    if (id) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) issues.push(location + '.id: use lowercase kebab-case')
      if (ids.has(id)) issues.push(location + '.id: duplicate record ID ' + id)
      ids.add(id)
    }
    const status = expectText(record.status, location + '.status')
    if (status && !['planned', 'active', 'retired'].includes(status)) issues.push(location + '.status: expected planned, active, or retired')
    expectText(record.title, location + '.title')
    expectList(record.features, location + '.features')
    const repositories = expectList(record.repositories, location + '.repositories')
    if (repositories) {
      for (const [repoIndex, repository] of repositories.entries()) {
        const source = expectRecord(repository, location + '.repositories[' + String(repoIndex) + ']')
        if (!source) continue
        expectText(source.name, location + '.repositories[' + String(repoIndex) + '].name')
        expectText(source.url, location + '.repositories[' + String(repoIndex) + '].url')
        expectText(source.baseline, location + '.repositories[' + String(repoIndex) + '].baseline')
      }
    }
    expectList(record.files, location + '.files')
    if (!Array.isArray(record.plugins)) issues.push(location + '.plugins: expected a list')
    expectText(record.compatibility, location + '.compatibility')
    expectText(record.owner, location + '.owner')
    expectList(record.verification, location + '.verification')
  }
}

function verifyCompositionRegistry(): void {
  const relativePath = 'presets/compositions/registry.yaml'
  const registry = readYaml(relativePath)
  if (!registry) return
  const compositions = registry.compositions
  if (!Array.isArray(compositions)) {
    issues.push(relativePath + '.compositions: expected a list')
    return
  }
  const claims = new Map<string, string>()
  for (const [index, value] of compositions.entries()) {
    const location = relativePath + '.compositions[' + String(index) + ']'
    const composition = expectRecord(value, location)
    if (!composition) continue
    const id = expectText(composition.id, location + '.id')
    const status = expectText(composition.status, location + '.status')
    expectText(composition.category, location + '.category')
    for (const property of ['tools', 'routes', 'settingsNamespaces', 'uiSlots', 'persistenceOwners']) {
      const values = composition[property]
      if (!Array.isArray(values)) {
        issues.push(location + '.' + property + ': expected a list')
        continue
      }
      if (status !== 'active') continue
      for (const [claimIndex, claim] of values.entries()) {
        const name = expectText(claim, location + '.' + property + '[' + String(claimIndex) + ']')
        if (!name || !id) continue
        const key = property + ':' + name
        const existing = claims.get(key)
        if (existing && existing !== id) issues.push(location + '.' + property + '[' + String(claimIndex) + ']: active claim conflicts with ' + existing)
        claims.set(key, id)
      }
    }
  }
}

verifyDiffRegistry('diffs/core/registry.yaml')
verifyDiffRegistry('diffs/community/registry.yaml')
verifyCompositionRegistry()

if (issues.length) {
  console.error('verify-plus-governance: invalid Plus governance metadata:')
  for (const issue of issues) console.error('  - ' + issue)
  process.exitCode = 1
} else {
  console.log('verify-plus-governance: core and community diff registries plus composition claims are valid.')
}
