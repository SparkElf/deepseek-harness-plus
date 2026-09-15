import { describe, expect, it } from 'vitest'
import { PACKAGED_FILES, STRIPPED_FIELDS } from './package-patched-official.mjs'

describe('PACKAGED_FILES', () => {
  it('carries every payload a published workspace declares', () => {
    // The built web frontend is its \`dist\` directory, and a bundle's composition is its
    // \`cordis.patch.yml\`. Omitting either published a package whose own \`files\` list
    // promised content it did not contain — the server answered 404 for every page, and a
    // bundle installed without mounting. Both looked correct in every manifest.
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
