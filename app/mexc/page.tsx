import { Screener } from "../screener";

export const metadata = { title: "Coin Hunt — MEXC Bullish Screener" };

export default function MexcBullish() {
  return <Screener exchangeKey="mexc" presetKey="bullish" />;
}
