import { defineConfig } from "vitest/config";

// convex-test runs Convex functions in-process against a mock backend, in the
// same V8-isolate-shaped environment the real backend gives them (no Node APIs).
export default defineConfig({
  test: {
    environment: "edge-runtime",
    server: { deps: { inline: ["convex-test"] } },
  },
});
