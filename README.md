# Coin Hunt

A Spot screener that looks for multi-timeframe trend alignment across the most
liquid USDT pairs, in both directions, on two exchanges.

Live: https://ahmadshakeelpu.github.io/coin-hunt/

## Pages

| Page | Market | Direction |
| --- | --- | --- |
| `/futures` | Binance Futures | Bullish |
| `/futures/bearish` | Binance Futures | Bearish |
| `/` | Binance Spot | Bullish |
| `/bearish` | Binance Spot | Bearish |
| `/mexc` | MEXC Spot | Bullish |
| `/mexc/bearish` | MEXC Spot | Bearish |

The nav groups Futures and Spot on separate rows.

## Signal rules

A pair is an exact match when all five conditions hold on closed candles.

**Bullish**

| Timeframe | Condition |
| --- | --- |
| 1 day | Smoothed Heikin Ashi green |
| 1 hour | Smoothed Heikin Ashi — **advisory, does not gate the match** |
| 30 min | Smoothed Heikin Ashi green |
| 1 hour | RSI(14) between 53 and 57 |
| 30 min | RSI(14) between 56 and 58 |
| 24h | Price change **at or above +7%** |

A bullish coin can therefore be an exact match with 1H SHA still red. The column
still shows it, and the rule strip labels it "optional", but it is not one of the
five checks. Bearish requires all three SHA timeframes, so it scores out of six.

**Bearish**

| Timeframe | Condition |
| --- | --- |
| 1 day / 1 hour / 30 min | Smoothed Heikin Ashi red |
| 1 hour | RSI(14) between 44 and 47 **and falling** |
| 30 min | RSI(14) between 42 and 44 **and falling** |
| 24h | Price change **at or below −7%** |

"Falling" compares the live RSI against the last closed candle's, so it tracks
the market rather than the last sweep. **Both presets show a ↓ or ↑** next to
every RSI reading — bearish requires the direction, bullish does not, but seeing
whether a reading is climbing into its band or falling out of it is the point of
watching it live.

24h change is evaluated live, like RSI, so a coin crossing ±7% moves in or out
of matching as it happens. The 24h cell turns lime when it satisfies the gate.
It is a hard filter: at a typical moment only ~28 of Binance's 671 USDT pairs are
at or above +7% and ~79 at or below −7%, so combined with the rest of the rules
exact matches are meant to be rare. Both thresholds live in `PRESETS` in
`app/screener-core.ts`.

Smoothed Heikin Ashi is a double EMA (10/10): the OHLC series is smoothed,
converted to Heikin Ashi, then smoothed again. Pairs that miss are still listed
with a partial score so you can see how close they are.

Stablecoin and fiat bases are excluded.

## Coverage

**Binance scans every tradeable USDT pair** — around 480 of them, once
non-spot and delisted symbols are filtered out. That is roughly 1,450 candle
requests at weight 2, inside Binance's 6,000/min budget, and takes about 30s.
Only the first sweep pays it: candles are cached until they close, so a rescan
refetches nothing until a 30m boundary passes.

The table fills in batches as the sweep runs, and the footnote reports anything
skipped — usually recent listings without enough candle history to compute an
indicator.

Rows render 150 at a time behind a "show all" control. Every pair is still
scanned, filtered, counted and alerted on; the cap only bounds how much DOM the
live flush has to touch. Rows are memoised on their rendered values, so a tick
only re-renders the symbols that actually moved.

**MEXC scans every pair above $100k/24h** — about 310 of its ~1,730 USDT
listings. The rest are dormant books where the indicators would be meaningless,
and most lack the candle history anyway. Lower `minQuoteVolume` in
`app/screener-core.ts` to widen it, at the cost of proxy invocations.

## Filtering

Alongside search there is a filter on how many checks a row passes: all coins,
within 2, within 1, or exact matches only. It runs on the live evaluation, so a
coin entering or leaving the band moves between filters as it happens.

## Match alerts

When a symbol newly becomes an exact match you get three things at once: a
browser notification listing each symbol with its price and both RSI readings, a
chime, and an on-page toast.

The toast matters because it works **without** notification permission — if the
browser prompt is declined or blocked, alerts still surface on the page rather
than failing silently. The 🔔 button reflects which you are getting.

The chime is synthesised, so the build carries no audio file: a rising major
arpeggio on bullish pages and a falling minor one on bearish, so the two are
distinguishable without looking. 🔊 mutes it, and clicking it while unmuted
replays it so you know what you are listening for. One AudioContext is shared
for the page — creating one per alert eventually throws and kills sound entirely.

A coin that stays matched is not re-announced, and the tab title carries a `(n)`
badge so a backgrounded tab still shows the count. Because matching is live, a
coin can cross in and out of a band repeatedly, so each symbol alerts at most
once every 10 minutes.

These only fire while the page is open — the tab may be backgrounded or the
window minimised, but not closed. Alerting with the browser shut would need a
server running the scan, and Binance rejects datacenter IPs, which is the same
wall that forced the scan into the browser in the first place.

### Binance Futures pacing

Futures allows **2,400 request-weight a minute against spot's 6,000**. Sweeping
all 526 perpetuals at spot pacing spent roughly three times that and earned a
`418` IP ban, so futures scans pairs above $2M/24h, four requests at a time,
and polls the ticker every 15s rather than 5s. Concurrency, poll interval and
volume floor are all per-exchange for this reason.

Its WebSocket is not used: `fstream.binance.com` accepts the connection and
acknowledges `SUBSCRIBE`, then sends nothing — no frames arrived on `@ticker`,
`@miniTicker`, `@aggTrade` or `@markPrice` while futures REST worked throughout.
Live values come from polling instead.

## How MEXC works

MEXC's REST API returns no `Access-Control-Allow-Origin` header on any host
(`api.mexc.com`, `www.mexc.com`, `contract.mexc.com`), so a browser cannot call
it directly — every request fails with a CORS error while the same URL returns
200 from curl. Its WebSocket does connect from a browser, but it streams
protobuf rather than JSON and carries no candle history, so it cannot drive the
indicators either.

Requests therefore go through our own edge function, source in [`proxy/`](proxy),
deployed on Vercel. MEXC serves datacenter IPs — unlike Binance, which `403`s
them — so forwarding from there works. It replaced the public `corsproxy.io`,
whose ~75 requests per window capped MEXC coverage at 15 symbols; that ceiling
is gone and coverage is now ~310.

The proxy forwards a fixed allowlist of public read-only endpoints and nothing
else. A general-purpose `?url=` proxy would be abused by anyone who found it.

Three MEXC-specific quirks the adapter handles:

- Its `exchangeInfo` is very large, so the symbol list is derived from the
  ticker snapshot instead (USDT pairs end in `USDT`, so the base asset is the
  remainder).
- It reports `priceChangePercent` as a **fraction** where Binance reports a
  percent, so it is scaled by 100. Without this, a 1% move displays as 0.01%.
- Its kline intervals are named differently: there is no `1h`, it is `60m`.

Live values come from polling the ticker snapshot every 5s rather than a socket,
since the protobuf feed is not usable.

### Proxy cost

A full MEXC sweep is about 900 invocations, and after the first sweep candles
are only refetched when one closes, so a tab open continuously costs roughly
1,000 invocations an hour. Candle responses are cached at the edge for 25s and
ticker responses for 2s, which absorbs repeat viewers. If usage matters, raise
`minQuoteVolume` — it is the single dial on how much this costs.

## Live updates

Price, 24h change and 24h volume stream over Binance's WebSocket feed and update
about once a second with no interaction. Only the symbols on screen are
subscribed — the all-market feed is megabytes a second. Frames are buffered and
flushed on a timer so ~480 streams do not drive ~480 renders a second, and a
price cell tints green or red as it moves.

RSI updates live too. The scan keeps the Wilder averages from the last closed
candle, so the reading for the candle currently being built is one arithmetic
step from the live price — no refetch. That is the same figure a chart shows
while a candle is open, and it means the match badge, the "Exact only" filter
and the alerts all track the market rather than the last sweep.

Smoothed Heikin Ashi is still evaluated on closed candles only, since the rules
are written against closed candles. Row order is also fixed at scan time, so a
moving RSI never reshuffles the table while you are reading it. Sweeps refresh
the candles every 3 minutes.

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

**Settings → Pages → Source should be "GitHub Actions".** On "Deploy from a
branch" GitHub additionally publishes the repo itself on every push, and
whichever pipeline finishes last wins — which served a Jekyll render of this
README at `/` and 404ed `/bearish`, `/mexc` and `/mexc/bearish`, since those
paths exist only in the build. The workflow cannot change that setting: it needs
admin rights `GITHUB_TOKEN` does not have.

Until it is switched, the workflow's final step copies the build to the branch
root so both pipelines serve the same site. The paths it writes are listed in
`.pages-mirror` and removed on the next run, so stale hashed assets do not
accumulate. Switching the source makes that step deletable, along with the
build output committed at the repo root.

## Disclaimer

A research tool, not financial advice.
