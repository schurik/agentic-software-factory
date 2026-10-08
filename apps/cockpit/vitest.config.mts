import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-process against a mock backend, in the
// same V8-isolate-shaped environment the real backend gives them (no Node APIs).
// The session page's components render there too, to static markup: they are
// pure functions of a query's result, so their tests need no browser.
// A test of what a person does to a form (open a select, type, submit) names
// happy-dom as its environment in its first line, and gets a DOM for that file.
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
