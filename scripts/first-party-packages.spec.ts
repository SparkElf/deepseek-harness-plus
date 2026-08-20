import { describe, expect, it } from 'vitest'
import { isFirstPartyDshPackageName, isFirstPartyPackageName, SETTINGS_BACKUP_PACKAGE, shortDshPackageName } from './first-party-packages.ts'

describe('first-party package names', () => {
  it('keeps the SparkElf Backup package inside first-party release policy', () => {
    expect(isFirstPartyPackageName(SETTINGS_BACKUP_PACKAGE)).toBe(true)
    expect(isFirstPartyDshPackageName(SETTINGS_BACKUP_PACKAGE)).toBe(true)
    expect(shortDshPackageName(SETTINGS_BACKUP_PACKAGE)).toBe('client-ui-settings-backup')
  })

  it('does not admit unrelated SparkElf packages as first-party', () => {
    expect(isFirstPartyPackageName('@sparkelf/dsh-mobile-bridge')).toBe(false)
    expect(isFirstPartyDshPackageName('@sparkelf/dsh-mobile-bridge')).toBe(false)
    expect(() => shortDshPackageName('@sparkelf/dsh-mobile-bridge')).toThrow(/not a first-party DSH package/)
  })

  it('preserves the existing DeepSeek package family', () => {
    expect(isFirstPartyPackageName('@deepseek-ai/cordis')).toBe(true)
    expect(isFirstPartyDshPackageName('@deepseek-ai/dsh-agent')).toBe(true)
    expect(shortDshPackageName('@deepseek-ai/dsh-agent')).toBe('agent')
  })
})
