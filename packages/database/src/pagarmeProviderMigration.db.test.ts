import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";

let connection: DatabaseConnection;
beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
});
afterAll(async () => {
  await connection?.close();
});

describe("0031 Pagar.me provider migration", () => {
  it("removes the Asaas-only tables", async () => {
    const result = await connection.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)",
      [
        [
          "withdrawal_authorization_candidate",
          "withdrawal_authorization_decision",
          "receiving_pix_preparation",
        ],
      ],
    );
    expect(result.rows).toEqual([]);
  });

  it("removes stored sub-account credentials and webhook state", async () => {
    const result = await connection.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND ((table_name='receiving_account' AND (column_name LIKE 'credential_%' OR column_name LIKE 'webhook_%')) OR (table_name='receiving_setup_holder' AND column_name='pix_preparation_consent'))",
    );
    expect(result.rows).toEqual([]);
  });

  it("accepts only pagarme-withdrawal observation identifiers", async () => {
    const result = await connection.pool.query(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='withdrawal_observation_hash_check'",
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].definition).toContain("pagarme-withdrawal:");
    expect(result.rows[0].definition).not.toContain("asaas");
  });
});
