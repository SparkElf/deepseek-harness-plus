import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const conversation = read('../src/client/skeleton/ConversationRoot.module.css')
const inputBar = read('../src/client/skeleton/InputBar.module.css')
const sessionHeader = read('../src/client/skeleton/ConversationSession.tsx')
const settings = read('../../ui-settings-general/src/client/SettingsRoot.module.css')
const jobs = read('../../ui-jobs/src/client/JobListAction.module.css')
const schedule = read('../../ui-schedule/src/client/ScheduleCatalogAction.module.css')
const sessionExport = read('../../../session-query/session-log-export/src/client/HeaderAction.module.css')
const models = read('../../ui-model-selection/src/client/ModelSelect.module.css')

describe('mobile shell responsive contracts', () => {
  it('preserves desktop order while placing only mobile task actions beside tabs', () => {
    expect(conversation).not.toContain('container-type: inline-size;')
    expect(conversation).toContain('.headerContext')
    expect(sessionHeader.indexOf('data-session-header-context')).toBeLessThan(sessionHeader.indexOf('data-session-header-actions'))
    expect(sessionHeader.indexOf('data-session-header-actions')).toBeLessThan(sessionHeader.indexOf('data-session-header-utilities'))
    const mobile = conversation.slice(conversation.lastIndexOf('@media (max-width: 800px)'))
    expect(mobile).toContain('position: absolute;')
    expect(mobile).toContain('padding-right: min(112px, 32vw);')
    expect(mobile).toContain('writing-mode: horizontal-tb;')
    const ultraNarrow = inputBar.slice(inputBar.indexOf('@container (max-width: 340px)'))
    expect(ultraNarrow).toContain('gap: 2px;')
    expect(ultraNarrow).toContain('padding-right: 6px;')
    expect(ultraNarrow).toContain('.trailing > [data-context-meter]')
  })

  it('uses a full-screen Settings navigation-to-detail flow', () => {
    const mobile = settings.slice(settings.indexOf('@media (max-width: 640px)'))
    expect(mobile).toContain('inset: 0;')
    expect(mobile).toContain('.detailOpen .nav')
    expect(mobile).toContain('.detailOpen .content')
    expect(mobile).toContain('overflow-x: hidden;')
  })

  it('collapses every header action family on phone widths', () => {
    expect(jobs).toContain('.compactIcon')
    expect(jobs).toContain('width: 336px;')
    expect(jobs).toContain('width: min(336px, calc(100vw - 80px));')
    expect(schedule).toContain('.count {')
    expect(schedule).toContain('display: none;')
    expect(sessionExport).toContain('@media (max-width: 800px)')
    expect(sessionExport).toContain('width: 28px;')
    expect(sessionExport).not.toContain('position: fixed;')
  })

  it('portals the mobile model menu outside composer clipping', () => {
    expect(models).toContain('.portalMenu {')
    expect(models).toContain('position: fixed;')
    expect(models).toContain('z-index: 100;')
  })
})
