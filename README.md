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

## Live updates

Price, 24h change and 24h volume stream over Binance's WebSocket feed and update
about once a second with no interaction. Only the symbols on screen are
subscribed — the all-market feed is megabytes a second. Frames are buffered and
flushed on a timer so 25 streams do not drive 25 renders a second, and a price
cell tints green or red as it moves.

Row order is fixed by the scan so live prices never reshuffle the table while
you are reading it.

The indicators are not streamed. Smoothed Heikin Ashi and RSI only change when a
candle closes, so they refresh over REST every 3 minutes; rescanning faster
spends rate limit for nothing.

## Market cap

Binance does not publish circulating supply, so market cap cannot come from the
same source as everything else. Supply is read once per scan from CoinGecko's
top 250 by market cap, and market cap is then recomputed locally as
`supply × live price` so it moves with the stream.

Two consequences worth knowing: coins outside CoinGecko's top 250 show `—`
rather than a wrong number, and because ticker symbols collide across coins the
highest-market-cap match wins, which is a heuristic rather than an exact
mapping.

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

**Settings → Pages → Source must be "GitHub Actions".** On "Deploy from a
branch" GitHub additionally runs Jekyll over the repo on every push, and
whichever pipeline finishes last wins, so the site alternates between this build
and a Jekyll render of this README. The workflow cannot fix this itself:
changing the Pages source needs admin rights that `GITHUB_TOKEN` does not have.

## Disclaimer

A research tool, not financial advice.
