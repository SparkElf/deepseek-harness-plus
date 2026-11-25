/** Local compile-time declarations for the public Slots consumed by this external plugin. */

import type { SettingsMobileBridgeKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Settings page supplied by the Mobile Bridge plugin. */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
    /** Global overlay used for the phone revocation notice. */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }

  interface LocaleNamespaceMap {
    /** Mobile Bridge settings copy. */
    settingsMobileBridge: SettingsMobileBridgeKey
  }
}
