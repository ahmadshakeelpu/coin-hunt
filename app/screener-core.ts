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
  }>;
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
  rsi1h: number;
  rsi30m: number;
  rsi1hFalling: boolean;
  rsi30mFalling: boolean;
  match: boolean;
  score: number;
};
export type ScanResponse = {
  coins: CoinResult[];
  scanned: number;
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
};

export type Exchange = {
  key: "binance" | "mexc";
  label: string;
  /** REST bases tried in order. Empty means the exchange needs a proxy. */
  hosts: string[];
  /** Interval names differ: MEXC has no "1h", it calls that "60m". */
  intervals: { day: string; hour: string; halfHour: string };
  /** Combined ticker stream URL, or null when the exchange has no usable feed. */
  streamUrl: ((symbols: string[]) => string) | null;
  tradeUrl: (baseAsset: string) => string;
  /** Why the exchange cannot be scanned from the browser, if it cannot. */
  unavailableReason?: string;
};

export const PRESETS: Record<Preset["key"], Preset> = {
  bullish: {
    key: "bullish",
    label: "Bullish alignment",
    shaBullish: true,
    rsi1h: [55, 57],
    rsi30m: [56, 58],
    requireFalling: false,
  },
  bearish: {
    key: "bearish",
    label: "Bearish alignment",
    shaBullish: false,
    rsi1h: [44, 47],
    rsi30m: [42, 44],
    requireFalling: true,
  },
};

// MEXC serves datacenter IPs but sends no CORS headers on any REST host, so the
// browser cannot call it directly. Point this at a proxy that adds them.
export const MEXC_PROXY = "";

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
    intervals: { day: "1d", hour: "1h", halfHour: "30m" },
    streamUrl: (symbols) =>
      `wss://stream.binance.com:9443/stream?streams=${symbols.map((s) => `${s.toLowerCase()}@ticker`).join("/")}`,
    tradeUrl: (baseAsset) => `https://www.binance.com/en/trade/${baseAsset}_USDT?type=spot`,
  },
  mexc: {
    key: "mexc",
    label: "MEXC",
    hosts: MEXC_PROXY ? [MEXC_PROXY] : [],
    intervals: { day: "1d", hour: "60m", halfHour: "30m" },
    // MEXC's socket connects from the browser but streams protobuf, not JSON,
    // so live values come from polling the proxy instead.
    streamUrl: null,
    tradeUrl: (baseAsset) => `https://www.mexc.com/exchange/${baseAsset}_USDT`,
    unavailableReason:
      "MEXC's API sends no CORS headers, so a browser cannot call it directly. Set MEXC_PROXY to a proxy that adds them.",
  },
};

export const REQUEST_TIMEOUT_MS = 12_000;
export const RESCAN_INTERVAL_MS = 180_000;
export const POLL_INTERVAL_MS = 5_000;
export const FLUSH_INTERVAL_MS = 400;
export const FLASH_MS = 900;
export const SHA_LENGTH_1 = 10;
export const SHA_LENGTH_2 = 10;
export const RSI_LENGTH = 14;
export const SCAN_LIMIT = 25;
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

/**
 * Wilder RSI across the closed candles. Returns the series so callers can see
 * the direction of travel, not just the latest reading.
 */
export function rsiSeries(klines: Kline[], length = RSI_LENGTH) {
  const closes = closedCandles(klines).map((candle) => Number(candle[4]));
  if (closes.length <= length + 1) throw new Error("Not enough candle history");
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= length; i++) {
    const change = closes[i] - closes[i - 1];
    gain += Math.max(change, 0);
    loss += Math.max(-change, 0);
  }
  let averageGain = gain / length;
  let averageLoss = loss / length;
  const toRsi = () => (averageLoss === 0 ? 100 : 100 - 100 / (1 + averageGain / averageLoss));
  const values = [toRsi()];
  for (let i = length + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    averageGain = (averageGain * (length - 1) + Math.max(change, 0)) / length;
    averageLoss = (averageLoss * (length - 1) + Math.max(-change, 0)) / length;
    values.push(toRsi());
  }
  return values;
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R | null>) {
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

async function connect(exchange: Exchange) {
  let lastError: unknown;
  for (const host of exchange.hosts) {
    try {
      const exchangeInfo = await requestJson<ExchangeInfo>(`${host}/api/v3/exchangeInfo`);
      return { host, exchangeInfo };
    } catch (error) {
      lastError = error;
    }
  }
  const reason = lastError instanceof Error ? lastError.message : "connection blocked";
  throw new Error(`${exchange.label} market data is unavailable from this network (${reason}). No API key is required.`);
}

const inBand = (value: number, [min, max]: [number, number]) => value >= min && value <= max;

export async function runScan(exchange: Exchange, preset: Preset): Promise<ScanResponse> {
  const started = Date.now();
  if (!exchange.hosts.length) throw new Error(exchange.unavailableReason ?? `${exchange.label} is not configured.`);
  const { host, exchangeInfo } = await connect(exchange);
  const tickers = await requestJson<Ticker[]>(`${host}/api/v3/ticker/24hr`);
  const symbols = new Map(
    exchangeInfo.symbols
      .filter(
        (s) =>
          s.quoteAsset === "USDT" &&
          s.status.toUpperCase() === "TRADING" &&
          s.isSpotTradingAllowed !== false &&
          !EXCLUDED_BASES.has(s.baseAsset),
      )
      .map((s) => [s.symbol, s]),
  );
  const candidates = tickers
    .filter((ticker) => symbols.has(ticker.symbol) && Number(ticker.quoteVolume) > 0)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, SCAN_LIMIT);

  const coins = await mapWithConcurrency(candidates, 5, async (ticker) => {
    const info = symbols.get(ticker.symbol)!;
    const base = `${host}/api/v3/klines?symbol=${encodeURIComponent(ticker.symbol)}&limit=160&interval=`;
    const [day, hour, halfHour] = await Promise.all([
      requestJson<Kline[]>(`${base}${exchange.intervals.day}`),
      requestJson<Kline[]>(`${base}${exchange.intervals.hour}`),
      requestJson<Kline[]>(`${base}${exchange.intervals.halfHour}`),
    ]);
    const sha1d = smoothedHeikinAshiBullish(day);
    const sha1h = smoothedHeikinAshiBullish(hour);
    const sha30m = smoothedHeikinAshiBullish(halfHour);
    const hourRsi = rsiSeries(hour);
    const halfHourRsi = rsiSeries(halfHour);
    const rsi1h = hourRsi.at(-1)!;
    const rsi30m = halfHourRsi.at(-1)!;
    const rsi1hFalling = rsi1h < hourRsi.at(-2)!;
    const rsi30mFalling = rsi30m < halfHourRsi.at(-2)!;

    const checks = [
      sha1d === preset.shaBullish,
      sha1h === preset.shaBullish,
      sha30m === preset.shaBullish,
      inBand(rsi1h, preset.rsi1h) && (!preset.requireFalling || rsi1hFalling),
      inBand(rsi30m, preset.rsi30m) && (!preset.requireFalling || rsi30mFalling),
    ];
    return {
      symbol: ticker.symbol,
      baseAsset: info.baseAsset,
      price: Number(ticker.lastPrice),
      change24h: Number(ticker.priceChangePercent),
      quoteVolume: Number(ticker.quoteVolume),
      sha1d, sha1h, sha30m, rsi1h, rsi30m, rsi1hFalling, rsi30mFalling,
      match: checks.every(Boolean),
      score: checks.filter(Boolean).length,
    };
  });

  if (!coins.length) throw new Error(`${exchange.label} connected, but candle requests were blocked. Please disable any strict tracker blocker and retry.`);
  coins.sort((a, b) => Number(b.match) - Number(a.match) || b.score - a.score || b.quoteVolume - a.quoteVolume);
  return { coins, scanned: coins.length, updatedAt: new Date().toISOString(), durationMs: Date.now() - started };
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
