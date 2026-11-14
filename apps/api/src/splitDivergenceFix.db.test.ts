import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import { createSplitDivergenceStore } from "./splitDivergenceFix";

it("reads the blocked V2 record, records the top-up once and resolves the alert", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    await connection.db.transaction(async (tx) => {
      // Temp tables shadow the real ones for the store's unqualified SQL.
      await tx.execute(
        sql.raw(`
        CREATE TEMP TABLE gift_order (
          id text, site_id text, account_id text, environment text, quote_id text
        ) ON COMMIT DROP;
        CREATE TEMP TABLE gift_quote_record (
          id text, site_id text, account_id text, environment text, snapshot jsonb
        ) ON COMMIT DROP;
        CREATE TEMP TABLE gift_payment_record (
          id text, site_id text, account_id text, environment text, order_id text,
          provider_payment_reference text, installment_number integer,
          platform_adjustment_cents integer CHECK (platform_adjustment_cents > 0),
          platform_adjustment_dispatch_at timestamptz, split_divergence_blocked_at timestamptz
        ) ON COMMIT DROP;
        CREATE TEMP TABLE financial_ledger_entry (
          payment_id text, site_id text, account_id text, environment text, kind text
        ) ON COMMIT DROP;
        CREATE TEMP TABLE financial_operator_alert (
          id text, kind text, environment text, payment_reference text,
          created_at timestamptz DEFAULT clock_timestamp(), resolved_at timestamptz, resolved_note text
        ) ON COMMIT DROP;
        INSERT INTO gift_order VALUES ('order-one', 'site-one', 'account-one', 'sandbox', 'quote-one');
        INSERT INTO gift_quote_record VALUES ('quote-one', 'site-one', 'account-one', 'sandbox',
          '{"quote":{"settlementVersion":"PLATFORM_ACCOUNT_SPLIT_V2"}}');
        INSERT INTO gift_payment_record VALUES ('payment-one', 'site-one', 'account-one', 'sandbox', 'order-one',
          'pay_one', 2, NULL, NULL, clock_timestamp());
        INSERT INTO financial_operator_alert (id, kind, environment, payment_reference)
          VALUES ('alert-one', 'SPLIT_DIVERGENCE_BLOCK', 'sandbox', 'pay_one');
      `),
      );
      const store = createSplitDivergenceStore(tx, "sandbox");
      await expect(store.load("pay_unknown")).resolves.toBeNull();
      await expect(store.load("pay_one")).resolves.toEqual({
        paymentId: "payment-one",
        siteId: "site-one",
        accountId: "account-one",
        installmentNumber: 2,
        platformAdjustmentCents: null,
        adjustmentDispatched: false,
        blocked: true,
        alertOpen: true,
        credited: false,
        snapshot: { quote: { settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2" } },
      });
      const outcome = await store.transaction(async (locked) => {
        const stored = await locked.load("pay_one");
        if (!stored) throw new Error("missing");
        return {
          first: await locked.recordTopUp(stored, 1000),
          second: await locked.recordTopUp(stored, 1000),
          resolved: await locked.resolveAlert(
            "pay_one",
            "fixSplitDivergence fit=9000 topUp=1000",
          ),
        };
      });
      expect(outcome).toEqual({ first: true, second: false, resolved: true });
      await expect(store.load("pay_one")).resolves.toMatchObject({
        platformAdjustmentCents: 1000,
        alertOpen: false,
      });
      const alert = await tx.execute(
        sql`SELECT resolved_note AS note FROM financial_operator_alert`,
      );
      expect(alert.rows).toEqual([
        { note: "fixSplitDivergence fit=9000 topUp=1000" },
      ]);
      await tx.execute(
        sql`INSERT INTO financial_ledger_entry VALUES ('payment-one','site-one','account-one','sandbox','GIFT_RECEIVED')`,
      );
      await expect(store.load("pay_one")).resolves.toMatchObject({
        credited: true,
      });
    });
  } finally {
    await connection.close();
  }
});
