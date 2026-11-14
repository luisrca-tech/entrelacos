import {
  createDatabaseConnection,
  verifyDatabaseConnection,
} from "@entrelacos/database";
import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import {
  listOwnerFinanceAlerts,
  listOwnerFinanceGifts,
  type OwnerFinanceDatabase,
  readOwnerFinanceSummary,
  resolveOwnerFinanceAlert,
} from "./ownerFinanceRepository";

// Temporary copies of the real tables (same columns, no foreign keys) shadow
// them inside the transaction, so the queries run against the real column set.
const shadowed = [
  "site",
  "gift_quote_record",
  "gift_order",
  "gift_payment_record",
  "financial_ledger_entry",
  "financial_event_inbox",
  "financial_operator_alert",
];

type Executor = Pick<OwnerFinanceDatabase, "execute">;

async function seed(tx: Executor) {
  for (const table of shadowed)
    await tx.execute(
      sql.raw(
        `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS) ON COMMIT DROP`,
      ),
    );
  for (const [id, name] of [
    ["site-a", "Ana & Bia"],
    ["site-b", "Caio & Duda"],
  ])
    await tx.execute(sql`INSERT INTO site (id, repository_slug, provisioning_key, display_name,
      partner_one_name, partner_two_name, event_date)
      VALUES (${id}, ${id}, ${id}, ${name}, 'One', 'Two', '2027-01-01')`);

  async function order(input: {
    id: string;
    siteId: string;
    method: "PIX" | "CREDIT_CARD";
    total: number;
    installments?: number;
    version?: string;
  }) {
    const quote = {
      title: `Presente ${input.id}`,
      settlementVersion: input.version ?? "PLATFORM_ACCOUNT_SPLIT_V2",
      ...(input.installments ? { installmentCount: input.installments } : {}),
    };
    await tx.execute(sql`INSERT INTO gift_quote_record (id, site_id, account_id, environment, gift_id,
      destination_version, method, nominal_cents, commission_cents, processing_cents, total_cents,
      policy_version, snapshot, expires_at, created_at)
      VALUES (${`quote-${input.id}`}, ${input.siteId}, 'account', 'sandbox', 'gift', 1, ${input.method},
        10000, 200, ${input.total - 10200}, ${input.total}, 'policy',
        ${JSON.stringify({ quote })}::jsonb, '2026-12-01T00:00:00Z', '2026-10-01T00:00:00Z')`);
    await tx.execute(sql`INSERT INTO gift_order (id, site_id, account_id, environment, quote_id,
      request_id, request_hash, recovery_token_hash, created_at)
      VALUES (${input.id}, ${input.siteId}, 'account', 'sandbox', ${`quote-${input.id}`},
        ${input.id}, ${"a".repeat(64)}, ${"b".repeat(64)}, '2026-10-01T00:00:00Z')`);
  }

  async function payment(input: {
    id: string;
    orderId: string;
    siteId: string;
    status: string;
    observedAt: string;
    gross: number;
    recipientNet?: number;
    platformNet?: number;
    installment?: number;
  }) {
    await tx.execute(sql`INSERT INTO gift_payment_record (id, site_id, account_id, environment, order_id,
      attempt_id, provider_payment_reference, provider_status, verification_status, observed_at,
      gross_cents, recipient_net_cents, platform_net_cents, provider_installment_reference, installment_number)
      VALUES (${input.id}, ${input.siteId}, 'account', 'sandbox', ${input.orderId}, 'attempt', ${`pay_${input.id}`},
        ${input.status}, 'VERIFIED', ${input.observedAt}::timestamptz, ${input.gross},
        ${input.recipientNet ?? null}, ${input.platformNet ?? null},
        ${input.installment ? "installment" : null}, ${input.installment ?? null})`);
    // A settled split (platform net known) is the one credited to the couple.
    if (input.platformNet !== undefined && input.recipientNet !== undefined)
      await tx.execute(sql`INSERT INTO financial_ledger_entry (id, site_id, account_id, environment,
        effect_key, kind, direction, currency, amount_cents, payment_id, created_at)
        VALUES (${`ledger-${input.id}`}, ${input.siteId}, 'account', 'sandbox', ${`effect-${input.id}`},
          'GIFT_RECEIVED', 'CREDIT', 'BRL', ${input.recipientNet}, ${input.id}, ${input.observedAt}::timestamptz)`);
  }

  await order({
    id: "order-pix",
    siteId: "site-a",
    method: "PIX",
    total: 10239,
  });
  await payment({
    id: "p-pix",
    orderId: "order-pix",
    siteId: "site-a",
    status: "RECEIVED",
    observedAt: "2026-10-05T12:00:00Z",
    gross: 10239,
    recipientNet: 10000,
    platformNet: 180,
  });
  await order({
    id: "order-card",
    siteId: "site-a",
    method: "CREDIT_CARD",
    total: 10600,
    installments: 3,
  });
  for (const [installment, recipientNet, platformNet] of [
    [1, 3334, 60],
    [2, undefined, undefined],
    [3, undefined, undefined],
  ] as const)
    await payment({
      id: `p-card-${installment}`,
      orderId: "order-card",
      siteId: "site-a",
      status: "CONFIRMED",
      observedAt: `2026-10-10T12:00:0${installment}Z`,
      gross: 3534,
      recipientNet,
      platformNet,
      installment,
    });
  await order({
    id: "order-review",
    siteId: "site-b",
    method: "PIX",
    total: 10239,
  });
  await payment({
    id: "p-review",
    orderId: "order-review",
    siteId: "site-b",
    status: "CONFIRMED",
    observedAt: "2026-10-12T12:00:00Z",
    gross: 10239,
  });
  await order({
    id: "order-wait",
    siteId: "site-b",
    method: "PIX",
    total: 10239,
  });
  await payment({
    id: "p-wait",
    orderId: "order-wait",
    siteId: "site-b",
    status: "CONFIRMED",
    observedAt: "2026-10-15T12:00:00Z",
    gross: 10239,
  });
  // Excluded: a V1 gift and an unpaid V2 checkout.
  await order({
    id: "order-v1",
    siteId: "site-a",
    method: "PIX",
    total: 10239,
    version: "PLATFORM_FEE_GUARANTEE_V1",
  });
  await payment({
    id: "p-v1",
    orderId: "order-v1",
    siteId: "site-a",
    status: "RECEIVED",
    observedAt: "2026-10-06T12:00:00Z",
    gross: 10239,
    recipientNet: 10000,
  });
  await order({
    id: "order-unpaid",
    siteId: "site-b",
    method: "PIX",
    total: 10239,
  });
  await payment({
    id: "p-unpaid",
    orderId: "order-unpaid",
    siteId: "site-b",
    status: "PENDING",
    observedAt: "2026-10-16T12:00:00Z",
    gross: 10239,
  });

  await tx.execute(sql`INSERT INTO financial_operator_alert (id, kind, severity, environment, site_id,
    payment_reference, created_at) VALUES
    ('alert-divergence', 'SPLIT_DIVERGENCE_BLOCK', 'critical', 'sandbox', 'site-b', 'pay_p-review', '2026-10-12T13:00:00Z'),
    ('alert-anticipation', 'ANTICIPATION_DENIED', 'warning', 'sandbox', 'site-a', 'pay_p-card-1', '2026-10-11T13:00:00Z'),
    ('alert-unroutable', 'UNROUTABLE_PLATFORM_EVENT', 'warning', 'sandbox', NULL, 'pay_unknown', '2026-10-13T13:00:00Z')`);
}

it("lists, totals and pages paid V2 gifts and alerts with owner filters", async () => {
  const connection = createDatabaseConnection({ target: "test" });
  try {
    await verifyDatabaseConnection(connection);
    await connection.db.transaction(async (tx) => {
      const db = tx as unknown as OwnerFinanceDatabase;
      await seed(db);

      // The anticipation alert is resolved first so it does not put the
      // card gift in review.
      await expect(
        resolveOwnerFinanceAlert(db, {
          id: "alert-anticipation",
          note: "Sem antecipação",
          now: new Date("2026-10-20T00:00:00Z"),
        }),
      ).resolves.toBe(true);
      await expect(
        resolveOwnerFinanceAlert(db, {
          id: "alert-anticipation",
          note: "De novo",
          now: new Date("2026-10-20T00:00:00Z"),
        }),
      ).resolves.toBe(false);

      const all = await listOwnerFinanceGifts(db, { limit: 50 });
      expect(all.nextCursor).toBeNull();
      expect(all.gifts.map((gift) => [gift.orderId, gift.status])).toEqual([
        ["order-wait", "AWAITING_RELEASE"],
        ["order-review", "IN_REVIEW"],
        ["order-card", "PARTIALLY_RECEIVED"],
        ["order-pix", "RECEIVED"],
      ]);
      expect(all.gifts[2]).toEqual({
        orderId: "order-card",
        siteId: "site-a",
        siteName: "Ana & Bia",
        environment: "sandbox",
        paidAt: "2026-10-10T12:00:01.000Z",
        giftTitle: "Presente order-card",
        method: "CREDIT_CARD",
        installmentCount: 3,
        grossCents: 10600,
        coupleCreditedCents: 3334,
        coupleExpectedCents: 10000,
        creditedInstallments: 1,
        estimatedCommissionCents: 200,
        netCommissionCents: 60,
        status: "PARTIALLY_RECEIVED",
      });
      expect(all.gifts[0].netCommissionCents).toBeNull();

      const first = await listOwnerFinanceGifts(db, { limit: 2 });
      expect(first.gifts.map((gift) => gift.orderId)).toEqual([
        "order-wait",
        "order-review",
      ]);
      expect(first.nextCursor).toMatch(/^\d+_order-review$/);
      const second = await listOwnerFinanceGifts(db, {
        limit: 2,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.gifts.map((gift) => gift.orderId)).toEqual([
        "order-card",
        "order-pix",
      ]);
      expect(second.nextCursor).toBeNull();

      const ids = async (
        filters: Parameters<typeof listOwnerFinanceGifts>[1],
      ) =>
        (await listOwnerFinanceGifts(db, filters)).gifts.map(
          (gift) => gift.orderId,
        );
      expect(await ids({ limit: 50, siteId: ["site-a"] })).toEqual([
        "order-card",
        "order-pix",
      ]);
      expect(await ids({ limit: 50, method: "CREDIT_CARD" })).toEqual([
        "order-card",
      ]);
      expect(await ids({ limit: 50, status: "IN_REVIEW" })).toEqual([
        "order-review",
      ]);
      expect(
        await ids({
          limit: 50,
          from: "2026-10-09T00:00:00.000Z",
          to: "2026-10-13T00:00:00.000Z",
        }),
      ).toEqual(["order-review", "order-card"]);
      expect(await ids({ limit: 50, environment: "live" })).toEqual([]);

      await expect(readOwnerFinanceSummary(db, {})).resolves.toEqual({
        giftCount: 4,
        grossChargedCents: 10239 * 3 + 10600,
        coupleCreditedCents: 13334,
        estimatedCommissionCents: 800,
        netCommissionCents: 240,
        // Only the fully received Pix gift: 200 estimated - 180 real.
        commissionDifferenceCents: 20,
      });
      await expect(
        readOwnerFinanceSummary(db, { siteId: ["site-b"] }),
      ).resolves.toMatchObject({
        giftCount: 2,
        coupleCreditedCents: 0,
        netCommissionCents: 0,
      });

      const open = await listOwnerFinanceAlerts(db, {
        status: "open",
        limit: 50,
      });
      expect(open.alerts.map((alert) => alert.id)).toEqual([
        "alert-unroutable",
        "alert-divergence",
      ]);
      expect(open).toMatchObject({ openCount: 2, criticalOpenCount: 1 });
      expect(open.alerts[1]).toMatchObject({
        siteName: "Caio & Duda",
        amountCents: 10239,
        dueAt: "2026-10-14T13:00:00.000Z",
        asaasPaymentUrl: null,
      });
      const resolved = await listOwnerFinanceAlerts(db, {
        status: "resolved",
        siteId: ["site-a"],
        limit: 50,
      });
      expect(resolved.alerts).toHaveLength(1);
      expect(resolved.alerts[0]).toMatchObject({
        id: "alert-anticipation",
        resolvedNote: "Sem antecipação",
        resolvedAt: "2026-10-20T00:00:00.000Z",
      });
      const page = await listOwnerFinanceAlerts(db, {
        status: "all",
        limit: 2,
      });
      expect(page.alerts.map((alert) => alert.id)).toEqual([
        "alert-unroutable",
        "alert-divergence",
      ]);
      const rest = await listOwnerFinanceAlerts(db, {
        status: "all",
        limit: 2,
        cursor: page.nextCursor ?? undefined,
      });
      expect(rest.alerts.map((alert) => alert.id)).toEqual([
        "alert-anticipation",
      ]);
      expect(rest.nextCursor).toBeNull();
    });
  } finally {
    await connection.close();
  }
});
