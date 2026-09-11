import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { defineConfig } from "vitest/config";

if (existsSync("packages/database/.env")) {
  loadEnvFile("packages/database/.env");
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["apps/**/*.db.test.ts", "packages/**/*.db.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    globalSetup: ["./packages/database/src/databaseTestSetup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
