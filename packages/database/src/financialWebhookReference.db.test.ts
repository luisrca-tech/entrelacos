import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";
import { financialEventInbox } from "./financialSchema";

let connection: DatabaseConnection;
const constraint = getTableConfig(financialEventInbox).checks.find(
  (entry) => entry.name === "financial_event_provider_reference_check",
);
if (!constraint) throw new Error("Missing webhook event reference constraint");
const expression = new PgDialect().sqlToQuery(constraint.value).sql;

beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
});
afterAll(async () => {
  await connection?.close();
});

describe("PostgreSQL webhook event reference constraint", () => {
  it.each([
    [null, true],
    ["evt_checkout-created&123", true],
    ["a", true],
    ["a".repeat(256), true],
    ["a".repeat(257), false],
    ["", false],
    [" ", false],
    ["evt\ninvalid", false],
    ["evt\u0001invalid", false],
    ["evt_é", false],
  ])(
    "validates reference %# with the database regex engine",
    async (reference, valid) => {
      const result = await connection.pool.query(
        `SELECT (${expression}) AS valid FROM (SELECT $1::text AS provider_event_reference) AS financial_event_inbox`,
        [reference],
      );
      expect(result.rows[0]?.valid).toBe(valid);
    },
  );
});
