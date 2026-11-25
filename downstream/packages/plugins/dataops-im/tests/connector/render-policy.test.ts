import { describe, expect, it } from 'vitest'
import {
  renderAssistantReply,
  resolveReplyAudience,
  sanitizeGenUiPreview,
  scanGenUiFences,
  stripGenUiFences,
} from '../../src/connector/render-policy.ts'
import { parseGenUiSpec } from '../../src/connector/genui-format.ts'

function fence(spec: unknown): string {
  return '```dsh-ui\n' + JSON.stringify(spec) + '\n```'
}

const calloutSpec = {
  title: '本周概览',
  items: [
    { type: 'callout', tone: 'info', title: '结论', content: '整体运行正常。' },
    { type: 'table', columns: ['指标', '数值'], rows: [['任务数', '12'], ['成功率', '98%']] },
  ],
}

const chartSpec = {
  title: '趋势',
  items: [
    { type: 'chart', kind: 'line', data: [{ label: '周一', value: 3 }, { label: '周二', value: 8 }] },
  ],
}

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('renderAssistantReply', () => {
  it('普通文本原样返回', async () => {
    const text = '这是一条普通回复，没有 GenUI。\n第二行。'
    const rendered = await renderAssistantReply(text, { channel: 'wecom' })
    expect(rendered.hadGenUI).toBe(false)
    expect(rendered.segments).toEqual([{ kind: 'text', text }])
    expect(rendered.fallbackReason).toBeUndefined()
  })

  it('合法 spec 转成可读文本，不回显 JSON', async () => {
    const rendered = await renderAssistantReply(
      `先看结论。\n\n${fence(calloutSpec)}\n\n详情如上。`,
      { channel: 'wecom' },
    )
    expect(rendered.hadGenUI).toBe(true)
    expect(rendered.segments.every(segment => segment.kind === 'text')).toBe(true)
    const text = rendered.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('\n')
    expect(text).toContain('先看结论')
    expect(text).toContain('【提示】')
    expect(text).toContain('整体运行正常')
    expect(text).toContain('任务数')
    expect(text).toContain('详情如上')
    expect(text).not.toContain('```')
    expect(text).not.toContain('"type"')
    expect(text).not.toContain('dsh-ui')
  })

  it('坏 JSON 删除围栏并给出提示', async () => {
    const rendered = await renderAssistantReply('前文\n\n```dsh-ui\n{not json}\n```\n\n后文', { channel: 'wecom' })
    expect(rendered.hadGenUI).toBe(true)
    expect(rendered.fallbackReason).toBe('parse_failed')
    const text = rendered.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('\n')
    expect(text).toContain('无法解析')
    expect(text).toContain('后文')
    expect(text).not.toContain('{not json}')
    expect(text).not.toContain('```')
  })

  it('未闭合围栏也不会漏出 JSON', async () => {
    const rendered = await renderAssistantReply('前文\n\n```dsh-ui\n{"items":[{"type":"text","content":"半截', { channel: 'wecom' })
    expect(rendered.fallbackReason).toBe('parse_failed')
    const text = rendered.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('\n')
    expect(text).not.toContain('"items"')
    expect(text).not.toContain('```')
  })

  it('大表格只给摘要 + 附件建议', async () => {
    const rows = Array.from({ length: 10 }, (_value, index) => [`行${String(index + 1)}`, 'A', 'B', 'C', `唯一值${String(index + 1)}`])
    const spec = {
      title: '明细',
      items: [{ type: 'table', columns: ['名称', '列二', '列三', '列四', '列五'], rows }],
    }
    const rendered = await renderAssistantReply(fence(spec), { channel: 'wecom' })
    const text = rendered.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('\n')
    expect(text).toContain('共 10 行 × 5 列')
    expect(text).toContain('导出 CSV/Excel')
    expect(text).not.toContain('唯一值10')
    expect(text).not.toContain('"rows"')
  })

  it('图表无 Chrome 时返回文本 + render_failed', async () => {
    const rendered = await renderAssistantReply(fence(chartSpec), { channel: 'wecom' }, {
      renderPng: async () => {
        throw new Error('no chrome')
      },
    })
    expect(rendered.fallbackReason).toBe('render_failed')
    expect(rendered.segments.every(segment => segment.kind === 'text')).toBe(true)
    const text = rendered.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('\n')
    expect(text).toContain('图片渲染失败')
    expect(text).toContain('周一')
    expect(text).not.toContain('"data"')
  })

  it('图表渲染成功返回 image segment', async () => {
    const rendered = await renderAssistantReply(fence(chartSpec), { channel: 'wecom' }, {
      renderPng: async () => [png],
    })
    expect(rendered.fallbackReason).toBeUndefined()
    const image = rendered.segments.find(segment => segment.kind === 'image')
    expect(image).toBeDefined()
    if (image?.kind === 'image') {
      expect(image.png.byteLength).toBe(png.byteLength)
      expect(image.alt).toContain('趋势')
    }
  })

  it('多个围栏按原顺序产出 segment', async () => {
    const rendered = await renderAssistantReply(
      `${fence(chartSpec)}\n\n中间正文\n\n${fence(calloutSpec)}`,
      { channel: 'wecom' },
      { renderPng: async () => [png] },
    )
    const kinds = rendered.segments.map(segment => segment.kind)
    expect(kinds).toEqual(['image', 'text'])
    const text = rendered.segments.map(segment => segment.kind === 'text' ? segment.text : '').join('\n')
    expect(text).toContain('中间正文')
    expect(text).toContain('整体运行正常')
  })
})

describe('audience', () => {
  it('未提供 hint 时默认 fail closed sender_only', async () => {
    const rendered = await renderAssistantReply(fence(calloutSpec), { channel: 'wecom' })
    expect(rendered.audience).toBe('sender_only')
  })

  it('公开周报 + room_safe hint 保持公开', async () => {
    const rendered = await renderAssistantReply(`本周工作周报\n${fence(calloutSpec)}`, {
      channel: 'wecom',
      audienceHint: 'room_safe',
    })
    expect(rendered.audience).toBe('room_safe')
  })

  it('hint=sender_only 时公开内容也不会回群', async () => {
    const rendered = await renderAssistantReply('本周工作周报：整体正常', {
      channel: 'wecom',
      audienceHint: 'sender_only',
    })
    expect(rendered.audience).toBe('sender_only')
  })

  it('硬敏感内容即使 hint=room_safe 也降为 sender_only', async () => {
    const rendered = await renderAssistantReply('密码：abc12345', {
      channel: 'wecom',
      audienceHint: 'room_safe',
    })
    expect(rendered.audience).toBe('sender_only')
  })

  it('无 hint 的明确公开摘要可判 room_safe', () => {
    expect(resolveReplyAudience('会议纪要：本周完成三件事')).toBe('room_safe')
    expect(resolveReplyAudience('resource:table:foo 的数据')).toBe('sender_only')
  })
})

describe('fence helpers', () => {
  it('扫描完整/未闭合围栏', () => {
    const complete = scanGenUiFences('a\n```dsh-ui\n{}\n```\nb')
    expect(complete).toHaveLength(1)
    expect(complete[0]?.terminated).toBe(true)
    const open = scanGenUiFences('a\n```dsh-ui\n{"items":')
    expect(open).toHaveLength(1)
    expect(open[0]?.terminated).toBe(false)
  })

  it('strip 删除围栏内容', () => {
    expect(stripGenUiFences('前\n```dsh-ui\n{"a":1}\n```\n后')).toBe('前\n\n后')
  })

  it('预览截断半截 JSON', () => {
    const preview = sanitizeGenUiPreview('处理中\n```dsh-ui\n{"items":[{"type":"text"')
    expect(preview).toBe('处理中')
    expect(sanitizeGenUiPreview('```dsh-ui\n{')).toBe('正在整理结果…')
  })
})

describe('parseGenUiSpec', () => {
  it('接受 items 包装和裸数组', () => {
    expect(parseGenUiSpec('{"items":[{"type":"text","content":"x"}]}')?.items).toHaveLength(1)
    expect(parseGenUiSpec('[{"type":"text","content":"x"}]')?.items).toHaveLength(1)
    expect(parseGenUiSpec('{"foo":1}')).toBeUndefined()
  })
})