import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as financialSchema from "./financialSchema";
import { receivingSetupHolder } from "./receivingSetupSchema";
import { withdrawalProviderObservation } from "./withdrawalProviderObservationSchema";

const dialect = new PgDialect();

describe("Pagar.me provider schema", () => {
  it("drops the withdrawal authorization and Pix preparation tables", () => {
    expect(financialSchema).not.toHaveProperty(
      "withdrawalAuthorizationCandidate",
    );
    expect(financialSchema).not.toHaveProperty(
      "withdrawalAuthorizationDecision",
    );
    expect(financialSchema).not.toHaveProperty("receivingPixPreparation");
  });

  it("identifies withdrawal provider observations as Pagar.me withdrawals", () => {
    const check = getTableConfig(withdrawalProviderObservation).checks.find(
      (entry) => entry.name === "withdrawal_observation_hash_check",
    );
    const query = check ? dialect.sqlToQuery(check.value).sql : "";
    expect(query).toContain("'pagarme-withdrawal:'");
    expect(query).not.toContain("-transfer:");
  });

  it("drops the incoming Pix consent from the receiving holder", () => {
    const config = getTableConfig(receivingSetupHolder);
    expect(config.columns.map((column) => column.name)).not.toContain(
      "pix_preparation_consent",
    );
    expect(config.checks.map((entry) => entry.name)).not.toContain(
      "receiving_setup_holder_pix_consent_check",
    );
  });

  it("ships a forward-only migration that never deletes rows", () => {
    const migration = readFileSync(
      new URL("../migrations/0031_pagarme_provider.sql", import.meta.url),
      "utf8",
    );
    expect(migration).not.toMatch(/\bDELETE\b|\bTRUNCATE\b/i);
    for (const statement of [
      'DROP TABLE "withdrawal_authorization_decision"',
      'DROP TABLE "withdrawal_authorization_candidate"',
      'DROP TABLE "receiving_pix_preparation"',
      'DROP COLUMN "credential_ciphertext"',
      'DROP COLUMN "webhook_token_hash"',
      "'pagarme-withdrawal:'",
    ])
      expect(migration).toContain(statement);
  });
});
