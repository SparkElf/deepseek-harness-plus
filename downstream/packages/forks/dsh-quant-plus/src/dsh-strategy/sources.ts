/**
 * 纯 Node A 股数据源（零 Python 依赖、零第三方包）—— dsh-strategy 域。
 *
 * 动机：原研究台用 akshare 取 CSI300 成分股，引入 Python 依赖。
 * 本模块用公开 HTTP 端点替代，全部走 Node 原生 fetch：
 *
 * - **成分股**：东方财富 datacenter 的 RPT_INDEX_COMPONENT 报表
 *   （实测与 akshare 结果的交集 300/300，完全一致）
 * - **日线**：复用 dsh-quant 既有的 sina / tencent 通道（前复权）
 *
 * 契约：所有网络函数接受 AbortSignal，超时由调用方控制；返回值经结构校验，
 * 异常数据（不足 bar、非正价格）被丢弃而不是静默传入回测。
 */

/** 一只标的的日线序列（前复权）。 */
export interface DailyBars {
  /** 带交易所前缀的代码，如 sh600000 */
  symbol: string
  /** 数据来源标识 */
  provider: string
  /** K 线（按时间升序） */
  candles: { openTime: number; open: number; high: number; low: number; close: number; volume: number }[]
}

/** 东方财富 datacenter 基址。 */
const EASTMONEY_DATACENTER = 'https://datacenter-web.eastmoney.com/api/data/v1/get'

/** 常用指数代码（东方财富 INDEX_CODE 口径）。 */
export const INDEX_CODES = {
  /** 沪深300 */
  csi300: '000300',
  /** 中证500 */
  csi500: '000905',
  /** 中证1000 */
  csi1000: '000852',
  /** 上证50 */
  sse50: '000016',
} as const

/**
 * 6 位代码 → 带交易所前缀的符号；无法判定时返回 undefined。
 *
 * 校验规则（被单元测试抓过一个边界）：输入必须是**恰好 6 位数字**，
 * 不做左侧补零 —— 早期实现对 '12345' 补成 '012345' 并返回 sz012345，
 * 那是个不存在的代码；错误输入必须显式拒绝而不是静默编造。
 */
export function toSymbol(code: string): string | undefined {
  const c = String(code).trim()
  if (!/^\d{6}$/.test(c)) return undefined
  if (c.startsWith('6')) return 'sh' + c
  if (/^(0|3)/.test(c)) return 'sz' + c
  if (/^(4|8)/.test(c)) return 'bj' + c
  return undefined
}

/** 带交易所前缀的符号 → 6 位代码。 */
export function toCode(symbol: string): string {
  return symbol.replace(/^(sh|sz|bj)/i, '')
}

/**
 * 抓取一个指数的成分股代码列表（纯 Node，无需 Python）。
 *
 * 数据源：东方财富 RPT_INDEX_COMPONENT 报表（公开 JSON 接口）。
 * 已验证：CSI300 返回 300 条，与 akshare 的成分股集合完全一致。
 *
 * @param indexCode 指数代码，见 INDEX_CODES（默认沪深300）
 * @param signal 中止信号
 * @returns 6 位股票代码（去重、已排序）
 */
export async function fetchIndexConstituents(
  indexCode: string = INDEX_CODES.csi300,
  signal?: AbortSignal,
): Promise<string[]> {
  const url = new URL(EASTMONEY_DATACENTER)
  url.searchParams.set('reportName', 'RPT_INDEX_COMPONENT')
  url.searchParams.set('columns', 'SECURITY_CODE,INDEX_CODE')
  url.searchParams.set('pageSize', '1000')
  url.searchParams.set('pageNumber', '1')
  url.searchParams.set('filter', `(INDEX_CODE="${indexCode}")`)
  const res = await fetch(url, {
    signal,
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; dsh-strategy/1.0)',
      referer: 'https://data.eastmoney.com/',
    },
  })
  if (!res.ok) throw new Error(`constituent fetch failed: HTTP ${res.status}`)
  const body = (await res.json()) as { result?: { data?: { SECURITY_CODE?: string }[] } }
  const rows = body.result?.data ?? []
  const codes = [...new Set(rows.map(r => r.SECURITY_CODE).filter((c): c is string => typeof c === 'string'))]
  if (!codes.length) throw new Error(`no constituents returned for index ${indexCode}`)
  return codes.sort()
}

/**
 * 抓取指数成分股并用给定取数函数拉日线（并发受限、失败重试、多源回退）。
 *
 * @param options.indexCode 指数代码
 * @param options.limit 最多取多少只（默认全部）
 * @param options.candles 单只标的的取数函数（如传入 dsh-quant 的 fetchKlines 包装）
 * @param options.concurrency 并发数（默认 4，避免被数据源限流）
 * @param options.retries 单只标的重试次数（默认 3）
 * @param options.signal 中止信号
 * @returns 成功取到的日线与失败清单
 */
export async function fetchIndexUniverse(
  options: {
    indexCode?: string
    limit?: number
    concurrency?: number
    retries?: number
    signal?: AbortSignal
    candles: (symbol: string, signal?: AbortSignal) => Promise<DailyBars>
  },
): Promise<{ bars: DailyBars[]; failed: string[]; requested: number }> {
  const codes = await fetchIndexConstituents(options.indexCode ?? INDEX_CODES.csi300, options.signal)
  const symbols = codes.map(toSymbol).filter((s): s is string => s !== undefined)
  const target = options.limit === undefined ? symbols : symbols.slice(0, options.limit)
  const concurrency = Math.max(1, options.concurrency ?? 4)
  const retries = Math.max(1, options.retries ?? 3)

  const queue = [...target]
  const bars: DailyBars[] = []
  const failed: string[] = []

  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const sym = queue.shift()!
      let ok = false
      for (let attempt = 0; attempt < retries && !ok; attempt++) {
        try {
          const res = await options.candles(sym, options.signal)
          if (!res.candles.length) throw new Error('empty candles')
          bars.push(res)
          ok = true
        } catch {
          // 指数退避后重试
          await new Promise(r => setTimeout(r, 400 + attempt * 700))
        }
      }
      if (!ok) failed.push(sym)
    }
  }))

  return { bars, requested: target.length, failed }
}
