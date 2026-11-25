/**
 * Behavior the pairing promises: the identity a desktop presents is the one it minted.
 *
 * The server routes every relayed frame by the device's bridgeId, so an identity that changes
 * between two reads leaves an already-paired phone addressed to a bridge the server no longer
 * serves. A reader sees that as the phone dropping as soon as it is used.
 *
 * The assertion runs the plugin's own settings-branch assignment rather than a paraphrase of it:
 * the choice of input happens in that expression, and a test of `identityFrom` alone cannot see
 * which input the plugin feeds it -- which is how the defect survived a passing suite.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const pluginSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** The composed config a deployment passes in: an empty identity, as the schema defaults it. */
const composedConfig: Record<string, unknown> = {
  serverUrl: 'https://example',
  localPort: 3080,
  bridgeId: '',
  bridgeToken: '',
  bridgeSecret: '',
  autoConnect: false,
  autoReconnect: false,
  userKey: '',
  ownerEmail: '',
  emailTwoFactor: false,
  sessionDays: 7,
  domDiagnostics: false,
}

let minted = 0
/** A randomBytes that returns a fresh value each call, so re-minting is observable. */
const randomBytes = (size: number) => ({
  toString: () => String(++minted).padStart(size * 2, '0').slice(0, size * 2),
})

/** The plugin's own `identityFrom`, compiled from its source. */
const identityFromOf = (): ((v: Record<string, unknown>) => Record<string, string>) => {
  const body = /const identityFrom = \(value: MobileBridgeConfig\): MobileBridgeConfig => \{([\s\S]*?)\n  \}/.exec(pluginSource)?.[1]
  if (body === undefined) throw new Error('identityFrom not found in the plugin source')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the body is read from the plugin
  // The body is a function body, so the wrapper supplies the parameter and the call shape.
  const factory = new Function('randomBytes', 'return (value) => {' + body + '}')
  return factory(randomBytes) as (v: Record<string, unknown>) => Record<string, string>
}

/**
 * The `current()` the plugin installs in its settings branch, built from its own assignment.
 *
 * `normalizeConfig` mirrors the plugin's: it resolves the value the branch reads. The test asserts
 * on a real bridgeId rather than on two `undefined`s, so a `current()` that returns nothing fails.
 * @returns The installed `current`.
 */
const currentFrom = (): (() => Record<string, string>) => {
  const identityFrom = identityFromOf()
  const start = pluginSource.indexOf('const settings = (settingsCtx')
  const end = pluginSource.indexOf('runtimeConfig = current()', start)
  if (start < 0 || end < 0) throw new Error('the settings branch was not found')
  const assignment = /^\s*current = \(\) => .*$/mu.exec(pluginSource.slice(start, end))?.[0]
  if (assignment === undefined) throw new Error('the settings branch assigns no current()')
  const expression = assignment.trim().replace(/^current = /u, '').replace(/;$/u, '')
  const normalizeConfig = (value: Record<string, unknown>) => ({ ...composedConfig, ...value })
  const mintedIdentity = identityFrom({ ...composedConfig })
  const runtimeConfig = mintedIdentity
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the expression is read from the plugin
  return new Function(
    'identityFrom', 'normalizeConfig', 'config', 'mintedIdentity', 'runtimeConfig',
    `return ${expression}`,
  )(identityFrom, normalizeConfig, composedConfig, mintedIdentity, runtimeConfig) as () => Record<string, string>
}

describe('pairing identity', () => {
  it('remembers the minted identity in a file under the Harness home', () => {
    // The settings form cannot carry this identity: `mutate` refuses an entry with no volatile
    // field, and a failed write-back left every restart with a new bridgeId. The file is the
    // mechanism that keeps an already-paired phone addressed to a bridge the relay still serves.
    expect(pluginSource, 'the plugin must read a stored identity').toContain('readStoredIdentity')
    expect(pluginSource, 'the plugin must write a stored identity').toContain('writeStoredIdentity')
    const pathHelper = /const identityPath = \(\): string => \{([\s\S]*?)\n  \}/u.exec(pluginSource)?.[1]
    expect(pathHelper, 'the identity path must resolve from the Harness home').toBeDefined()
    expect(pathHelper).toContain('DSH_HOME')
    expect(pathHelper).toContain('mobile-bridge-identity.json')
  })

  it('restores the identity from the file rather than minting a new one', () => {
    // The seeding call is what makes the value survive a restart; without it the file is written
    // and never read, which is the failure the probe in this repository's notes measured.
    const seeding = /identityFrom\(\{ \.\.\.config, \.\.\.readStoredIdentity\(\) \}\)/u.exec(pluginSource)
    expect(seeding, 'the identity must be seeded from the stored file').not.toBeNull()
  })

  it('mints an identity when the composed config carries none', () => {
    const identity = identityFromOf()({ ...composedConfig })
    expect(identity.bridgeId).toMatch(/^[0-9a-f]{32}$/u)
    expect(identity.bridgeSecret).toMatch(/^[0-9a-f]{32}$/u)
  })

  it('returns the identity it minted on every read', () => {
    const current = currentFrom()
    const first = current()
    expect(first.bridgeId).toMatch(/^[0-9a-f]{32}$/u)
    expect(current().bridgeId).toBe(first.bridgeId)
    expect(current().bridgeToken).toBe(first.bridgeToken)
  })
})