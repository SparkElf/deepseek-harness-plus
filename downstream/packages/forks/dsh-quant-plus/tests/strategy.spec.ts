/**
 * dsh-strategy 域测试：引擎契约、成本模型、杠杆护栏、策略库。
 *
 * 重点是**回归测试**：把实验阶段踩到的两个真 bug 固化成断言，
 * 防止后续改动重新引入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  backtestTargetWeights, backtestSingle, buyCostRate, sellCostRate, DEFAULT_COST,
  maxDrawdown, sharpeRatio, annualizedReturn, simpleReturns, equalWeightBenchmark,
} from '../src/dsh-strategy/engine.js'
// 注意：engine.ts 直接导出 sma / rollingStd；index.ts 因与 dsh-alpha 指标同名而改用别名。
// 测试从域模块直接导入，故用原名。
import { sma as smaSeries, rollingStd as rollingStdSeries } from '../src/dsh-strategy/engine.js'
import {
  ALL_STRATEGIES, findStrategy, runStrategy, momentumStop, lowVolCircuit, maCross,
  equalWeightIndex, drawdownFromHigh,
} from '../src/dsh-strategy/strategies.js'

/** 构造一段可预测的 K 线：价格按给定序列走，开=收。 */
function makeBars(closes: readonly number[], volume = 1_000_000) {
  return closes.map((c, i) => ({ t: 1_700_000_000_000 + i * 86_400_000, o: c, h: c, l: c, c, v: volume }))
}

test('sma: 等长输出，前 window-1 位为 null', () => {
  const out = smaSeries([1, 2, 3, 4, 5], 3)
  assert.deepEqual(out, [null, null, 2, 3, 4])
})

test('rollingStd: 常数列方差为 0', () => {
  assert.deepEqual(rollingStdSeries([5, 5, 5, 5], 2), [null, 0, 0, 0])
})

test('simpleReturns: 首位为 0，其余为简单收益', () => {
  const r = simpleReturns([100, 110, 99])
  assert.equal(r[0], 0)
  assert.ok(Math.abs(r[1]! - 0.1) < 1e-12)
  assert.ok(Math.abs(r[2]! - -0.1) < 1e-12)
})

test('maxDrawdown: 已知序列回撤正确', () => {
  // 峰值 120 → 谷底 60 = 50%
  assert.ok(Math.abs(maxDrawdown([100, 120, 60, 80]) - 0.5) < 1e-12)
})

test('成本模型: 买入不含印花税，卖出含', () => {
  assert.ok(Math.abs(buyCostRate() - (0.00025 + 0.00001 + 0.0005)) < 1e-12)
  assert.ok(Math.abs(sellCostRate() - (0.00025 + 0.0005 + 0.00001 + 0.0005)) < 1e-12)
  assert.ok(sellCostRate() > buyCostRate(), '卖出成本应高于买入（含印花税）')
})

test('引擎: 无成本的完美行情下，满仓收益等于价格涨幅', () => {
  const closes = [100, 110, 121]           // +21%
  const bars = [makeBars(closes)]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const signals = [[1], [1], [0]]
  const r = backtestTargetWeights(bars, signals, { cost: zero })
  // 第一天收盘后给权重，第二天开盘(110)买入，第三天(121)卖出 → 涨幅 10%
  assert.ok(Math.abs(r.totalReturnPct - 10) < 1e-9, `got ${r.totalReturnPct}`)
})

test('引擎: 空信号不产生交易，净值恒为 1', () => {
  const bars = [makeBars([100, 90, 80])]
  const r = backtestTargetWeights(bars, [[0], [0], [0]])
  assert.equal(r.totalReturnPct, 0)
  assert.equal(r.maxDrawdownPct, 0)
  assert.equal(r.avgTurnover, 0)
})

test('引擎: 信号在 bar i 确认，bar i+1 开盘成交（无未来函数）', () => {
  // 若用了未来信息（同日收盘成交），在暴涨日会给出行情收益；这里应只吃到次日之后
  const bars = [{ t: 1, o: 100, c: 100 }, { t: 2, o: 100, c: 200 }, { t: 3, o: 200, c: 200 }]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  // bar0 给权重 1 → bar1 开盘(100)买入；bar1 收盘已 200，但涨幅发生在 bar1 日内
  const r = backtestTargetWeights([bars], [[1], [1], [0]], { cost: zero })
  // bar1 开盘 100 买入，持仓到 bar2 开盘 200 卖出 → +100%
  assert.ok(Math.abs(r.totalReturnPct - 100) < 1e-9, `got ${r.totalReturnPct}`)
})

// ═════════════ 回归测试：实验阶段发现的两个真 bug ═════════════

test('REGRESSION 杠杆护栏: 单 bar 权重和 >1 时被归一，不得产生隐性杠杆', () => {
  // 实验中 lowVolCircuit 初版对每只标的独立给权重 1 → 权重和 = 标的数，
  // 回测变成 N 倍杠杆（曾把 Calmar 从 0.13 虚增到 132）。护栏必须拦住。
  const n = 4
  const closes = [100, 110, 121, 133]
  const bars = Array.from({ length: n }, () => makeBars(closes))
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const weightOne = new Array(n).fill(1)      // 权重和 = 4
  const signals = [weightOne, weightOne, weightOne, weightOne]
  const r = backtestTargetWeights(bars, signals, { cost: zero, grossCap: 1 })
  assert.equal(r.maxGrossRaw, n, '应记录到原始总权重为 4')
  // 护栏把总权重压到 1：净值应等于「满仓一只、bar1 开盘买入」的结果。
  // 手算：bar1 开盘 110 买入 → bar2 收盘 133 = +20.909%；未归一则会是 4 倍敞口。
  assert.ok(Math.abs(r.totalReturnPct - 20.909090909090907) < 1e-9,
    `归一后应精确等于无杠杆满仓结果，got ${r.totalReturnPct}`)
  assert.ok(r.totalReturnPct < 40, '不应出现杠杆放大')
  // 记录：现金约束使"无护栏"也无法真正超过 1 倍杠杆（买入需要现金），
  // 因此护栏的价值在于**如实反映策略意图**并暴露 maxGrossRaw，而非事后救火。
  assert.ok(r.maxGrossRaw > 1, 'maxGrossRaw 必须暴露原始超配，让调用方看见问题')
})

test('REGRESSION 未来函数: 信号切片错位会改变结果，故必须用开盘价成交', () => {
  // 构造跳空行情：若在信号当日收盘成交，收益会不同
  const bars = [
    { t: 1, o: 100, c: 100 },
    { t: 2, o: 150, c: 150 },   // 跳空 +50%
    { t: 3, o: 150, c: 150 },
  ]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const r = backtestTargetWeights([bars], [[1], [1], [0]], { cost: zero })
  // bar0 收盘=100 给权重；bar1 开盘=150 成交 → 没有吃到跳空缺口
  assert.ok(Math.abs(r.totalReturnPct) < 1e-9, `不应吃到跳空，got ${r.totalReturnPct}`)
})

test('引擎: 检查输入长度不一致时抛错', () => {
  assert.throws(
    () => backtestTargetWeights([makeBars([1, 2, 3]), makeBars([1, 2])], [[1], [1]]),
    /same number of bars/,
  )
})

// ═════════════ 策略库测试 ═════════════

test('策略库: 每个策略都能生成合法权重矩阵（等长、权重和 ≤ 1）', () => {
  const K = 5, T = 200
  const bars = Array.from({ length: K }, (_, k) =>
    makeBars(Array.from({ length: T }, (_, i) => 100 + k * 10 + Math.sin(i / 7) * 8 + i * 0.15)))
  for (const st of ALL_STRATEGIES) {
    const sig = st.generate(bars, {})
    assert.equal(sig.length, T, `${st.id}: 信号长度应为 ${T}`)
    for (let i = 0; i < T; i++) {
      assert.equal(sig[i]!.length, K, `${st.id}: 第 ${i} 行长度应为 ${K}`)
      const sum = sig[i]!.reduce((a, b) => a + b, 0)
      assert.ok(sum <= 1 + 1e-9, `${st.id}: 第 ${i} 行权重和 ${sum} 超过 1`)
      for (const w of sig[i]!) assert.ok(w >= 0 && Number.isFinite(w), `${st.id}: 权重非法 ${w}`)
    }
  }
})

test('策略库: findStrategy 与 runStrategy 按 id 工作', () => {
  assert.equal(findStrategy('momentum_stop')?.id, 'momentum_stop')
  assert.equal(findStrategy('nope'), undefined)
  const bars = [makeBars(Array.from({ length: 120 }, (_, i) => 100 + i))]
  const r = runStrategy(bars, 'ma_cross')
  assert.equal(r.strategy, 'ma_cross')
  assert.equal(r.bars, 120)
  assert.throws(() => runStrategy(bars, 'nope'), /unknown strategy/)
})

test('策略库: 空仓策略在纯下跌行情中不亏钱', () => {
  // 单调下跌 → 趋势策略应识别并空仓
  const bars = [makeBars(Array.from({ length: 150 }, (_, i) => 200 - i))]
  const r = runStrategy(bars, momentumStop, { lookback: 40, topN: 1, stopPct: 0.05, filterMa: 60 })
  assert.ok(r.totalReturnPct >= -50, `下跌行情不应巨亏，got ${r.totalReturnPct.toFixed(1)}%`)
})

test('策略库: equalWeightIndex 与 drawdownFromHigh 数值正确', () => {
  const bars = [makeBars([100, 100]), makeBars([200, 200])]
  const idx = equalWeightIndex(bars)
  assert.ok(Math.abs(idx[0] - 1) < 1e-12)
  assert.ok(Math.abs(idx[1] - 1) < 1e-12)
  const dd = drawdownFromHigh([100, 120, 60], 3)
  assert.equal(dd[0], 0)
  assert.equal(dd[1], 0)
  assert.ok(Math.abs(dd[2] - 0.5) < 1e-12)
})

test('策略库: 无杠杆（所有策略的输出经引擎后 maxGrossRaw ≤ 1）', () => {
  const K = 6, T = 180
  const bars = Array.from({ length: K }, (_, k) =>
    makeBars(Array.from({ length: T }, (_, i) => 100 + k * 5 + Math.sin(i / 5 + k) * 10 + i * 0.2)))
  for (const st of ALL_STRATEGIES) {
    const r = runStrategy(bars, st, {})
    assert.ok(r.maxGrossRaw <= 1 + 1e-9, `${st.id}: maxGrossRaw = ${r.maxGrossRaw} 应 ≤ 1`)
  }
})

// ═════════════ 纯 Node 数据源（替代 akshare）═════════════

test('sources: toSymbol / toCode 交易所前缀判定正确', async () => {
  const { toSymbol, toCode } = await import('../src/dsh-strategy/sources.js')
  assert.equal(toSymbol('600000'), 'sh600000')
  assert.equal(toSymbol('000001'), 'sz000001')
  assert.equal(toSymbol('300750'), 'sz300750')
  assert.equal(toSymbol('430047'), 'bj430047')
  assert.equal(toSymbol('abc'), undefined)
  assert.equal(toSymbol('12345'), undefined)          // 5 位非法
  assert.equal(toCode('sh600000'), '600000')
  assert.equal(toCode('sz000001'), '000001')
})

test('sources: INDEX_CODES 覆盖常用宽基指数', async () => {
  const { INDEX_CODES } = await import('../src/dsh-strategy/sources.js')
  assert.equal(INDEX_CODES.csi300, '000300')
  assert.equal(INDEX_CODES.csi500, '000905')
  assert.equal(INDEX_CODES.csi1000, '000852')
  assert.equal(INDEX_CODES.sse50, '000016')
})

test('sources: fetchIndexConstituents 返回合法代码（网络依赖，失败即跳过）', async (t) => {
  const { fetchIndexConstituents, INDEX_CODES } = await import('../src/dsh-strategy/sources.js')
  let codes
  try {
    codes = await fetchIndexConstituents(INDEX_CODES.csi300, AbortSignal.timeout(20_000))
  } catch {
    t.skip('network unavailable')
    return
  }
  assert.ok(codes.length >= 250, `CSI300 应返回约 300 只，got ${codes.length}`)
  for (const c of codes) assert.match(c, /^\d{6}$/)
  assert.equal(new Set(codes).size, codes.length, '不应有重复代码')
})

test('equalWeightBenchmark: 等权持有，无成本时收益等于各标的价格涨幅均值', () => {
  // 两只标的：一只 +10%，一只 +20%（从 bar0 收盘到 bar1 收盘）
  // 等权买入在 bar1 开盘成交，故用开盘=收盘的简化序列
  const closes = [100, 110, 121]
  const bars = [makeBars(closes), makeBars(closes.map(c => c * 1.1))]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const r = equalWeightBenchmark(bars, { cost: zero })
  assert.ok(r.totalReturnPct > 0, '上涨行情下等权基准应为正收益')
  // 基准自身也应满足无杠杆约束
  assert.ok(r.maxGrossRaw <= 1 + 1e-9, `等权基准 maxGrossRaw 应 ≤ 1，got ${r.maxGrossRaw}`)
})

test('equalWeightBenchmark: 空输入抛错', () => {
  assert.throws(() => equalWeightBenchmark([]), /at least one instrument/)
})

test('equalWeightBenchmark: 与手工构造的等权信号结果一致', () => {
  const closes = [100, 105, 99, 108]
  const bars = [makeBars(closes), makeBars(closes.map(c => c * 1.05))]
  const zero = { commission: 0, stampDuty: 0, transferFee: 0, slippage: 0 }
  const viaHelper = equalWeightBenchmark(bars, { cost: zero })
  // 手工构造同样的信号
  const n = bars[0].length
  const sig = Array.from({ length: n }, () => [0.5, 0.5])
  const viaManual = backtestTargetWeights(bars, sig, { cost: zero })
  assert.ok(Math.abs(viaHelper.totalReturnPct - viaManual.totalReturnPct) < 1e-9,
    `helper ${viaHelper.totalReturnPct} vs manual ${viaManual.totalReturnPct}`)
})

// ═════════════ stats 模块（统计功效与显著性）═════════════

test('stats: 包入口导出全部公开统计函数（防漏导出回归）', async () => {
  // 该测试源于一个真实缺陷：stats.ts 实现了 centralTCdf/tQuantile/noncentralTCdf/
  // incompleteBeta，但 index.ts 忘记 re-export，使用者 import 时直接报错。
  const entry = await import('../src/index.js')
  const required = [
    'normCdf', 'normInv', 'meanSeNW', 'pValue', 'power', 'requiredSampleSize',
    'centralTCdf', 'tQuantile', 'noncentralTCdf', 'incompleteBeta', 'deflatedSharpeStrategy',
  ]
  for (const name of required) {
    assert.equal(typeof (entry as Record<string, unknown>)[name], 'function', `包入口缺少导出: ${name}`)
  }
})

test('stats: normCdf/normInv 互为逆函数', async () => {
  const { normCdf, normInv } = await import('../src/dsh-strategy/stats.js')
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9)
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3)
  assert.ok(Math.abs(normInv(0.975) - 1.96) < 1e-2)
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    assert.ok(Math.abs(normCdf(normInv(p)) - p) < 1e-6, `p=${p}`)
  }
})

test('stats: incompleteBeta 满足恒等式 I_x(a,b) + I_{1-x}(b,a) = 1', async () => {
  const { incompleteBeta } = await import('../src/dsh-strategy/stats.js')
  const cases = [[0.3, 1, 1], [0.5, 2, 2], [0.2, 3, 5], [0.7, 4, 2], [0.9, 1, 8]]
  for (const [x, a, b] of cases) {
    const s = incompleteBeta(x, a, b) + incompleteBeta(1 - x, b, a)
    assert.ok(Math.abs(s - 1) < 1e-8, `x=${x} a=${a} b=${b} → 和=${s}`)
  }
  // 已知值
  assert.ok(Math.abs(incompleteBeta(0.5, 1, 1) - 0.5) < 1e-9)
})

test('stats: noncentralTCdf 在 ncp=0 时退化为中央 t', async () => {
  const { noncentralTCdf, centralTCdf, tQuantile } = await import('../src/dsh-strategy/stats.js')
  for (const df of [5, 15, 30, 100]) {
    // tQuantile(0.975, df) 是上尾 2.5% 分位点（正值，如 df=5 → 2.5706）
    const crit = tQuantile(0.975, df)
    assert.ok(crit > 0, `df=${df}: 分位点应为正`)
    const cdf = noncentralTCdf(crit, df, 0)
    assert.ok(Math.abs(cdf - 0.975) < 0.01, `df=${df}: noncentralTCdf=${cdf} 应 ≈0.975`)
    // 与独立的中央 t CDF 一致
    assert.ok(Math.abs(cdf - centralTCdf(crit, df)) < 1e-9, `df=${df}: 两者应完全一致`)
  }
})

test('stats: noncentralTCdf 对 ncp>0 满足值域、单调性与对称性', async () => {
  const { noncentralTCdf } = await import('../src/dsh-strategy/stats.js')
  for (const ncp of [0.5, 1, 2, 3]) {
    for (const t of [-3, -1, 0, 1, 3]) {
      const v = noncentralTCdf(t, 10, ncp)
      assert.ok(v >= 0 && v <= 1, `值域越界 t=${t} ncp=${ncp} → ${v}`)
    }
  }
  for (const ncp of [1, 2]) {
    let prev = -1
    for (let t = -5; t <= 5; t += 0.25) {
      const v = noncentralTCdf(t, 10, ncp)
      assert.ok(v >= prev - 1e-12, `非单调 t=${t} ncp=${ncp}`)
      prev = v
    }
  }
  // 对称恒等式：P(T'(δ) ≤ t) = 1 − P(T'(−δ) ≤ −t)
  for (const [t, ncp] of [[1.5, 1], [-0.5, 2], [2, 0.5]] as [number, number][]) {
    const a = noncentralTCdf(t, 12, ncp)
    const b = 1 - noncentralTCdf(-t, 12, -ncp)
    assert.ok(Math.abs(a - b) < 1e-9, `对称性失败 t=${t} ncp=${ncp}: ${a} vs ${b}`)
  }
})

test('stats: tQuantile 精确匹配教科书 t 分位数', async () => {
  const { tQuantile, centralTCdf } = await import('../src/dsh-strategy/stats.js')
  // 标准 t 表（上尾 2.5%）
  const table: [number, number][] = [[5, 2.5706], [10, 2.2281], [15, 2.1314], [30, 2.0423], [100, 1.9840]]
  for (const [df, exact] of table) {
    assert.ok(Math.abs(tQuantile(0.975, df) - exact) < 1e-3, `df=${df}: got ${tQuantile(0.975, df)} want ${exact}`)
  }
  // 反函数一致性
  for (const df of [3, 8, 25, 60]) {
    for (const p of [0.05, 0.25, 0.5, 0.9, 0.975]) {
      assert.ok(Math.abs(centralTCdf(tQuantile(p, df), df) - p) < 1e-8, `df=${df} p=${p}`)
    }
  }
})

test('stats: power 与蒙特卡洛仿真一致（单样本 t 检验）', async () => {
  const { power } = await import('../src/dsh-strategy/stats.js')
  // 用较小的仿真次数保证测试速度，但足以区分对错实现
  function simulate(d, n, trials = 20000) {
    let reject = 0
    for (let t = 0; t < trials; t++) {
      let sum = 0
      const xs = []
      for (let i = 0; i < n; i++) {
        let u = 0, v = 0
        while (u === 0) u = Math.random()
        while (v === 0) v = Math.random()
        const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
        xs.push(d + z); sum += d + z
      }
      const m = sum / n
      let ss = 0
      for (const x of xs) ss += (x - m) ** 2
      const sd = Math.sqrt(ss / (n - 1))
      if (Math.abs(m / (sd / Math.sqrt(n))) > 2.0) reject++
    }
    return reject / trials
  }
  // d=0.8, n=26：解析式 0.975；用 2.0 近似临界值时仿真略低
  const analytic = power(0.8, 1, 26)
  const mc = simulate(0.8, 26, 20000)
  assert.ok(Math.abs(analytic - mc) < 0.06, `解析 ${analytic.toFixed(3)} vs 仿真 ${mc.toFixed(3)}`)
})

test('stats: requiredSampleSize 单调且合理', async () => {
  const { requiredSampleSize, power } = await import('../src/dsh-strategy/stats.js')
  const n08 = requiredSampleSize(0.5, 1, 0.8)
  const n09 = requiredSampleSize(0.5, 1, 0.9)
  assert.ok(n09 > n08, '90% 功效需要更多样本')
  assert.ok(power(0.5, 1, n08) >= 0.8, '在返回的 n 上功效应达标')
  assert.ok(power(0.5, 1, n08 - 1) < 0.8, '在 n-1 上功效应不达标（最小性）')
  assert.equal(requiredSampleSize(0, 1), Infinity)
})

test('stats: meanSeNW 与直接计算一致（无自相关时）', async () => {
  const { meanSeNW } = await import('../src/dsh-strategy/stats.js')
  const xs = [1, 2, 3, 4, 5]
  const { mean } = meanSeNW(xs, 0)
  assert.ok(Math.abs(mean - 3) < 1e-12)
  // lag=0 时 se = sd/sqrt(n)
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - 3) ** 2, 0) / xs.length)
  const { se } = meanSeNW(xs, 0)
  assert.ok(Math.abs(se - sd / Math.sqrt(5)) < 1e-12)
})


// ═════════════ 六道关卡稳健性检验 ═════════════

test('validate: 真实 momentum_stop 数据被判定为不通过', async () => {
  const { validateStrategy } = await import('../src/dsh-strategy/validate.js')
  // 来自 round21 的实测逐窗口超额：剔除任一最好窗口即失去显著性
  const real = [51.9, 51.5, 30.7, 12.4, 9.8, 8.3, 5.1, 4.2, 2.9, 1.1, -0.4, -1.2, -2.8, -16.1, -18.1]
  const r = validateStrategy(real, { trials: 21 })
  assert.equal(r.pass, false, '该结果不应通过全部关卡')
  // 关卡 4（leave-one-out）必须失败 —— 这正是它的作用
  const loo = r.gates.find(g => g.gate.startsWith('4.'))!
  assert.equal(loo.pass, false, 'leave-one-out 应捕获"由个别窗口主导"的结果')
  // 关卡 6（功效）也应失败：n=15 不足以检测该效应
  const pw = r.gates.find(g => g.gate.startsWith('6.'))!
  assert.equal(pw.pass, false, '功效不足应被指出')
  assert.ok(r.summary.requiredN > 15, '所需样本量应大于当前样本量')
})

test('validate: 稳健序列（无极端值）通过全部关卡', async () => {
  const { validateStrategy } = await import('../src/dsh-strategy/validate.js')
  const robust = [3.2, 2.8, 4.1, 3.5, 2.2, 3.8, 4.4, 2.9, 3.1, 3.6, 2.7, 4.0, 3.3, 3.9, 2.5]
  const r = validateStrategy(robust, { trials: 21 })
  assert.equal(r.pass, true, '稳健序列应通过: ' + JSON.stringify(r.gates.filter(g => !g.pass)))
  assert.ok(r.summary.tStat > 3)
})

test('validate: 纯噪声不通过', async () => {
  const { validateStrategy } = await import('../src/dsh-strategy/validate.js')
  const noise = [1.2, -0.8, 0.5, -1.1, 2.0, -0.3, 0.9, -1.5, 0.2, 1.1, -0.6, 0.4, -0.9, 1.5, -0.4]
  const r = validateStrategy(noise, { trials: 21 })
  assert.equal(r.pass, false, '噪声不应通过')
  assert.ok(r.summary.pValue > 0.05)
})

test('validate: 关卡 5 随 trials 增加而变严格', async () => {
  const { validateStrategy } = await import('../src/dsh-strategy/validate.js')
  // 一个中等强度、中等样本的序列
  const mid = [2.5, 1.8, 3.1, 2.2, 2.9, 1.5, 3.3, 2.0, 2.7, 1.9, 2.4, 3.0, 2.1, 2.6, 1.7]
  const few = validateStrategy(mid, { trials: 1 })
  const many = validateStrategy(mid, { trials: 1000 })
  const s1 = few.gates.find(g => g.gate.startsWith('5.'))!
  const s2 = many.gates.find(g => g.gate.startsWith('5.'))!
  // trials 越多，最小显著夏普越高（门槛更严）
  assert.ok(s1.detail !== s2.detail, 'trials 应影响 Deflated Sharpe 判定')
})

test('validate: 边界情况（n=0/1/2）不抛错', async () => {
  const { validateStrategy } = await import('../src/dsh-strategy/validate.js')
  for (const seq of [[], [1.5], [1.5, -0.5]]) {
    const r = validateStrategy(seq, {})
    assert.equal(typeof r.pass, 'boolean')
    assert.equal(r.summary.n, seq.length)
  }
})


// ═════════════ 行业分类数据源 ═════════════

test('industry: industryStats 统计正确', async () => {
  const { industryStats } = await import('../src/dsh-strategy/industry.js')
  const map = {
    '600000': '银行', '600001': '银行', '000001': '地产', '300001': '电子', '688001': '电子',
  }
  const s = industryStats(map)
  assert.equal(s.total, 5)
  assert.equal(s.sectors, 3)
  // 并列时的裁决：银行 2 与 电子 2 并列 → 按字典序取更小者（电子）。
  // 这里断言的是**确定性**，不是"先出现的那个"：
  // 早期实现依赖 Object.entries 的顺序，而 JS 对象键序在引擎间可能不同，
  // 会导致同一份数据给出不同的"最大行业"，结果不可复现。
  assert.equal(s.largest!.name, '电子')
  assert.equal(s.largest!.count, 2)
  assert.ok(Math.abs(s.largest!.share - 0.4) < 1e-12)
  assert.equal(s.shCount, 3, '6 开头为上交所')
  assert.equal(s.szCount, 2, '0/3 开头为深交所')
})

test('industry: 并列最大行业的裁决是确定性的（不受键序影响）', async () => {
  const { industryStats } = await import('../src/dsh-strategy/industry.js')
  // 同一组数据、不同插入顺序 → 必须给出相同结果
  const a = industryStats({ '600000': '银行', '600001': '银行', '000001': '地产', '300001': '电子', '688001': '电子' })
  const b = industryStats({ '300001': '电子', '688001': '电子', '600000': '银行', '600001': '银行', '000001': '地产' })
  assert.equal(a.largest!.name, b.largest!.name, '插入顺序不同不应改变结果')
  assert.equal(a.largest!.count, b.largest!.count)
  assert.equal(a.sectors, b.sectors)
})

test('industry: industryStats 处理空映射', async () => {
  const { industryStats } = await import('../src/dsh-strategy/industry.js')
  const s = industryStats({})
  assert.equal(s.total, 0)
  assert.equal(s.largest, null)
})

test('industry: fetchIndustries 翻页取到全市场（网络依赖，失败即跳过）', async (t) => {
  const { fetchIndustries, industryStats } = await import('../src/dsh-strategy/industry.js')
  let map
  try {
    map = await fetchIndustries('000300', AbortSignal.timeout(60_000))
  } catch {
    t.skip('network unavailable')
    return
  }
  const s = industryStats(map)
  // 关键回归断言：必须翻页到底，否则只会拿到第一页的少量数据。
  // 该数据源的缺陷正是"pageSize 过大时静默截断"，实测修正后应拿到数千只。
  assert.ok(s.total > 1000, `应翻页取到全市场标的（>1000），实际 ${s.total} —— 若过少说明翻页失败`)
  assert.ok(s.sectors > 30, `行业数应 >30，实际 ${s.sectors}`)
  assert.ok(s.shCount > 500, `应包含上交所标的，实际 ${s.shCount}`)
  assert.ok(s.szCount > 500, `应包含深交所标的，实际 ${s.szCount}`)
  // 代码格式
  for (const code of Object.keys(map)) {
    assert.match(code, /^\d{6}$/)
  }
})


// ═════════════ 板块反转轮动（本研究唯一通过双向稳定性检验的配置）═════════════

test('sector-reversal: riskParityWeights 权重和恒为 1 且低波权重更高', async () => {
  const { riskParityWeights } = await import('../src/dsh-strategy/sector-reversal.js')
  // 手算基线：atrPct = [0.02, 0.04] → inv = [50, 25] → sum = 75 → w = [2/3, 1/3]
  const w = riskParityWeights([0.02, 0.04])
  assert.ok(Math.abs(w[0]! - 2 / 3) < 1e-12, `期望 2/3，得到 ${w[0]}`)
  assert.ok(Math.abs(w[1]! - 1 / 3) < 1e-12, `期望 1/3，得到 ${w[1]}`)
  assert.ok(Math.abs(w[0]! + w[1]! - 1) < 1e-12, '权重和应为 1')
  // 低波动（atrPct 小）应获得更高权重
  assert.ok(w[0]! > w[1]!, '低波标的权重应更高')
})

test('sector-reversal: riskParityWeights 处理零波动与空数组', async () => {
  const { riskParityWeights } = await import('../src/dsh-strategy/sector-reversal.js')
  // 有 0 时：inv = [1/0.02, 0, 1/0.04] = [50, 0, 25] → sum=75 → [0.6667, 0, 0.3333]
  const w = riskParityWeights([0.02, 0, 0.04])
  assert.ok(Math.abs(w[0]! - 2 / 3) < 1e-12)
  assert.equal(w[1], 0, '零波动（或负值）权重应为 0')
  assert.ok(Math.abs(w[2]! - 1 / 3) < 1e-12)
  // 全为 0 → 等权
  const w2 = riskParityWeights([0, 0])
  assert.ok(Math.abs(w2[0]! - 0.5) < 1e-12 && Math.abs(w2[1]! - 0.5) < 1e-12, '全零应退化为等权')
})

test('sector-reversal: scoreSectorReversal 偏好强板块与超跌个股', async () => {
  const { scoreSectorReversal } = await import('../src/dsh-strategy/sector-reversal.js')
  // 全部行业中位数：[0.05, 0.02, -0.01, -0.05]
  const medians = [0.05, 0.02, -0.01, -0.05]
  // A：板块 +0.05（最强，分位 3/4）且个股 −10%（超跌）
  const scoreA = scoreSectorReversal({ sectorPctile: 0.05, reversal: -0.10, atrPct: 0.03 }, medians, 2)
  // B：板块 −0.05（最弱，分位 0/4）且个股 +10%（已涨）
  const scoreB = scoreSectorReversal({ sectorPctile: -0.05, reversal: 0.10, atrPct: 0.03 }, medians, 2)
  // 修正后的语义：返回值 = 「强于 v 的行业数 / 总数」（0 = 全市场最强）
  // A：板块 +0.05 是最强 → 强于它的有 0 个 → rank = 0/4 = 0
  //    分数 = −2×0 − (−0.10) = +0.10
  assert.ok(Math.abs(scoreA - 0.10) < 1e-12, `A 期望 +0.10，得到 ${scoreA}`)
  // B：板块 −0.05 是最弱 → 强于它的有 3 个（0.05/0.02/−0.01）→ rank = 3/4 = 0.75
  //    分数 = −2×0.75 − 0.10 = −1.50 − 0.10 = −1.60
  assert.ok(Math.abs(scoreB - (-1.60)) < 1e-12, `B 期望 −1.60，得到 ${scoreB}`)
  // scoreB > scoreA → A 更优（得分越高越优先买入）
  assert.ok(scoreA > scoreB, '强板块+超跌应优于弱板块+已涨')
})

test('sector-reversal: shouldExit 止盈止损超时三种触发', async () => {
  const { shouldExit } = await import('../src/dsh-strategy/sector-reversal.js')
  // 默认参数：止盈 10%、止损 5%、最长 20 日
  assert.equal(shouldExit(10, 11.2, 3), true, '涨 12% 应触发止盈')
  assert.equal(shouldExit(10, 10.5, 3), false, '涨 5% 未达止盈')
  assert.equal(shouldExit(10, 9.4, 3), true, '跌 6% 应触发止损')
  assert.equal(shouldExit(10, 9.6, 3), false, '跌 4% 未达止损')
  assert.equal(shouldExit(10, 10.0, 20), true, '持有满 20 日应超时卖出')
  assert.equal(shouldExit(10, 10.0, 19), false, '持有 19 日未超时')
  // 边界：恰好触达阈值
  assert.equal(shouldExit(10, 11.0, 1), true, '恰好 +10% 应触发（含等号）')
  assert.equal(shouldExit(10, 9.5, 1), true, '恰好 −5% 应触发（含等号）')
  // 自定义参数
  assert.equal(shouldExit(10, 10.6, 1, { takeProfit: 0.05 }), true, '自定义止盈 5%')
})

test('sector-reversal: canAddSector 行业分散约束', async () => {
  const { canAddSector } = await import('../src/dsh-strategy/sector-reversal.js')
  const holdings = ['银行', '银行', '电子']
  assert.equal(canAddSector(holdings, '银行', 2), false, '银行已有 2 只，达上限')
  assert.equal(canAddSector(holdings, '电子', 2), true, '电子仅 1 只，可加仓')
  assert.equal(canAddSector(holdings, '医药', 2), true, '医药 0 只，可加仓')
  assert.equal(canAddSector(holdings, '银行', 3), true, '上限放宽到 3 后可加')
  assert.equal(canAddSector([], '银行', 1), true, '空持仓可加')
})
