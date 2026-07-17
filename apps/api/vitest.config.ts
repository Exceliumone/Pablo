import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./src/test/setup.ts"],
    // Integration tests share one real Postgres/Redis (see src/test/setup.ts)
    // and reset it in a beforeEach — running files in parallel would let
    // one file's reset race another's assertions.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
