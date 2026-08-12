import { Screener } from "../screener";

export const metadata = { title: "Coin Hunt — Binance Futures Bullish Screener" };

export default function FuturesBullish() {
  return <Screener exchangeKey="binance-futures" presetKey="bullish" />;
}
