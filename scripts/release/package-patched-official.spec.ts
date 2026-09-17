// @ts-expect-error The packager is runtime JavaScript without declaration artifacts.
import { PACKAGED_FILES, PATCHED_WORKSPACES, STRIPPED_FIELDS } from './package-patched-official.mjs'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Every repository workspace the declared patches modify, read from the patches.
 *
 * The patch files are the authority: a \`diff --git a/<path>\` header names what the patch
 * touches, so a patch that adds a workspace updates this result without anyone editing a
 * list. A source-patch header is repository-relative; an npm-patch header is relative to
 * the package it patches, which is why only \`dsh-source\` variants contribute.
 *
 * @returns sorted repository-relative workspace paths.
 */
function workspacesThePatchesModify(): string[] {
  const distribution = JSON.parse(readFileSync(join(root, 'packages/bundle/plus/package.json'), 'utf8')) as {
    dshPlus: { patchPackages: string[] }
  }
  const derived = new Set<string>()
  for (const name of distribution.dshPlus.patchPackages) {
    const directory = join(root, 'patches/npm', name.replace('@sparkelf/dsh-patch-', ''))
    const manifestPath = join(directory, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dshPatch?: { variants?: { target: { kind: string } }[] }
    }
    const variants = manifest.dshPatch?.variants ?? []
    if (!variants.some(variant => variant.target.kind === 'dsh-source')) continue
    const patches = join(directory, 'patches')
    if (!existsSync(patches)) continue
    for (const file of readdirSync(patches)) {
      for (const match of readFileSync(join(patches, file), 'utf8').matchAll(/^diff --git a\/([^ ]+)/gm)) {
        const captured = match[1]
        if (captured === undefined) continue
        const parts = captured.split('/')
        // A workspace is apps/<name>, packages/<group>/<name>, vendor/<name>, or python/<name>.
        if (parts[0] === 'apps' && parts.length >= 3) derived.add(parts.slice(0, 2).join('/'))
        else if (parts[0] === 'packages' && parts.length >= 4) derived.add(parts.slice(0, 3).join('/'))
        else if ((parts[0] === 'vendor' || parts[0] === 'python') && parts.length >= 3) derived.add(parts.slice(0, 2).join('/'))
      }
    }
  }
  return [...derived].sort()
}

describe('PACKAGED_FILES', () => {
  it('carries every payload a published workspace declares', () => {
    // The built web frontend is its \`dist\` directory, a bundle's composition is its
    // \`cordis.patch.yml\`, and a preset package's payload is its \`presets\` tree. Omitting any
    // published a package whose own \`files\` list promised content it did not contain — the
    // server answered 404 for every page, and a bundle installed without mounting. Every
    // manifest looked correct.
    for (const entry of ['dist', 'lib', 'presets', 'skills', 'cordis.patch.yml']) {
      expect(PACKAGED_FILES).toContain(entry)
    }
  })

  it('names entries literally rather than by pattern', () => {
    // The copy skips a source the workspace lacks, so a typo publishes a short package
    // in silence; a glob would make that failure impossible to see at review time.
    for (const entry of PACKAGED_FILES) {
      expect(entry).not.toContain('*')
      expect(entry).not.toMatch(/^!/u)
    }
  })
})

describe('PATCHED_WORKSPACES', () => {
  it('matches the workspaces the declared patches modify', () => {
    // A hand-written list drifts: the first version of this file omitted a workspace a
    // patch had touched, which publishes a package set the patches do not describe. The
    // patch files answer the question directly, so the list is checked against them
    // rather than trusted.
    expect([...(PATCHED_WORKSPACES as string[])].sort()).toEqual(workspacesThePatchesModify())
  })

  it('is referenced by an override for every patched workspace', () => {
    // Repackaging a workspace produces @sparkelf/dsh-*; nothing installs it until the
    // distribution's overrides name it. A workspace present here but absent there ships a
    // package no consumer receives, which is how three source patches reached the source
    // checkout and never reached a registry installation.
    const distribution = JSON.parse(
      readFileSync(join(root, 'packages/bundle/plus/package.json'), 'utf8'),
    ) as { dshPlus: { profile: { overrides: Record<string, string> } } }
    // A key is the official package name the consumer imports; the value is the npm
    // substitution that replaces it. The workspace's own name is the key.
    const overridden = new Set(Object.keys(distribution.dshPlus.profile.overrides))
    // The packaged name is the workspace's own manifest name, not a path join: apps/web
    // publishes as @deepseek-ai/dsh-web-frontend and packages/bundle/web-app as
    // @deepseek-ai/dsh-web-app. Reading the manifest is what keeps this check honest.
    const missing = [...(PATCHED_WORKSPACES as string[])].filter((workspace) => {
      const manifest = JSON.parse(readFileSync(join(root, workspace, 'package.json'), 'utf8')) as { name?: string }
      const name = manifest.name
      if (name === undefined) return true
      const spec = overridden.has(name)
      return !spec
    })
    expect(missing).toEqual([])
  })
})

describe('STRIPPED_FIELDS', () => {
  it('keeps the manifest fields that register a package', () => {
    // \`dsh.client\` is a browser module's registration. Dropping it published twenty
    // packages that installed cleanly and never loaded, so the model selector and the
    // settings panels did not appear while every other check passed.
    expect(STRIPPED_FIELDS).not.toContain('dsh')
    for (const field of ['devDependencies', 'scripts', 'private']) {
      expect(STRIPPED_FIELDS).toContain(field)
    }
  })
})
