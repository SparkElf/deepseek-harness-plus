// @ts-nocheck
/**
 * The one official slot this plugin shadows, declared structurally.
 *
 * `settings.launcher` belongs to `@deepseek-ai/dsh-client-ui-settings`, which this
 * package deliberately does not depend on: a peer pin would tie the plugin to one
 * official UI version and make a profile that ships another fail to activate. The
 * declaration below mirrors `SettingsLauncherOwnerProps` from
 * `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts` for the parts this
 * plugin uses; declaration merging adds members, so a deployment that loads the
 * official declaration still resolves the real, fully typed one.
 *
 * @module @sparkelf/dsh-dataops-account/client/contract
 */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The account launcher in the sidebar foot.
     *
     * A `single` cell: the lowest live priority renders, so registering at a
     * negative priority shadows the official `AccountMenu` without patching it.
     */
    'settings.launcher': {
      kind: 'single'
      scope: 'root'
      owner: {
        /** Whether the sidebar shows labels. */
        readonly wide: boolean
        /** Whether the settings dialog covers the sidebar. */
        readonly settingsOpen: boolean
        /** Effective Settings key labels and accessible combination; omitted when unbound. */
        readonly settingsShortcut?: {
          readonly keys: readonly string[]
          readonly aria?: string | undefined
        }
        /** Open the settings panel. */
        readonly openSettings: () => void
        /** @param id - registered onboarding editor to open explicitly. */
        readonly openOnboarding: (id: string) => void
      }
    }
  }
}

export {}