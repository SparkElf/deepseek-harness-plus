# @sparkelf/dsh-quant

SparkElf-maintained fork of [pengpengyi92/dsh-quant](https://github.com/pengpengyi92/dsh-quant) (MIT),
installed into the **plus** profile as an optional quant-research bundle.

## Why a fork

Upstream is a strong AI-native quant toolkit (59 tools, 6 domains, zero runtime deps),
but two of its assumptions do not hold for **A-share research**, and one is a silent
correctness bug. The fork fixes those while staying backward compatible.

| # | Issue | Upstream behavior | Fork behavior |
|---|---|---|---|
| 1 | **Cross-sectional IC** | Its docs suggest "flatten a cross-section into a series", but `lagPair` then pairs `factor[i]` with `forwardReturns[i+1]`, mixing assets and periods. The IC is silently meaningless — no error. | New tool `quant_factor_evaluate_cs`: one Pearson IC + one RankIC **per period across assets**, then the time-series mean IC, IC std, ICIR, t-stat and positive-IC rate. |
| 2 | **Annualization hardcoded to 365** | `computeSharpe` / `equityMetrics` / `riskMetrics` assume 365 bars/year (crypto 7×24). A-share Sharpe is overstated by ≈22.6% (`sqrt(365/243)`). | `annualization` parameter added (default **365**, so upstream callers are unaffected; pass **243** for A-shares). |
| 3 | **winRate units** | Both `equityMetrics.winRate` and `tradeMetrics.winRate` return **percent** (0–100), while several consumers read them as fractions. | Not changed (a unit change would break upstream callers); documented, and callers must divide by 100 when a fraction is expected. |

## Evidence the fix is correct

Same real A-share dataset (8 stocks × 500 daily bars, Sina source, forward-adjusted):

| Method | mean IC | ICIR | mean RankIC |
|---|---|---|---|
| Python pandas `mom.corrwith(fwd, axis=1)` (independent) | **+0.0339** | **0.070** | **+0.0441** |
| Fork `quant_factor_evaluate_cs` | **+0.0339** | **0.070** | **+0.0441** |
| Upstream nested-loop flattened usage | −0.0373 | — | −0.0409 |

The fork matches the independent Python implementation exactly; upstream gets the sign wrong.

## Install

```sh
# Already installed into the plus profile as a linked local path:
dsh plugin --profile plus add /root/projects/dsh-quant-plus
```

The bundle patch (`cordis.patch.yml`) inserts one row:

```yaml
- insert:
    - id: quant-indicators      # historical anchor, kept for backward compatibility
      name: '@sparkelf/dsh-quant'
```

Disable or reconfigure it from your own profile patch layer by row id:

```yaml
- id: quant-indicators
  disabled: true
```

## A-share usage

```ts
import { fetchKlines, backtestMaCross, equityMetrics } from '@sparkelf/dsh-quant'

const res = await fetchKlines('sh600000', '1d', 600, AbortSignal.timeout(30_000), 'sina')
const close = (res.candles ?? res).map(c => c.close)
const bt = backtestMaCross(close, 10, 30, 0.0003)

// A-share: annualize by 243 trading days, not 365
const m = equityMetrics(bt.equityCurve, 243)
```

For cross-sectional factor work, build `[period][asset]` matrices and call
`quant_factor_evaluate_cs` — never flatten them into `quant_factor_evaluate`.

## Development

```sh
npm ci && npm run build && npx tsx --test tests/*.spec.ts   # 233 tests, all pass
```

- Branch `sparkelf/maintain` carries fork changes; `upstream` remote tracks the original.
- Upstream baseline: master @ `a403a2f` (v0.91.0).

## Known limitations (inherited from upstream)

- No short selling, leverage, or margin — long-only spot semantics.
- Strategies are a fixed family (dual-MA / Bollinger / RSI / portfolio / grid); no strategy callback API.
- Crypto-first market data; A-shares via Sina/Tencent daily bars only (no financials, no suspensions, no limit-up/down rules).
- No live trading by design.
