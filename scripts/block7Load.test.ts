import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertSafeLoadPrefix,
  buildLoadPlan,
  finalizeLoadRun,
  LOAD_SHAPE,
  percentile,
  runWithCleanup,
  summarizeSamples,
} from "./block7Load";

describe("Block 7 load shape", () => {
  it("keeps the load harness PIN-only", () => {
    const source = readFileSync(
      new URL("./block7Load.ts", import.meta.url),
      "utf8",
    );

    expect(source).not.toMatch(/smsMonthlyLimit|SMS_MODE|Twilio|simulated/i);
  });

  it("builds exactly 20 active tenants with 500 guests each", () => {
    const plan = buildLoadPlan("block7-load-test");

    expect(LOAD_SHAPE).toEqual({
      tenantCount: 20,
      guestsPerTenant: 500,
      totalGuests: 10_000,
    });
    expect(plan.tenants).toHaveLength(LOAD_SHAPE.tenantCount);
    expect(plan.tenants.every((tenant) => tenant.guests.length === 500)).toBe(
      true,
    );
    expect(plan.tenants.flatMap((tenant) => tenant.guests)).toHaveLength(
      LOAD_SHAPE.totalGuests,
    );
    expect(plan.tenants.every((tenant) => tenant.isDemo === false)).toBe(true);
  });

  it("uses nearest-rank percentiles and counts HTTP failures separately", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(
      summarizeSamples([
        { latencyMs: 10, status: 200, timedOut: false },
        {
          latencyMs: 20,
          status: 429,
          timedOut: false,
          problemCode: "RATE_LIMITED",
        },
        { latencyMs: 30, status: 503, timedOut: false },
        { latencyMs: 40, timedOut: true, error: "TIMEOUT" },
      ]),
    ).toEqual({
      p50Ms: 20,
      p95Ms: 40,
      p99Ms: 40,
      statusCounts: { "200": 1, "429": 1, "503": 1 },
      problemCodes: { RATE_LIMITED: 1 },
      errors: 3,
      timeouts: 1,
      rateLimits: 1,
    });
  });

  it("fails closed for unsafe fixture markers and always invokes cleanup", async () => {
    expect(() => assertSafeLoadPrefix("block7-load-demo-data")).toThrow();
    expect(() => assertSafeLoadPrefix("legacy-fixtures")).toThrow();

    const cleanup = [] as string[];
    await expect(
      runWithCleanup(
        async () => {
          throw new Error("work failed");
        },
        async () => {
          cleanup.push("done");
        },
      ),
    ).rejects.toThrow("work failed");
    expect(cleanup).toEqual(["done"]);
  });

  it("closes the database connection even when fixture cleanup fails", async () => {
    const calls: string[] = [];

    await expect(
      finalizeLoadRun(
        async () => {
          calls.push("cleanup");
          throw new Error("cleanup failed");
        },
        async () => {
          calls.push("close");
        },
      ),
    ).rejects.toThrow("cleanup failed");
    expect(calls).toEqual(["cleanup", "close"]);
  });
});
