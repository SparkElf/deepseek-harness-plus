import { describe, expect, it } from 'vitest'
import { capabilityPatchLayer } from '../src/standalone-capabilities.ts'

/**
 * The profile loader requires a top-level YAML array in the capability layer, so a
 * selection that mounts nothing still has to produce one.
 *
 * Measured: an empty selection wrote comments alone, which parse as `null`, and the
 * profile refused to boot with "must be a top-level YAML array of loader patch entries".
 * The failure took down the whole deployment rather than only the omitted capability,
 * which is why an empty selection is asserted here beside the populated one.
 */
describe('capability patch layer', () => {
  it('mounts an array when the selection enables nothing', () => {
    const layer = capabilityPatchLayer({ enabled: [] })
    expect(layer).toContain('[]')
    // Comments alone would parse as null; the array marker is what the loader needs.
    expect(layer.split('\n').some(line => line.trim() === '[]')).toBe(true)
  })

  it('mounts the selected capabilities as an insert row', () => {
    const layer = capabilityPatchLayer({ enabled: ['exa'] })
    expect(layer).toContain('- insert:')
    expect(layer).toContain("name: '@deepseek-ai/dsh-web-search-exa'")
    expect(layer).toContain('searchProvider: exa')
  })

  it('mounts both computer-use plugins together', () => {
    // The capability is one choice but two plugins: the registry service and the driver
    // that talks to it. Mounting either alone leaves the capability unusable.
    const layer = capabilityPatchLayer({ enabled: ['computer-use'] })
    expect(layer).toContain("name: '@deepseek-ai/dsh-computer-use'")
    expect(layer).toContain("name: '@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp'")
  })
})
