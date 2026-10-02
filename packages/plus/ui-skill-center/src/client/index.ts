/**
 * Skill center — browser half. Contributes the sidebar entry and the panel it
 * opens through the same official slots the Plugins panel uses: a
 * `sidebar.panellist` row and a keyed `main` page, with the sidebar shell
 * owning the button, label, and selected state around the glyph.
 *
 * @module @sparkelf/dsh-client-ui-skill-center/client
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the slot, layout, sidebar, and locale service merges.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// The re-export carries this page's slot declaration to the plugins that contribute to it: a
// bare `import type {}` is erased from the emitted types, while a type export keeps the module
// in the declaration graph.
export type { SkillCenterSectionOwnerProps } from './slot-contract.ts'
import { SkillCenterPage } from './SkillCenterPage.tsx'
import { SkillCenterPanelIcon } from './SkillCenterPanelIcon.tsx'
import { en, zh, type SkillCenterLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Skill center panel copy. */
    'skillCenter': SkillCenterLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'skillCenter'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'skill-center' as MainPanelId

/** Services required by the sidebar and page registrations. */
export const inject = ['slots', 'locale']

/**
 * Contribute the Skill Center entry and the page it opens.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skill-center: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    children: {
      // A section another plugin contributes to this page. It stays empty unless one is
      // installed, so a profile without such a plugin renders the page as it always has.
      'skill-center.section': { kind: 'list', scope: 'root' },
    },
  }, SkillCenterPage))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 10,
    label: () => t('panel'),
    locale: NS,
  }, SkillCenterPanelIcon))
}
