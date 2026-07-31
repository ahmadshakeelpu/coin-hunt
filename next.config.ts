import type { NextConfig } from "next";

// Static export: the scan runs entirely in the visitor's browser, so there is
// no server work to host. basePath matches the GitHub Pages project subpath.
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/coin-hunt",
  images: { unoptimized: true },
};

export default nextConfig;
