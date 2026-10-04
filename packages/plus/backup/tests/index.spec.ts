/**
 * The root `apply` hands the archive routes.
 *
 * The archived user data lives under the Harness home. Deriving that root from the settings
 * document instead selected the profile directory, whose only planned entry is the profile
 * patch file: an export reported success while Session logs, attachments, Workspace storage,
 * credentials, and identity were all absent. The archive tests call the planner directly, so
 * only this test observes which root the plugin actually chooses.
 */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** Root and settings basename `registerBackupRoutes` received on the last call. */
const registered: { root: string | undefined; settingsFile: string | undefined } = { root: undefined, settingsFile: undefined }

vi.mock('../src/routes.ts', () => ({
  registerBackupRoutes: (_ctx: unknown, config: { settingsFile: string }, root: string) => {
    registered.root = root
    registered.settingsFile = config.settingsFile
  },
}))

const { apply } = await import('../src/index.ts')

/** The context services `apply` reads, with no Host services behind them. */
const context = () => ({
  settings: { documentPath: join('/some/home', 'profiles', 'web', 'cordis.patch.yml') },
}) as unknown as Parameters<typeof apply>[0]

beforeEach(() => {
  registered.root = undefined
  registered.settingsFile = undefined
})

describe('apply', () => {
  it('roots the archive at the Harness home, not beside the settings document', () => {
    apply(context())

    // The Harness home is the only directory holding every archived entry. A root beside the
    // document is the profile directory, which holds the patch file and no Session data.
    expect(registered.root).toBe(resolveDshHome())
    expect(registered.root).not.toBe(join('/some/home', 'profiles', 'web'))
  })

  it('keeps the manifest Settings filename as the document basename', () => {
    apply(context())

    // Import refuses a configuration archive whose manifest names another document, so the
    // basename must still come from the document rather than from the scanned root.
    expect(registered.settingsFile).toBe('cordis.patch.yml')
  })
})
