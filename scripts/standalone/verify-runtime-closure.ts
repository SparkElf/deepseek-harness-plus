/**
 * Detect packages whose built output imports an official DSH package the manifest
 * does not declare.
 *
 * The official npm packages are published from a pnpm workspace, where hoisting
 * supplies sibling packages that the manifests never name. A standalone consumer
 * installs from the registry alone, so every such gap becomes a module-resolution
 * failure at startup. This gate resolves each official package's declared names
 * against its built ESM imports and reports the ones nothing declares.
 *
 * Usage: tsx scripts/standalone/verify-runtime-closure.ts --root <node_modules root>
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

/** One undeclared import found in a built package. */
interface DeclarationGap {
  /** Package whose build imports the name. */
  readonly from: string
  /** Official package name nothing declares. */
  readonly name: string
}

/** Package names a manifest declares as its own dependencies or peers. */
function declaredNames(manifest: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const field of ['dependencies', 'peerDependencies'] as const) {
    const record = manifest[field]
    if (record === null || typeof record !== 'object' || Array.isArray(record)) continue
    for (const name of Object.keys(record)) names.add(name)
  }
  return names
}

/** Every official package name imported by built JavaScript under one directory. */
function importedNames(directory: string): Set<string> {
  const names = new Set<string>()
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) { visit(path); continue }
      if (!entry.name.endsWith('.js')) continue
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(/from ['"]@deepseek-ai\/([a-z0-9-]+)['"]/gu)) names.add(match[1] as string)
    }
  }
  if (existsSync(directory)) visit(directory)
  return names
}

/**
 * Every official package name one bundle patch mounts.
 *
 * A profile mounts most of its tree through loader entries rather than imports, so
 * a patch naming a package the manifest never declares fails at activation with a
 * module-resolution error that no import scan can predict.
 */
function mountedNames(directory: string): Set<string> {
  const names = new Set<string>()
  const patchPath = join(directory, 'cordis.patch.yml')
  if (!existsSync(patchPath)) return names
  const source = readFileSync(patchPath, 'utf8')
  for (const match of source.matchAll(/['"]@deepseek-ai\/([a-z0-9-]+)(?:\/[a-z0-9-]+)*['"]/gu)) names.add(match[1] as string)
  return names
}

function main(): void {
  const { values } = parseArgs({ options: { root: { type: 'string' } } })
  const root = resolve(values.root ?? 'node_modules/@deepseek-ai')
  if (!existsSync(root)) throw new Error('official package root does not exist: ' + root)
  const gaps: DeclarationGap[] = []
  for (const entry of readdirSync(root)) {
    const directory = join(root, entry)
    if (!statSync(directory).isDirectory()) continue
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    const declared = declaredNames(manifest)
    const referenced = new Set([...importedNames(join(directory, 'lib')), ...mountedNames(directory)])
    for (const name of referenced) {
      if (name === entry) continue
      if (declared.has('@deepseek-ai/' + name)) continue
      if (existsSync(join(root, name))) continue
      gaps.push({ from: entry, name })
    }
  }
  const names = [...new Set(gaps.map(gap => gap.name))].sort()
  if (names.length > 0) {
    console.error('verify-runtime-closure: the runtime tree cannot resolve ' + String(names.length) + ' official package(s); declare them in the standalone manifest:')
    for (const name of names) console.error('  @deepseek-ai/' + name)
    process.exitCode = 1
    return
  }
  console.info('verify-runtime-closure: every official import in the runtime tree resolves.')
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) main()
