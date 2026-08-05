import { Screener } from "../../screener";

export const metadata = { title: "Coin Hunt — MEXC Bearish Screener" };

export default function MexcBearish() {
  return <Screener exchangeKey="mexc" presetKey="bearish" />;
}
