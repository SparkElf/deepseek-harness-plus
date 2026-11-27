/**
 * 板块反转轮动策略（本研究唯一通过稳定性检验的配置）—— dsh-strategy 域
 *
 * 来源：A 股策略研究（2026）的买点×卖点全矩阵实验。
 * 该配置是唯一在两个维度上都通过稳定性检验的：
 *   - 买入信号在 **6/6** 个卖出规则下都跑赢基准
 *   - 卖出规则在 **6/6** 个买入信号下都跑赢基准
 *
 * 配置（每条都经过验证）：
 *   买入：板块强度（行业 20 日涨幅排名）+ 个股反转（20 日跌幅）
 *   卖出：固定止盈/止损（实测优于 ATR 移动止损：6/6 vs 2/6）
 *   仓位：风险平价（权重 ∝ 1/ATR%，使每只风险贡献相等）
 *   组合：每行业最多 N 只（分散特异性风险）
 *
 * ⚠️ 必须同时报告的已知限制：
 *   1. 15 个历史窗口中仅 7/15 跑赢基准 —— 跨期不稳
 *   2. 15 窗口中位收益（1.60%）远小于回撤中位（11.05%）
 *   3. 在特定窗口（2026-06~09）表现突出（+16.74%，回撤 11.39%），
 *      但**不能假定该表现可复制**
 *   4. 随机组合对照（同仓位管理、随机选股）中位 −0.48%，
 *      说明选股贡献约 +2.98pp —— 有真实但微弱的边际
 *
 * 参数来自矩阵实验，非任意选取；但仍是有限样本上的最优，
 * 存在选择偏差，实盘前应再做样本外验证。
 */

/** 策略上下文参数。 */
export interface SectorReversalContext {
  /** 板块强度回看天数（默认 20） */
  sectorLookback?: number
  /** 个股反转回看天数（默认 20） */
  reversalLookback?: number
  /** 板块强度权重（默认 2） */
  sectorWeight?: number
  /** 止盈（默认 0.10） */
  takeProfit?: number
  /** 止损（默认 0.05） */
  stopLoss?: number
  /** 最长持有天数（默认 20） */
  maxHold?: number
  /** 最大持仓数（默认 6） */
  maxPositions?: number
  /** 每行业最大持仓数（默认 2） */
  maxPerSector?: number
  /** 是否用风险平价分配（默认 true） */
  riskParity?: boolean
}

/** 单只标的的横截面特征。 */
export interface CrossFeatures {
  /** 板块强度分位（0 = 最强，1 = 最弱） */
  sectorPctile: number
  /** 个股区间收益（越低表示跌得越多） */
  reversal: number
  /** ATR / 价格（用于风险平价） */
  atrPct: number
}

/**
 * 计算「劣后度」：返回值越大表示该行业越弱（0 = 全市场最强，1 = 最弱）。
 *
 * ⚠️ 修正记录：早期实现统计「小于 v 的个数」，但这与语义相反 ——
 * 行业涨幅中位数越大表示越强，若按「小于 v 的个数」计算，
 * **最强行业会得到最大的排名值**（实测：最强行业 rank=0.75）。
 * 这会让打分函数偏好弱行业，与策略逻辑完全相反。
 * 单元测试用手算基线（scoreA 应为 +0.10）捕获了该缺陷。
 * 正确语义是统计「**强于** v 的行业个数」。
 */
function percentileRank(values: readonly number[], v: number): number {
  if (!values.length) return 0.5
  let stronger = 0
  for (const x of values) if (x > v) stronger++
  return stronger / values.length
}

/**
 * 计算横截面得分。
 *
 * 得分 = −sectorWeight × 板块分位 − 个股反转收益
 * 分值越高越优先买入（板块越强、跌得越多）。
 *
 * @param features 单只标的特征
 * @param allSectorMedians 当日全部行业的 20 日涨幅中位数（用于排名）
 * @param sectorWeight 板块权重
 */
export function scoreSectorReversal(
  features: CrossFeatures,
  allSectorMedians: readonly number[],
  sectorWeight = 2,
): number {
  const rank = percentileRank(allSectorMedians, features.sectorPctile)
  return -sectorWeight * rank - features.reversal
}

/**
 * 风险平价权重：权重 ∝ 1/波动率，使每只标的的**风险贡献相等**。
 *
 * @param atrPcts 各标的的 ATR/价格
 * @returns 归一化权重（和为 1）
 */
export function riskParityWeights(atrPcts: readonly number[]): number[] {
  const inv = atrPcts.map((a) => (a > 0 ? 1 / a : 0))
  const sum = inv.reduce((x, y) => x + y, 0)
  return sum > 0 ? inv.map((x) => x / sum) : atrPcts.map(() => 1 / Math.max(1, atrPcts.length))
}

/**
 * 卖出判定：止盈 / 止损 / 超时。
 *
 * ⚠️ 为何不用 ATR 移动止损：矩阵实验显示，固定止盈止损在 **6/6** 个买入
 * 信号下都跑赢基准，而 ATR 移动止损仅 **2/6**。移动止损在震荡市
 * 会过早离场，把本可恢复的仓位砍掉。
 *
 * @param entryPrice 买入价
 * @param currentPrice 当前价
 * @param heldDays 已持有天数
 * @param ctx 参数
 * @returns 是否卖出
 */
export function shouldExit(
  entryPrice: number,
  currentPrice: number,
  heldDays: number,
  ctx: SectorReversalContext = {},
): boolean {
  const tp = ctx.takeProfit ?? 0.10
  const sl = ctx.stopLoss ?? 0.05
  const maxHold = ctx.maxHold ?? 20
  const ret = currentPrice / entryPrice - 1
  return ret <= -sl || ret >= tp || heldDays >= maxHold
}

/**
 * 行业分散约束：判断某行业是否还能继续加仓。
 *
 * @param holdings 当前持仓的行业列表
 * @param industry 待检查行业
 * @param maxPerSector 每行业上限
 */
export function canAddSector(
  holdings: readonly string[],
  industry: string,
  maxPerSector = 2,
): boolean {
  let count = 0
  for (const h of holdings) if (h === industry) count++
  return count < maxPerSector
}

/** 策略元信息（供策略库登记）。 */
export const SECTOR_REVERSAL_META = {
  id: 'sector_reversal',
  name: '板块反转轮动',
  thesis:
    '买「强板块 + 超跌个股」：板块处于强势（资金关注）但个股尚未跟上（反转机会）。' +
    '卖出用固定止盈止损而非移动止损（实测 6/6 vs 2/6）。' +
    '仓位用风险平价，组合限制每行业持仓数。',
  evidence: {
    entryStability: '6/6 卖出规则下跑赢基准',
    exitStability: '6/6 买入信号下跑赢基准',
    historicalWindows: '15 窗口，7/15 跑赢',
    targetWindow2026: '收益 +16.74%，回撤 11.39%，比值 1.47',
    randomControl: '随机组合中位 −0.48%，选股贡献 +2.98pp',
  },
  limitations: [
    '15 窗口中仅 7/15 跑赢基准，跨期不稳定',
    '15 窗口中位收益 1.60% 小于回撤中位 11.05%',
    '2026 窗口的突出表现不保证可复制',
    '参数来自有限样本搜索，存在选择偏差',
  ],
} as const
