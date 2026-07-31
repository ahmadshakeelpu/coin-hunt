# Coin Hunt

A Binance Spot screener that looks for multi-timeframe trend alignment across
the most liquid USDT pairs.

Live: https://ahmadshakeelpu.github.io/coin-hunt/

## Signal rules

A pair is an exact match when all five conditions hold on closed candles:

| Timeframe | Condition |
| --- | --- |
| 1 day | Smoothed Heikin Ashi bullish |
| 1 hour | Smoothed Heikin Ashi bullish |
| 30 min | Smoothed Heikin Ashi bullish |
| 1 hour | RSI(14) between 55 and 57 |
| 30 min | RSI(14) between 56 and 58 |

Smoothed Heikin Ashi is a double EMA (10/10): the OHLC series is smoothed,
converted to Heikin Ashi, then smoothed again. Pairs that miss are still listed
with a partial score so you can see how close they are.

Stablecoin and fiat bases are excluded, and only the top pairs by 24h quote
volume are scanned.

## Why the scan runs in the browser

Binance's WAF returns `403` to requests from datacenter IP ranges, which covers
essentially every hosting provider. A server-side scan therefore fails on any
deployment, so the scan runs client-side from the visitor's own connection and
the app ships as a static site with no backend.

The practical consequence: anyone whose network blocks `binance.com`, or who is
in a region where Binance is geo-restricted, will see an error rather than data.
Serving those users would require a paid market-data provider or a proxy in an
unblocked region.

Requests fail over across `api.binance.com`, `api-gcp.binance.com` and
`data-api.binance.vision`, in that order, with a 12s timeout each.

## Development

```bash
npm install
npm run dev
```

Then open http://localhost:3000/coin-hunt/.

```bash
npm run build
```

Produces a static export in `out/`. Pushing to `main` builds and publishes it to
GitHub Pages via `.github/workflows/deploy.yml`.

## Disclaimer

A research tool, not financial advice.
