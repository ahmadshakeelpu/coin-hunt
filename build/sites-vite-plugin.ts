import type { Plugin } from "vite";

/**
 * Stub for the site-creator platform plugin that was not included in the
 * exported source. The original plugin wires platform-specific preview and
 * auth behavior; none of it is needed to run the app locally or self-host.
 */
export function sites(): Plugin {
  return { name: "sites-stub" };
}
