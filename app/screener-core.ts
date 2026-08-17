/** Shared scan logic for every exchange/preset page. */

export type Kline = [number, string, string, string, string, string, number, ...unknown[]];
export type Ticker = { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string };
export type ExchangeInfo = {
  symbols: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    isSpotTradingAllowed?: boolean;
    /** Futures only. Non-perpetual contracts are dated and excluded. */
    contractType?: string;
  }>;
};
/**
 * Enough of the Wilder state at the last closed candle to project the current
 * reading from a live price, without refetching candles.
 */
export type RsiState = {
  /** RSI at the last closed candle. */
  closed: number;
  avgGain: number;
  avgLoss: number;
  lastClose: number;
};
export type CoinResult = {
  symbol: string;
  baseAsset: string;
  price: number;
  change24h: number;
  quoteVolume: number;
  sha1d: boolean;
  sha1h: boolean;
  sha30m: boolean;
  rsi1hState: RsiState;
  rsi30mState: RsiState;
};
/** A coin with its RSI, direction and match recomputed against a live price. */
export type EvaluatedCoin = CoinResult & {
  rsi1h: number;
  rsi30m: number;
  rsi1hFalling: boolean;
  rsi30mFalling: boolean;
  match: boolean;
  score: number;
  /** Checks that gate the match, which varies by preset. */
  total: number;
};
export type ScanResponse = {
  coins: CoinResult[];
  scanned: number;
  /** Candidates the scan attempted; exceeds `scanned` when requests fail. */
  requested: number;
  updatedAt: string;
  durationMs: number;
};
/** Streamed values that replace the scanned snapshot as they arrive. */
export type LiveTick = {
  price: number;
  change24h: number;
  quoteVolume: number;
  dir: "up" | "down" | null;
  at: number;
};

export type Preset = {
  key: "bullish" | "bearish";
  label: string;
  /** Required Smoothed Heikin Ashi state on all three timeframes. */
  shaBullish: boolean;
  rsi1h: [number, number];
  rsi30m: [number, number];
  /** Bearish also requires RSI to be declining, not merely inside the band. */
  requireFalling: boolean;
  /**
   * Which SHA timeframes gate the match. 1H is advisory on the bullish preset:
   * it is still shown, and still scored, but a red 1H no longer stops a coin
   * being an exact match when everything else lines up.
   */
  shaRequired: { day: boolean; hour: boolean; halfHour: boolean };
  /**
   * Required 24h price change, in percent. Bullish sets a floor, bearish a
   * ceiling. Evaluated live, since 24h change moves with the stream.
   */
  change24h: { min?: number; max?: number };
};

export type Exchange = {
  key: "binance" | "mexc" | "binance-futures";
  label: string;
  /** Path prefix for REST calls: spot is /api/v3, futures is /fapi/v1. */
  apiPath: string;
  /** REST bases tried in order. */
  hosts: string[];
  /** Interval names differ: MEXC has no "1h", it calls that "60m". */
  intervals: { day: string; hour: string; halfHour: string };
  /**
   * Base socket URL, or null when the exchange has no usable feed. Symbols are
   * subscribed after connecting rather than in the URL: 670 of them makes a
   * query string about 9KB long, which is past what is safe to send.
   */
  streamUrl: string | null;
  /** Stream names to SUBSCRIBE once the socket opens. */
  streamParams?: (symbols: string[]) => string[];
  tradeUrl: (baseAsset: string) => string;
  /** Rewrites outbound URLs, e.g. through a CORS proxy. */
  proxy?: (url: string) => string;
  /** Binance reports 24h change as a percent, MEXC as a fraction. */
  changeScale: number;
  /**
   * Skip pairs thinner than this in 24h quote volume. Everything above it is
   * scanned. RSI on a book below roughly $100k/24h is mostly noise, and those
   * pairs are usually too new to have the candle history anyway.
   */
  minQuoteVolume: number;
  /**
   * Parallel candle requests. Binance Futures allows 2400 weight a minute
   * against spot's 6000, so it has to crawl or the sweep earns a 418 ban.
   */
  concurrency: number;
  /** Ticker poll interval for exchanges without a usable socket. */
  pollIntervalMs: number;
  /**
   * MEXC's exchangeInfo is ~10MB and the proxy rejects it with 413, so its
   * symbol list is derived from the ticker snapshot instead.
   */
  symbolSource: "exchangeInfo" | "tickers";
};

export const PRESETS: Record<Preset["key"], Preset> = {
  bullish: {
    key: "bullish",
    label: "Bullish alignment",
    shaBullish: true,
    rsi1h: [53, 57],
    rsi30m: [56, 58],
    requireFalling: false,
    shaRequired: { day: true, hour: false, halfHour: true },
    change24h: { min: 7 },
  },
  bearish: {
    key: "bearish",
    label: "Bearish alignment",
    shaBullish: false,
    rsi1h: [44, 47],
    rsi30m: [42, 44],
    requireFalling: true,
    shaRequired: { day: true, hour: true, halfHour: true },
    change24h: { max: -7 },
  },
};

/**
 * MEXC sends no CORS headers on any REST host, so the browser cannot call it
 * directly. Requests go through our own edge function (source in ../proxy),
 * which forwards a fixed allowlist of public read-only endpoints and attaches
 * the headers. It replaced a public proxy whose ~75 requests per window capped
 * MEXC coverage at 15 symbols.
 */
const MEXC_PROXY_BASE = "https://coin-hunt-mexc-proxy-ranksups-projects.vercel.app";
const MEXC_PROXY = (url: string) => {
  // The upstream path travels as a query parameter: a nested catch-all route
  // only matched one path segment, so /api/v3/klines did not reach the handler.
  const target = new URL(url);
  const params = new URLSearchParams(target.search);
  params.set("path", target.pathname);
  return `${MEXC_PROXY_BASE}/api/mexc?${params.toString()}`;
};

export const EXCHANGES: Record<Exchange["key"], Exchange> = {
  binance: {
    key: "binance",
    label: "Binance",
    // Ordered fastest-first. data-api.binance.vision stays reachable where the
    // main host is restricted, but responds far slower.
    hosts: [
      "https://api.binance.com",
      "https://api-gcp.binance.com",
      "https://data-api.binance.vision",
    ],
    apiPath: "/api/v3",
    intervals: { day: "1d", hour: "1h", halfHour: "30m" },
    streamUrl: "wss://stream.binance.com:9443/stream",
    streamParams: (symbols) => symbols.map((symbol) => `${symbol.toLowerCase()}@ticker`),
    tradeUrl: (baseAsset) => `https://www.binance.com/en/trade/${baseAsset}_USDT?type=spot`,
    changeScale: 1,
    // Every tradeable USDT pair, about 480. Roughly 1450 candle requests at
    // weight 2, inside the 6000/min budget, and about 30s. Only the first sweep
    // pays it: candles are cached until they close.
    minQuoteVolume: 0,
    concurrency: 12,
    pollIntervalMs: 5_000,
    symbolSource: "exchangeInfo",
  },
  "binance-futures": {
    key: "binance-futures",
    label: "Binance Futures",
    hosts: ["https://fapi.binance.com"],
    apiPath: "/fapi/v1",
    intervals: { day: "1d", hour: "1h", halfHour: "30m" },
    // fstream.binance.com accepts the connection and acknowledges SUBSCRIBE,
    // then sends nothing: no frames arrived on @ticker, @miniTicker, @aggTrade
    // or @markPrice, while futures REST worked throughout. Live values come
    // from polling the ticker snapshot instead, which needs one request for
    // every symbol. Restore the socket here if it starts delivering.
    streamUrl: null,
    tradeUrl: (baseAsset) => `https://www.binance.com/en/futures/${baseAsset}USDT`,
    changeScale: 1,
    // Futures allows 2400 weight a minute, not spot's 6000, and a full 526-pair
    // sweep at spot pacing spent roughly 3x that and earned a 418 IP ban. So:
    // fewer pairs, a slower crawl, and a lazier ticker poll. $2M/24h still
    // covers the whole liquid perpetual market.
    minQuoteVolume: 2_000_000,
    // Weight 1 per candle request at this limit, so ~900 for a sweep against a
    // 2400/min budget. Eight at a time lands near 1600/min with headroom.
    concurrency: 8,
    pollIntervalMs: 15_000,
    symbolSource: "exchangeInfo",
  },
  mexc: {
    key: "mexc",
    label: "MEXC",
    hosts: ["https://api.mexc.com"],
    apiPath: "/api/v3",
    intervals: { day: "1d", hour: "60m", halfHour: "30m" },
    // MEXC's socket connects from the browser but streams protobuf, not JSON,
    // so live values come from polling instead.
    streamUrl: null,
    tradeUrl: (baseAsset) => `https://www.mexc.com/exchange/${baseAsset}_USDT`,
    proxy: MEXC_PROXY,
    changeScale: 100,
    // MEXC lists ~1730 USDT pairs but only ~300 clear $100k/24h; the rest are
    // dormant books where the indicators would be meaningless. Scanning those
    // 300 costs ~900 proxy invocations a sweep, which the free tier absorbs.
    // Lower this to widen coverage, at the cost of proxy usage.
    minQuoteVolume: 100_000,
    concurrency: 8,
    pollIntervalMs: 5_000,
    symbolSource: "tickers",
  },
};

export const proxied = (exchange: Exchange, url: string) => (exchange.proxy ? exchange.proxy(url) : url);
export const tickerUrl = (exchange: Exchange) => proxied(exchange, `${exchange.hosts[0]}${exchange.apiPath}/ticker/24hr`);

export const REQUEST_TIMEOUT_MS = 12_000;
export const RESCAN_INTERVAL_MS = 180_000;
export const FLUSH_INTERVAL_MS = 400;
export const FLASH_MS = 900;
const PROGRESS_BATCH = 15;
export const SHA_LENGTH_1 = 10;
export const SHA_LENGTH_2 = 10;
export const RSI_LENGTH = 14;
/**
 * Candles per request. Measured: dropping 160 -> 100 leaves RSI within 0.008
 * and SHA identical, cuts the payload 37%, and halves the futures weight (that
 * endpoint charges 1 below 100 and 2 above, on a 2400/min budget).
 */
const KLINE_LIMIT = 100;
const SCAN_CACHE_VERSION = 3;
const EXCLUDED_BASES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "TRY", "BRL", "GBP", "UAH", "BIDR", "AEUR"]);

export async function requestJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache: "no-store", mode: "cors", signal: controller.signal });
    if (!response.ok) throw new Error(`Exchange returned ${response.status}`);
    return (await response.json()) as T;
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Exchange request timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
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

const closedCandles = (klines: Kline[]) => klines.filter((candle) => candle[6] < Date.now());

/** True when the last smoothed Heikin Ashi candle is green. */
export function smoothedHeikinAshiBullish(klines: Kline[]) {
  const closed = closedCandles(klines);
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

const toRsi = (gain: number, loss: number) => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));

/** Wilder RSI over the closed candles, keeping the state needed to project it. */
export function rsiState(klines: Kline[], length = RSI_LENGTH): RsiState {
  const closes = closedCandles(klines).map((candle) => Number(candle[4]));
  if (closes.length <= length + 1) throw new Error("Not enough candle history");
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let avgGain = gain / length;
  let avgLoss = loss / length;
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    avgGain = (avgGain * (length - 1) + Math.max(change, 0)) / length;
    avgLoss = (avgLoss * (length - 1) + Math.max(-change, 0)) / length;
  }
  return { closed: toRsi(avgGain, avgLoss), avgGain, avgLoss, lastClose: closes.at(-1)! };
}

/**
 * RSI including the candle currently being built, which is what moves as the
 * price ticks. One Wilder step from the last closed candle, so it costs nothing
 * to recompute on every price update.
 */
export function projectRsi(state: RsiState, price: number, length = RSI_LENGTH) {
  if (!Number.isFinite(price) || price <= 0) return state.closed;
  const change = price - state.lastClose;
  const gain = (state.avgGain * (length - 1) + Math.max(change, 0)) / length;
  const loss = (state.avgLoss * (length - 1) + Math.max(-change, 0)) / length;
  return toRsi(gain, loss);
}

const inBand = (value: number, [min, max]: [number, number]) => value >= min && value <= max;

/** True when a 24h change satisfies the preset's floor or ceiling. */
export const changeInRange = (change: number, bounds: Preset["change24h"]) =>
  (bounds.min === undefined || change >= bounds.min) &&
  (bounds.max === undefined || change <= bounds.max);

/** Scores a coin against a preset using live price and 24h change. */
export function evaluate(
  coin: CoinResult,
  preset: Preset,
  price: number,
  change24h: number = coin.change24h,
): EvaluatedCoin {
  const rsi1h = projectRsi(coin.rsi1hState, price);
  const rsi30m = projectRsi(coin.rsi30mState, price);
  const rsi1hFalling = rsi1h < coin.rsi1hState.closed;
  const rsi30mFalling = rsi30m < coin.rsi30mState.closed;
  const checks: boolean[] = [];
  if (preset.shaRequired.day) checks.push(coin.sha1d === preset.shaBullish);
  if (preset.shaRequired.hour) checks.push(coin.sha1h === preset.shaBullish);
  if (preset.shaRequired.halfHour) checks.push(coin.sha30m === preset.shaBullish);
  checks.push(inBand(rsi1h, preset.rsi1h) && (!preset.requireFalling || rsi1hFalling));
  checks.push(inBand(rsi30m, preset.rsi30m) && (!preset.requireFalling || rsi30mFalling));
  // Empty bounds mean the gate is switched off, so it drops out of the score
  // entirely rather than counting as a free pass.
  if (preset.change24h.min !== undefined || preset.change24h.max !== undefined) {
    checks.push(changeInRange(change24h, preset.change24h));
  }
  return {
    ...coin,
    change24h,
    rsi1h, rsi30m, rsi1hFalling, rsi30mFalling,
    match: checks.every(Boolean),
    score: checks.filter(Boolean).length,
    total: checks.length,
  };
}

const INTERVAL_MS: Record<string, number> = {
  "30m": 30 * 60_000,
  "60m": 60 * 60_000,
  "1h": 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

/**
 * Candles are cached until the one being built closes, because the indicators
 * only read closed candles: nothing they depend on can change until then.
 * Without this a rescan refetches every candle every few minutes, which burns
 * the proxy's rate limit and gets symbols dropped from the table.
 */
const klineCache = new Map<string, Kline[]>();

const bucketOf = (interval: string) => Math.floor(Date.now() / (INTERVAL_MS[interval] ?? 30 * 60_000));

type CachedScan = {
  version: number;
  buckets: [number, number, number];
  coins: Array<Omit<CoinResult, "price" | "change24h" | "quoteVolume">>;
};

const scanCacheKey = (exchange: Exchange) => `coin-hunt:scan:${exchange.key}`;

/**
 * Indicators cannot change until the candle being built closes, so a reload
 * inside the same 30m window can reuse the whole previous sweep and spend one
 * ticker request instead of ~1450 candle requests.
 */
function loadCachedScan(exchange: Exchange): Map<string, CachedScan["coins"][number]> {
  const empty = new Map<string, CachedScan["coins"][number]>();
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(scanCacheKey(exchange));
    if (!raw) return empty;
    const cached = JSON.parse(raw) as CachedScan;
    if (cached.version !== SCAN_CACHE_VERSION) return empty;
    const current: [number, number, number] = [
      bucketOf(exchange.intervals.day),
      bucketOf(exchange.intervals.hour),
      bucketOf(exchange.intervals.halfHour),
    ];
    if (current.some((bucket, i) => bucket !== cached.buckets[i])) return empty;
    return new Map(cached.coins.map((coin) => [coin.symbol, coin]));
  } catch {
    return empty;
  }
}

function saveCachedScan(exchange: Exchange, coins: CoinResult[]) {
  if (typeof window === "undefined" || !coins.length) return;
  try {
    const payload: CachedScan = {
      version: SCAN_CACHE_VERSION,
      buckets: [
        bucketOf(exchange.intervals.day),
        bucketOf(exchange.intervals.hour),
        bucketOf(exchange.intervals.halfHour),
      ],
      // Price, change and volume come from the ticker on every load anyway.
      coins: coins.map(({ price: _p, change24h: _c, quoteVolume: _q, ...rest }) => rest),
    };
    window.localStorage.setItem(scanCacheKey(exchange), JSON.stringify(payload));
  } catch {
    // A full quota is not worth failing a scan over.
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Retries transient proxy failures so a 429 does not silently drop a symbol. */
async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await sleep(500 * 2 ** attempt + Math.random() * 250);
    }
  }
  throw lastError;
}

async function fetchKlines(exchange: Exchange, host: string, symbol: string, interval: string) {
  const span = INTERVAL_MS[interval] ?? 30 * 60_000;
  const key = `${exchange.key}|${symbol}|${interval}|${Math.floor(Date.now() / span)}`;
  const cached = klineCache.get(key);
  if (cached) return cached;
  const url = `${host}${exchange.apiPath}/klines?symbol=${encodeURIComponent(symbol)}&limit=${KLINE_LIMIT}&interval=${interval}`;
  const klines = await withRetry(() => requestJson<Kline[]>(proxied(exchange, url)));
  // Keys carry their own candle bucket, so stale ones simply stop being read.
  if (klineCache.size > 600) klineCache.clear();
  klineCache.set(key, klines);
  return klines;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R | null>,
  onProgress?: (done: R[]) => void,
) {
  const results: Array<R | null> = new Array(items.length).fill(null);
  const settled = () => results.filter((value): value is R => value !== null);
  let cursor = 0;
  let completed = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index]);
      } catch {
        results[index] = null;
      }
      // Report in batches so a long sweep fills the table as it goes.
      if (onProgress && ++completed % PROGRESS_BATCH === 0) onProgress(settled());
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return settled();
}

type SymbolInfo = { symbol: string; baseAsset: string };

/**
 * exchangeInfo is ~16MB on Binance and the listing set barely moves, so it is
 * cached for a day. Without this every load spent most of its time downloading
 * a symbol list that had not changed.
 */
function cachedSymbols(exchange: Exchange): Map<string, SymbolInfo> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(`coin-hunt:symbols:${exchange.key}`);
    if (!raw) return null;
    const cached = JSON.parse(raw) as { version: number; day: number; symbols: SymbolInfo[] };
    if (cached.version !== SCAN_CACHE_VERSION) return null;
    if (cached.day !== Math.floor(Date.now() / 86_400_000)) return null;
    return new Map(cached.symbols.map((entry) => [entry.symbol, entry]));
  } catch {
    return null;
  }
}

function storeSymbols(exchange: Exchange, symbols: Map<string, SymbolInfo>) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      `coin-hunt:symbols:${exchange.key}`,
      JSON.stringify({
        version: SCAN_CACHE_VERSION,
        day: Math.floor(Date.now() / 86_400_000),
        symbols: [...symbols.values()],
      }),
    );
  } catch {
    // Quota failures just mean the next load refetches the list.
  }
}

/** Resolves the tradeable USDT symbols and their base assets. */
async function listSymbols(exchange: Exchange, host: string, tickers: Ticker[]) {
  if (exchange.symbolSource === "tickers") {
    // Every symbol here is already a live spot market, and USDT-quoted pairs
    // end in "USDT", so the base asset is the remainder.
    return new Map(
      tickers
        .filter((t) => t.symbol.endsWith("USDT") && !EXCLUDED_BASES.has(t.symbol.slice(0, -4)))
        .map((t) => [t.symbol, { symbol: t.symbol, baseAsset: t.symbol.slice(0, -4) }]),
    );
  }
  const reusable = cachedSymbols(exchange);
  if (reusable) return reusable;
  const info = await requestJson<ExchangeInfo>(proxied(exchange, `${host}${exchange.apiPath}/exchangeInfo`));
  const resolved = new Map(
    info.symbols
      .filter(
        (s) =>
          s.quoteAsset === "USDT" &&
          s.status.toUpperCase() === "TRADING" &&
          s.isSpotTradingAllowed !== false &&
          (s.contractType === undefined || s.contractType === "PERPETUAL") &&
          !EXCLUDED_BASES.has(s.baseAsset),
      )
      .map((s) => [s.symbol, { symbol: s.symbol, baseAsset: s.baseAsset }]),
  );
  storeSymbols(exchange, resolved);
  return resolved;
}

async function fetchTickers(exchange: Exchange) {
  let lastError: unknown;
  for (const host of exchange.hosts) {
    try {
      const tickers = await withRetry(() => requestJson<Ticker[]>(proxied(exchange, `${host}${exchange.apiPath}/ticker/24hr`)));
      return { host, tickers };
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : "connection blocked";
  throw new Error(`${exchange.label} market data is unavailable from this network (${reason}). No API key is required.`);
}

/**
 * Row order is settled here, at scan time, so live prices never reshuffle the
 * table while it is being read.
 */
function rank(coins: CoinResult[], preset: Preset) {
  return [...coins].sort((a, b) => {
    const left = evaluate(a, preset, a.price, a.change24h);
    const right = evaluate(b, preset, b.price, b.change24h);
    return Number(right.match) - Number(left.match) || right.score - left.score || b.quoteVolume - a.quoteVolume;
  });
}

export async function runScan(
  exchange: Exchange,
  preset: Preset,
  onPartial?: (partial: ScanResponse) => void,
): Promise<ScanResponse> {
  const started = Date.now();
  const { host, tickers } = await fetchTickers(exchange);
  const symbols = await listSymbols(exchange, host, tickers);
  const candidates = tickers
    .filter((ticker) => symbols.has(ticker.symbol) && Number(ticker.quoteVolume) > exchange.minQuoteVolume)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume));

  // Anything still inside its candle bucket is reused, so a reload or a hop
  // between the bullish and bearish page of the same exchange costs nothing.
  const cached = loadCachedScan(exchange);

  const snapshot = (coins: CoinResult[]): ScanResponse => ({
    coins: rank(coins, preset),
    scanned: coins.length,
    requested: candidates.length,
    updatedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
  });

  const concurrency = exchange.concurrency;
  const coins = await mapWithConcurrency(
    candidates,
    concurrency,
    async (ticker) => {
      const info = symbols.get(ticker.symbol)!;
      const live = {
        price: Number(ticker.lastPrice),
        change24h: Number(ticker.priceChangePercent) * exchange.changeScale,
        quoteVolume: Number(ticker.quoteVolume),
      };
      const reusable = cached.get(ticker.symbol);
      if (reusable) return { ...reusable, ...live };

      const [day, hour, halfHour] = await Promise.all([
        fetchKlines(exchange, host, ticker.symbol, exchange.intervals.day),
        fetchKlines(exchange, host, ticker.symbol, exchange.intervals.hour),
        fetchKlines(exchange, host, ticker.symbol, exchange.intervals.halfHour),
      ]);
      return {
        symbol: ticker.symbol,
        baseAsset: info.baseAsset,
        ...live,
        sha1d: smoothedHeikinAshiBullish(day),
        sha1h: smoothedHeikinAshiBullish(hour),
        sha30m: smoothedHeikinAshiBullish(halfHour),
        rsi1hState: rsiState(hour),
        rsi30mState: rsiState(halfHour),
      };
    },
    onPartial && ((done) => onPartial(snapshot(done))),
  );

  if (!coins.length) throw new Error(`${exchange.label} connected, but candle requests were blocked. Please disable any strict tracker blocker and retry.`);
  saveCachedScan(exchange, coins);
  return snapshot(coins);
}

/**
 * Circulating supply per base asset so market cap can track the live price.
 * Symbols collide across coins, so the highest-cap match wins and anything
 * outside CoinGecko's top 250 is left without a market cap.
 */
export async function fetchSupplyMap(): Promise<Record<string, number>> {
  const supply: Record<string, number> = {};
  try {
    const rows = await requestJson<Array<{ symbol?: string; circulating_supply?: number }>>(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false",
    );
    for (const row of rows) {
      const asset = String(row.symbol ?? "").toUpperCase();
      const circulating = Number(row.circulating_supply);
      if (asset && circulating > 0 && !(asset in supply)) supply[asset] = circulating;
    }
  } catch {
    // Market cap is supplementary; a failure here must not fail the scan.
  }
  return supply;
}

export const formatPrice = (value: number) => {
  if (value >= 1000) return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (value >= 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return value.toLocaleString("en-US", { maximumSignificantDigits: 5 });
};

export const formatUsd = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${(value / 1e3).toFixed(0)}K`;
};
