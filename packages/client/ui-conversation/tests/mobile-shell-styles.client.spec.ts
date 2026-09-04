import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
const conversation = read('../src/client/skeleton/ConversationRoot.module.css')
const settings = read('../../ui-settings-general/src/client/SettingsRoot.module.css')
const jobs = read('../../ui-jobs/src/client/JobListAction.module.css')
const schedule = read('../../ui-schedule/src/client/ScheduleCatalogAction.module.css')
const sessionExport = read('../../../session-query/session-log-export/src/client/HeaderAction.module.css')
const models = read('../../ui-model-selection/src/client/ModelSelect.module.css')

describe('mobile shell responsive contracts', () => {
  it('places task actions beside tabs and keeps title utilities separate', () => {
    expect(conversation).toContain('container-type: inline-size;')
    const mobile = conversation.slice(conversation.lastIndexOf('@media (max-width: 800px)'))
    expect(mobile).toContain('position: absolute;')
    expect(mobile).toContain('padding-right: 150px;')
  })

  it('uses a full-screen Settings navigation-to-detail flow', () => {
    const mobile = settings.slice(settings.indexOf('@media (max-width: 640px)'))
    expect(mobile).toContain('inset: 0;')
    expect(mobile).toContain('.detailOpen .nav')
    expect(mobile).toContain('.detailOpen .content')
    expect(mobile).toContain('overflow-x: hidden;')
  })

  it('collapses every header action family on phone widths', () => {
    expect(jobs).toContain('.compactLabel')
    expect(jobs).toContain('width: min(336px, 92cqw);')
    expect(schedule).toContain('.count {')
    expect(schedule).toContain('display: none;')
    expect(sessionExport).toContain('width: 28px;')
  })

  it('portals the mobile model menu outside composer clipping', () => {
    expect(models).toContain('.portalMenu {')
    expect(models).toContain('position: fixed;')
    expect(models).toContain('z-index: 100;')
  })
})
