import { readFileSync } from "node:fs";
import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { expect, it, vi } from "vitest";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import { createGiftPaymentAdjustmentWorker } from "./giftPaymentAdjustmentWorker";
import { giftReceivedEffectKey } from "./giftPaymentReconciliation";
import { buildGiftV2Settlement } from "./giftQuotes";

type Executor = Pick<
  ReturnType<typeof createDatabaseConnection>["db"],
  "execute"
>;

// Minimal temp tables the worker joins, plus the real settlement migration.
async function createAdjustmentTables(tx: Executor) {
  await tx.execute(
    sql.raw(`
    CREATE TEMP TABLE site (id text PRIMARY KEY, is_demo boolean) ON COMMIT DROP;
    CREATE TEMP TABLE receiving_account (
      id text, site_id text, environment text, provider text, recipient_reference text, account_reference text
    ) ON COMMIT DROP;
    CREATE TEMP TABLE gift_order (
      id text, site_id text, account_id text, environment text, quote_id text
    ) ON COMMIT DROP;
    CREATE TEMP TABLE gift_quote_record (
      id text, site_id text, account_id text, environment text, snapshot jsonb
    ) ON COMMIT DROP;
    CREATE TEMP TABLE gift_payment_record (
      id text, site_id text, account_id text, environment text, order_id text,
      provider_payment_reference text, recipient_net_cents integer, verification_status text,
      provider_status text, currency text, created_at timestamptz DEFAULT clock_timestamp()
    ) ON COMMIT DROP;
    CREATE TEMP TABLE financial_ledger_entry (
      payment_id text, site_id text, account_id text, environment text, kind text,
      direction text, currency text, amount_cents integer, effect_key text
    ) ON COMMIT DROP;
    CREATE TEMP TABLE financial_event_inbox (
      site_id text, account_id text, environment text, payload jsonb, event_type text
    ) ON COMMIT DROP;
    INSERT INTO site VALUES ('site-one', true);
    INSERT INTO receiving_account VALUES ('account-one', 'site-one', 'sandbox', 'ASAAS', 'couple_wallet', 'remote_couple');
    INSERT INTO gift_order VALUES ('order-one', 'site-one', 'account-one', 'sandbox', 'quote-one');
  `),
  );
  const migration = readFileSync(
    new URL(
      "../../../packages/database/migrations/0028_gift_payment_settlement.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await tx.execute(sql.raw(migration));
}

it("applies the migration, funds one adjustment and fences an inconclusive transfer", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    await connection.db.transaction(async (tx) => {
      await createAdjustmentTables(tx);
      const quote = {
        id: "quote-one",
        siteId: "site-one",
        giftId: "gift-one",
        title: "A contribution",
        mode: "sandbox",
        method: "PIX",
        currency: "BRL",
        nominalCents: 10000,
        commissionBasisPoints: 200,
        commissionCents: 200,
        processingCents: 39,
        totalCents: 10239,
        policyVersion: "policy-one",
        feeAllocation: "BUYER_GROSS_UP",
        settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
        expiresAt: "2026-11-06T12:05:00.000Z",
      };
      const snapshot = JSON.stringify({
        quote,
        receiving: {
          recipientReference: "couple_wallet",
          accountReference: "remote_couple",
        },
      });
      await tx.execute(
        sql`INSERT INTO gift_quote_record VALUES ('quote-one','site-one','account-one','sandbox',${snapshot}::jsonb)`,
      );
      async function addPayment(id: string) {
        await tx.execute(sql`INSERT INTO gift_payment_record (
          id, site_id, account_id, environment, order_id, provider_payment_reference, recipient_net_cents,
          verification_status, provider_status, currency, platform_adjustment_cents
        ) VALUES (${id}, 'site-one', 'account-one', 'sandbox', 'order-one', ${id}, 9999, 'VERIFIED', 'RECEIVED', 'BRL', 1)`);
        await tx.execute(sql`INSERT INTO financial_ledger_entry VALUES (
          ${id}, 'site-one', 'account-one', 'sandbox', 'GIFT_RECEIVED', 'CREDIT', 'BRL', 9999, ${giftReceivedEffectKey(id)}
        )`);
      }
      await addPayment("payment-one");
      let loseResponse = false;
      let terminalFailure = false;
      let unrestricted = true;
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/wallets/"))
          return Response.json({ data: [{ id: "platform_wallet" }] });
        if (path.endsWith("/balance")) return Response.json({ balance: 1 });
        if (options?.method === "POST") {
          if (loseResponse) throw new Error("Simulated response loss");
          const body = JSON.parse(String(options.body));
          return Response.json({
            id: terminalFailure ? "transfer_failed" : "transfer_one",
            object: "transfer",
            type: "ASAAS_ACCOUNT",
            ...body,
            status: terminalFailure ? "FAILED" : "DONE",
            netValue: body.value,
            effectiveDate: "2026-11-06",
          });
        }
        return Response.json({ data: [], hasMore: false });
      });
      const worker = createGiftPaymentAdjustmentWorker(tx, {
        environment: "sandbox",
        platformApiKey: "$aact_hmlg_fixture",
        platformWalletId: "platform_wallet",
        fetch,
        now: () => new Date("2026-11-06T19:00:00Z"),
        reader: {
          hasInternalTransferCredit: vi.fn().mockResolvedValue(false),
          hasUnrestrictedGiftPayment: vi.fn(async () => unrestricted),
        },
      });
      await expect(worker.nextDueAt()).resolves.toBe(0);
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "POSTED",
      });
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "IDLE",
      });
      await expect(worker.nextDueAt()).resolves.toBeNull();
      const settled =
        await tx.execute(sql`SELECT platform_adjustment_transfer_reference AS reference,
        platform_adjustment_funded_at IS NOT NULL AS funded FROM gift_payment_record WHERE id='payment-one'`);
      expect(settled.rows).toEqual([
        { reference: "transfer_one", funded: true },
      ]);

      await addPayment("payment-two");
      loseResponse = true;
      await expect(worker.processNextReceivedPayment()).rejects.toThrow(
        "Simulated response loss",
      );
      const retry = await tx.execute(
        sql`SELECT ceil(extract(epoch FROM platform_adjustment_next_attempt_at)*1000)::float8 AS deadline
            FROM gift_payment_record WHERE id='payment-two'`,
      );
      await expect(worker.nextDueAt()).resolves.toBe(retry.rows[0].deadline);
      await tx.execute(
        sql`UPDATE gift_payment_record SET platform_adjustment_next_attempt_at=NULL WHERE id='payment-two'`,
      );
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "RETRY",
      });
      const pending =
        await tx.execute(sql`SELECT platform_adjustment_dispatch_at IS NOT NULL AS dispatched,
        platform_adjustment_funded_at IS NULL AS owed FROM gift_payment_record WHERE id='payment-two'`);
      expect(pending.rows).toEqual([{ dispatched: true, owed: true }]);
      const countPosts = () =>
        fetch.mock.calls.filter(([, options]) => options?.method === "POST")
          .length;
      expect(countPosts()).toBe(2);

      await addPayment("payment-three");
      unrestricted = false;
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "RETRY",
      });
      expect(countPosts()).toBe(2);
      const restricted =
        await tx.execute(sql`SELECT platform_adjustment_dispatch_at IS NULL AS held
        FROM gift_payment_record WHERE id='payment-three'`);
      expect(restricted.rows).toEqual([{ held: true }]);

      unrestricted = true;
      loseResponse = false;
      terminalFailure = true;
      await tx.execute(
        sql`UPDATE gift_payment_record SET platform_adjustment_next_attempt_at=NULL WHERE id='payment-three'`,
      );
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "DEAD_LETTER",
      });
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "IDLE",
      });
      const parked =
        await tx.execute(sql`SELECT platform_adjustment_funded_at IS NULL AS owed,
        platform_adjustment_next_attempt_at='infinity'::timestamptz AS parked
        FROM gift_payment_record WHERE id='payment-three'`);
      expect(parked.rows).toEqual([{ owed: true, parked: true }]);
      expect(countPosts()).toBe(3);
      await tx.execute(
        sql`UPDATE gift_payment_record SET platform_adjustment_next_attempt_at='infinity'`,
      );
      await expect(worker.nextDueAt()).resolves.toBeNull();
    });
  } finally {
    await connection.close();
  }
});

it("transfers a V2 split-divergence top-up once the lowered split is credited", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    await connection.db.transaction(async (tx) => {
      await createAdjustmentTables(tx);
      const quote = {
        id: "quote-one",
        siteId: "site-one",
        giftId: "gift-one",
        title: "A contribution",
        mode: "sandbox" as const,
        method: "PIX" as const,
        currency: "BRL" as const,
        commissionBasisPoints: 200 as const,
        settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2" as const,
        expiresAt: "2026-11-06T12:05:00.000Z",
        ...quoteGiftPurchaseAmounts({
          nominalCents: 10_000,
          method: "PIX",
          policy: platformTariffPolicy("PIX"),
        }),
      };
      const settlement = buildGiftV2Settlement(quote);
      expect(settlement.recipientSplitCents).toEqual([10_000]);
      const snapshot = JSON.stringify({
        quote,
        settlement,
        receiving: {
          recipientReference: "couple_wallet",
          accountReference: "remote_couple",
        },
      });
      await tx.execute(
        sql`INSERT INTO gift_quote_record VALUES ('quote-one','site-one','account-one','sandbox',${snapshot}::jsonb)`,
      );
      // The fix lowered the split to the 90.00 net; the platform owes 10.00.
      async function addPayment(id: string, topUpCents: number) {
        await tx.execute(sql`INSERT INTO gift_payment_record (
          id, site_id, account_id, environment, order_id, provider_payment_reference, recipient_net_cents,
          verification_status, provider_status, currency, platform_adjustment_cents
        ) VALUES (${id}, 'site-one', 'account-one', 'sandbox', 'order-one', ${id}, 9000, 'VERIFIED', 'RECEIVED', 'BRL', ${topUpCents})`);
        await tx.execute(sql`INSERT INTO financial_ledger_entry VALUES (
          ${id}, 'site-one', 'account-one', 'sandbox', 'GIFT_RECEIVED', 'CREDIT', 'BRL', 9000, ${giftReceivedEffectKey(id)}
        )`);
      }
      await addPayment("payment-v2", 1000);
      const fetch = vi.fn<typeof globalThis.fetch>(async (url, options) => {
        const path = new URL(String(url)).pathname;
        if (path.endsWith("/wallets/"))
          return Response.json({ data: [{ id: "platform_wallet" }] });
        if (path.endsWith("/balance")) return Response.json({ balance: 50 });
        if (options?.method === "POST") {
          const body = JSON.parse(String(options.body));
          return Response.json({
            id: "transfer_topup",
            object: "transfer",
            type: "ASAAS_ACCOUNT",
            ...body,
            status: "DONE",
            netValue: body.value,
            effectiveDate: "2026-11-06",
          });
        }
        return Response.json({ data: [], hasMore: false });
      });
      const worker = createGiftPaymentAdjustmentWorker(tx, {
        environment: "sandbox",
        platformApiKey: "$aact_hmlg_fixture",
        platformWalletId: "platform_wallet",
        fetch,
        now: () => new Date("2026-11-06T19:00:00Z"),
        reader: {
          hasInternalTransferCredit: vi.fn().mockResolvedValue(false),
          hasUnrestrictedGiftPayment: vi.fn().mockResolvedValue(true),
        },
      });
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "POSTED",
      });
      const posts = fetch.mock.calls.filter(
        ([, options]) => options?.method === "POST",
      );
      expect(posts).toHaveLength(1);
      const body = JSON.parse(String(posts[0]?.[1]?.body));
      expect(body).toMatchObject({
        walletId: "couple_wallet",
        value: 10,
        description: "SPLIT_DIVERGENCE_TOPUP",
      });
      expect(body.externalReference).toMatch(/^gift_topup_[0-9a-f]{64}$/);
      const settled =
        await tx.execute(sql`SELECT platform_adjustment_transfer_reference AS reference,
        platform_adjustment_funded_at IS NOT NULL AS funded FROM gift_payment_record WHERE id='payment-v2'`);
      expect(settled.rows).toEqual([
        { reference: "transfer_topup", funded: true },
      ]);
      await expect(worker.processNextReceivedPayment()).resolves.toEqual({
        kind: "IDLE",
      });

      // A top-up that does not close the gap to the frozen split is refused.
      await addPayment("payment-v2-wrong", 999);
      await expect(worker.processNextReceivedPayment()).rejects.toThrow();
      expect(
        fetch.mock.calls.filter(([, options]) => options?.method === "POST"),
      ).toHaveLength(1);
    });
  } finally {
    await connection.close();
  }
});
