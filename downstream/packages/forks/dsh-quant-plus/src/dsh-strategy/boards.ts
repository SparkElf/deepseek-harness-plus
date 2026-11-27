/**
 * A 股板块（交易场所）识别与过滤 —— 纯函数、零依赖。
 *
 * 用途：不同板块的**涨跌停幅度**、交易规则、波动特征差异极大，
 * 混在一个票池里回测会系统性算错涨跌停判断。
 *
 * 板块与代码前缀（2026 年现状）：
 * - 上交所主板：600 / 601 / 603 / 605  → 涨跌停 ±10%
 * - 深交所主板：000 / 001 / 002 / 003  → 涨跌停 ±10%
 *   （002 原中小板，2021 年并入主板；003 亦为主板）
 * - 创业板：300 / 301                  → 涨跌停 ±20%（2020-08 起）
 * - 科创板：688 / 689                  → 涨跌停 ±20%
 * - 北交所：4xx / 8xx                  → 涨跌停 ±30%
 *
 * ⚠️ 常见错误：把创业板当主板用 10% 判断涨停，会把 +10% 误判为涨停
 * （实际还能再涨 10%），或把 +20% 的真实涨停漏判。本模块的存在就是为了避免这种错误。
 */

/** 板块类型。 */
export type MarketBoard =
  | 'sh-main'    // 上交所主板
  | 'sz-main'    // 深交所主板
  | 'chinext'    // 创业板
  | 'star'       // 科创板
  | 'bse'        // 北交所
  | 'unknown'

/** 从带前缀或纯数字的代码判定板块。 */
export function marketBoard(symbol: string): MarketBoard {
  const code = String(symbol).replace(/^(sh|sz|bj)/i, '').trim()
  if (!/^\d{6}$/.test(code)) return 'unknown'
  if (/^(600|601|603|605)/.test(code)) return 'sh-main'
  if (/^(000|001|002|003)/.test(code)) return 'sz-main'
  if (/^(300|301)/.test(code)) return 'chinext'
  if (/^(688|689)/.test(code)) return 'star'
  if (/^[48]/.test(code)) return 'bse'
  return 'unknown'
}

/** 是否为主板（用户只交易这类）。 */
export function isMainBoard(symbol: string): boolean {
  const b = marketBoard(symbol)
  return b === 'sh-main' || b === 'sz-main'
}

/**
 * 涨跌停幅度（小数）。
 *
 * @param symbol 股票代码（带不带 sh/sz 前缀均可）
 * @param isSt   是否 ST 股（ST 主板为 ±5%）；默认 false
 * @returns 涨停幅度，如 0.1 表示 +10%
 */
export function priceLimitPct(symbol: string, isSt = false): number {
  const board = marketBoard(symbol)
  if (board === 'bse') return 0.3
  if (board === 'chinext' || board === 'star') {
    // 创业板/科创板 ST 股仍为 20%
    return 0.2
  }
  // 主板：普通 10%，ST 5%
  return isSt ? 0.05 : 0.1
}

/** 板块统计。 */
export interface BoardBreakdown {
  total: number
  'sh-main': number
  'sz-main': number
  chinext: number
  star: number
  bse: number
  unknown: number
  /** 主板占比 */
  mainShare: number
}

/** 统计一组代码的板块分布。 */
export function boardBreakdown(symbols: readonly string[]): BoardBreakdown {
  const out: BoardBreakdown = {
    total: symbols.length, 'sh-main': 0, 'sz-main': 0, chinext: 0, star: 0, bse: 0, unknown: 0, mainShare: 0,
  }
  for (const s of symbols) {
    const b = marketBoard(s)
    out[b === 'unknown' ? 'unknown' : b] += 1
  }
  out.mainShare = out.total > 0 ? (out['sh-main'] + out['sz-main']) / out.total : 0
  return out
}

/**
 * 按板块过滤票池。
 *
 * @param symbols 原始代码列表
 * @param boards  保留的板块（默认仅主板）
 * @returns 过滤后的代码列表
 */
export function filterByBoard(
  symbols: readonly string[],
  boards: readonly MarketBoard[] = ['sh-main', 'sz-main'],
): string[] {
  const keep = new Set(boards)
  return symbols.filter((s) => keep.has(marketBoard(s)))
}
