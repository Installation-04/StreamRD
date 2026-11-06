import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: "./tests/global-setup.ts",
    // The suite shares one SQLite test database; keep files sequential.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
