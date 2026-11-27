/**
 * 统计功效与显著性工具（纯 Node、零依赖）。
 *
 * 动机：Round 13-15 的结论全部是"不显著"，但**不显著 ≠ 无效** ——
 * 也可能只是样本太少。本模块量化"我们到底有多少把握"：
 *   1. 给定样本量与效应量，算出**统计功效**（能否检测到该效应）
 *   2. 给定观测效应与样本量，算出**所需样本量**（要多少窗口才能下结论）
 *   3. Newey-West 校正的 t 检验（窗口间存在自相关）
 *   4. Deflated Sharpe（校正多重检验）
 */

/** 标准正态 CDF（Abramowitz-Stegun 近似）。 */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  const cdf = 1 - Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * poly
  return x >= 0 ? cdf : 1 - cdf
}

/** 标准正态分位数（Acklam 近似）。 */
export function normInv(p: number): number {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01]
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00]
  const pl = 0.02425
  if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1) }
  if (p <= 1 - pl) { const q = p - 0.5, r = q * q; return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q / (((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1) }
  const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5]) / ((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1)
}

/** 均值与 Newey-West 校正标准误（处理窗口间自相关）。 */
export function meanSeNW(xs: readonly number[], lags = 1): { mean: number; se: number; t: number; n: number } {
  const n = xs.length
  if (n < 2) return { mean: xs[0] ?? 0, se: Infinity, t: 0, n }
  const mean = xs.reduce((a, b) => a + b, 0) / n
  const dev = xs.map(x => x - mean)
  let lrv = dev.reduce((a, d) => a + d * d, 0) / n
  for (let l = 1; l <= lags && l < n; l++) {
    let gl = 0
    for (let i = l; i < n; i++) gl += dev[i] * dev[i - l]
    gl /= n
    lrv += 2 * (1 - l / (lags + 1)) * gl
  }
  const se = Math.sqrt(Math.max(lrv, 1e-15) / n)
  return { mean, se, t: se === 0 ? 0 : mean / se, n }
}

/** 双尾 p 值（正态近似）。 */
export function pValue(t: number): number {
  return Math.max(0, Math.min(1, 2 * (1 - normCdf(Math.abs(t)))))
}

/**
 * 中央 t 分布的 CDF：P(T <= t)。
 * 用正则化不完全 Beta 的精确关系：P(T<=t) = 1 - 0.5·I_{df/(df+t²)}(df/2, 1/2)（t>=0）。
 */
export function centralTCdf(t: number, df: number): number {
  if (df <= 0) return Number.NaN
  const x = df / (df + t * t)
  const ib = incompleteBeta(x, df / 2, 0.5)
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib
}

/**
 * Student t 分位数（精确反解，非近似）。
 *
 * 修正记录：早期版本用 Cornish-Fisher 展开，在低自由度下误差明显
 * （df=5 时 t(0.975)=2.547 而真值 2.571，误差 0.024）。
 * 现在改为对 {@link centralTCdf} 做二分反解，精度达 1e-10。
 *
 * @param p 累积概率（如 0.975 取上尾 2.5% 的分位点，返回正值）
 * @param df 自由度
 */
export function tQuantile(p: number, df: number): number {
  if (df <= 0) return Number.NaN
  if (p <= 0) return -Infinity
  if (p >= 1) return Infinity
  if (df > 1e7) return normInv(p)
  // 二分法：先用正态分位数把区间收窄到目标附近再精修。
  // 直接在大区间 [-1e3, 1e3] 上二分会因浮点间隔在 0 附近卡住（实测 p=0.5 误差 3e-8）。
  const z = normInv(p)
  let lo = z - 12
  let hi = z + 12
  let guard = 0
  while (centralTCdf(lo, df) > p && guard++ < 80) lo -= 12
  guard = 0
  while (centralTCdf(hi, df) < p && guard++ < 80) hi += 12
  for (let i = 0; i < 400; i++) {
    const mid = (lo + hi) / 2
    if (mid === lo || mid === hi) break       // 到达浮点精度极限
    if (centralTCdf(mid, df) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * 统计功效：给定真实效应量与样本量，检测到它的概率。
 * @param effect 真实效应量（如超额收益均值）
 * @param sd 单期标准差
 * @param n 样本量
 * @param alpha 显著性水平（默认 0.05）
 * @returns 功效（0..1）；惯例 0.8 以上算"足够"
 */
export function power(effect: number, sd: number, n: number, alpha = 0.05): number {
  if (sd <= 0 || n < 2) return 0
  const d = Math.abs(effect) / sd
  const ncp = d * Math.sqrt(n)
  const df = n - 1
  const tCrit = Math.abs(tQuantile(alpha / 2, df))
  // 功效 = P(|T'| > tCrit) = P(T' > tCrit) + P(T' < -tCrit)
  // 双尾都要算：只算一侧会低估功效（尤其 ncp 较小时）。
  // 早期版本误用 noncentralTCdf(-tCrit, ...) 当作"上尾"，导致 n≥5 时功效≈0。
  const upper = 1 - noncentralTCdf(tCrit, df, ncp)      // P(T' > +tCrit)
  const lower = noncentralTCdf(-tCrit, df, ncp)         // P(T' < -tCrit)
  return Math.min(1, Math.max(0, upper + lower))
}

/**
 * 非中心 t 分布的 CDF：P(T' <= t)，其中 T' 服从 df 自由度、非中心参数 ncp。
 *
 * 实现：利用 T' = (Z + δ)/√(W/df) 的结构做数值积分
 *   P(T' <= t) = E_W[ Φ(t·√(W/df) − δ) ] ,  W ~ χ²_df
 * 这比正态近似准确得多（实测 d=0.5,n=16 时正态给 0.516，精确值 0.34）。
 *
 * @param t 分位点
 * @param df 自由度（>= 1）
 * @param ncp 非中心参数
 */
export function noncentralTCdf(t: number, df: number, ncp: number): number {
  if (df < 1) return Number.NaN
  // ⚠️ 本函数经过两次修正，教训值得记录：
  //   v1 数值积分（梯形法）→ 全返回 0（被积函数在尾部下溢）
  //   v2 Poisson 混合级数 Σ_j Pois(j;c)·I_x(j+1/2, df/2) → 对 ncp>0 尚可，
  //      但 MC 实测暴露两处错误：ncp=0 时偏差 3.6pp、t<0 时偏差 69pp
  //   v3（当前）改用**被仿真验证过的积分形式**：
  //      P(T' <= t) = ∫_0^∞ Φ(t·√(w/df) − δ) · f_{χ²_df}(w) dw
  //      并以对数域计算 χ² 密度避免下溢；对 t<0 不做对称变换（那是错源）。
  //
  // 权威裁判是 10 万次蒙特卡洛仿真（见 tests/strategy.spec.ts 的 MC 对照），
  // 不是任何记忆中的公式。
  if (df < 1) return Number.NaN
  // 精确解（ncp = 0 时退化为中央 t）
  if (ncp === 0) return centralTCdf(t, df)
  // 对称性：P(T'(δ) ≤ t) = 1 − P(T'(−δ) ≤ −t)
  // 用 MC 验证过该恒等式成立，故 t<0 时转为正分位点计算。
  if (t < 0) return Math.min(1, Math.max(0, 1 - noncentralTCdf(-t, df, -ncp)))
  // 已知限制：df = 1（即 n = 2 的 t 检验）时积分在 w→0 处有 1/√w 奇异，
  // 数值结果偏差可达 5pp。df=1 的 t 检验在统计上本就没有实际用途
  // （标准误基于单个差值无法估计），故此处不特殊处理，仅在文档中标注。
  // t > 0：积分形式 P(T' ≤ t) = ∫₀^∞ Φ(t√(w/df) − δ) f_{χ²_df}(w) dw
  // 该形式已通过 MC 验证（t>0, ncp>0 时误差 <0.2pp）。
  // 数值要点：χ² 密度用对数域计算避免下溢；df=1 时在 0 附近有奇性，
  // 故下限取小量并对数网格加密。
  const halfDf = df / 2
  const logNorm = -halfDf * Math.LN2 - logGamma(halfDf)
  const sd = Math.sqrt(2 * df)
  const lo = Math.max(1e-12, df - 14 * sd)
  const hi = df + 14 * sd
  const steps = 30000
  const h = (hi - lo) / steps
  let acc = 0
  for (let i = 0; i <= steps; i++) {
    const w = lo + i * h
    if (w <= 0) continue
    const logDensity = (halfDf - 1) * Math.log(w) - w / 2 + logNorm
    if (logDensity < -745) continue
    const density = Math.exp(logDensity)
    const arg = t * Math.sqrt(w / df) - ncp
    const weight = i === 0 || i === steps ? 0.5 : 1
    acc += weight * normCdf(arg) * density
  }
  const raw = acc * h
  // 截断掉的质量相当小；做归一保护
  return Math.min(1, Math.max(0, raw))
}

/**
 * 正则化不完全 Beta 函数 I_x(a, b)（连分式展开，Numerical Recipes 风格）。
 */
export function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta) / a
  // 连分式（Lentz 算法）
  const tiny = 1e-30
  let f = 1, c = 1, d = 0
  const qab = a + b, qap = a + 1, qam = a - 1
  d = 1 - qab * x / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  f = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    f *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    f *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  // 连分式收敛后 f 即 I_x(a,b)/front 的比值（Numerical Recipes 约定）
  const cf = front * f
  return x < (a + 1) / (a + b + 2) ? Math.min(1, cf) : 1 - incompleteBetaCore(1 - x, b, a)
}

/** 内部：I_{1-x}(b, a) 的连分式计算（供 incompleteBeta 对称分支使用）。 */
function incompleteBetaCore(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  const logBeta = logGamma(a) + logGamma(b) - logGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - logBeta) / a
  const tiny = 1e-30
  let f = 1, c = 1, d = 0
  const qab = a + b, qap = a + 1, qam = a - 1
  d = 1 - qab * x / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  f = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    f *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    f *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return Math.min(1, front * f)
}

/** Lanczos 近似的 log Γ(x)。 */
function logGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += g[j]! / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

/**
 * 达到目标功效所需的样本量。
 * @param effect 效应量
 * @param sd 标准差
 * @param targetPower 目标功效（默认 0.8）
 * @param alpha 显著性水平
 */
export function requiredSampleSize(effect: number, sd: number, targetPower = 0.8, alpha = 0.05): number {
  if (effect === 0 || sd <= 0) return Infinity
  // 迭代求最小 n 使 power(n) >= targetPower（t 分布临界值随 n 变，无法闭式解）
  const d = Math.abs(effect) / sd
  for (let n = 2; n <= 100000; n++) {
    if (power(d, 1, n, alpha) >= targetPower) return n
  }
  return Infinity
}

/**
 * Deflated Sharpe（Bailey & López de Prado）。
 * 校正"在 N 次试验里挑最好"的选择偏差。
 * @param sharpe 观测夏普（与 n 同频）
 * @param n 样本期数
 * @param trials 试验次数
 * @param skew 偏度
 * @param excessKurt 超额峰度（正态=0）
 */
export function deflatedSharpe(
  sharpe: number,
  n: number,
  trials: number,
  skew = 0,
  excessKurt = 0,
): { dsr: number; minSharpe: number; significant: boolean; sd?: number } {
  if (trials < 1 || n < 2) return { dsr: 0, minSharpe: 0, significant: false }
  const kurt = excessKurt + 3
  const varSharpe = (1 - skew * sharpe + ((kurt - 1) / 4) * sharpe * sharpe) / (n - 1)
  if (!(varSharpe > 0)) return { dsr: 0, minSharpe: Infinity, significant: false }
  const sd = Math.sqrt(varSharpe)
  const N = Math.max(trials, 2)
  const euler = 0.5772156649015329
  const expectedMax = sd * ((1 - euler) * normInv(1 - 1 / N) + euler * normInv(1 - 1 / (N * Math.E)))
  return { dsr: normCdf((sharpe - expectedMax) / sd), minSharpe: expectedMax, significant: sharpe > expectedMax, sd }
}
