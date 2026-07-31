"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Kline = [number, string, string, string, string, string, number, ...unknown[]];
type Ticker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };
type ExchangeInfo = {
  symbols: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    isSpotTradingAllowed: boolean;
  }>;
};
type CoinResult = {
  symbol: string;
  baseAsset: string;
  price: number;
  change24h: number;
  quoteVolume: number;
  sha1d: boolean;
  sha1h: boolean;
  sha30m: boolean;
  rsi1h: number;
  rsi30m: number;
  match: boolean;
  score: number;
};
type ScanResponse = {
  coins: CoinResult[];
  scanned: number;
  updatedAt: string;
  durationMs: number;
  settings: { shaLength1: number; shaLength2: number; rsiLength: number };
};

// Ordered fastest-first. data-api.binance.vision stays reachable in regions
// where the main host is restricted, but responds far slower, so it is a
// fallback rather than the default.
const API_HOSTS = [
  "https://api.binance.com",
  "https://api-gcp.binance.com",
  "https://data-api.binance.vision",
];
const REQUEST_TIMEOUT_MS = 12_000;
const SHA_LENGTH_1 = 10;
const SHA_LENGTH_2 = 10;
const RSI_LENGTH = 14;
const SCAN_LIMIT = 25;
const EXCLUDED_BASES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "TRY", "BRL", "GBP", "UAH", "BIDR", "AEUR"]);

async function requestJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", mode: "cors", signal: controller.signal });
    if (!response.ok) throw new Error(`Binance returned ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Binance request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function connectToBinance() {
  let lastError: unknown;
  for (const host of API_HOSTS) {
    try {
      const exchange = await requestJson<ExchangeInfo>(`${host}/api/v3/exchangeInfo?permissions=SPOT`);
      return { host, exchange };
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : "connection blocked";
  throw new Error(`Binance public data is unavailable from this network (${reason}). No API key is required.`);
}

function ema(values: number[], length: number) {
  if (!values.length) return [];
  const alpha = 2 / (length + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index++) {
    result.push(alpha * values[index] + (1 - alpha) * result[index - 1]);
  }
  return result;
}

function smoothedHeikinAshiBullish(klines: Kline[]) {
  const closed = klines.filter((candle) => candle[6] < Date.now());
  if (closed.length < 30) throw new Error("Not enough candle history");
  const open = ema(closed.map((c) => Number(c[1])), SHA_LENGTH_1);
  const high = ema(closed.map((c) => Number(c[2])), SHA_LENGTH_1);
  const low = ema(closed.map((c) => Number(c[3])), SHA_LENGTH_1);
  const close = ema(closed.map((c) => Number(c[4])), SHA_LENGTH_1);
  const haClose = close.map((value, i) => (open[i] + high[i] + low[i] + value) / 4);
  const haOpen: number[] = [(open[0] + close[0]) / 2];
  for (let i = 1; i < haClose.length; i++) haOpen.push((haOpen[i - 1] + haClose[i - 1]) / 2);
  const finalOpen = ema(haOpen, SHA_LENGTH_2);
  const finalClose = ema(haClose, SHA_LENGTH_2);
  return finalClose.at(-1)! > finalOpen.at(-1)!;
}

function calculateRsi(klines: Kline[], length = RSI_LENGTH) {
  const closes = klines.filter((candle) => candle[6] < Date.now()).map((candle) => Number(candle[4]));
  if (closes.length <= length) throw new Error("Not enough candle history");
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / length;
  let averageLoss = loss / length;
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    averageGain = (averageGain * (length - 1) + Math.max(change, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-change, 0)) / length;
  }
  if (averageLoss === 0) return 100;
  return 100 - 100 / (1 + averageGain / averageLoss);
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R | null>,
) {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch {
        results[index] = null;
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results.filter((value): value is R => value !== null);
}

async function runBrowserScan(): Promise<ScanResponse> {
  const started = Date.now();
  const { host, exchange } = await connectToBinance();
  const tickers = await requestJson<Ticker[]>(`${host}/api/v3/ticker/24hr`);
  const symbols = new Map(
    exchange.symbols
      .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING" && s.isSpotTradingAllowed && !EXCLUDED_BASES.has(s.baseAsset))
      .map((s) => [s.symbol, s]),
  );
  const candidates = tickers
    .filter((ticker) => symbols.has(ticker.symbol) && Number(ticker.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, SCAN_LIMIT);

  const coins = await mapWithConcurrency(candidates, 5, async (ticker) => {
    const symbolInfo = symbols.get(ticker.symbol)!;
    const symbol = encodeURIComponent(ticker.symbol);
    const base = `${host}/api/v3/klines?symbol=${symbol}&limit=160&interval=`;
    const [day, hour, halfHour] = await Promise.all([
      requestJson<Kline[]>(`${base}1d`),
      requestJson<Kline[]>(`${base}1h`),
      requestJson<Kline[]>(`${base}30m`),
    ]);
    const sha1d = smoothedHeikinAshiBullish(day);
    const sha1h = smoothedHeikinAshiBullish(hour);
    const sha30m = smoothedHeikinAshiBullish(halfHour);
    const rsi1h = calculateRsi(hour);
    const rsi30m = calculateRsi(halfHour);
    const checks = [sha1d, sha1h, sha30m, rsi1h >= 55 && rsi1h <= 57, rsi30m >= 56 && rsi30m <= 58];
    return {
      symbol: ticker.symbol,
      baseAsset: symbolInfo.baseAsset,
      price: Number(ticker.lastPrice),
      change24h: Number(ticker.priceChangePercent),
      quoteVolume: Number(ticker.quoteVolume),
      sha1d, sha1h, sha30m, rsi1h, rsi30m,
      match: checks.every(Boolean),
      score: checks.filter(Boolean).length,
    };
  });

  if (!coins.length) throw new Error("Binance connected, but candle requests were blocked. Please disable any strict tracker blocker and retry.");
  coins.sort((a, b) => Number(b.match) - Number(a.match) || b.score - a.score || b.quoteVolume - a.quoteVolume);
  return {
    coins,
    scanned: coins.length,
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    settings: { shaLength1: SHA_LENGTH_1, shaLength2: SHA_LENGTH_2, rsiLength: RSI_LENGTH },
  };
}

const formatPrice = (value: number) => {
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value.toLocaleString("en-US", { maximumSignificantDigits: 5 });
};
const formatVolume = (value: number) =>
  value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : `$${(value / 1e6).toFixed(1)}M`;

function Candle({ bull }: { bull: boolean }) {
  return <span className={`candle ${bull ? "bull" : "bear"}`}><i />{bull ? "Green" : "Red"}</span>;
}

function Rsi({ value, min, max }: { value: number; min: number; max: number }) {
  const inRange = value >= min && value <= max;
  return (
    <span className={`rsi ${inRange ? "in-range" : ""}`}>
      {value.toFixed(1)}
      <span className="rsi-bar"><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></span>
    </span>
  );
}

export function CoinHuntDashboard() {
  const [data, setData] = useState<ScanResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [matchesOnly, setMatchesOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Binance rejects datacenter IPs with a 403, so the scan has to run from
      // the visitor's own connection rather than from a server.
      setData(await runBrowserScan());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load the market scan.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 60_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const coins = useMemo(() => {
    const q = query.trim().toUpperCase();
    return (data?.coins ?? []).filter(
      (coin) => (!matchesOnly || coin.match) && (!q || coin.symbol.includes(q) || coin.baseAsset.includes(q)),
    );
  }, [data, matchesOnly, query]);

  const matches = data?.coins.filter((coin) => coin.match).length ?? 0;
  const updated = data ? new Date(data.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌁</span> Coin Hunt <span className="brand-sub">BINANCE SPOT SCREENER</span></div>
        <div className="live-pill"><span className="live-dot" /> LIVE MARKET DATA</div>
      </header>

      <main className="main">
        <section className="hero">
          <div>
            <div className="eyebrow">Multi-timeframe signal engine</div>
            <h1>Find alignment.<br />Before the crowd.</h1>
            <p>Scanning liquid Binance Spot USDT pairs using closed candles. Exact signals require three bullish Smoothed Heikin Ashi timeframes and both RSI windows to align.</p>
          </div>
          <button className="refresh-button" onClick={load} disabled={loading}>{loading ? "Scanning…" : "↻ Run scan"}</button>
        </section>

        <section className="rule-strip" aria-label="Active signal rules">
          <div className="rule"><div className="rule-k">1 Day</div><div className="rule-v green">SHA · GREEN</div></div>
          <div className="rule"><div className="rule-k">1 Hour</div><div className="rule-v green">SHA · GREEN</div></div>
          <div className="rule"><div className="rule-k">30 Minutes</div><div className="rule-v green">SHA · GREEN</div></div>
          <div className="rule"><div className="rule-k">1H RSI (14)</div><div className="rule-v">55.0 — 57.0</div></div>
          <div className="rule"><div className="rule-k">30m RSI (14)</div><div className="rule-v">56.0 — 58.0</div></div>
        </section>

        <div className="status-row">
          <div className="status-left"><h2>Market candidates</h2><span className="count">{matches} MATCH{matches === 1 ? "" : "ES"}</span></div>
          <div className="controls">
            <input className="search" aria-label="Search coin" placeholder="Search coin…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className={`filter-button ${matchesOnly ? "active" : ""}`} onClick={() => setMatchesOnly((v) => !v)}>Exact only</button>
          </div>
        </div>

        <div className="table-wrap">
          {error ? (
            <div className="error"><strong>Scan could not complete</strong>{error}<br /><button className="filter-button" onClick={load} style={{ marginTop: 16 }}>Try again</button></div>
          ) : (
            <table>
              <thead><tr><th>Asset</th><th>Price</th><th>24H</th><th>1D SHA</th><th>1H SHA</th><th>30m SHA</th><th>1H RSI</th><th>30m RSI</th><th>Signal</th><th></th></tr></thead>
              <tbody>
                {loading && !data ? Array.from({ length: 7 }, (_, index) => (
                  <tr className="skeleton-row" key={index}>{Array.from({ length: 10 }, (_, cell) => <td key={cell}><div className="shimmer" /></td>)}</tr>
                )) : coins.map((coin) => (
                  <tr key={coin.symbol}>
                    <td><div className="coin"><span className="coin-icon">{coin.baseAsset.slice(0, 2)}</span><div><div className="coin-name">{coin.baseAsset}</div><div className="coin-pair">{coin.symbol}</div></div></div></td>
                    <td className="mono">${formatPrice(coin.price)}<div className="coin-pair">{formatVolume(coin.quoteVolume)}</div></td>
                    <td className={`mono ${coin.change24h >= 0 ? "positive" : "negative"}`}>{coin.change24h >= 0 ? "+" : ""}{coin.change24h.toFixed(2)}%</td>
                    <td><Candle bull={coin.sha1d} /></td><td><Candle bull={coin.sha1h} /></td><td><Candle bull={coin.sha30m} /></td>
                    <td><Rsi value={coin.rsi1h} min={55} max={57} /></td><td><Rsi value={coin.rsi30m} min={56} max={58} /></td>
                    <td><span className={coin.match ? "match-badge" : "near-badge"}>{coin.match ? "Exact match" : `${coin.score}/5 aligned`}</span></td>
                    <td><a className="chart-link" href={`https://www.binance.com/en/trade/${coin.baseAsset}_USDT?type=spot`} target="_blank" rel="noreferrer" aria-label={`Open ${coin.baseAsset} chart`}>↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && !error && coins.length === 0 && <div className="empty"><strong>No coins match this view</strong>Turn off “Exact only” to inspect the closest candidates.</div>}
        </div>

        <div className="footnote">
          <span>Last scan {updated} · {data?.scanned ?? 0} liquid USDT pairs · {data?.durationMs ?? 0}ms</span>
          <span>Official Binance Spot public data API · SHA: double EMA {data?.settings.shaLength1 ?? 10}/{data?.settings.shaLength2 ?? 10} · Closed candles only · Research tool, not financial advice.</span>
        </div>
      </main>
    </div>
  );
}
