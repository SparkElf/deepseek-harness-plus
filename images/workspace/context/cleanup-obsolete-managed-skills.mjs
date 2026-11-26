#!/usr/bin/env node
/**
 * Remove retired managed skill packages and the skills they copied into a workspace.
 *
 * Two kinds of state outlive the image that created them, and only one of them is
 * replaced by `prepare_profile()`:
 *
 *   <profile>/node_modules/<pkg>     image-owned; replaced when the template marker changes
 *   <profile>/package.json           image-owned; replaced with the same copy
 *   <profile>/cordis.patch.yml       USER-owned; retained across the replacement
 *   $DSH_HOME/skills/<name>          outside the profile; never touched by prepare_profile()
 *
 * So an image that drops a managed skill package is enough for listeners of the profile
 * replacement, but not for a skill a previous image copied into the DSH home, and not for
 * a user patch row that mounts the removed package. This program handles all three, and it
 * is safe to run on every start: it only removes names listed here or recorded in the
 * previous managed-skills inventory.
 *
 * Usage: cleanup-obsolete-managed-skills.mjs [--profile <dir>] [--skills <dir>]... [--dry-run]
 *
 * Exit codes: 0 nothing left to remove or removal succeeded; 1 a target could not be
 * cleaned; 2 bad usage.
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

/**
 * Packages this deployment no longer ships.
 *
 * `@sparkelf/dsh-dataops-admin` provided the 「万相数据AI中台管理」 skill together with
 * `scripts/dataops-admin.mjs`, which drove the DataOps admin API through a local script.
 * DataOps now exposes those operations as server tools and MCP resources, so the package
 * is retired rather than republished. Keeping the list here is what stops an older profile,
 * an operator-supplied extra-plugins tarball, or a stale user patch row from resurrecting it.
 */
const RETIRED_PACKAGES = ['@sparkelf/dsh-dataops-admin']

/** Skill directory names the retired packages used to provide. */
const RETIRED_SKILLS = ['dataops-admin']

/**
 * Skill names the current image copies into `$DSH_HOME/skills` as managed built-ins.
 *
 * The previous run's inventory is stored beside the skills so a later image can tell
 * "this directory was copied by us" from "the user wrote this skill". A name missing from
 * this list after having been recorded is deleted on the next start.
 */
const MANAGED_SKILLS = []

const INVENTORY_FILE = '.dataops-managed-skills.json'

/** @returns {{ profileDirectory: string | undefined, skillDirectories: string[], dryRun: boolean }} */
function parseArguments(argv) {
  let profileDirectory
  const skillDirectories = []
  let dryRun = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--profile') {
      profileDirectory = argv[index + 1]
      index += 1
    } else if (argument === '--skills') {
      const value = argv[index + 1]
      if (value !== undefined) skillDirectories.push(value)
      index += 1
    } else if (argument === '--dry-run') {
      dryRun = true
    } else if (argument === '--help' || argument === '-h') {
      console.log('usage: cleanup-obsolete-managed-skills.mjs [--profile <dir>] [--skills <dir>]... [--dry-run]')
      process.exit(0)
    } else {
      throw new Error('unknown argument: ' + argument)
    }
  }
  if (profileDirectory === undefined && skillDirectories.length === 0) {
    throw new Error('nothing to clean: pass --profile and/or --skills')
  }
  return {
    profileDirectory: profileDirectory === undefined ? undefined : resolve(profileDirectory),
    skillDirectories: skillDirectories.map(directory => resolve(directory)),
    dryRun,
  }
}

/** Flatten a package name the way an npm tarball filename does. */
function tarballPrefix(name) {
  return name.replace(/^@/u, '').replace('/', '-')
}

/** Refuse a path that would escape its root. */
function ownedPath(root, name) {
  if (name.length === 0 || basename(name) !== name) {
    throw new Error('refusing unsafe managed name: ' + JSON.stringify(name))
  }
  const target = join(root, name)
  if (!target.startsWith(root + sep)) {
    throw new Error('refusing path outside the managed root: ' + target)
  }
  return target
}

function removePath(path, dryRun) {
  if (!existsSync(path)) return false
  console.log((dryRun ? '  would remove ' : '  removed ') + path)
  if (!dryRun) rmSync(path, { recursive: true, force: true })
  return true
}

/**
 * Drop patch rows that mount one of the retired packages.
 *
 * The profile patch is a flat YAML sequence of plugin rows. A row is removed when its own
 * `name:` (indent 2) names a retired package or its own `id:` is a retired skill. A nested
 * occurrence — a plugin entry inside a preset row — is removed as its own list item, so the
 * preset keeps its other plugins instead of losing the whole row.
 */
function stripPatchRows(text, dryRun, profileDirectory) {
  const trailingNewline = text.endsWith('\n')
  const lines = text.split('\n')
  if (trailingNewline) lines.pop()

  const isOwnFieldAt = (line, indent) => line.trim() !== '' && line.search(/\S/) === indent && headerFieldMatches(line.trim())

  // Split into top-level list items; anything before the first item is a header/comment block.
  const header = []
  const rows = []
  let current
  for (const line of lines) {
    if (line.startsWith('- ')) {
      if (current !== undefined) rows.push(current)
      current = [line]
    } else if (current === undefined) {
      header.push(line)
    } else {
      current.push(line)
    }
  }
  if (current !== undefined) rows.push(current)

  let removed = 0
  const keptRows = []
  for (const row of rows) {
    if (row.some(line => isOwnFieldAt(line, 2))) {
      removed += 1
      continue
    }
    const stripped = stripNestedItems(row, () => { removed += 1 })
    keptRows.push(...stripped)
  }
  if (removed === 0) return false
  console.log(`  ${dryRun ? 'would remove' : 'removed'} ${removed} stale patch row(s) in ${join(profileDirectory, 'cordis.patch.yml')}`)
  if (!dryRun) {
    const body = [...header, ...keptRows].join('\n') + (trailingNewline ? '\n' : '')
    writeFileSync(join(profileDirectory, 'cordis.patch.yml'), body)
  }
  return true
}

/**
 * Remove nested list items that name a retired package, leaving their parent item intact.
 * Each item owns the lines indented deeper than its own `- ` marker, so its own fields sit
 * exactly two columns in.
 */
function stripNestedItems(lines, onRemove) {
  const output = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const marker = /^(\s+)- /.exec(line)
    if (marker === null) {
      output.push(line)
      index += 1
      continue
    }
    const indent = marker[1].length
    const block = [line]
    index += 1
    while (index < lines.length) {
      const next = lines[index]
      if (next.trim() !== '' && next.search(/\S/) <= indent) break
      block.push(next)
      index += 1
    }
    if (block.some(entry => entry.search(/\S/) === indent + 2 && headerFieldMatches(entry.trim()))) {
      onRemove()
      continue
    }
    output.push(...block)
  }
  return output
}

/** Whether one YAML field line names a retired package or skill. */
function headerFieldMatches(trimmedLine) {
  for (const name of RETIRED_PACKAGES) {
    if (trimmedLine === `name: "${name}"` || trimmedLine === `name: '${name}'` || trimmedLine === `name: ${name}`) return true
  }
  for (const skill of RETIRED_SKILLS) {
    if (trimmedLine === `id: ${skill}`) return true
  }
  return false
}

function cleanProfile(profileDirectory, dryRun) {
  if (!existsSync(join(profileDirectory, 'package.json'))) {
    console.log('cleanup: no profile manifest under ' + profileDirectory + '; skipping the profile')
    return
  }
  let changed = false
  const manifestPath = join(profileDirectory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const name of RETIRED_PACKAGES) {
    if (manifest.dependencies !== undefined && manifest.dependencies[name] !== undefined) {
      delete manifest.dependencies[name]
      changed = true
      console.log('  dropped dependency ' + name)
    }
    if (manifest.overrides !== undefined && manifest.overrides[name] !== undefined) {
      delete manifest.overrides[name]
      changed = true
      console.log('  dropped override ' + name)
    }
    const bundles = manifest.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(name)) {
      manifest.dsh.profile.bundles = bundles.filter(bundle => bundle !== name)
      changed = true
      console.log('  dropped bundle row ' + name)
    }
  }
  if (changed && !dryRun) writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

  for (const name of RETIRED_PACKAGES) {
    removePath(join(profileDirectory, 'node_modules', ...name.split('/')), dryRun)
  }

  const tarballDirectories = [profileDirectory, join(profileDirectory, '.dataops-extra-plugins')]
  for (const directory of tarballDirectories) {
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory)) {
      if (!entry.endsWith('.tgz')) continue
      if (!RETIRED_PACKAGES.some(name => entry.startsWith(tarballPrefix(name) + '-'))) continue
      removePath(join(directory, entry), dryRun)
    }
  }

  const patchPath = join(profileDirectory, 'cordis.patch.yml')
  if (existsSync(patchPath)) stripPatchRows(readFileSync(patchPath, 'utf8'), dryRun, profileDirectory)

  if (existsSync(join(profileDirectory, 'pnpm-workspace.yaml'))) {
    const workspacePath = join(profileDirectory, 'pnpm-workspace.yaml')
    const text = readFileSync(workspacePath, 'utf8')
    const kept = text.split('\n').filter(line => !RETIRED_PACKAGES.some(name => line.trimStart().startsWith(`"${name}":`) || line.trimStart().startsWith(`'${name}':`) || line.trimStart().startsWith(`${name}:`)))
    if (kept.length !== text.split('\n').length) {
      console.log('  dropped stale override rows in ' + workspacePath)
      if (!dryRun) writeFileSync(workspacePath, kept.join('\n'))
    }
  }
}

function readInventory(skillsDirectory) {
  const path = join(skillsDirectory, INVENTORY_FILE)
  if (!existsSync(path)) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    const managed = value?.managed
    if (!Array.isArray(managed) || managed.some(name => typeof name !== 'string')) throw new Error('malformed inventory')
    return managed
  } catch (error) {
    console.log('  ignoring unreadable managed-skill inventory (' + String(error) + '); no skill will be removed')
    return undefined
  }
}

function cleanSkills(skillsDirectory, dryRun) {
  if (!existsSync(skillsDirectory) || !statSync(skillsDirectory).isDirectory()) {
    console.log('cleanup: no skills directory at ' + skillsDirectory + '; nothing copied to clean')
    return
  }
  const previous = readInventory(skillsDirectory)
  if (previous !== undefined) {
    // Only a name this deployment recorded as managed is removable. A same-named directory
    // the user created after the record is still deleted, which is why retirement is driven
    // by the inventory diff and not by scanning names.
    for (const name of previous) {
      if (MANAGED_SKILLS.includes(name)) continue
      removePath(ownedPath(skillsDirectory, name), dryRun)
    }
  } else {
    for (const skill of RETIRED_SKILLS) {
      const path = ownedPath(skillsDirectory, skill)
      if (existsSync(path)) {
        console.log('  kept ' + path + ': no managed-skill inventory proves it was copied by this deployment; remove it manually if it is a stale built-in')
      }
    }
  }
  const markerPath = join(skillsDirectory, INVENTORY_FILE)
  if (MANAGED_SKILLS.length > 0 || previous !== undefined) {
    if (!dryRun) writeFileSync(markerPath, JSON.stringify({ managed: MANAGED_SKILLS }, null, 2) + '\n')
  }
}

try {
  const { profileDirectory, skillDirectories, dryRun } = parseArguments(process.argv.slice(2))
  console.log('cleanup-obsolete-managed-skills' + (dryRun ? ' (dry run)' : ''))
  if (profileDirectory !== undefined) cleanProfile(profileDirectory, dryRun)
  for (const skillsDirectory of skillDirectories) cleanSkills(skillsDirectory, dryRun)
} catch (error) {
  console.error('cleanup-obsolete-managed-skills: ' + (error instanceof Error ? error.message : String(error)))
  process.exit(1)
}