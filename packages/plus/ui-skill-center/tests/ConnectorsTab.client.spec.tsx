// @vitest-environment jsdom
/**
 * Connector tab states: loading/failure/empty, the demo notice, and the two
 * write callbacks the card exposes. Visibility of permitted capabilities is
 * asserted on the page-level tab spec; this file covers the states around it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ConnectorsTab } from '../src/client/ConnectorsTab.tsx'
import { zh } from '../src/client/locales.ts'
import type { Connector } from '../src/client/connectors.ts'

const t = (key: keyof typeof zh): string => zh[key]
const connector: Connector = {
  id: 'wanxiang-ai',
  name: '万相AI中台连接器',
  enabled: true,
  capabilities: [
    { id: 'approval.read', name: '读取审批任务', enabled: true, permitted: true },
    { id: 'task.writeback', name: '回写任务状态', enabled: false, permitted: true, unavailableReason: '未开通' },
  ],
}

afterEach(cleanup)

function mount(state: Parameters<typeof ConnectorsTab>[0]['state'], overrides: Partial<Parameters<typeof ConnectorsTab>[0]> = {}): void {
  render(
    <ConnectorsTab
      state={state}
      query=""
      busyId={null}
      t={t}
      onRetry={() => undefined}
      onToggleConnector={() => undefined}
      onToggleCapability={() => undefined}
      {...overrides}
    />,
  )
}

describe('ConnectorsTab states', () => {
  it('renders the loading state', () => {
    mount({ kind: 'loading' })
    expect(screen.getByText('正在加载连接器…')).toBeTruthy()
  })

  it('renders a failure with a retry action', () => {
    const onRetry = vi.fn()
    mount({ kind: 'failed', message: 'gateway down' }, { onRetry })
    expect(screen.getByRole('alert').textContent).toContain('gateway down')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetry).toHaveBeenCalled()
  })

  it('renders empty and no-match states separately', () => {
    mount({ kind: 'ready', catalogue: { connectors: [], demo: false } })
    expect(screen.getByText('暂无连接器')).toBeTruthy()
    cleanup()
    mount({ kind: 'ready', catalogue: { connectors: [connector], demo: false } }, { query: 'nothing' })
    expect(screen.getByText('无匹配连接器')).toBeTruthy()
  })

  it('renders the demo notice and both cards', () => {
    mount({ kind: 'ready', catalogue: { connectors: [connector], demo: true } })
    expect(screen.getByText('当前显示示例连接器，后端接入后自动替换')).toBeTruthy()
    expect(document.querySelector('[data-connector-id="wanxiang-ai"]')).not.toBeNull()
  })

  it('shows an enabled connector with no visible capability as an explicit empty list', () => {
    mount({
      kind: 'ready',
      catalogue: {
        connectors: [{ ...connector, capabilities: [{ id: 'hidden', name: '隐藏能力', enabled: false, permitted: false }] }],
        demo: false,
      },
    })
    expect(screen.getByText('当前账号没有可用的连接器能力')).toBeTruthy()
    expect(document.querySelector('[data-capability-id="hidden"]')).toBeNull()
  })

  it('shows the connection-failure label and detail', () => {
    mount({
      kind: 'ready',
      catalogue: {
        connectors: [{ ...connector, connected: false, error: '握手失败' }],
        demo: false,
      },
    })
    expect(screen.getByText('连接异常')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toContain('握手失败')
  })

  it('matches the connector by vendor, description, or a visible capability', () => {
    mount(
      { kind: 'ready', catalogue: { connectors: [{ ...connector, vendor: 'DataOps', description: '中台连接' }], demo: false } },
      { query: '读取审批' },
    )
    expect(document.querySelector('[data-connector-id="wanxiang-ai"]')).not.toBeNull()
  })

  it('disables the card switches while a write is in flight', () => {
    mount(
      { kind: 'ready', catalogue: { connectors: [connector], demo: false } },
      { busyId: 'wanxiang-ai:approval.read' },
    )
    expect((screen.getByRole('switch', { name: '停用 读取审批任务' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('switch', { name: '停用 万相AI中台连接器' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('forwards connector and capability toggles', () => {
    const onToggleConnector = vi.fn()
    const onToggleCapability = vi.fn()
    mount({ kind: 'ready', catalogue: { connectors: [connector], demo: false } }, { onToggleConnector, onToggleCapability })
    fireEvent.click(screen.getByRole('switch', { name: '停用 万相AI中台连接器' }))
    expect(onToggleConnector).toHaveBeenCalledWith(connector, false)
    fireEvent.click(screen.getByRole('switch', { name: '停用 读取审批任务' }))
    expect(onToggleCapability).toHaveBeenCalledWith(connector, connector.capabilities[0], false)
  })
})