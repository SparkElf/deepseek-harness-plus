/**
 * 工具层回归测试：年化参数暴露 + 无 trades 时不得返回 undefined 字段。
 *
 * 两个缺陷都继承自上游 dsh-quant@0.90.0：
 *  1. `quant_metrics` / `quant_risk` 的 schema 未暴露 annualization，
 *     库层虽已支持，但 Agent 通过工具调用无法使用（A 股夏普虚高 22.6%）。
 *  2. `return { ...equity, tradeMetrics: trades }` 在 trades 为 undefined 时
 *     产出一个 undefined 属性；registry 以 lossless JSON 序列化返回值，
 *     该属性会导致 "tool quant_metrics returned invalid output"。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../src/index.js'
import type { Context } from '@deepseek-ai/cordis'

/** 捕获 apply() 注册的所有工具。 */
function captureTools(): Record<string, any> {
  const captured: Record<string, any> = {}
  const ctx = {
    tools: { register: (def: any) => { captured[def.name] = def; return () => {} } },
    systemPrompt: { tools: () => {} },
    effect: (fn: () => unknown) => { fn(); return () => {} },
  } as unknown as Context
  plugin.apply(ctx)
  return captured
}

const equity = [1, 1.02, 1.01, 1.05, 1.03, 1.08, 1.06, 1.12, 1.09, 1.15, 1.11, 1.20]
const signal = new AbortController().signal

test('tools: quant_metrics 与 quant_risk 的 schema 暴露 annualization', () => {
  const tools = captureTools()
  assert.ok(JSON.stringify(tools['quant_metrics']!.parameters).includes('annualization'))
  assert.ok(JSON.stringify(tools['quant_risk']!.parameters).includes('annualization'))
})

test('regression: quant_metrics 在无 trades 时不返回 undefined 字段', async () => {
  const tools = captureTools()
  const value = await tools['quant_metrics']!.execute({ equityCurve: equity }, { signal })
  const undefinedKeys = Object.entries(value).filter(([, v]) => v === undefined).map(([k]) => k)
  assert.deepEqual(undefinedKeys, [], 'undefined properties fail the lossless-JSON output check')
  // 同时确认 tradeMetrics 确实被省略，而不是被写成 null
  assert.equal('tradeMetrics' in value, false)
})

test('regression: quant_metrics 传入 trades 时仍返回 tradeMetrics', async () => {
  const tools = captureTools()
  const trades = [{ entryIndex: 0, exitIndex: 5, returnPct: 0.02 }]
  const value = await tools['quant_metrics']!.execute({ equityCurve: equity, trades }, { signal })
  assert.equal(value.tradeMetrics.tradeCount, 1)
  assert.equal(value.tradeMetrics.winRate, 100)
})

test('quant_metrics: annualization 改变年化结果（A 股用 243）', async () => {
  const tools = captureTools()
  const a = await tools['quant_metrics']!.execute({ equityCurve: equity, annualization: 243 }, { signal })
  const b = await tools['quant_metrics']!.execute({ equityCurve: equity, annualization: 365 }, { signal })
  assert.ok(Math.abs(b.sharpe / a.sharpe - Math.sqrt(365 / 243)) < 1e-9)
  assert.ok(Math.abs(b.annualizedVol / a.annualizedVol - Math.sqrt(365 / 243)) < 1e-9)
})

test('quant_metrics: 非法 annualization 被拒绝', async () => {
  const tools = captureTools()
  await assert.rejects(() => tools['quant_metrics']!.execute({ equityCurve: equity, annualization: 0 }, { signal }), /annualization/)
})

test('quant_risk: annualization 影响信息比率与跟踪误差', async () => {
  const tools = captureTools()
  const returns = [0.01, -0.02, 0.03, 0.01, -0.01, 0.02]
  const bench = returns.map(r => r * 0.8)
  const a = await tools['quant_risk']!.execute({ returns, benchmarkReturns: bench, annualization: 243 }, { signal })
  const b = await tools['quant_risk']!.execute({ returns, benchmarkReturns: bench, annualization: 365 }, { signal })
  assert.ok(Math.abs(b.trackingError / a.trackingError - Math.sqrt(365 / 243)) < 1e-9)
})
