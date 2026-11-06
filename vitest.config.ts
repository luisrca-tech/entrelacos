import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "apps/**/*.test.ts",
      "packages/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.db.test.ts"],
    // The full suite saturates the CPU; the 5s default made heavy DOM and
    // full-stack tests time out at random while they pass in well under 1s alone.
    testTimeout: 15_000,
  },
});
