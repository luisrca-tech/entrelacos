import { readFileSync } from "node:fs";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseConnection,
  type DatabaseConnection,
  verifyDatabaseConnection,
} from "./connection";
import { giftQuoteRecord } from "./financialSchema";

let connection: DatabaseConnection;
const constraint = getTableConfig(giftQuoteRecord).checks.find(
  (entry) => entry.name === "gift_quote_allocation_check",
);
if (!constraint) throw new Error("Missing quote allocation constraint");
const expression = new PgDialect().sqlToQuery(constraint.value).sql;

beforeAll(async () => {
  connection = createDatabaseConnection({ target: "test" });
  await verifyDatabaseConnection(connection);
});
afterAll(async () => {
  await connection?.close();
});

function snapshot(quote: unknown, policy: unknown) {
  return {
    quote: quote === undefined ? {} : { feeAllocation: quote },
    pricing: { policy: policy === undefined ? {} : { feeAllocation: policy } },
  };
}

describe("PostgreSQL immutable quote fee allocation constraint", () => {
  it("reproduces the prior constraint rejecting recipient deductions while accepting the historical quote", async () => {
    const previous = JSON.parse(
      readFileSync(
        new URL("../migrations/meta/0018_snapshot.json", import.meta.url),
        "utf8",
      ),
    );
    const oldExpression =
      previous.tables["public.gift_quote_record"].checkConstraints
        .gift_quote_allocation_check.value;
    for (const [total, expected] of [
      [1000, false],
      [1020, true],
    ] as const) {
      const result = await connection.pool.query(
        `SELECT (${oldExpression}) AS valid FROM (SELECT 1000::integer AS nominal_cents, 20::integer AS commission_cents, $1::integer AS total_cents, 0::integer AS processing_cents) AS gift_quote_record`,
        [total],
      );
      expect(result.rows[0]?.valid).toBe(expected);
    }
  });
  it.each([
    [undefined, undefined, 1020, 0, true],
    ["BUYER_GROSS_UP", "BUYER_GROSS_UP", 1119, 99, true],
    ["RECIPIENT_DEDUCTED", "RECIPIENT_DEDUCTED", 1000, 99, true],
    ["RECIPIENT_DEDUCTED", "RECIPIENT_DEDUCTED", 1000, 0, true],
    ["RECIPIENT_DEDUCTED", "RECIPIENT_DEDUCTED", 1000, 980, false],
    ["RECIPIENT_DEDUCTED", "RECIPIENT_DEDUCTED", 1119, 99, false],
    [undefined, undefined, 1000, 99, false],
    ["BUYER_GROSS_UP", "BUYER_GROSS_UP", 1000, 99, false],
    ["RECIPIENT_DEDUCTED", undefined, 1000, 99, false],
    [undefined, "RECIPIENT_DEDUCTED", 1000, 99, false],
    ["BUYER_GROSS_UP", undefined, 1020, 0, false],
    [undefined, "BUYER_GROSS_UP", 1020, 0, false],
    ["RECIPIENT_DEDUCTED", "BUYER_GROSS_UP", 1000, 99, false],
    ["BUYER_GROSS_UP", "RECIPIENT_DEDUCTED", 1020, 0, false],
    ["UNKNOWN", "UNKNOWN", 1020, 0, false],
    [null, null, 1020, 0, false],
    [1, 1, 1020, 0, false],
    [[], [], 1020, 0, false],
    [{}, {}, 1020, 0, false],
  ])(
    "validates allocation %# with PostgreSQL",
    async (quote, policy, total, fee, valid) => {
      // SELECT only: operational rows and schema remain untouched.
      const result = await connection.pool.query(
        `SELECT (${expression}) AS valid FROM (SELECT 1000::integer AS nominal_cents, 20::integer AS commission_cents, $1::integer AS total_cents, $2::integer AS processing_cents, $3::jsonb AS snapshot) AS gift_quote_record`,
        [total, fee, JSON.stringify(snapshot(quote, policy))],
      );
      expect(result.rows[0]?.valid).toBe(valid);
    },
  );
});
