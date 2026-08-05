import type { NextConfig } from "next";

// Static export: the scan runs entirely in the visitor's browser, so there is
// no server work to host. basePath matches the GitHub Pages project subpath.
const nextConfig: NextConfig = {
  output: "export",
  basePath: "/coin-hunt",
  // Emit each route as its own directory + index.html so a plain static host
  // resolves /bearish and /mexc/bearish without extensionless-URL rewriting.
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
