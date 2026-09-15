import { describe, expect, it } from 'vitest'
// @ts-expect-error The packager is runtime JavaScript without declaration artifacts.
import { PACKAGED_FILES } from './package-patched-official.mjs'

describe('PACKAGED_FILES', () => {
  it('carries every payload a published workspace declares', () => {
    // The built web frontend is its \`dist\` directory, and leaving it out published a
    // package whose \`files\` promised a directory it did not contain — the server then
    // answered 404 for every page while every manifest looked correct. Each directory a
    // republished workspace can carry has to be on this list.
    for (const directory of ['dist', 'lib', 'presets', 'skills']) {
      expect(PACKAGED_FILES).toContain(directory)
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
