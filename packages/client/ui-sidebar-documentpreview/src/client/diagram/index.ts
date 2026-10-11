/** Builtin diagram metadata and keyed body registration; assembly belongs to the package entry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { DiagramBody, type DiagramFormat } from './DiagramBody.tsx'
import { en, zh } from './locales.ts'

/** draw.io implementation identity, shared by metadata and the keyed slot. */
export const DRAWIO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/drawio'

/** XMind implementation identity, shared by metadata and the keyed slot. */
export const XMIND_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/xmind'

/** File suffixes rendered by the draw.io body. */
export const DRAWIO_EXTENSIONS = ['drawio', 'dio'] as const

/** File suffixes rendered by the XMind body. */
export const XMIND_EXTENSIONS = ['xmind'] as const

/**
 * Describe one diagram renderer independently from its keyed body slot.
 * @param id - implementation identity.
 * @param extensions - recognized file suffixes.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete diagram files.
 */
function diagramDefinition(id: string, extensions: readonly string[], title: () => string): DocumentPreviewDefinition {
  return { id, extensions, priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the diagram dictionary, both format metadata entries, and their keyed bodies.
 *
 * The two formats share one body and one dictionary: the only difference is the parser the body
 * selects, which the registration supplies as a prop.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('documentDiagram')
  ctx.effect(() => ctx.locale.register('documentDiagram', { zh, en }))
  const entries: readonly { readonly id: string; readonly extensions: readonly string[]; readonly format: DiagramFormat }[] = [
    { id: DRAWIO_BODY_ID, extensions: DRAWIO_EXTENSIONS, format: 'drawio' },
    { id: XMIND_BODY_ID, extensions: XMIND_EXTENSIONS, format: 'xmind' },
  ]
  for (const entry of entries) {
    ctx.effect(() => ctx.documentPreviews.register(diagramDefinition(entry.id, entry.extensions, () => t('title'))))
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
      { name: 'sidebar.right.tab.document', key: entry.id, locale: 'documentDiagram', inject: () => ({ format: entry.format }) },
      DiagramBody,
    )))
  }
}
