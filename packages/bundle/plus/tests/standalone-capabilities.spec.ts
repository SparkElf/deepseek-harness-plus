import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_RECORD,
  capabilityEnvironment,
  capabilityPatchLayer,
  detectEnabledCapabilities,
  editCapabilityPatchLayer,
  readCapabilityRecord,
} from '../src/standalone-capabilities.ts'

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

  it('keeps a hand-written row the capability rows do not own', () => {
    // This file is the profile's only user layer. Rewriting it whole to change one capability
    // dropped every row an operator had put there — measured 2026-09-29: enabling a capability
    // from the GUI emptied a 9.6 kB layer down to the capability rows, taking a hand-written
    // model provider, the permission presets, and the theme with it.
    const existing = [
      '- id: llm-pi-ai',
      "  name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      link_api:',
      '        baseURL: https://example.invalid/v1',
      '',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '  config:',
      '    defaultPreset: danger-full-access',
      '',
    ].join('\n')
    const layer = capabilityPatchLayer({ enabled: ['exa'] }, existing)
    expect(layer).toContain('id: llm-pi-ai')
    expect(layer).toContain('https://example.invalid/v1')
    expect(layer).toContain('id: permission')
    expect(layer).toContain('defaultPreset: danger-full-access')
    // The capability's own rows are still written, and a row this module owns is replaced
    // rather than duplicated.
    expect(layer).toContain("name: '@deepseek-ai/dsh-web-search-exa'")
    expect(layer.match(/id: web-search-exa/g)?.length).toBe(1)
  })

  it('drops a capability row the selection no longer enables', () => {
    // The rewrite is also how a capability is turned back off, so an owned row must not
    // survive on the strength of "keep what was there".
    const existing = [
      '- insert:',
      '    - id: mineru',
      "      name: '@sparkelf/dsh-mineru'",
      '      config:',
      '        endpoint: http://127.0.0.1:8000/file_parse',
      '',
      '- id: permission',
      "  name: '@deepseek-ai/dsh-permission-presets'",
      '',
    ].join('\n')
    const layer = capabilityPatchLayer({ enabled: [] }, existing)
    expect(layer).not.toContain('id: mineru')
    expect(layer).toContain('id: permission')
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

  it('keeps the key already in the file when the answers carry none', () => {
    // The interview returns no key when the user chose to add it later, and enabling any
    // other capability rewrites this whole file. Dropping the key there would silently
    // disable a working search provider.
    const file = capabilityEnvironment({ enabled: ['exa', 'officecli'] }, 'EXA_API_KEY=already-there\n')
    expect(file).toContain('EXA_API_KEY=already-there')
  })

  it('drops the key when web search is no longer selected', () => {
    // Deselecting the capability is what removes the assignment that turned it on; keeping
    // it would make the file disagree with the profile layer.
    const file = capabilityEnvironment({ enabled: ['officecli'] }, 'EXA_API_KEY=already-there\n')
    expect(file).not.toContain('EXA_API_KEY')
  })
})

describe('capability patch layer rows', () => {
  it('mounts officecli when it is selected', () => {
    // The capability reported itself as ready while writing no row, so the tools stayed
    // absent. The row id and package match the plugin's own bundle layer.
    const layer = capabilityPatchLayer({ enabled: ['officecli'] })
    expect(layer).toContain('- id: officecli')
    expect(layer).toContain("name: '@sparkelf/dsh-officecli'")
  })
})

describe('capability record', () => {
  it('round-trips the answers a configured run recorded', () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-capability-record-'))
    try {
      writeFileSync(join(home, CAPABILITY_RECORD), JSON.stringify({ enabled: ['exa', 'mineru'], mineruEndpoint: 'http://127.0.0.1:9000/parse' }))
      expect(readCapabilityRecord(home)).toEqual({ enabled: ['exa', 'mineru'], mineruEndpoint: 'http://127.0.0.1:9000/parse' })
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('treats an absent or malformed record as no record', () => {
    // The record is a cache of an earlier answer; refusing to boot over a corrupted one
    // would strand a deployment whose write was interrupted.
    const home = mkdtempSync(join(tmpdir(), 'dsh-capability-record-'))
    try {
      expect(readCapabilityRecord(home)).toBeUndefined()
      writeFileSync(join(home, CAPABILITY_RECORD), '{ not json')
      expect(readCapabilityRecord(home)).toBeUndefined()
      writeFileSync(join(home, CAPABILITY_RECORD), JSON.stringify({ enabled: 'exa' }))
      expect(readCapabilityRecord(home)).toBeUndefined()
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('capability detection', () => {
  it('reads the rows the loader mounts, not the record', () => {
    const layer = capabilityPatchLayer({ enabled: ['exa', 'officecli'] })
    const detected = detectEnabledCapabilities(layer, 'EXA_API_KEY=k\n')
    expect([...detected.mounted].sort()).toEqual(['exa', 'officecli'])
    expect(detected.env).toContain('EXA_API_KEY')
  })

  it('does not count a package name mentioned in a comment', () => {
    // Matching a bare package name would report a capability as mounted because a comment
    // or an unrelated row's config mentioned it.
    const detected = detectEnabledCapabilities('# - id: web-search-exa\n[]\n', '')
    expect(detected.mounted).toEqual([])
  })
})

describe('capability layer editing', () => {
  /** A layer shaped like a deployment's own: capability rows beside hand-written ones. */
  const ownLayer = [
    '# Written by hand for this deployment.',
    '- id: llm-pi-ai',
    '  config:',
    '    model: something',
    '',
    '- insert:',
    '    - id: web-search-exa',
    "      name: '@deepseek-ai/dsh-web-search-exa'",
    '',
    '- id: web',
    '  config:',
    '    searchProvider: exa',
    '    fetchProvider: http',
    '',
    '- id: better-sidebar',
    '  config:',
    '    workspaceFence: false',
    '',
  ].join('\n')

  it('removes only the capability rows when disabling', () => {
    const off = editCapabilityPatchLayer(ownLayer, 'exa', false)
    expect(off).not.toContain('web-search-exa')
    expect(off).not.toContain('searchProvider: exa')
    // The rows this command does not own must survive: replacing the layer wholesale is
    // what `dsh-plus start` does, and it is why an operator with hand-written rows cannot
    // use that path to change one capability.
    expect(off).toContain('- id: llm-pi-ai')
    expect(off).toContain('- id: better-sidebar')
    expect(off).toContain('# Written by hand for this deployment.')
  })

  it('restores the capability rows when enabling again', () => {
    const on = editCapabilityPatchLayer(editCapabilityPatchLayer(ownLayer, 'exa', false), 'exa', true)
    expect(on).toContain('- id: web-search-exa')
    expect(on).toContain('searchProvider: exa')
    // A patch replaces the targeted row's whole `config`, so the selector has to restate
    // `fetchProvider`; omitting it silently drops web_fetch.
    expect(on).toContain('fetchProvider: http')
    expect(on).toContain('- id: llm-pi-ai')
  })

  it('is idempotent when the capability is already enabled', () => {
    // Inserting a second row under the same id doubles the entry rather than replacing it,
    // so the edit removes the rows it owns before adding them back.
    const once = editCapabilityPatchLayer(ownLayer, 'exa', true)
    const twice = editCapabilityPatchLayer(once, 'exa', true)
    expect(twice.match(/id: web-search-exa/g)).toHaveLength(1)
    expect(twice.match(/^- id: web$/gm)).toHaveLength(1)
  })

  it('creates the insert entry when the layer has none', () => {
    const on = editCapabilityPatchLayer('- id: llm-pi-ai\n', 'officecli', true)
    expect(on).toContain('- insert:')
    expect(on).toContain('- id: officecli')
    expect(on).toContain('- id: llm-pi-ai')
  })

  it('replaces the empty-array marker rather than nesting it', () => {
    // The loader requires a top-level array; a layer that mounts nothing is the literal
    // `[]`, and leaving it beside an insert would produce two documents.
    const on = editCapabilityPatchLayer('[]\n', 'exa', true)
    expect(on).not.toContain('[]')
    expect(on).toContain('- insert:')
    expect(on).toContain('- id: web-search-exa')
  })

  it('writes the MinerU endpoint from the answers', () => {
    const on = editCapabilityPatchLayer('- id: llm-pi-ai\n', 'mineru', true, 'http://127.0.0.1:9000/parse')
    expect(on).toContain("name: '@sparkelf/dsh-mineru'")
    expect(on).toContain('endpoint: http://127.0.0.1:9000/parse')
  })

  it('ends the file with exactly one newline', () => {
    const off = editCapabilityPatchLayer(ownLayer, 'exa', false)
    expect(off.endsWith('\n')).toBe(true)
    expect(off.endsWith('\n\n')).toBe(false)
  })
})
