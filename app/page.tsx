import { Screener } from "./screener";

export const metadata = { title: "Coin Hunt — Binance Bullish Screener" };

export default function Home() {
  return <Screener exchangeKey="binance" presetKey="bullish" />;
}
