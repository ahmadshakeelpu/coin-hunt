import { Screener } from "../screener";

export const metadata = { title: "Coin Hunt — Binance Bearish Screener" };

export default function BinanceBearish() {
  return <Screener exchangeKey="binance" presetKey="bearish" />;
}
