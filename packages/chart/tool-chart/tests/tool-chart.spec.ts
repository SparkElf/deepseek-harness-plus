import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolChart from '../src/index.ts'

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

describe('render_chart', () => {
  it('keeps the canonical result compact and persists the complete option in presentation metadata', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(ToolChart).await()

    const option = {
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'category', data: ['Jan', 'Feb'] },
      yAxis: { type: 'value' },
      series: [{ type: 'line', data: [12, 18] }],
    }
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('chart-1'),
      name: 'render_chart',
      arguments: {
        sourceResultRef: '  qr1_example  ',
        title: '  Monthly cases  ',
        option,
      },
    })

    expect(result.isError).toBe(false)
    expect(result.value).toEqual({ rendered: true, sourceResultRef: 'qr1_example', title: 'Monthly cases' })
    expect(result.meta).toEqual({
      version: 1,
      sourceResultRef: 'qr1_example',
      title: 'Monthly cases',
      option,
    })
    expect(text(result)).toContain('Monthly cases')
    expect(text(result)).not.toContain(JSON.stringify(option))

    await ctx.fiber.dispose()
  })

  it('rejects a blank provenance reference instead of recording an ambiguous chart', async () => {
    const ctx = new Context()
    await ctx.plugin(ToolRuntime).await()
    await ctx.plugin(ToolChart).await()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('chart-blank-ref'),
      name: 'render_chart',
      arguments: { sourceResultRef: '   ', option: { series: [] } },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('sourceResultRef must be a non-empty string')
    await ctx.fiber.dispose()
  })
})
