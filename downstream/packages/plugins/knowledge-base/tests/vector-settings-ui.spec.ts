import { describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'

const read = (path: string): Promise<string> => readFile(new URL(path, import.meta.url), 'utf8')

describe('vector settings surfaces', () => {
  it('uses one shared component in the DSH settings section and the panel settings page', async () => {
    const [section, panel, shared] = await Promise.all([
      read('../src/client/KnowledgeSettingsSection.tsx'),
      read('../src/client/KnowledgeSettings.tsx'),
      read('../src/client/VectorSettingsGroup.tsx'),
    ])
    expect(section).toContain("from './VectorSettingsGroup.tsx'")
    expect(section).toContain('<VectorSettingsGroup t={t} />')
    expect(panel).toContain("from './VectorSettingsGroup.tsx'")
    expect(panel).toContain('<VectorSettingsGroup t={')
    expect(shared).toContain('KB_API.configSet')
    expect(shared).toContain('KB_API.vectorRebuild')
    expect(shared).toContain("t('vectorRebuildConfirm')")
    expect(shared).toContain('canManageVector')
  })

  it('does not leave a second copy of vector business logic in the section', async () => {
    const section = await read('../src/client/KnowledgeSettingsSection.tsx')
    expect(section).not.toContain('interface VectorDraft')
    expect(section).not.toContain('rebuildVectors')
    expect(section).not.toContain('vectorDraft')
  })
})
