import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { giftPurchaseHasPayment } from "./giftPaymentHistoryRepository";

const connection = createDatabaseConnection({ target: "test" });
const connect = () => connection.pool.connect();
let client: Awaited<ReturnType<typeof connect>>;
beforeAll(async () => {
  await verifyDatabaseConnection(connection);
  client = await connection.pool.connect();
  await client.query(`
    CREATE TEMP TABLE gift_order (id text,site_id text,account_id text,environment text);
    CREATE TEMP TABLE gift_payment_record (id text,order_id text,site_id text,account_id text,environment text,provider_status text,verification_status text,observed_at timestamptz,currency text,gross_cents integer,recipient_net_cents integer,provider_payment_reference text);
    CREATE TEMP TABLE financial_ledger_entry (payment_id text,site_id text,account_id text,environment text,kind text,direction text,currency text,amount_cents integer,compensates_entry_id text);
    CREATE TEMP TABLE financial_event_inbox (payment_id text,site_id text,account_id text,environment text,event_type text,state text,authenticated_at timestamptz,processed_at timestamptz,payload jsonb);
  `);
});
beforeEach(async () => {
  await client.query(`TRUNCATE pg_temp.gift_order,pg_temp.gift_payment_record,pg_temp.financial_ledger_entry,pg_temp.financial_event_inbox;
    INSERT INTO pg_temp.gift_order VALUES ('order','site','account','sandbox');`);
});
afterAll(async () => {
  client?.release();
  await connection.close();
});
async function payment(status: string, verified = "VERIFIED") {
  await client.query(
    `INSERT INTO pg_temp.gift_payment_record VALUES ('payment','order','site','account','sandbox',$1,$2,now(),'BRL',55000,53000,'pay_one')`,
    [status, verified],
  );
}
async function visible() {
  const result = await drizzle(client).execute(
    sql`SELECT o.id FROM gift_order o WHERE o.site_id='site' AND o.environment='sandbox' AND ${giftPurchaseHasPayment} ORDER BY o.id LIMIT 25`,
  );
  return result.rows.map((row) => row.id);
}
it("keeps an issued checkout without any payment internal", async () => {
  expect(await visible()).toEqual([]);
});
it.each([
  "PENDING",
  "OVERDUE",
  "CANCELLED",
  "DELETED",
  "REFUNDED",
  "AWAITING_RISK_ANALYSIS",
])("keeps %s without prior payment evidence internal", async (status) => {
  await payment(status);
  expect(await visible()).toEqual([]);
});
it.each(["CONFIRMED", "RECEIVED"])(
  "shows verified %s without inventing a settled receipt",
  async (status) => {
    await payment(status);
    expect(await visible()).toEqual(["order"]);
  },
);
it("does not accept an unverified paid status", async () => {
  await payment("RECEIVED", "UNKNOWN");
  expect(await visible()).toEqual([]);
});
it.each(["site_id", "account_id", "environment"])(
  "does not borrow a payment from another %s",
  async (field) => {
    await payment("RECEIVED");
    await client.query(
      `UPDATE pg_temp.gift_payment_record SET ${field}='foreign'`,
    );
    expect(await visible()).toEqual([]);
  },
);
it("retains a previously credited purchase after refund", async () => {
  await payment("REFUNDED");
  await client.query(
    `INSERT INTO pg_temp.financial_ledger_entry VALUES ('payment','site','account','sandbox','GIFT_RECEIVED','CREDIT','BRL',53000,null)`,
  );
  expect(await visible()).toEqual(["order"]);
  await client.query(
    `UPDATE pg_temp.financial_ledger_entry SET account_id='foreign'`,
  );
  expect(await visible()).toEqual([]);
});
it("retains an authenticated prior confirmation after refund before release", async () => {
  await payment("REFUNDED");
  await client.query(
    `INSERT INTO pg_temp.financial_event_inbox VALUES ('payment','site','account','sandbox','PAYMENT_CONFIRMED','PROCESSED',now(),now(),'{"paymentId":"pay_one"}')`,
  );
  expect(await visible()).toEqual(["order"]);
  await client.query(
    `UPDATE pg_temp.financial_event_inbox SET payload='{"paymentId":"other"}'`,
  );
  expect(await visible()).toEqual([]);
});
it("does not treat CHECKOUT_PAID or an unprocessed event as verified payment", async () => {
  await payment("PENDING");
  await client.query(
    `INSERT INTO pg_temp.financial_event_inbox VALUES ('payment','site','account','sandbox','CHECKOUT_PAID','PROCESSED',now(),now(),'{"paymentId":"pay_one"}')`,
  );
  expect(await visible()).toEqual([]);
  await client.query(
    `UPDATE pg_temp.financial_event_inbox SET event_type='PAYMENT_CONFIRMED',state='PENDING',processed_at=null`,
  );
  expect(await visible()).toEqual([]);
});
it("filters abandoned attempts before applying the page limit", async () => {
  await payment("RECEIVED");
  await client.query(
    `INSERT INTO pg_temp.gift_order SELECT 'abandoned-'||n,'site','account','sandbox' FROM generate_series(1,100) n`,
  );
  expect(await visible()).toEqual(["order"]);
});
