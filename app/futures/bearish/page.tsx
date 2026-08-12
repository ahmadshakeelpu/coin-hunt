import { Screener } from "../../screener";

export const metadata = { title: "Coin Hunt — Binance Futures Bearish Screener" };

export default function FuturesBearish() {
  return <Screener exchangeKey="binance-futures" presetKey="bearish" />;
}
