/**
 * CORS proxy for MEXC's public market data.
 *
 * MEXC sends no Access-Control-Allow-Origin header on any REST host, so a
 * browser cannot call it directly. It does serve datacenter IPs (unlike
 * Binance, which 403s them), so forwarding from here works.
 *
 * The upstream path arrives as ?path=... rather than in the URL: a nested
 * catch-all route only matched a single segment here, so /api/v3/klines 404ed
 * while /x reached the handler.
 *
 * Deliberately NOT a general-purpose proxy. Only these public read-only
 * endpoints are forwarded; an open proxy would be abused and is not something
 * to leave running on someone's account.
 */
export const config = { runtime: "edge" };

const UPSTREAM = "https://api.mexc.com";
const ALLOWED_PATHS = new Set([
  "/api/v3/ping",
  "/api/v3/time",
  "/api/v3/exchangeInfo",
  "/api/v3/ticker/24hr",
  "/api/v3/klines",
]);

const cors = (extra = {}) => ({
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,OPTIONS",
  "access-control-max-age": "86400",
  ...extra,
});

const json = (body, status) =>
  new Response(JSON.stringify(body), { status, headers: cors({ "content-type": "application/json" }) });

export default async function handler(request) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
  if (request.method !== "GET") return json({ error: "Only GET is proxied." }, 405);

  const url = new URL(request.url);
  const path = url.searchParams.get("path") ?? "";
  if (!ALLOWED_PATHS.has(path)) return json({ error: `Path not proxied: ${path}` }, 403);

  const params = new URLSearchParams(url.searchParams);
  params.delete("path");
  const query = params.toString();

  // Candles cannot change until the one being built closes, so repeat sweeps
  // can be absorbed at the edge. The ticker carries live prices and cannot.
  const cacheControl = path === "/api/v3/klines"
    ? "public, s-maxage=25, stale-while-revalidate=60"
    : "public, s-maxage=2, stale-while-revalidate=4";

  try {
    const upstream = await fetch(`${UPSTREAM}${path}${query ? `?${query}` : ""}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(12000),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: cors({
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "cache-control": cacheControl,
      }),
    });
  } catch (error) {
    return json({ error: `Upstream request failed: ${String(error)}` }, 502);
  }
}
