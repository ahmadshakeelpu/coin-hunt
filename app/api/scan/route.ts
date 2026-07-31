import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type Kline = [number, string, string, string, string, string, number, ...unknown[]];
type ExchangeInfo = {
  symbols: Array<{
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    status: string;
    isSpotTradingAllowed: boolean;
  }>;
};
type Ticker = {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
};
type WsResponse<T = unknown> = {
  id: string;
  status: number;
  result?: T;
  error?: { code?: number; msg?: string };
};

const WS_URLS = [
  "wss://ws-api.binance.com:443/ws-api/v3?returnRateLimits=false",
  "wss://ws-api.binance.com:9443/ws-api/v3?returnRateLimits=false",
];
const SHA_LENGTH_1 = 10;
const SHA_LENGTH_2 = 10;
const RSI_LENGTH = 14;
const SCAN_LIMIT = 20;
const EXCLUDED_BASES = new Set(["USDC", "FDUSD", "TUSD", "USDP", "DAI", "EUR", "TRY", "BRL", "GBP", "UAH", "BIDR", "AEUR"]);

class BinanceWsClient {
  private socket: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
  }>();

  async connect(url: string) {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("Binance WebSocket connection timed out"));
      }, 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        this.socket = socket;
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("Binance WebSocket connection was blocked"));
      });
      socket.addEventListener("message", (event) => {
        try {
          const message = JSON.parse(String(event.data)) as WsResponse;
          const item = this.pending.get(message.id);
          if (!item) return;
          this.pending.delete(message.id);
          if (message.status === 200) item.resolve(message.result);
          else item.reject(new Error(message.error?.msg || `Binance WebSocket returned ${message.status}`));
        } catch {
          // Ignore server events that are not request responses.
        }
      });
      socket.addEventListener("close", () => {
        for (const item of this.pending.values()) item.reject(new Error("Binance WebSocket closed early"));
        this.pending.clear();
      });
    });
  }

  request<T>(method: string, params: Record<string, unknown> = {}) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Binance WebSocket is not connected"));
    }
    const id = String(this.nextId++);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Binance ${method} request timed out`));
      }, 12_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (reason) => {
          clearTimeout(timer);
          reject(reason);
        },
      });
      this.socket!.send(JSON.stringify({ id, method, params: { ...params, returnRateLimits: false } }));
    });
  }

  close() {
    this.socket?.close(1000, "scan complete");
    this.socket = null;
  }
}

async function connectBinance() {
  let lastError: unknown;
  for (const url of WS_URLS) {
    const client = new BinanceWsClient();
    try {
      await client.connect(url);
      return client;
    } catch (error) {
      lastError = error;
      client.close();
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Unable to connect to Binance WebSocket API");
}

function ema(values: number[], length: number) {
  if (!values.length) return [];
  const alpha = 2 / (length + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i++) result.push(alpha * values[i] + (1 - alpha) * result[i - 1]);
  return result;
}

function closedKlines(klines: Kline[]) {
  return klines.filter((candle) => candle[6] < Date.now());
}

function smoothedHeikinAshiBullish(klines: Kline[]) {
  const candles = closedKlines(klines);
  if (candles.length < 30) throw new Error("Not enough candle history");
  const open = ema(candles.map((c) => Number(c[1])), SHA_LENGTH_1);
  const high = ema(candles.map((c) => Number(c[2])), SHA_LENGTH_1);
  const low = ema(candles.map((c) => Number(c[3])), SHA_LENGTH_1);
  const close = ema(candles.map((c) => Number(c[4])), SHA_LENGTH_1);
  const haClose = close.map((value, i) => (open[i] + high[i] + low[i] + value) / 4);
  const haOpen: number[] = [(open[0] + close[0]) / 2];
  for (let i = 1; i < haClose.length; i++) haOpen.push((haOpen[i - 1] + haClose[i - 1]) / 2);
  const finalOpen = ema(haOpen, SHA_LENGTH_2);
  const finalClose = ema(haClose, SHA_LENGTH_2);
  return finalClose.at(-1)! > finalOpen.at(-1)!;
}

function rsi(klines: Kline[], length = RSI_LENGTH) {
  const closes = closedKlines(klines).map((candle) => Number(candle[4]));
  if (closes.length <= length) throw new Error("Not enough candle history");
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
  return avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R | null>) {
  const results: Array<R | null> = new Array(items.length).fill(null);
  let cursor = 0;
  async function run() {
    while (cursor < items.length) {
      const index = cursor++;
      try { results[index] = await worker(items[index]); } catch { results[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, run));
  return results.filter((value): value is R => value !== null);
}

export async function GET() {
  const started = Date.now();
  let client: BinanceWsClient | null = null;
  try {
    client = await connectBinance();
    const [exchange, tickers] = await Promise.all([
      client.request<ExchangeInfo>("exchangeInfo", { permissions: ["SPOT"], symbolStatus: "TRADING" }),
      client.request<Ticker[]>("ticker.24hr", { type: "FULL", symbolStatus: "TRADING" }),
    ]);

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
      const [day, hour, halfHour] = await Promise.all([
        client!.request<Kline[]>("klines", { symbol: ticker.symbol, interval: "1d", limit: 160 }),
        client!.request<Kline[]>("klines", { symbol: ticker.symbol, interval: "1h", limit: 160 }),
        client!.request<Kline[]>("klines", { symbol: ticker.symbol, interval: "30m", limit: 160 }),
      ]);
      const sha1d = smoothedHeikinAshiBullish(day);
      const sha1h = smoothedHeikinAshiBullish(hour);
      const sha30m = smoothedHeikinAshiBullish(halfHour);
      const rsi1h = rsi(hour);
      const rsi30m = rsi(halfHour);
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

    if (!coins.length) throw new Error("Binance returned no usable candle history");
    coins.sort((a, b) => Number(b.match) - Number(a.match) || b.score - a.score || b.quoteVolume - a.quoteVolume);
    return NextResponse.json({
      coins,
      scanned: coins.length,
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      settings: { shaLength1: SHA_LENGTH_1, shaLength2: SHA_LENGTH_2, rsiLength: RSI_LENGTH },
    }, { headers: { "Cache-Control": "public, s-maxage=45, stale-while-revalidate=30" } });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Binance WebSocket scan failed.",
        source: "Binance Spot WebSocket API",
      },
      { status: 503 },
    );
  } finally {
    client?.close();
  }
}
