import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

const BASE_PATH = "/coin-hunt";
const SITE_URL = `https://ahmadshakeelpu.github.io${BASE_PATH}`;
const title = "Coin Hunt — Binance Spot Signal Scanner";
const description = "Live multi-timeframe Smoothed Heikin Ashi and RSI signal scanner for Binance Spot.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title,
  description,
  icons: { icon: `${BASE_PATH}/favicon.svg`, shortcut: `${BASE_PATH}/favicon.svg` },
  openGraph: { title, description, type: "website", url: SITE_URL, images: [{ url: `${SITE_URL}/og.png`, width: 1734, height: 907, alt: "Coin Hunt signal scanner" }] },
  twitter: { card: "summary_large_image", title, description, images: [`${SITE_URL}/og.png`] },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
