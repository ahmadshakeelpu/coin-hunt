# Coin Hunt

A Spot screener that looks for multi-timeframe trend alignment across the most
liquid USDT pairs, in both directions, on two exchanges.

Live: https://ahmadshakeelpu.github.io/coin-hunt/

## Pages

| Page | Exchange | Direction | Status |
| --- | --- | --- | --- |
| `/` | Binance | Bullish | working |
| `/bearish` | Binance | Bearish | working |
| `/mexc` | MEXC | Bullish | working, via a public CORS proxy |
| `/mexc/bearish` | MEXC | Bearish | working, via a public CORS proxy |

## Signal rules

A pair is an exact match when all five conditions hold on closed candles.

**Bullish**

| Timeframe | Condition |
| --- | --- |
| 1 day / 1 hour / 30 min | Smoothed Heikin Ashi green |
| 1 hour | RSI(14) between 55 and 57 |
| 30 min | RSI(14) between 56 and 58 |

**Bearish**

| Timeframe | Condition |
| --- | --- |
| 1 day / 1 hour / 30 min | Smoothed Heikin Ashi red |
| 1 hour | RSI(14) between 44 and 47 **and falling** |
| 30 min | RSI(14) between 42 and 44 **and falling** |

"Falling" compares the RSI on the last closed candle against the one before it;
the table shows a ↓ or ↑ next to each bearish reading. The bullish preset has no
direction requirement, matching how it was specified.

Smoothed Heikin Ashi is a double EMA (10/10): the OHLC series is smoothed,
converted to Heikin Ashi, then smoothed again. Pairs that miss are still listed
with a partial score so you can see how close they are.

Stablecoin and fiat bases are excluded, and only the top pairs by 24h quote
volume are scanned.

## Match alerts

The 🔔 button asks for browser notification permission and then fires a
notification plus a chime whenever a symbol *newly* becomes an exact match. A
coin that stays matched across rescans is not re-announced, and the tab title
carries a `(n)` badge so a backgrounded tab still shows the count. The
preference is remembered per browser.

These only fire while the page is open — the tab may be backgrounded or the
window minimised, but not closed. Alerting with the browser shut would need a
server running the scan, and Binance rejects datacenter IPs, which is the same
wall that forced the scan into the browser in the first place.

## How MEXC works, and its one weak point

MEXC's REST API returns no `Access-Control-Allow-Origin` header on any host
(`api.mexc.com`, `www.mexc.com`, `contract.mexc.com`), so a browser cannot call
it directly — every request fails with a CORS error while the same URL returns
200 from curl. Its WebSocket does connect from a browser, but it streams
protobuf rather than JSON and carries no candle history, so it cannot drive the
indicators either.

Requests therefore go through the public proxy `corsproxy.io`. **This is the
weak point of the MEXC pages: an unaffiliated third party sits in the live data
path, and if it rate limits or goes down, those two pages stop updating.**
Binance is unaffected. Replacing `MEXC_PROXY` in `app/screener-core.ts` with a
self-hosted proxy removes the dependency; MEXC serves datacenter IPs, so
anything that forwards `/api/v3/*` and adds CORS headers works.

Three MEXC-specific quirks the adapter handles:

- Its `exchangeInfo` is large enough that the proxy rejects it with `413`, so
  the symbol list is derived from the ticker snapshot instead (USDT pairs end in
  `USDT`, so the base asset is the remainder).
- It reports `priceChangePercent` as a **fraction** where Binance reports a
  percent, so it is scaled by 100. Without this, a 1% move displays as 0.01%.
- The proxy caches by URL, which would freeze prices at whatever it fetched
  first, so every request carries a unique parameter.

Live values come from polling the ticker snapshot every 5s rather than a socket.

**The proxy's rate limit is the binding constraint on the MEXC pages.** It
allows roughly 75 requests per window, and each scanned symbol costs three
candle requests, so MEXC scans 15 symbols against Binance's 25. Candles are
cached until the candle being built closes — a 30m candle cannot change for 30
minutes, so rescans reuse them instead of refetching — and failed requests are
retried, but a fresh load can still lose a few symbols. When that happens the
footnote says `13 of 15 (rest rate-limited)` rather than quietly showing a short
table. A self-hosted proxy removes the limit and lets MEXC scan the full 25.

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
