// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ChartRow, type ChartRowProps } from '../src/client/ChartRow.tsx'
import type { ChartKey } from '../src/client/locales.ts'

const mocks = vi.hoisted(() => ({
  setOption: vi.fn(),
  resize: vi.fn(),
  dispose: vi.fn(),
  init: vi.fn(),
}))

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconInspectOutline12: () => null,
}))

vi.mock('echarts', () => ({
  init: mocks.init,
}))

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

const copy: Record<ChartKey, string> = {
  'row.title': 'Interactive chart',
  'state.rendering': 'Rendering chart…',
  'state.failed': 'Chart rendering failed',
  'state.unavailable': 'Chart data is unavailable',
  'action.inspect': 'Inspect',
  'chart.aria': 'Interactive data chart',
}

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
    t: (key: ChartKey) => copy[key],
  } as unknown as ChartRowProps
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  document.body.removeAttribute('data-ds-dark-theme')
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
  document.body.removeAttribute('data-ds-dark-theme')
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ChartRow', () => {
  it('renders replay metadata through ECharts and disposes the instance on unmount', () => {
    const option = { xAxis: { type: 'category', data: ['A', 'B'] }, yAxis: {}, series: [{ type: 'bar', data: [1, 2] }] }
    const view = render(<ChartRow {...props({ version: 1, sourceResultRef: 'qr1_x', title: 'Cases', option })} />)

    expect(screen.getByText('Cases')).toBeTruthy()
    expect(mocks.init).toHaveBeenCalledWith(expect.any(HTMLDivElement), undefined)
    expect(mocks.setOption).toHaveBeenCalledWith(option, { notMerge: true, lazyUpdate: false })

    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })

  it('recreates the chart when the Harness theme changes and disposes both instances', async () => {
    const option = { series: [{ type: 'line', data: [1, 2] }] }
    const view = render(<ChartRow {...props({ version: 1, sourceResultRef: 'qr1_theme', option })} />)

    document.body.setAttribute('data-ds-dark-theme', '')
    await waitFor(() => { expect(mocks.init).toHaveBeenCalledTimes(2) })
    expect(mocks.init).toHaveBeenLastCalledWith(expect.any(HTMLDivElement), 'dark')
    expect(mocks.dispose).toHaveBeenCalledTimes(1)

    view.unmount()
    expect(mocks.dispose).toHaveBeenCalledTimes(2)
  })

  it('shows a user-facing failure without exposing an ECharts exception', () => {
    const failure = new Error('internal option parser detail')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.setOption.mockImplementationOnce(() => { throw failure })
    render(<ChartRow {...props({ version: 1, sourceResultRef: 'qr1_bad', option: { series: [] } })} />)

    expect(consoleError).toHaveBeenCalledWith('dsh-chart: ECharts render failed', failure)
    expect(screen.getByRole('alert').textContent).toBe('Chart rendering failed')
    expect(screen.queryByText('internal option parser detail')).toBeNull()
    expect(mocks.dispose).toHaveBeenCalledTimes(1)
  })

  it('fails soft when replay metadata is missing instead of initializing ECharts', () => {
    render(<ChartRow {...props({ nope: true })} />)
    expect(screen.getByText('Chart data is unavailable')).toBeTruthy()
    expect(mocks.init).not.toHaveBeenCalled()
  })
})
