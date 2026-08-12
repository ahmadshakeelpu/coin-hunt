"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EXCHANGES, FLASH_MS, FLUSH_INTERVAL_MS, PRESETS, RESCAN_INTERVAL_MS,
  SHA_LENGTH_1, SHA_LENGTH_2, evaluate, fetchSupplyMap, formatPrice, formatUsd, requestJson, runScan, tickerUrl,
  type EvaluatedCoin, type Exchange, type LiveTick, type Preset, type ScanResponse, type Ticker,
} from "./screener-core";
import {
  chime, loadPreference, loadSoundPreference, notifyMatches, readPermission, requestPermission,
  savePreference, saveSoundPreference,
  type AlertEvent, type AlertPermission,
} from "./alerts";

/** A symbol will not alert again within this window. */
const RE_ANNOUNCE_MS = 10 * 60_000;
/** Streams per SUBSCRIBE frame. */
const STREAM_CHUNK = 150;
/**
 * Rows rendered before the "show all" control. Every pair is still scanned,
 * filtered and alerted on; this only bounds how much DOM the 400ms live flush
 * has to diff, which is what makes 670 rows feel slow rather than the scan.
 */
const VISIBLE_ROWS = 150;

const NAV_GROUPS = [
  {
    label: "Futures",
    pages: [
      { href: "/futures", exchange: "binance-futures", preset: "bullish", label: "Binance · Bullish" },
      { href: "/futures/bearish", exchange: "binance-futures", preset: "bearish", label: "Binance · Bearish" },
    ],
  },
  {
    label: "Spot",
    pages: [
      { href: "/", exchange: "binance", preset: "bullish", label: "Binance · Bullish" },
      { href: "/bearish", exchange: "binance", preset: "bearish", label: "Binance · Bearish" },
      { href: "/mexc", exchange: "mexc", preset: "bullish", label: "MEXC · Bullish" },
      { href: "/mexc/bearish", exchange: "mexc", preset: "bearish", label: "MEXC · Bearish" },
    ],
  },
] as const;

function Candle({ bull }: { bull: boolean }) {
  return <span className={`candle ${bull ? "bull" : "bear"}`}><i />{bull ? "Green" : "Red"}</span>;
}

function Rsi({ value, band, falling, requireFalling }: {
  value: number; band: [number, number]; falling: boolean; requireFalling: boolean;
}) {
  const ok = value >= band[0] && value <= band[1] && (!requireFalling || falling);
  // The arrow shows on both presets. Only bearish requires the direction, but
  // knowing whether a bullish reading is climbing into its band or falling out
  // of it is the whole point of watching it live.
  return (
    <span className={`rsi ${ok ? "in-range" : ""}`}>
      {value.toFixed(1)}
      <span className={`trend ${falling ? "down" : "up"}`} title={falling ? "RSI falling" : "RSI rising"}>
        {falling ? "↓" : "↑"}
      </span>
      <span className="rsi-bar"><span style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></span>
    </span>
  );
}

const Row = memo(function Row({ coin, preset, tradeUrl }: {
  coin: EvaluatedCoin & { marketCap: number; dir: "up" | "down" | null };
  preset: Preset;
  tradeUrl: (baseAsset: string) => string;
}) {
  return (
    <tr>
      <td><div className="coin"><span className="coin-icon">{coin.baseAsset.slice(0, 2)}</span><div><div className="coin-name">{coin.baseAsset}</div><div className="coin-pair">{coin.symbol}</div></div></div></td>
      <td className={`mono tick ${coin.dir ?? ""}`}>${formatPrice(coin.price)}</td>
      <td className={`mono ${coin.change24h >= 0 ? "positive" : "negative"}`}>{coin.change24h >= 0 ? "+" : ""}{coin.change24h.toFixed(2)}%</td>
      <td className="mono">{formatUsd(coin.marketCap)}</td>
      <td className="mono">{formatUsd(coin.quoteVolume)}</td>
      <td><Candle bull={coin.sha1d} /></td><td><Candle bull={coin.sha1h} /></td><td><Candle bull={coin.sha30m} /></td>
      <td><Rsi value={coin.rsi1h} band={preset.rsi1h} falling={coin.rsi1hFalling} requireFalling={preset.requireFalling} /></td>
      <td><Rsi value={coin.rsi30m} band={preset.rsi30m} falling={coin.rsi30mFalling} requireFalling={preset.requireFalling} /></td>
      <td><span className={coin.match ? "match-badge" : "near-badge"}>{coin.match ? "Exact match" : `${coin.score}/${coin.total} aligned`}</span></td>
      <td><a className="chart-link" href={tradeUrl(coin.baseAsset)} target="_blank" rel="noreferrer" aria-label={`Open ${coin.baseAsset} chart`}>↗</a></td>
    </tr>
  );
}, (before, after) => {
  // Each flush rebuilds every coin object, so the default reference check never
  // bails out. Compare what is actually rendered instead: on a typical tick
  // only a fraction of symbols move, and the rest then skip re-rendering.
  const a = before.coin;
  const b = after.coin;
  return (
    before.preset === after.preset &&
    a.price === b.price &&
    a.change24h === b.change24h &&
    a.quoteVolume === b.quoteVolume &&
    a.marketCap === b.marketCap &&
    a.rsi1h === b.rsi1h &&
    a.rsi30m === b.rsi30m &&
    a.rsi1hFalling === b.rsi1hFalling &&
    a.rsi30mFalling === b.rsi30mFalling &&
    a.dir === b.dir &&
    a.match === b.match &&
    a.score === b.score &&
    a.total === b.total
  );
});

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
  const [showAll, setShowAll] = useState(false);
  /** Minimum passing checks a row must have to be listed. */
  const [minScore, setMinScore] = useState(0);
  const [signalOnly, setSignalOnly] = useState<"all" | "rsi" | "sha">("all");

  const [alertsOn, setAlertsOn] = useState(false);
  const [soundOn, setSoundOn] = useState(true);
  const [permission, setPermission] = useState<AlertPermission>("default");
  const [toasts, setToasts] = useState<AlertEvent[]>([]);
  const [history, setHistory] = useState<AlertEvent[]>([]);

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
    const socket = new WebSocket(exchange.streamUrl);
    socket.onopen = () => {
      setStreaming(true);
      const params = exchange.streamParams?.(symbols) ?? [];
      // Chunked because a single SUBSCRIBE carrying 670 streams is rejected.
      for (let i = 0; i < params.length; i += STREAM_CHUNK) {
        socket.send(JSON.stringify({ method: "SUBSCRIBE", params: params.slice(i, i + STREAM_CHUNK), id: i + 1 }));
      }
    };
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
    const timer = window.setInterval(poll, exchange.pollIntervalMs);
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
    setSoundOn(loadSoundPreference());
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const raiseAlert = useCallback((event: AlertEvent) => {
    setToasts((current) => [event, ...current].slice(0, 3));
    setHistory((current) => [event, ...current].slice(0, 25));
    window.setTimeout(() => dismissToast(event.id), 12_000);
  }, [dismissToast]);

  const toggleAlerts = useCallback(async () => {
    if (alertsOn) {
      setAlertsOn(false);
      savePreference(false);
      return;
    }
    const granted = await requestPermission();
    setPermission(granted);
    // Toasts work without notification permission, so alerting is still useful
    // when the browser prompt is declined.
    setAlertsOn(true);
    savePreference(true);
    if (soundOn) chime(preset.key);
  }, [alertsOn, soundOn, preset]);

  const toggleSound = useCallback(() => {
    setSoundOn((current) => {
      const next = !current;
      saveSoundPreference(next);
      if (next) chime(preset.key);
      return next;
    });
  }, [preset]);

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
      (coin) =>
        coin.score >= Math.min(minScore, coin.total) &&
        (!q || coin.symbol.includes(q) || coin.baseAsset.includes(q)),
    );
  }, [evaluated, minScore, query]);

  const evaluatedRef = useRef(evaluated);
  evaluatedRef.current = evaluated;

  const visible = useMemo(() => (showAll ? coins : coins.slice(0, VISIBLE_ROWS)), [coins, showAll]);
  const matches = evaluated.filter((coin) => coin.match).length;
  const matchKey = evaluated.filter((coin) => coin.match).map((coin) => coin.symbol).sort().join(",");

  // Matching is live now, so a coin can cross the band repeatedly. Announce a
  // symbol at most once per window rather than on every crossing.
  useEffect(() => {
    if (!alertsOn || !matchKey) return;
    const now = Date.now();
    const symbols = matchKey.split(",").filter((symbol) => {
      const last = announcedRef.current.get(symbol);
      return last === undefined || now - last > RE_ANNOUNCE_MS;
    });
    if (!symbols.length) return;
    for (const symbol of symbols) announcedRef.current.set(symbol, now);

    const byId = new Map(evaluatedRef.current.map((coin) => [coin.symbol, coin]));
    const details = symbols.map((symbol) => {
      const coin = byId.get(symbol);
      return {
        symbol,
        price: coin ? `$${formatPrice(coin.price)}` : "",
        rsi1h: coin?.rsi1h ?? 0,
        rsi30m: coin?.rsi30m ?? 0,
      };
    });
    const context = `${exchange.label} ${preset.key}`;
    notifyMatches(details, context, `coin-hunt-${exchange.key}-${preset.key}`);
    if (soundOn) chime(preset.key);
    raiseAlert({ id: `${now}-${symbols[0]}`, symbols, context, tone: preset.key, at: now });
  }, [matchKey, alertsOn, soundOn, exchange, preset, raiseAlert]);

  // Badge the tab so a backgrounded page still shows the count.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "");
    document.title = matches ? `(${matches}) ${base}` : base;
  }, [matches]);
  const updated = data
    ? new Date(data.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : "—";
  const checksTotal = (preset.shaRequired.day ? 1 : 0) + (preset.shaRequired.hour ? 1 : 0)
    + (preset.shaRequired.halfHour ? 1 : 0) + 2;
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
        {NAV_GROUPS.map((group) => (
          <div className="pagenav-group" key={group.label}>
            <span className="pagenav-label">{group.label}</span>
            {group.pages.map((page) => {
              const active = page.exchange === exchangeKey && page.preset === presetKey;
              return (
                <Link
                  key={page.href}
                  href={page.href}
                  className={`pagenav-link ${active ? "active" : ""} ${page.preset}`}
                  aria-current={active ? "page" : undefined}
                >
                  {page.label}
                </Link>
              );
            })}
          </div>
        ))}
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
          <button className="refresh-button" onClick={load} disabled={loading}>
            {loading
              ? data && data.requested
                ? `Scanning ${data.scanned}/${data.requested}`
                : "Scanning…"
              : "↻ Rescan signals"}
          </button>
        </section>

        <section className="rule-strip" aria-label="Active signal rules">
          <div className="rule"><div className="rule-k">1 Day</div><div className={`rule-v ${preset.shaBullish ? "green" : "red"}`}>{shaLabel}</div></div>
          <div className="rule">
            <div className="rule-k">1 Hour{preset.shaRequired.hour ? "" : " · optional"}</div>
            <div className={`rule-v ${preset.shaRequired.hour ? (preset.shaBullish ? "green" : "red") : "muted"}`}>
              {preset.shaRequired.hour ? shaLabel : "SHA · ANY"}
            </div>
          </div>
          <div className="rule"><div className="rule-k">30 Minutes</div><div className={`rule-v ${preset.shaBullish ? "green" : "red"}`}>{shaLabel}</div></div>
          <div className="rule"><div className="rule-k">1H RSI (14)</div><div className="rule-v">{band(preset.rsi1h)}</div></div>
          <div className="rule"><div className="rule-k">30m RSI (14)</div><div className="rule-v">{band(preset.rsi30m)}</div></div>
        </section>

        <div className="status-row">
          <div className="status-left"><h2>Market candidates</h2><span className="count">{matches} MATCH{matches === 1 ? "" : "ES"}</span></div>
          <div className="controls">
            <input className="search" aria-label="Search coin" placeholder="Search coin…" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select
              className="select-filter"
              aria-label="Filter by how many checks pass"
              value={minScore}
              onChange={(e) => setMinScore(Number(e.target.value))}
            >
              <option value={0}>All coins</option>
              <option value={checksTotal - 2}>Within 2 checks</option>
              <option value={checksTotal - 1}>Within 1 check</option>
              <option value={checksTotal}>Exact matches only</option>
            </select>
            <button
              className={`filter-button alert-toggle ${alertsOn ? "active" : ""}`}
              onClick={toggleAlerts}
              aria-pressed={alertsOn}
              title={
                permission === "denied"
                  ? "Browser notifications are blocked, but on-page alerts still work"
                  : alertsOn ? "Alerting on new exact matches" : "Alert me on new exact matches"
              }
            >
              {alertsOn ? (permission === "granted" ? "🔔 Alerts on" : "🔔 On-page only") : "🔔 Alert me"}
            </button>
            <button
              className={`filter-button sound-toggle ${soundOn ? "active" : ""}`}
              onClick={toggleSound}
              aria-pressed={soundOn}
              title={soundOn ? "Sound on — click to mute, or to hear it again" : "Sound muted"}
            >
              {soundOn ? "🔊" : "🔇"}
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
                )) : visible.map((coin) => (
                  <Row key={coin.symbol} coin={coin} preset={preset} tradeUrl={exchange.tradeUrl} />
                ))}
              </tbody>
            </table>
          )}
          {!loading && !error && coins.length === 0 && <div className="empty"><strong>No coins match this view</strong>Turn off “Exact only” to inspect the closest candidates.</div>}
          {!error && coins.length > visible.length && (
            <div className="more-row">
              Showing the {visible.length} closest of {coins.length} scanned pairs.
              <button className="filter-button" onClick={() => setShowAll(true)}>Show all {coins.length}</button>
            </div>
          )}
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

      {/* On-page alerts, so a match still surfaces when browser notifications
          are blocked or the prompt was declined. */}
      <div className="toast-stack" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone}`} role="status">
            <div className="toast-mark">{toast.tone === "bullish" ? "▲" : "▼"}</div>
            <div className="toast-body">
              <strong>
                {toast.symbols.length} exact match{toast.symbols.length === 1 ? "" : "es"}
              </strong>
              <span>{toast.symbols.slice(0, 5).join(", ")}{toast.symbols.length > 5 ? ` +${toast.symbols.length - 5}` : ""}</span>
              <span className="toast-meta">{toast.context} · {new Date(toast.at).toLocaleTimeString()}</span>
            </div>
            <button className="toast-close" onClick={() => dismissToast(toast.id)} aria-label="Dismiss alert">×</button>
          </div>
        ))}
      </div>
    </div>
  );
}
