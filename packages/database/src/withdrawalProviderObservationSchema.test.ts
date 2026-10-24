import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { withdrawalProviderObservation } from "./withdrawalProviderObservationSchema";

describe("immutable withdrawal provider observation custody", () => {
  it("binds custody to the same site, account, environment, and operation", () => {
    const config = getTableConfig(withdrawalProviderObservation);
    expect(
      config.foreignKeys.some(
        (key) =>
          key
            .reference()
            .columns.map((column) => column.name)
            .join(",") === "site_id,account_id,environment,operation_id",
      ),
    ).toBe(true);
    expect(withdrawalProviderObservation.payload.notNull).toBe(true);
    expect(withdrawalProviderObservation.payloadHash.notNull).toBe(true);
  });
  it("rejects UPDATE and DELETE through an unconditional database trigger", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0020_withdrawal_provider_observation.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(migration).toContain("RAISE EXCEPTION");
    expect(migration).toContain("FOR EACH ROW");
  });
});

it("initializes financialSchema directly without an enum initialization cycle", async () => {
  vi.resetModules();
  const schema = await import("./financialSchema");
  expect(schema.financialEnvironment.enumValues).toEqual(["sandbox", "live"]);
});
