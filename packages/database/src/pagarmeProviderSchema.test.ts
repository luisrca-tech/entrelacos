import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as financialSchema from "./financialSchema";
import { receivingSetupHolder } from "./receivingSetupSchema";
import { withdrawalProviderObservation } from "./withdrawalProviderObservationSchema";

const dialect = new PgDialect();

describe("Pagar.me provider schema", () => {
  it("keeps the legacy withdrawal authorization and Pix preparation tables", () => {
    expect(financialSchema).toHaveProperty("withdrawalAuthorizationCandidate");
    expect(financialSchema).toHaveProperty("withdrawalAuthorizationDecision");
    expect(financialSchema).toHaveProperty("receivingPixPreparation");
  });

  it("identifies withdrawal provider observations as Pagar.me withdrawals", () => {
    const check = getTableConfig(withdrawalProviderObservation).checks.find(
      (entry) => entry.name === "withdrawal_observation_hash_check",
    );
    const query = check ? dialect.sqlToQuery(check.value).sql : "";
    expect(query).toContain("'pagarme-withdrawal:'");
    expect(query).not.toContain("-transfer:");
  });

  it("keeps the legacy incoming Pix consent without binding new rows to it", () => {
    const config = getTableConfig(receivingSetupHolder);
    expect(config.columns.map((column) => column.name)).toContain(
      "pix_preparation_consent",
    );
    expect(config.checks.map((entry) => entry.name)).not.toContain(
      "receiving_setup_holder_pix_consent_check",
    );
  });

  it("ships forward-only migrations that never delete rows, tables or columns", () => {
    for (const name of [
      "0031_pagarme_provider",
      "0032_pagarme_orders",
      "0033_legacy_data_and_alerts",
    ]) {
      const migration = readFileSync(
        new URL(`../migrations/${name}.sql`, import.meta.url),
        "utf8",
      );
      expect(migration).not.toMatch(
        /^\s*DELETE\b|\bTRUNCATE\b|DROP TABLE|DROP COLUMN|DROP FUNCTION/im,
      );
    }
    expect(
      readFileSync(
        new URL("../migrations/0031_pagarme_provider.sql", import.meta.url),
        "utf8",
      ),
    ).toContain("'pagarme-withdrawal:'");
  });
});
