import { describe, expect, it } from 'vitest'
import { capabilityEnvironment, capabilityPatchLayer } from '../src/standalone-capabilities.ts'

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

  it('carries the MinerU endpoint as plugin config rather than an environment variable', () => {
    // The plugin reads `endpoint` from its own config; a `DSH_`-prefixed name is refused in any
    // .env because DSH_HOME is bootstrap-only. Writing the endpoint to the env file instead made
    // the launcher refuse to start at all.
    const layer = capabilityPatchLayer({ enabled: ['mineru'], mineruEndpoint: 'http://127.0.0.1:9000/parse' })
    expect(layer).toContain("name: '@sparkelf/dsh-mineru'")
    expect(layer).toContain('endpoint: http://127.0.0.1:9000/parse')
  })
})

describe('capability environment file', () => {
  it('never writes a name the launcher refuses to read', () => {
    // `DSH_` and `XDG_` are bootstrap prefixes: a .env setting one makes the launcher exit with
    // "only the launching environment may set". Enabling every capability must still produce a file
    // it accepts.
    const file = capabilityEnvironment({ enabled: ['exa', 'mineru', 'officecli', 'computer-use'], exaApiKey: 'k' })
    for (const line of file.split('\n')) {
      const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1]
      if (name === undefined) continue
      expect(name.startsWith('DSH_')).toBe(false)
      expect(name.startsWith('XDG_')).toBe(false)
    }
  })

  it('keeps an unrelated assignment the deployment wrote itself', () => {
    const file = capabilityEnvironment({ enabled: ['exa'], exaApiKey: 'k' }, 'MY_OWN_FLAG=1\nEXA_API_KEY=old\n')
    expect(file).toContain('MY_OWN_FLAG=1')
    // The interview owns this name, so the stale value is replaced rather than kept beside it.
    expect(file).toContain('EXA_API_KEY=k')
    expect(file).not.toContain('EXA_API_KEY=old')
  })
})
