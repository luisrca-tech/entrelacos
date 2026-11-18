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

async function definition(name: string): Promise<string> {
  const result = await connection.pool.query(
    "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname=$1",
    [name],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0].definition;
}

describe("0032 Pagar.me order migration", () => {
  it("stores the Pix QR data shown to the guest on the checkout attempt", async () => {
    const result = await connection.pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='gift_checkout_attempt' AND column_name LIKE 'pix_%' ORDER BY column_name",
    );
    expect(result.rows.map((row) => row.column_name)).toEqual([
      "pix_qr_code",
      "pix_qr_code_url",
    ]);
    expect(await definition("gift_checkout_attempt_pix_check")).toContain(
      "pix_qr_code_url",
    );
  });

  it("accepts refund, chargeback and order mismatch operator alerts", async () => {
    const check = await definition("financial_operator_alert_kind_check");
    for (const kind of ["GIFT_REFUNDED", "GIFT_CHARGEBACK", "ORDER_MISMATCH"])
      expect(check).toContain(kind);
  });
});
