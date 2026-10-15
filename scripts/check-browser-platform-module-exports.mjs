/** Check that every `@deepseek-ai/dsh-client-ui-primitives` name a browser plugin references is exported by the host bundle that serves it.
 *
 * The host application statically bundles `@deepseek-ai/dsh-client-ui-primitives` as a platform
 * module (`packages/client/web/src/platform.ts`), so a plugin's
 * `require('@deepseek-ai/dsh-client-ui-primitives')` resolves to the host's copy rather than the
 * one in the plugin's own tree. A name the plugin imports at build time from this repository's
 * source -- where the icon set is named by drawn size (`<Name>16`) -- can therefore be absent
 * from a host copy built from the published line, which names the same glyphs by weight
 * (`<Name>Regular`). The import then evaluates to `undefined`, React fails with error #130
 * ("element type is invalid"), the slot entry unmounts, and the whole panel renders blank.
 *
 * TypeScript cannot see this: the compile-time module resolves against this repository's source,
 * where the name exists. The two copies are only distinguishable at runtime, which makes this a
 * release-boundary check rather than a type error.
 *
 * Measured 2026-10-16: a skill-center build importing `IconSearchOutline16` passed tsc, tsdown,
 * and the client i18n gate, then blanked the panel on deploy; the deployed host bundle exported
 * `IconSearchOutlineRegular` and not the `16` spelling.
 *
 * Usage:
 *   node scripts/check-browser-platform-module-exports.mjs [--host-bundle <file>] [--plugins-root <dir>]
 *
 * Point `--host-bundle` at the bundle a deployment actually serves to check a plugin against the
 * copy it will receive there; the default is this repository's own `apps/web/dist`.
 */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** The platform module whose exports a plugin must be able to resolve. */
export const PLATFORM_MODULE = '@deepseek-ai/dsh-client-ui-primitives'

/** Names used to recognise the platform module's export table inside a minified bundle. */
const TABLE_MARKERS = ['Button', 'Input', 'Modal', 'Tooltip', 'StateDot', 'IconPlusOutlineRegular']

/**
 * Read the names the host bundle exports from the platform module.
 *
 * The bundle is minified, so the export set is recovered structurally: the platform module's
 * factory is the widest object literal carrying several known primitive names, and its keys are
 * the exported identifiers. A name that merely appears as a reference elsewhere in the bundle is
 * deliberately not counted, because what matters is the object the module publishes.
 *
 * The minimum table size guards against matching an unrelated literal: an export table holding
 * fewer than the recognised markers is not this module's.
 * @param source - the host bundle text.
 * @returns the exported names.
 * @throws when no table matches, which means the bundle layout is not what this check reads.
 */
export function platformExports(source) {
  let best
  for (const match of source.matchAll(/\{[^{}]{200,20000}\}/g)) {
    const body = match[0]
    const hits = TABLE_MARKERS.filter(name => body.includes('"' + name + '"') || body.includes(name + ':')).length
    if (hits < 4) continue
    if (best === undefined || hits > best.hits) best = { hits, body }
  }
  if (best === undefined) {
    throw new Error('check-browser-platform-module-exports: no platform module export table found')
  }
  const names = new Set()
  for (const match of best.body.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*):/g)) names.add(match[1])
  for (const match of best.body.matchAll(/"([A-Za-z_$][A-Za-z0-9_$]*)"/g)) names.add(match[1])
  return names
}

/**
 * Collect every platform-module name one built client bundle references.
 *
 * The built bundle is read rather than the source because the bundle is what ships, and a
 * re-export would not show the reference in the plugin's own source.
 * @param source - the client bundle text.
 * @returns the referenced member names.
 */
export function referencedNames(source) {
  const names = new Set()
  // A bundler binds the module to a local alias, then reads members off it: alias.Name.
  const bound = source.match(new RegExp('(?:var|let|const)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*require\\("'
    + PLATFORM_MODULE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\)'))
  if (bound !== null) {
    const name = bound[1]
    for (const match of source.matchAll(new RegExp('\\b' + name + '\\.([A-Za-z_$][A-Za-z0-9_$]*)', 'g'))) {
      names.add(match[1])
    }
  }
  // A destructuring require is the other shape a bundler emits.
  for (const match of source.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*require\("([^"]+)"\)\.([A-Za-z_$][A-Za-z0-9_$]*)/g)) {
    if (match[2] === PLATFORM_MODULE) names.add(match[3])
  }
  return names
}

/**
 * Name every referenced platform member the host bundle does not export.
 * @param hostSource - the host bundle text.
 * @param clientSource - one plugin's built client bundle text.
 * @returns the unresolvable names, sorted; empty when the plugin resolves completely.
 */
export function unresolvableReferences(hostSource, clientSource) {
  if (!clientSource.includes(PLATFORM_MODULE)) return []
  const exported = platformExports(hostSource)
  return [...referencedNames(clientSource)].filter(name => !exported.has(name)).sort()
}

/** Run the check over a tree, reporting each bundle that references an unresolvable name. */
function main() {
  const args = process.argv.slice(2)
  const optionOf = (name) => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const hostBundle = optionOf('--host-bundle') ?? newestHostBundle(repositoryRoot)
  if (hostBundle === undefined || !existsSync(hostBundle)) {
    console.error('check-browser-platform-module-exports: no host bundle at apps/web/dist/assets/index-*.js')
    console.error('  build the web application first (pnpm run build:web); an unchecked tree is not a passing tree')
    return 1
  }
  const pluginsRoot = resolve(optionOf('--plugins-root') ?? resolve(repositoryRoot, 'packages'))
  const bundles = globSync('**/lib/client.js', { cwd: pluginsRoot }).map(file => resolve(pluginsRoot, file)).sort()
  if (bundles.length === 0) {
    console.error('check-browser-platform-module-exports: no built client bundle under ' + pluginsRoot)
    console.error('  an empty corpus is a failure, not a pass')
    return 1
  }
  const hostSource = readFileSync(hostBundle, 'utf8')
  const exported = platformExports(hostSource)
  const failures = []
  let checked = 0
  for (const bundle of bundles) {
    const source = readFileSync(bundle, 'utf8')
    if (!source.includes(PLATFORM_MODULE)) continue
    checked += 1
    const missing = unresolvableReferences(hostSource, source)
    if (missing.length > 0) failures.push({ bundle: bundle.replace(repositoryRoot + '/', ''), missing })
  }
  console.log('check-browser-platform-module-exports: host bundle ' + hostBundle.replace(repositoryRoot + '/', ''))
  console.log('check-browser-platform-module-exports: ' + String(exported.size) + ' exported name(s), '
    + String(checked) + ' plugin bundle(s) referencing ' + PLATFORM_MODULE)
  if (failures.length === 0) {
    console.log('check-browser-platform-module-exports: every referenced platform name resolves')
    return 0
  }
  for (const failure of failures) {
    console.error('  ' + failure.bundle + ' references ' + failure.missing.join(', ')
      + ' -- not exported by the host bundle, so each resolves to undefined at runtime')
  }
  console.error('check-browser-platform-module-exports: ' + String(failures.length)
    + ' plugin bundle(s) reference an unresolvable name; a missing name fails as React error #130 and blanks the panel')
  return 1
}

/**
 * The newest built host bundle in a repository.
 * @param repositoryRoot - repository root holding `apps/web/dist`.
 * @returns absolute path, or undefined when the application is not built.
 */
function newestHostBundle(repositoryRoot) {
  const candidates = globSync('apps/web/dist/assets/index-*.js', { cwd: repositoryRoot })
    .map(file => resolve(repositoryRoot, file))
    .filter(file => existsSync(file))
  return candidates.sort().at(-1)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main())
}
