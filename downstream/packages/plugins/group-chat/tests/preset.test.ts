/**
 * The rule that turns a preset roster row into the copy an operator reads.
 *
 * The bug this guards is silent: the registry keys presets by the `config.id` a patch declares,
 * while a directory listing can only offer filenames. Every shipped preset happens to name its
 * file after its id, so reading filenames looks correct until a deployment renames a file — and
 * then the failure lands at room creation, far from the listing that was wrong.
 *
 * The mirror of that mistake is display copy: a shipped preset publishes no `name`, so its words
 * come from a locale key, whereas a preset that names itself owns its own words. Treating either
 * one as the other renders a key or an id instead of the name and never throws.
 *
 * @module tests/preset.test
 */

import { describe, expect, it } from 'vitest'
import { presetDisplay, presetOptions, PRESET_LOCALE_NS } from '../src/client/rows.ts'
import type { PresetOption } from '../src/client/api.ts'

/** A locale lookup that behaves like the platform's: a missing key resolves to the key. */
const lookup = (dictionary: Record<string, string>) => (key: string): string => dictionary[key] ?? key

const SHIPPED = { presetStandardName: '标准模式', presetStandardDescription: '处理代码、文件和资料。' }

describe('preset 显示文案', () => {
  it('内置 preset 走 locale，而不是把 id 当名字', () => {
    const preset: PresetOption = { id: 'standard', order: 1 }
    expect(presetDisplay(preset, lookup(SHIPPED))).toEqual({
      name: '标准模式',
      description: '处理代码、文件和资料。',
    })
  })

  it('自定义 preset 用它自己声明的名字，且不翻译', () => {
    const preset: PresetOption = { id: 'in-house', name: '内部模式', description: '只读工具。' }
    const copy = presetDisplay(preset, lookup(SHIPPED))
    expect(copy.name).toBe('内部模式')
    expect(copy.description).toBe('只读工具。')
  })

  it('locale 缺 key 时退回 id，而不是把 key 显示给用户', () => {
    // 平台改了 key 名，本插件没跟上 —— 这是真实会发生的漂移。
    const copy = presetDisplay({ id: 'standard' }, lookup({}))
    expect(copy.name).toBe('standard')
    expect(copy.name).not.toBe('presetStandardName')
    expect(copy.description).toBeUndefined()
  })

  it('roster 里的 id 与文件名不同时，取的是 id', () => {
    // 这条是本轮修复的核心：文件名 fancy-name.patch.yml 声明的是 config.id: standard。
    const row: PresetOption = { id: 'standard', name: undefined }
    expect(presetDisplay(row, lookup(SHIPPED)).name).toBe('标准模式')
  })
})

describe('preset 候选行', () => {
  it('保留 roster 顺序，不重排', () => {
    const rows = presetOptions(
      [{ id: 'standard', order: 1 }, { id: 'ptc', order: 2 }, { id: 'minimal', order: 3 }],
      lookup(SHIPPED),
    )
    expect(rows.map((row) => row.id)).toEqual(['standard', 'ptc', 'minimal'])
  })

  it('把描述放进 secondary，让选择器能搜到', () => {
    const rows = presetOptions([{ id: 'standard' }], lookup(SHIPPED))
    expect(rows[0]?.secondary).toBe('处理代码、文件和资料。')
  })

  it('无法激活的 preset 仍然列出但禁用，而不是消失', () => {
    const rows = presetOptions(
      [{ id: 'standard' }, { id: 'broken-one', broken: 'activation failed' }],
      lookup(SHIPPED),
    )
    expect(rows.map((row) => row.id)).toEqual(['standard', 'broken-one'])
    expect(rows[0]?.disabled).toBeUndefined()
    expect(rows[1]?.disabled).toBe(true)
  })
})

describe('locale 命名空间', () => {
  it('指向平台自己的命名空间，而不是本插件的', () => {
    // 抄一份文案会冻结今天的措辞，并在平台改词后与 hero 选择器不一致。
    expect(PRESET_LOCALE_NS).toBe('settings.agentPreset')
  })
})
