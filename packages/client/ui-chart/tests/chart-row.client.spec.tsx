// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ChartRow, type ChartRowProps } from '../src/client/ChartRow.tsx'

const mocks = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  init: vi.fn(),
}))

vi.mock('echarts', () => ({
  init: mocks.init,
}))

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const copy = {
  'row.title': 'Interactive chart',
  'state.rendering': 'Rendering chart…',
  'state.failed': 'Chart rendering failed',
  'state.unavailable': 'Chart data is unavailable',
  'action.inspect': 'Inspect',
  'chart.aria': 'Interactive data chart',
} as const

function props(meta: Record<string, unknown>): ChartRowProps {
  return {
    callId: 'chart-1',
    toolName: 'render_chart',
    block: {
      kind: 'tool-result',
      seq: 1,
      time: 1,
      turn: 1,
      step: 1,
      callId: 'chart-1',
      call: { name: 'render_chart', argsRaw: '{}' },
      content: [],
      isError: false,
      meta,
      callView: null,
      resultView: null,
      subCalls: [],
    },
    openFile: () => {},
    t: key => copy[key],
  } as unknown as ChartRowProps
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  mocks.setOption.mockReset()
  mocks.resize.mockReset()
  mocks.dispose.mockReset()
  mocks.init.mockReset()
  mocks.init.mockReturnValue({
    setOption: mocks.setOption,
    resize: mocks.resize,
    dispose: mocks.dispose,
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ChartRow', () => {
  it('renders replay metadata through ECharts and disposes the instance on unmount', () => {
    const option = { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'bar', data: [1, 2] }] }
    const view = render(<ChartRow {...props({ version: 1, sourceResultRef: 'qr1_x', title: 'Cases', option })} />)

    expect(screen.getByText('Cases')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledTimes(1)
    expect(mocks.setOption).toHaveBeenCalledWith(option, { notMerge: true, lazyUpdate: false })

    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })

  it('fails soft when replay metadata is missing instead of trying to initialize ECharts', () => {
    render(<ChartRow {...props({ nope: true })} />)
    expect(screen.getByText('Chart data is unavailable')).toBeTruthy()
    expect(mocks.init).not.toHaveBeenCalled()
  })
})
