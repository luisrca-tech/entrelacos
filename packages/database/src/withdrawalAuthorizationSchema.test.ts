import { readFileSync } from "node:fs";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  withdrawalAuthorizationCandidate,
  withdrawalAuthorizationDecision,
} from "./financialSchema";

describe("withdrawal security authorization custody", () => {
  it("makes each native ID and original operation unambiguous within its environment", () => {
    const config = getTableConfig(withdrawalAuthorizationCandidate);
    expect(config.primaryKeys[0].columns.map((c) => c.name)).toEqual([
      "environment",
      "provider_reference",
    ]);
    expect(
      config.uniqueConstraints.some(
        (c) =>
          c.columns.map((x) => x.name).join(",") === "environment,operation_id",
      ),
    ).toBe(true);
    expect(
      config.foreignKeys.some(
        (key) =>
          key
            .reference()
            .columns.map((c) => c.name)
            .join(",") === "site_id,account_id,environment,operation_id",
      ),
    ).toBe(true);
    expect(withdrawalAuthorizationCandidate.payloadHash.notNull).toBe(true);
    expect(withdrawalAuthorizationCandidate.payload.notNull).toBe(true);
  });
  it("binds the only decision to its immutable candidate", () => {
    const config = getTableConfig(withdrawalAuthorizationDecision);
    expect(config.primaryKeys[0].columns.map((c) => c.name)).toEqual([
      "environment",
      "provider_reference",
    ]);
    expect(
      config.foreignKeys.some((key) =>
        key
          .reference()
          .foreignColumns.every(
            (c) => c.table === withdrawalAuthorizationCandidate,
          ),
      ),
    ).toBe(true);
  });
  it("rejects candidate and decision UPDATE/DELETE through unconditional database triggers", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0021_withdrawal_authorization.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(2);
    expect(migration).toContain("RAISE EXCEPTION");
    expect(migration).toContain("FOR EACH ROW");
  });
});
