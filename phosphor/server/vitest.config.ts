import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Requests are approved by themselves by default; the tests that are not about that wait for a person, as most of them were written to. Tests of automatic approval switch it on.
    env: { REQUESTS_AUTO_APPROVE: "false" },
    globalSetup: "./tests/global-setup.ts",
    fileParallelism: false,
    testTimeout: 20000,
  },
});
