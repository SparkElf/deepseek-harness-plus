import { describe, expect, it } from 'vitest'
import { plusMemberNamesAt } from './sync-plus-mirror.ts'

describe('plusMemberNamesAt', () => {
  it('names every Plus member at the release version', () => {
    // The sync step must cover the whole closure: a package left out of the request is
    // exactly the 404 a consumer hits after the publisher's install succeeded.
    const names = plusMemberNamesAt(process.cwd(), '0.1.0-rc.34')
    expect(names.length).toBeGreaterThan(10)
    expect(names).toContain('@sparkelf/dsh-plus')
    expect(names).toContain('@sparkelf/dsh-patch-better-sidebar-media-path')
  })

  it('refuses a version no member declares', () => {
    // Matching nothing would otherwise report success for a release that does not exist.
    expect(() => plusMemberNamesAt(process.cwd(), '0.1.0-rc.99'))
      .toThrow(/no Plus member declares version/u)
  })
})
