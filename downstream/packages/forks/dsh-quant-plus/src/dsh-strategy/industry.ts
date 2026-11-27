/**
 * 行业分类数据源（纯 Node、零依赖）—— dsh-strategy 域。
 *
 * 用途：行业中性化策略需要每只标的所属行业。
 * 数据源：东方财富 datacenter 的 RPT_INDEX_TS_COMPONENT 报表。
 *
 * ⚠️ 踩坑记录（重要，直接影响结论正确性）：
 *   该接口有**分页上限**。早期版本用 pageSize=2000 一次拉完，
 *   接口**静默截断**只返回第一页的部分数据 —— 296 只票里只有 38 只能匹配到行业，
 *   而接口不报错。基于这个残缺数据得出的"行业中性化有效"结论完全无效。
 *   修正为逐页翻页（每页 500）后拿到 3865 只 / 127 个行业（沪深两市齐全）。
 *
 * 教训：**数据源静默截断比显式报错危险得多**。凡是分页接口，必须翻页到底。
 */

/** 行业映射：6 位代码 → 行业名。 */
export type IndustryMap = Record<string, string>

/** 东方财富 datacenter 基址。 */
const DATACENTER = 'https://datacenter-web.eastmoney.com/api/data/v1/get'

/** 单页大小（该接口的可靠上限；超过会被静默截断）。 */
const PAGE_SIZE = 500

/** 安全上限：避免异常时无限翻页。 */
const MAX_PAGES = 60

/** 请求头（该接口对 UA/Referer 有要求）。 */
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (compatible; dsh-strategy/1.0)',
  referer: 'https://data.eastmoney.com/',
} as const

/**
 * 抓取行业分类（自动翻页到底）。
 *
 * @param indexCode 指数代码（默认沪深300；该报表与指数无关，实际返回全市场）
 * @param signal 中止信号
 * @returns 6 位代码 → 行业名（同一代码出现多行时取首个非空值）
 */
export async function fetchIndustries(
  indexCode = '000300',
  signal?: AbortSignal,
): Promise<IndustryMap> {
  const map: IndustryMap = {}
  let page = 1
  let pages = 1
  while (page <= pages && page <= MAX_PAGES) {
    const url = new URL(DATACENTER)
    url.searchParams.set('reportName', 'RPT_INDEX_TS_COMPONENT')
    url.searchParams.set('columns', 'SECURITY_CODE,INDUSTRY')
    url.searchParams.set('pageSize', String(PAGE_SIZE))
    url.searchParams.set('pageNumber', String(page))
    // ⚠️ 注意：本报表**不支持**按 INDEX_CODE 过滤（会返回 9501「列不存在」）。
    // 它实际返回全市场标的的行业分类，故不加 filter。
    // 早期版本曾误加 filter，导致 "no industry rows returned"。
    void indexCode
    const res = await fetch(url, { signal, headers: HEADERS })
    if (!res.ok) throw new Error(`industry fetch failed: HTTP ${res.status}`)
    const body = (await res.json()) as {
      result?: { pages?: number; data?: { SECURITY_CODE?: string; INDUSTRY?: string }[] }
    }
    pages = body.result?.pages ?? 1
    for (const row of body.result?.data ?? []) {
      const code = row.SECURITY_CODE
      const industry = row.INDUSTRY
      if (typeof code === 'string' && typeof industry === 'string' && industry !== '' && map[code] === undefined) {
        map[code] = industry
      }
    }
    page++
  }
  if (!Object.keys(map).length) throw new Error('no industry rows returned')
  return map
}

/**
 * 统计行业分布（用于检查覆盖度与集中度）。
 *
 * @param map 行业映射
 * @returns 行业数、最大行业及其占比
 */
export function industryStats(map: IndustryMap): {
  total: number
  sectors: number
  largest: { name: string; count: number; share: number } | null
  shCount: number
  szCount: number
} {
  const codes = Object.keys(map)
  const counts: Map<string, number> = new Map()
  for (const v of Object.values(map)) counts.set(v, (counts.get(v) ?? 0) + 1)
  // ⚠️ 修正记录：早期版本用普通对象存 counts 并依赖 Object.entries 的顺序做
  // "取最大"的裁决。但 JS 对象对**整数样式的键**会重排（V8 先枚举整数键），
  // 行业名虽非整数，但把 map 换成 Map 才能保证**插入序**语义明确。
  // 更重要的是：并列时必须用**确定性**裁决（此处按字典序），
  // 否则同一份数据在不同引擎上可能给出不同的"最大行业"，结果不可复现。
  // 单元测试正是发现了这一点（并列 2:2 时结果与预期不符）。
  let largest: { name: string; count: number; share: number } | null = null
  for (const [name, count] of counts) {
    if (
      !largest ||
      count > largest.count ||
      (count === largest.count && name < largest.name)   // 并列 → 字典序，保证确定性
    ) {
      largest = { name, count, share: count / codes.length }
    }
  }
  return {
    total: codes.length,
    // counts 已改为 Map（保证插入序与确定性），故用 .size 而非 Object.keys
    sectors: counts.size,
    largest,
    shCount: codes.filter(c => c.startsWith('6')).length,
    szCount: codes.filter(c => /^(0|3)/.test(c)).length,
  }
}
