"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EXCHANGES, FLASH_MS, FLUSH_INTERVAL_MS, POLL_INTERVAL_MS, PRESETS, RESCAN_INTERVAL_MS,
  SHA_LENGTH_1, SHA_LENGTH_2, evaluate, fetchSupplyMap, formatPrice, formatUsd, requestJson, runScan, tickerUrl,
  type Exchange, type LiveTick, type Preset, type ScanResponse, type Ticker,
} from "./screener-core";
import {
  chime, loadPreference, notifyMatches, readPermission, requestPermission, savePreference,
  type AlertPermission,
} from "./alerts";

/** A symbol will not alert again within this window. */
const RE_ANNOUNCE_MS = 10 * 60_000;

const PAGES = [
  { href: "/", exchange: "binance", preset: "bullish", label: "Binance · Bullish" },
  { href: "/bearish", exchange: "binance", preset: "bearish", label: "Binance · Bearish" },
  { href: "/mexc", exchange: "mexc", preset: "bullish", label: "MEXC · Bullish" },
  { href: "/mexc/bearish", exchange: "mexc", preset: "bearish", label: "MEXC · Bearish" },
] as const;

function Candle({ bull }: { bull: boolean }) {
  return <span className={`candle ${bull ? "bull" : "bear"}`}><i />{bull ? "Green" : "Red"}</span>;
}

function Rsi({ value, band, falling, requireFalling }: {
  value: number; band: [number, number]; falling: boolean; requireFalling: boolean;
}) {
  const ok = value >= band[0] && value <= band[1] && (!requireFalling || falling);
  return (
    <span className={`rsi ${ok ? "in-range" : ""}`}>
      {value.toFixed(1)}
      {requireFalling && <span className={`trend ${falling ? "down" : "up"}`}>{falling ? "↓" : "↑"}</span>}
      <span className="rsi-bar"><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></span>
    </span>
  );
}

export function Screener({ exchangeKey, presetKey }: { exchangeKey: Exchange["key"]; presetKey: Preset["key"] }) {
  const exchange = EXCHANGES[exchangeKey];
  const preset = PRESETS[presetKey];

  const [data, setData] = useState<ScanResponse | null>(null);
  const [live, setLive] = useState<Record<string, LiveTick>>({});
  const [supply, setSupply] = useState<Record<string, number>>({});
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [matchesOnly, setMatchesOnly] = useState(false);

  const [alertsOn, setAlertsOn] = useState(false);
  const [permission, setPermission] = useState<AlertPermission>("default");

  // Frames arrive about once a second per symbol. Buffer them and flush on a
  // timer so 25 streams do not drive 25 renders a second.
  const pendingRef = useRef<Record<string, LiveTick>>({});
  const lastPriceRef = useRef<Record<string, number>>({});
  /** When each symbol was last announced, to rate-limit repeat crossings. */
  const announcedRef = useRef<Map<string, number>>(new Map());

  const recordTick = useCallback((symbol: string, price: number, change24h: number, quoteVolume: number) => {
    if (!Number.isFinite(price)) return;
    const previous = lastPriceRef.current[symbol];
    lastPriceRef.current[symbol] = price;
    pendingRef.current[symbol] = {
      price, change24h, quoteVolume,
      dir: previous === undefined || price === previous ? null : price > previous ? "up" : "down",
      at: Date.now(),
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Exchanges reject datacenter IPs, so the scan runs from the visitor's
      // own connection rather than from a server.
      const [scan, supplyMap] = await Promise.all([
        runScan(exchange, preset, setData),
        fetchSupplyMap(),
      ]);
      setData(scan);
      setSupply(supplyMap);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Unable to load the market scan.");
    } finally {
      setLoading(false);
    }
  }, [exchange, preset]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, RESCAN_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const symbolKey = useMemo(() => (data?.coins ?? []).map((coin) => coin.symbol).join(","), [data]);

  // Stream only the symbols on screen; the all-market feed is megabytes a
  // second. Waiting for the sweep to finish keeps the progressive batches from
  // tearing the socket down and rebuilding it every fifteen rows.
  useEffect(() => {
    if (loading || !symbolKey || !exchange.streamUrl) return;
    const symbols = symbolKey.split(",");
    const socket = new WebSocket(exchange.streamUrl(symbols));
    socket.onopen = () => setStreaming(true);
    socket.onclose = () => setStreaming(false);
    socket.onerror = () => setStreaming(false);
    socket.onmessage = (event) => {
      try {
        const frame = JSON.parse(String(event.data)) as { data?: { s?: string; c?: string; P?: string; q?: string } };
        const tick = frame.data;
        if (tick?.s) recordTick(tick.s, Number(tick.c), Number(tick.P), Number(tick.q));
      } catch {
        // Ignore frames that are not ticker payloads.
      }
    };
    return () => socket.close();
  }, [symbolKey, loading, exchange, recordTick]);

  // Exchanges without a usable socket fall back to polling the ticker snapshot.
  useEffect(() => {
    if (loading || !symbolKey || exchange.streamUrl) return;
    const symbols = new Set(symbolKey.split(","));
    let cancelled = false;
    const poll = async () => {
      try {
        const tickers = await requestJson<Ticker[]>(tickerUrl(exchange));
        if (cancelled) return;
        for (const ticker of tickers) {
          if (symbols.has(ticker.symbol)) {
            recordTick(
              ticker.symbol,
              Number(ticker.lastPrice),
              Number(ticker.priceChangePercent) * exchange.changeScale,
              Number(ticker.quoteVolume),
            );
          }
        }
        setStreaming(true);
      } catch {
        setStreaming(false);
      }
    };
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [symbolKey, loading, exchange, recordTick]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const pending = pendingRef.current;
      pendingRef.current = {};
      const arrived = Object.keys(pending);
      setLive((previous) => {
        const next = { ...previous, ...pending };
        let changed = arrived.length > 0;
        const now = Date.now();
        for (const symbol of Object.keys(next)) {
          if (next[symbol].dir && now - next[symbol].at > FLASH_MS) {
            next[symbol] = { ...next[symbol], dir: null };
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    }, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const current = readPermission();
    setPermission(current);
    setAlertsOn(current === "granted" && loadPreference());
  }, []);

  const toggleAlerts = useCallback(async () => {
    if (alertsOn) {
      setAlertsOn(false);
      savePreference(false);
      return;
    }
    const granted = await requestPermission();
    setPermission(granted);
    if (granted === "granted") {
      setAlertsOn(true);
      savePreference(true);
      chime();
    }
  }, [alertsOn]);

  // Every row scored against its live price. Row order stays as the scan left
  // it, so a moving RSI never reshuffles the table while it is being read.
  const evaluated = useMemo(
    () =>
      (data?.coins ?? []).map((coin) => {
        const tick = live[coin.symbol];
        const price = tick?.price ?? coin.price;
        const circulating = supply[coin.baseAsset];
        return {
          ...evaluate(coin, preset, price),
          price,
          change24h: tick?.change24h ?? coin.change24h,
          quoteVolume: tick?.quoteVolume ?? coin.quoteVolume,
          marketCap: circulating ? circulating * price : 0,
          dir: tick?.dir ?? null,
        };
      }),
    [data, live, preset, supply],
  );

  const coins = useMemo(() => {
    const q = query.trim().toUpperCase();
    return evaluated.filter(
      (coin) => (!matchesOnly || coin.match) && (!q || coin.symbol.includes(q) || coin.baseAsset.includes(q)),
    );
  }, [evaluated, matchesOnly, query]);

  const matches = evaluated.filter((coin) => coin.match).length;
  const matchKey = evaluated.filter((coin) => coin.match).map((coin) => coin.symbol).sort().join(",");

  // Matching is live now, so a coin can cross the band repeatedly. Announce a
  // symbol at most once per window rather than on every crossing.
  useEffect(() => {
    if (!alertsOn || !matchKey) return;
    const now = Date.now();
    const fresh = matchKey.split(",").filter((symbol) => {
      const last = announcedRef.current.get(symbol);
      return last === undefined || now - last > RE_ANNOUNCE_MS;
    });
    if (!fresh.length) return;
    for (const symbol of fresh) announcedRef.current.set(symbol, now);
    notifyMatches(fresh, `${exchange.label} ${preset.key}`, `coin-hunt-${exchange.key}-${preset.key}`);
    chime();
  }, [matchKey, alertsOn, exchange, preset]);

  const updated = data ? new Date(data.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";

  // Badge the tab so a backgrounded page still shows the count.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = matches ? `(${matches}) ${base}` : base;
  }, [matches]);
  const shaLabel = preset.shaBullish ? "SHA · GREEN" : "SHA · RED";
  const band = (range: [number, number]) =>
    preset.requireFalling ? `${range[1].toFixed(1)} → ${range[0].toFixed(1)} ↓` : `${range[0].toFixed(1)} — ${range[1].toFixed(1)}`;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">⌁</span> Coin Hunt <span className="brand-sub">SPOT SCREENER</span></div>
        <div className={`live-pill ${streaming ? "" : "offline"}`}>
          <span className="live-dot" /> {streaming ? "LIVE — STREAMING" : "CONNECTING…"}
        </div>
      </header>

      <nav className="pagenav" aria-label="Screener pages">
        {PAGES.map((page) => {
          const active = page.exchange === exchangeKey && page.preset === presetKey;
          return (
            <Link key={page.href} href={page.href} className={`pagenav-link ${active ? "active" : ""} ${page.preset}`} aria-current={active ? "page" : undefined}>
              {page.label}
            </Link>
          );
        })}
      </nav>

      <main className="main">
        <section className="hero">
          <div>
            <div className="eyebrow">{exchange.label} · {preset.label}</div>
            <h1>{preset.shaBullish ? <>Find alignment.<br />Before the crowd.</> : <>Catch the breakdown.<br />Before the bounce.</>}</h1>
            <p>
              Scanning liquid {exchange.label} Spot USDT pairs using closed candles. An exact signal needs all three
              Smoothed Heikin Ashi timeframes {preset.shaBullish ? "green" : "red"} and both RSI windows in band
              {preset.requireFalling ? " while still falling." : "."}
            </p>
          </div>
          <button className="refresh-button" onClick={load} disabled={loading}>{loading ? "Scanning…" : "↻ Rescan signals"}</button>
        </section>

        <section className="rule-strip" aria-label="Active signal rules">
          <div className="rule"><div className="rule-k">1 Day</div><div className={`rule-v ${preset.shaBullish ? "green" : "red"}`}>{shaLabel}</div></div>
          <div className="rule"><div className="rule-k">1 Hour</div><div className={`rule-v ${preset.shaBullish ? "green" : "red"}`}>{shaLabel}</div></div>
          <div className="rule"><div className="rule-k">30 Minutes</div><div className={`rule-v ${preset.shaBullish ? "green" : "red"}`}>{shaLabel}</div></div>
          <div className="rule"><div className="rule-k">1H RSI (14)</div><div className="rule-v">{band(preset.rsi1h)}</div></div>
          <div className="rule"><div className="rule-k">30m RSI (14)</div><div className="rule-v">{band(preset.rsi30m)}</div></div>
        </section>

        <div className="status-row">
          <div className="status-left"><h2>Market candidates</h2><span className="count">{matches} MATCH{matches === 1 ? "" : "ES"}</span></div>
          <div className="controls">
            <input className="search" aria-label="Search coin" placeholder="Search coin…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <button className={`filter-button ${matchesOnly ? "active" : ""}`} onClick={() => setMatchesOnly((v) => !v)}>Exact only</button>
            <button
              className={`filter-button alert-toggle ${alertsOn ? "active" : ""}`}
              onClick={toggleAlerts}
              disabled={permission === "unsupported" || permission === "denied"}
              aria-pressed={alertsOn}
              title={
                permission === "unsupported" ? "This browser does not support notifications"
                  : permission === "denied" ? "Notifications are blocked for this site in your browser settings"
                  : alertsOn ? "Alerting on new exact matches" : "Alert me on new exact matches"
              }
            >
              {alertsOn ? "🔔 Alerts on" : permission === "denied" ? "🔕 Alerts blocked" : "🔔 Alert me"}
            </button>
          </div>
        </div>

        <div className="table-wrap">
          {error ? (
            <div className="error">
              <strong>Scan could not complete</strong>{error}
              <br /><button className="filter-button" onClick={load} style={{ marginTop: 16 }}>Try again</button>
            </div>
          ) : (
            <table>
              <thead><tr><th>Asset</th><th>Price</th><th>24H</th><th>Market cap</th><th>24H volume</th><th>1D SHA</th><th>1H SHA</th><th>30m SHA</th><th>1H RSI</th><th>30m RSI</th><th>Signal</th><th></th></tr></thead>
              <tbody>
                {loading && !data ? Array.from({ length: 7 }, (_, index) => (
                  <tr className="skeleton-row" key={index}>{Array.from({ length: 12 }, (_, cell) => <td key={cell}><div className="shimmer" /></td>)}</tr>
                )) : coins.map((coin) => (
                  <tr key={coin.symbol}>
                    <td><div className="coin"><span className="coin-icon">{coin.baseAsset.slice(0, 2)}</span><div><div className="coin-name">{coin.baseAsset}</div><div className="coin-pair">{coin.symbol}</div></div></div></td>
                    <td className={`mono tick ${coin.dir ?? ""}`}>${formatPrice(coin.price)}</td>
                    <td className={`mono ${coin.change24h >= 0 ? "positive" : "negative"}`}>{coin.change24h >= 0 ? "+" : ""}{coin.change24h.toFixed(2)}%</td>
                    <td className="mono">{formatUsd(coin.marketCap)}</td>
                    <td className="mono">{formatUsd(coin.quoteVolume)}</td>
                    <td><Candle bull={coin.sha1d} /></td><td><Candle bull={coin.sha1h} /></td><td><Candle bull={coin.sha30m} /></td>
                    <td><Rsi value={coin.rsi1h} band={preset.rsi1h} falling={coin.rsi1hFalling} requireFalling={preset.requireFalling} /></td>
                    <td><Rsi value={coin.rsi30m} band={preset.rsi30m} falling={coin.rsi30mFalling} requireFalling={preset.requireFalling} /></td>
                    <td><span className={coin.match ? "match-badge" : "near-badge"}>{coin.match ? "Exact match" : `${coin.score}/5 aligned`}</span></td>
                    <td><a className="chart-link" href={exchange.tradeUrl(coin.baseAsset)} target="_blank" rel="noreferrer" aria-label={`Open ${coin.baseAsset} chart`}>↗</a></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {!loading && !error && coins.length === 0 && <div className="empty"><strong>No coins match this view</strong>Turn off “Exact only” to inspect the closest candidates.</div>}
        </div>

        <div className="footnote">
          <span>
            Signals rescanned {updated} · {data?.scanned ?? 0}
            {data && data.requested > data.scanned ? ` of ${data.requested}` : ""} liquid USDT pairs
            {data && data.requested > data.scanned
              ? ` · ${data.requested - data.scanned} skipped (too little history, or rate-limited)`
              : ""} · {data?.durationMs ?? 0}ms · RSI and prices update live
          </span>
          <span>{exchange.label} Spot API · market cap from CoinGecko supply × live price · SHA: double EMA {SHA_LENGTH_1}/{SHA_LENGTH_2} · Closed candles only · Research tool, not financial advice.</span>
        </div>
      </main>
    </div>
  );
}
