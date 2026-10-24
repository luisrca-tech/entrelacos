import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
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
  it("allows only Sandbox and live candidate environments in the schema model", () => {
    const config = getTableConfig(withdrawalAuthorizationCandidate);
    const environment = config.checks.find(
      (check) =>
        check.name === "withdrawal_authorization_candidate_environment_check",
    );
    if (!environment) throw new Error("Missing candidate environment check");
    const sql = new PgDialect().sqlToQuery(environment.value).sql;
    expect(sql).toContain("IN ('sandbox', 'live')");
  });
  it("extends candidate environments through a new constraint-only migration", () => {
    const migration = readFileSync(
      new URL(
        "../migrations/0022_withdrawal_authorization_live.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect(migration).toContain(
      'DROP CONSTRAINT "withdrawal_authorization_candidate_environment_check"',
    );
    expect(migration).toContain(
      'ADD CONSTRAINT "withdrawal_authorization_candidate_environment_check"',
    );
    expect(migration).toContain("IN ('sandbox', 'live')");
    expect(migration).not.toMatch(
      /DROP TABLE|DROP TRIGGER|DELETE FROM|UPDATE |INSERT INTO/,
    );
    expect(migration.match(/ALTER TABLE/g)).toHaveLength(2);
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
