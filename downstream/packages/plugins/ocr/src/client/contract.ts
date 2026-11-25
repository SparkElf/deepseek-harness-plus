/**
 * Compile-time declarations for the public slots this plugin consumes.
 *
 * `SlotMap` and `LocaleNamespaceMap` are declaration-merged by every plugin that occupies a
 * slot, so the entry a plugin contributes is also the type its registration is checked
 * against. Declaring them here is what makes a `kind`/`scope` mistake a compile error rather
 * than a registration the shell silently refuses.
 *
 * @module @sparkelf/dsh-ocr/client/contract
 */

import type { SettingsOcrKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One section of the Settings page.
     *
     * `list` = any number of sections share the page; `root` = the page belongs to no
     * Session, which is why it may not read session state.
     */
    'settings.section': {
      kind: 'list'
      scope: 'root'
      owner: { close: () => void }
    }
  }

  interface LocaleNamespaceMap {
    /** Document-recognition settings copy. */
    settingsOcr: SettingsOcrKey
  }
}
