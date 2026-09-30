import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-process against a mock backend, in the
// same V8-isolate-shaped environment the real backend gives them (no Node APIs).
// The session page's components render there too, to static markup: they are
// pure functions of a query's result, so their tests need no browser.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
