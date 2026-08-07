# MEXC CORS proxy

A single Vercel edge function that forwards MEXC's public market data with CORS
headers attached.

## Why it exists

MEXC returns no `Access-Control-Allow-Origin` header on any REST host, so the
browser-side scan cannot call it. MEXC does serve datacenter IPs — unlike
Binance, which `403`s them — so forwarding from a serverless function works.

Before this existed the MEXC pages went through the public `corsproxy.io`, which
allows roughly 75 requests per window. A full MEXC sweep needs about 450, so
coverage was pinned at 15 symbols. This removes that ceiling.

## Scope

It forwards only these read-only endpoints, and nothing else:

`/api/v3/ping`, `/api/v3/time`, `/api/v3/exchangeInfo`, `/api/v3/ticker/24hr`,
`/api/v3/klines`

That restriction is deliberate. A general-purpose `?url=` proxy would be abused
by anyone who found it, and is not something to leave running on an account.

Candle responses are cached at the edge for 25s, since a candle cannot change
until the one being built closes. Ticker responses carry live prices and are
cached for 2s.

## Deploying

```bash
npx vercel deploy --prod
```

The screener points at it via `MEXC_PROXY` in `../app/screener-core.ts`.
