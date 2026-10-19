import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import { databaseTimestampEpochMicroseconds } from "./databaseTimestamp";
import type { GiftPaymentHistoryReadScope } from "./giftPaymentHistory";
import { giftReceivedEffectKey } from "./giftPaymentReconciliation";
import { readReceivingProvisioningRecord } from "./receivingNomination";

async function fixture() {
  const scope: GiftPaymentHistoryReadScope = {
    siteId: "site-one",
    mode: "sandbox",
    policy: "SITE_HISTORY",
    userId: "viewer-one",
    sessionId: "session-one",
    membershipId: "membership-one",
  };
  const created = "2026-10-12T16:00:00.000Z";
  const nomination = {
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    requestId: "original-account-request",
    operatorUserId: "operator-old",
    environment: "sandbox",
    policyVersion: "nomination-original",
    accountId: "account-old",
    operationId: "account-operation",
    createdAt: created,
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          "original-account-request",
          "operator-old",
          "sandbox",
          "nomination-original",
          true,
        ]),
      )
      .digest("hex"),
    authentication: {
      userId: "operator-old",
      siteId: "site-one",
      sessionId: "operator-old-session",
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T15:59:30.000Z",
      expiresAt: "2026-10-12T16:04:00.000Z",
    },
  };
  const provision = {
    provider: "ASAAS",
    siteId: "site-one",
    accountId: "account-old",
    operationId: "account-operation",
    requestId: "original-account-request",
    operatorUserId: "operator-old",
    environment: "sandbox",
    policyVersion: "nomination-original",
    parentAccountReference: "fictional-parent",
    fingerprintVersion: "hkdf-hmac-sha256-v1",
    fingerprintKeyId: "fictional-fingerprint",
    inputFingerprint: "a".repeat(64),
    dispatch: {
      leaseOwner: "original-owner",
      leaseToken: "original-token",
      leaseExpiresAtMicroseconds: (
        BigInt(Date.parse(created)) * 1000n +
        60000000n
      ).toString(),
      possibleDispatch: true,
    },
  };
  const record = readReceivingProvisioningRecord({
    version: "receiving.account-provisioning.v1",
    nomination,
    provision,
    sealedResult: null,
  });
  const receiving = {
    siteId: "site-one",
    provider: "ASAAS",
    environment: "sandbox",
    operatorReference: "operator-original",
    accountReference: "provider-account-old",
    recipientReference: "recipient-original",
    bankReference: "bank-original",
    destinationVersion: 1,
  };
  const snapshot = {
    quote: {
      id: "quote-one",
      siteId: "site-one",
      giftId: "gift-one",
      title: "Original archived gift",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 39,
      totalCents: 10239,
      policyVersion: "pricing-original",
      mode: "sandbox",
      expiresAt: "2026-10-12T17:00:00.000Z",
    },
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Original archived gift",
      description: "",
      nominalCents: 10000,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    receiving,
    pricing: {
      ...receiving,
      verification: "verified",
      provenance: "provider",
      observedAt: "2026-10-12T16:54:00.000Z",
      expiresAt: "2026-10-12T17:10:00.000Z",
      policy: {
        version: "pricing-original",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 39,
        rounding: "CEILING",
      },
    },
    createdAt: "2026-10-12T16:55:00.000Z",
    expiresAt: "2026-10-12T17:00:00.000Z",
  };
  const base = {
    site_id: "site-one",
    account_id: "account-old",
    environment: "sandbox",
  };
  const recoveryHash = "b".repeat(64);
  const checkoutHash = createHash("sha256")
    .update(
      JSON.stringify([
        "gift-checkout-create-v1",
        "site-one",
        "checkout-request",
        "quote-one",
        recoveryHash,
      ]),
    )
    .digest("hex");
  const payload = {
    paymentId: "pay_one",
    checkoutId: "checkout-one",
    externalReference: "attempt-one",
  };
  const tables: Record<string, Array<Record<string, unknown>>> = {
    gift_order: [
      {
        ...base,
        id: "order-one",
        quote_id: "quote-one",
        request_id: "checkout-request",
        request_hash: checkoutHash,
        recovery_token_hash: recoveryHash,
        created_at: "2026-10-12T16:55:10.000Z",
      },
    ],
    gift_quote_record: [
      {
        ...base,
        id: "quote-one",
        gift_id: "gift-one",
        destination_version: 1,
        method: "PIX",
        currency: "BRL",
        nominal_cents: 10000,
        commission_basis_points: 200,
        commission_cents: 200,
        processing_cents: 39,
        total_cents: 10239,
        policy_version: "pricing-original",
        snapshot,
        created_at: snapshot.createdAt,
        expires_at: snapshot.expiresAt,
      },
    ],
    receiving_account: [
      {
        id: "account-old",
        site_id: "site-one",
        environment: "sandbox",
        provider: "ASAAS",
        operator_user_id: "operator-old",
        operator_reference: "operator-original",
        account_reference: "provider-account-old",
        recipient_reference: "recipient-original",
        created_at: created,
        is_current: false,
        provider_account_state: "SUSPENDED",
      },
    ],
    receiving_destination: [
      {
        ...base,
        id: "destination-old",
        version: 1,
        bank_reference: "bank-original",
        created_at: "2026-10-12T16:01:00.000Z",
        is_current: false,
        bank_state: "REJECTED",
      },
    ],
    financial_operation: [
      {
        ...base,
        id: "account-operation",
        kind: "ACCOUNT_CREATE",
        state: "SUCCEEDED",
        request_id: nomination.requestId,
        request_hash: nomination.requestHash,
        request_snapshot: record,
        attempts: 1,
        lease_owner: "original-owner",
        lease_token: "original-token",
        lease_expires_at: "2026-10-12T16:01:00.000Z",
        provider_operation_reference: "provider-account-old",
        order_id: null,
        payment_id: null,
        withdrawal_intent_id: null,
        created_at: created,
        next_attempt_at: created,
        last_error_code: null,
      },
      {
        ...base,
        id: "attempt-one",
        order_id: "order-one",
        kind: "CHECKOUT_CREATE",
        state: "SUCCEEDED",
        request_id: "checkout-request",
        request_hash: checkoutHash,
        provider_operation_reference: "checkout-one",
        attempts: 1,
        lease_owner: "original-checkout-owner",
        lease_token: "attempt-one",
        lease_expires_at: "2026-10-12T16:55:40.000Z",
        request_snapshot: {
          version: 1,
          siteId: "site-one",
          accountId: "account-old",
          environment: "sandbox",
          quoteId: "quote-one",
          orderId: "order-one",
          attemptId: "attempt-one",
          requestId: "checkout-request",
        },
        created_at: "2026-10-12T16:55:10.000Z",
        updated_at: "2026-10-12T16:55:11.000Z",
      },
    ],
    gift_checkout_attempt: [
      {
        ...base,
        id: "attempt-one",
        order_id: "order-one",
        operation_id: "attempt-one",
        operation_kind: "CHECKOUT_CREATE",
        attempt_number: 1,
        provider_reference: "checkout-one",
        created_at: "2026-10-12T16:55:10.000Z",
      },
    ],
    gift_payment_record: [
      {
        ...base,
        id: "payment-one",
        order_id: "order-one",
        attempt_id: "attempt-one",
        provider_payment_reference: "pay_one",
        provider_status: "RECEIVED",
        verification_status: "VERIFIED",
        observed_at: "2026-10-12T17:04:30.000124Z",
        created_at: "2026-10-12T17:04:30.000123Z",
        currency: "BRL",
        gross_cents: 10239,
        processing_cents: 39,
        commission_cents: 200,
        recipient_net_cents: 10000,
        split_provider_reference: "split-one",
        split_fixed_cents: 200,
      },
    ],
    financial_event_inbox: [
      {
        ...base,
        id: "event-one",
        provider_event_reference: "evt_one",
        event_type: "PAYMENT_RECEIVED",
        payload_hash: hashAsaasEventIdentity(
          "evt_one",
          "PAYMENT_RECEIVED",
          "provider-account-old",
          payload,
        ),
        payload,
        received_at: "2026-10-12T17:04:00.000123Z",
        authenticated_at: "2026-10-12T17:04:00.000123Z",
        processed_at: "2026-10-12T17:05:00.000123Z",
        payment_id: "payment-one",
        state: "PROCESSED",
      },
    ],
    financial_ledger_entry: [
      {
        ...base,
        id: "effect-one",
        effect_key: giftReceivedEffectKey("pay_one"),
        kind: "GIFT_RECEIVED",
        direction: "CREDIT",
        currency: "BRL",
        amount_cents: 10000,
        payment_id: "payment-one",
        operation_id: "attempt-one",
        event_id: "event-one",
        compensates_entry_id: null,
        created_at: "2026-10-12T17:05:00.000123Z",
      },
    ],
  };
  const state = {
    clock: "2026-10-13T14:00:00.000123Z",
    active: true,
    membership: true,
    role: "SITE_ADMIN",
    membershipId: "membership-one",
    changeOnCommit: false,
    pauseClock: null as Promise<void> | null,
    loseCommit: false,
    onCommit: null as (() => void) | null,
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      expect(text).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\b/i);
      if (/^begin|^rollback/i.test(text)) return { rows: [] };
      if (/^commit/i.test(text)) {
        state.onCommit?.();
        if (state.changeOnCommit) state.membershipId = "membership-replaced";
        if (state.loseCommit) throw new Error("fictional-private-driver-cause");
        return { rows: [] };
      }
      if (/FROM "session" se/.test(text))
        return {
          rows: state.active
            ? [
                {
                  userId: "viewer-one",
                  sessionId: "session-one",
                  role: state.role,
                  state: "ACTIVE",
                  expiresAt: "2026-10-13T15:00:00Z",
                  createdAt: "2026-10-13T13:59:00Z",
                  lastActiveAt: "2026-10-13T13:59:00Z",
                  checkedAt: state.clock,
                },
              ]
            : [],
        };
      if (/FROM "user" u/.test(text))
        return {
          rows:
            state.membership || state.role === "OWNER"
              ? [
                  {
                    user_id: "viewer-one",
                    account_role: state.role,
                    account_state: "ACTIVE",
                    site_id: "site-one",
                    membership_id: state.membershipId,
                    membership_user_id: "viewer-one",
                    membership_role: "SITE_ADMIN",
                    revoked_at: null,
                  },
                ]
              : [],
        };
      if (/FROM "site" s/.test(text))
        return { rows: [{ id: "site-one", is_demo: false }] };
      if (/clock_timestamp/.test(text)) {
        if (state.pauseClock) await state.pauseClock;
        return { rows: [{ clock: state.clock }] };
      }
      const table = text.match(/FROM "([^"]+)"/)?.[1];
      if (table && tables[table]) {
        let rows = structuredClone(tables[table]);
        if (table === "gift_order") {
          rows = rows.filter(
            (row) =>
              row.site_id === "site-one" && row.environment === "sandbox",
          );
          const compact = text.replace(/\s/g, "");
          const originalId = compact.match(/o\.id=\$(\d+)/);
          if (originalId)
            rows = rows.filter(
              (row) => row.id === params[Number(originalId[1]) - 1],
            );
          const keyset = compact.match(/1000000\)<\$(\d+)/);
          if (keyset) {
            const at = BigInt(String(params[Number(keyset[1]) - 1]));
            const originalId = compact.match(/o\.idCOLLATE"C"<\$(\d+)/);
            if (!originalId)
              throw new Error("missing synthetic keyset identity");
            const afterId = String(params[Number(originalId[1]) - 1]);
            rows = rows.filter((row) => {
              const created = databaseTimestampEpochMicroseconds(
                String(row.created_at),
              );
              return (
                created < at || (created === at && String(row.id) < afterId)
              );
            });
          }
          rows.sort((a, b) => {
            const left = databaseTimestampEpochMicroseconds(
              String(a.created_at),
            );
            const right = databaseTimestampEpochMicroseconds(
              String(b.created_at),
            );
            return left === right
              ? String(a.id) < String(b.id)
                ? 1
                : String(a.id) > String(b.id)
                  ? -1
                  : 0
              : left < right
                ? 1
                : -1;
          });
          const limit = text.match(/LIMIT \$(\d+)/);
          if (limit) rows = rows.slice(0, Number(params[Number(limit[1]) - 1]));
        }
        if (table === "receiving_account")
          rows = rows.map(
            ({
              id,
              site_id,
              environment,
              provider,
              operator_user_id,
              operator_reference,
              account_reference,
              recipient_reference,
              created_at,
            }) => ({
              id,
              site_id,
              environment,
              provider,
              operator_user_id,
              operator_reference,
              account_reference,
              recipient_reference,
              created_at,
            }),
          );
        if (table === "financial_operation")
          rows = rows.map((row) => ({
            ...row,
            nomination:
              (row.request_snapshot as Record<string, unknown>)?.nomination ??
              null,
            provision:
              (row.request_snapshot as Record<string, unknown>)?.provision ??
              null,
            provisioning_version:
              (row.request_snapshot as Record<string, unknown>)?.version ??
              null,
            sealed_present: false,
          }));
        return { rows: rows.map((record) => ({ record })) };
      }
      throw new Error("unexpected synthetic query");
    },
  );
  const db = drizzle({ query } as unknown as NodePgClient);
  const module = await import("./giftPaymentHistoryRepository");
  const options = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    policy: "SITE_HISTORY" as const,
    now: () => new Date("2026-10-13T14:00:00.000Z"),
  };
  const repository = module.createGiftPaymentHistoryRepository(db, options);
  return { repository, module, db, options, scope, tables, queries, state };
}
function seedIndex(v: Awaited<ReturnType<typeof fixture>>, count: number) {
  const order = v.tables.gift_order[0];
  const quote = v.tables.gift_quote_record[0];
  v.tables.gift_order = [];
  v.tables.gift_quote_record = [];
  for (let index = 0; index < count; index++) {
    const suffix = String(index).padStart(3, "0");
    const snapshot = structuredClone(quote.snapshot) as {
      quote: { id: string };
    };
    snapshot.quote.id = `quote-${suffix}`;
    v.tables.gift_quote_record.push({
      ...quote,
      id: snapshot.quote.id,
      snapshot,
    });
    v.tables.gift_order.push({
      ...order,
      id: `order-${suffix}`,
      quote_id: snapshot.quote.id,
      request_id: `request-${suffix}`,
      created_at: "2026-10-12T16:55:10.000123Z",
    });
  }
}
describe("bounded historical purchase stored reader", () => {
  it("preserves recipient-deducted frozen pricing and the actual recipient credit in private history", async () => {
    const v = await fixture();
    const stored = v.tables.gift_quote_record[0];
    const snapshot = stored.snapshot as {
      quote: Record<string, unknown>;
      pricing: { policy: Record<string, unknown> };
    };
    Object.assign(snapshot.quote, {
      totalCents: 10000,
      feeAllocation: "RECIPIENT_DEDUCTED",
    });
    snapshot.pricing.policy.feeAllocation = "RECIPIENT_DEDUCTED";
    stored.total_cents = 10000;
    Object.assign(v.tables.gift_payment_record[0], {
      gross_cents: 10000,
      processing_cents: 99,
      recipient_net_cents: 9701,
    });
    v.tables.financial_ledger_entry[0].amount_cents = 9701;
    const frozen = structuredClone(snapshot);
    const page = await v.repository.readPurchasePage(v.scope, null);
    expect(page.history.items[0].quoted).toEqual({
      nominalCents: 10000,
      totalCents: 10000,
      commissionCents: 200,
      processingCents: 39,
      feeAllocation: "RECIPIENT_DEDUCTED",
    });
    const detail = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(detail.history.originalPurchase.quoted).toEqual(
      page.history.items[0].quoted,
    );
    expect(
      detail.history.validatedHistoricalReceipts[0].recipientCreditCents,
    ).toBe(9701);
    expect(snapshot).toEqual(frozen);
    await v.repository.close();
  });

  it("reads index and detail for a native OWNER without membership, preserving public DTOs", async () => {
    const v = await fixture();
    v.state.role = "OWNER";
    v.state.membership = false;
    const scope = { ...v.scope, membershipId: null };
    const page = await v.repository.readPurchasePage(scope, null);
    expect(page.history.items).toHaveLength(1);
    const detail = await v.repository.readPurchaseDetailPage(
      scope,
      "order-one",
      null,
    );
    expect(detail.history.originalPurchase.orderId).toBe("order-one");
    expect(detail.history.scope).not.toHaveProperty("membershipId");
    await v.repository.close();
  });

  it.each([
    "revoked-session",
    "demoted-owner",
    "disabled-membership-owner-claim",
  ] as const)(
    "revalidates native OWNER scope after transaction settlement (%s)",
    async (fault) => {
      const v = await fixture();
      v.state.role = "OWNER";
      v.state.membership = false;
      v.state.onCommit = () => {
        if (fault === "revoked-session") v.state.active = false;
        else
          v.state.role =
            fault === "demoted-owner" ? "SITE_ASSISTANT" : "SITE_ADMIN";
      };
      await expect(
        v.repository.readPurchasePage({ ...v.scope, membershipId: null }, null),
      ).rejects.toThrow("Purchase history unavailable");
      expect(v.queries.some((query) => /^begin/i.test(query.sql))).toBe(true);
      await v.repository.close();
    },
  );
  it("accepts a receipt event processed after the credit at exact microsecond precision", async () => {
    const v = await fixture();
    v.tables.financial_event_inbox[0].processed_at =
      "2026-10-12T17:05:00.000124Z";
    const reply = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(reply.history.validatedHistoricalReceipts).toHaveLength(1);
    expect(reply.history.validatedHistoricalReceipts[0].postedAtMicros).toBe(
      "1791824700000123",
    );
    await v.repository.close();
  });
  it.each(["CHECKOUT_CREATED", "CHECKOUT_PAID"])(
    "retains a canonical received credit beside its authenticated %s event without a native payment ID",
    async (eventType) => {
      const v = await fixture();
      const payload = {
        checkoutId: "checkout-one",
        externalReference: "attempt-one",
      };
      v.tables.financial_event_inbox.push({
        ...v.tables.financial_event_inbox[0],
        id: "checkout-event",
        event_type: eventType,
        provider_event_reference: "evt_checkout",
        payment_id: null,
        payload,
        payload_hash: hashAsaasEventIdentity(
          "evt_checkout",
          eventType,
          "provider-account-old",
          payload,
        ),
      });
      const reply = await v.repository.readPurchaseDetailPage(
        v.scope,
        "order-one",
        null,
      );
      expect(reply.history.retainedPayments).toHaveLength(1);
      expect(reply.history.validatedHistoricalReceipts).toEqual([
        expect.objectContaining({ recipientCreditCents: 10000 }),
      ]);
      expect(reply.history.coverage.receipts).toBe("AVAILABLE");
      await v.repository.close();
    },
  );
  it.each([
    "missing-checkout",
    "malformed-checkout",
    "unknown-payload-key",
    "invalid-hash",
    "missing-authentication",
    "missing-payment-on-receipt",
    "unsupported-checkout",
  ])("rejects invalid correlated event evidence: %s", async (fault) => {
    const v = await fixture();
    const eventType =
      fault === "missing-payment-on-receipt"
        ? "PAYMENT_RECEIVED"
        : fault === "unsupported-checkout"
          ? "CHECKOUT_UNKNOWN"
          : "CHECKOUT_PAID";
    const payload: Record<string, string> = {
      checkoutId: "checkout-one",
      externalReference: "attempt-one",
    };
    if (fault === "missing-checkout") delete payload.checkoutId;
    if (fault === "malformed-checkout") payload.checkoutId = "not a reference";
    if (fault === "unknown-payload-key") payload.unexpected = "value";
    v.tables.financial_event_inbox.push({
      ...v.tables.financial_event_inbox[0],
      id: "checkout-event",
      event_type: eventType,
      provider_event_reference: "evt_checkout",
      payment_id: null,
      authenticated_at:
        fault === "missing-authentication"
          ? null
          : v.tables.financial_event_inbox[0].authenticated_at,
      payload,
      payload_hash:
        fault === "invalid-hash"
          ? "0".repeat(64)
          : hashAsaasEventIdentity(
              "evt_checkout",
              eventType,
              "provider-account-old",
              payload,
            ),
    });
    await expect(
      v.repository.readPurchaseDetailPage(v.scope, "order-one", null),
    ).rejects.toThrow("Purchase history unavailable");
    await v.repository.close();
  });
  it("rejects a receipt event processed before the credit by one microsecond", async () => {
    const v = await fixture();
    v.tables.financial_event_inbox[0].processed_at =
      "2026-10-12T17:05:00.000122Z";
    await expect(
      v.repository.readPurchaseDetailPage(v.scope, "order-one", null),
    ).rejects.toThrow("Purchase history unavailable");
    await v.repository.close();
  });
  it("rejects credit before its authenticated receipt evidence by one microsecond", async () => {
    const v = await fixture();
    v.tables.financial_event_inbox[0].authenticated_at =
      "2026-10-12T17:05:00.000124Z";
    v.tables.financial_event_inbox[0].processed_at =
      "2026-10-12T17:05:00.000125Z";
    await expect(
      v.repository.readPurchaseDetailPage(v.scope, "order-one", null),
    ).rejects.toThrow("Purchase history unavailable");
    await v.repository.close();
  });
  it.each([
    [
      "attempts0",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_operation[1].attempts = 0;
      },
    ],
    [
      "attempt2",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.gift_checkout_attempt[0].attempt_number = 2;
      },
    ],
    [
      "missing retained lease",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_operation[1].lease_owner = null;
        v.tables.financial_operation[1].lease_token = null;
        v.tables.financial_operation[1].lease_expires_at = null;
      },
    ],
    [
      "wrong retained lease token",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_operation[1].lease_token = "different-attempt";
      },
    ],
    [
      "empty original lease owner",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_operation[1].lease_owner = "";
      },
    ],
    [
      "success beyond original lease fence",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_operation[1].lease_expires_at =
          "2026-10-12T16:55:10.999999Z";
      },
    ],
  ])(
    "rejects unsupported original producer %s before receipt projection",
    async (_name, change) => {
      const v = await fixture();
      change(v);
      await expect(
        v.repository.readPurchaseDetailPage(v.scope, "order-one", null),
      ).rejects.toThrow("Purchase history unavailable");
      await v.repository.close();
    },
  );
  it("bounds the index to25 and navigates exact scoped original microsecond positions", async () => {
    const v = await fixture();
    seedIndex(v, 26);
    const first = await v.repository.readPurchasePage(v.scope, null);
    expect(first.history.items).toHaveLength(25);
    expect(first.history.items[0].orderId).toBe("order-025");
    expect(first.history.items[24].orderId).toBe("order-001");
    expect(first.history.items[24].purchasedAtMicros).toBe("1791824110000123");
    const cursor = first.history.nextCursor;
    expect(cursor).not.toBeNull();
    const next = await v.repository.readPurchasePage(v.scope, cursor);
    expect(next.history.items.map((row) => row.orderId)).toEqual(["order-000"]);
    expect(next.history.nextCursor).toBeNull();
    await expect(
      v.repository.readPurchaseDetailPage(v.scope, "order-001", cursor),
    ).rejects.toThrow("Purchase history unavailable");
    const anchor = v.tables.gift_order.find((row) => row.id === "order-001");
    if (!anchor) throw new Error("missing original synthetic cursor position");
    anchor.created_at = "2026-10-12T16:55:10.000124Z";
    await expect(
      v.repository.readPurchasePage(v.scope, cursor),
    ).rejects.toThrow("Purchase history unavailable");
    v.tables.gift_order = v.tables.gift_order.filter(
      (row) => row.id !== "order-001",
    );
    await expect(
      v.repository.readPurchasePage(v.scope, cursor),
    ).rejects.toThrow("Purchase history unavailable");
    await v.repository.close();
  });
  it("validates the26th original purchase before issuing a25-row index cursor", async () => {
    const v = await fixture();
    seedIndex(v, 26);
    v.tables.gift_quote_record[0].total_cents = 10240;
    await expect(v.repository.readPurchasePage(v.scope, null)).rejects.toThrow(
      "Purchase history unavailable",
    );
    await v.repository.close();
  });
  it("preserves a recorded pre-dispatch expired order without applying current quote eligibility", async () => {
    const v = await fixture();
    v.tables.gift_order[0].created_at = "2026-10-12T17:01:00.000Z";
    v.tables.financial_operation[1].state = "CANCELLED";
    v.tables.financial_operation[1].created_at = "2026-10-12T17:01:00.000Z";
    const reply = await v.repository.readPurchasePage(v.scope, null);
    expect(reply.history.items[0].orderId).toBe("order-one");
    expect(reply.history.currentKnowledge).toBe("UNKNOWN");
    await v.repository.close();
  });
  it("reads the archived original purchase without current READY, recipient, publication or repricing", async () => {
    const v = await fixture();
    const reply = await v.repository.readPurchasePage(v.scope, null);
    expect(reply.history.items).toHaveLength(1);
    expect(reply.history.items[0]).toMatchObject({
      orderId: "order-one",
      titleSnapshot: "Original archived gift",
      destinationVersion: 1,
      binding: "AVAILABLE",
      quoted: { nominalCents: 10000, totalCents: 10239 },
    });
    expect(reply.history).toMatchObject({
      consistency: "PER_READ",
      currentKnowledge: "UNKNOWN",
      sourceOrdering: "UNAVAILABLE",
    });
    expect(
      v.queries.some((q) => /begin.*repeatable read.*read only/i.test(q.sql)),
    ).toBe(true);
    expect(v.queries.map((q) => q.sql).join(" ")).not.toMatch(
      /credential|FOR UPDATE/i,
    );
    await v.repository.close();
  });
  it("validates the original complete receipt chain and preserves exact independent microseconds", async () => {
    const v = await fixture();
    const reply = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(reply.history.validatedHistoricalReceipts).toEqual([
      {
        effectId: "effect-one",
        paymentId: "payment-one",
        orderId: "order-one",
        currency: "BRL",
        recipientCreditCents: 10000,
        postedAtMicros: "1791824700000123",
        sourceObservedAtMicros: "1791824670000124",
        source: "CORRELATED_STORED_POSTING",
      },
    ]);
    expect(reply.history.retainedPayments[0].createdAtMicros).toBe(
      "1791824670000123",
    );
    expect(reply.history.coverage).toEqual({
      payments: "AVAILABLE",
      receipts: "AVAILABLE",
      reversals: "UNAVAILABLE",
      bankSettlement: "UNAVAILABLE",
    });
    for (const privateValue of [
      "provider-account-old",
      "operator-old",
      "recipient-original",
      "pay_one",
      "evt_one",
      "original-token",
    ])
      expect(JSON.stringify(reply)).not.toContain(privateValue);
    await v.repository.close();
  });

  it.each([
    [99, 9940],
    [0, 10039],
  ])(
    "retains the actual provider fee %i and validated recipient credit %i",
    async (fee, net) => {
      const v = await fixture();
      v.tables.gift_payment_record[0].processing_cents = fee;
      v.tables.gift_payment_record[0].recipient_net_cents = net;
      v.tables.financial_ledger_entry[0].amount_cents = net;
      const reply = await v.repository.readPurchaseDetailPage(
        v.scope,
        "order-one",
        null,
      );
      expect(reply.history.validatedHistoricalReceipts).toEqual([
        expect.objectContaining({ recipientCreditCents: net }),
      ]);
      expect(reply.history.coverage.receipts).toBe("AVAILABLE");
      await v.repository.close();
    },
  );
  it.each(["session", "membership", "role", "scope"] as const)(
    "current %s denial admits no stored transaction",
    async (fault) => {
      const v = await fixture();
      if (fault === "session") v.state.active = false;
      if (fault === "membership") v.state.membership = false;
      if (fault === "role") v.state.role = "OWNER";
      const scope =
        fault === "scope"
          ? { ...v.scope, membershipId: "forged-membership" }
          : v.scope;
      await expect(v.repository.readPurchasePage(scope, null)).rejects.toThrow(
        "Purchase history unavailable",
      );
      expect(v.queries.some((q) => /^begin/i.test(q.sql))).toBe(false);
      await v.repository.close();
    },
  );
  it("independently rejects actual membership replacement after COMMIT rather than using the read snapshot", async () => {
    const v = await fixture();
    v.state.changeOnCommit = true;
    await expect(v.repository.readPurchasePage(v.scope, null)).rejects.toThrow(
      "Purchase history unavailable",
    );
    await v.repository.close();
  });
  it("event-less legacy credit is unavailable, never a receipt or a zero refund", async () => {
    const v = await fixture();
    v.tables.financial_ledger_entry[0].event_id = null;
    const reply = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(reply.history.currentKnowledge).toBe("UNAVAILABLE");
    expect(reply.history.coverage.receipts).toBe("UNAVAILABLE");
    expect(reply.history.validatedHistoricalReceipts).toEqual([]);
    await v.repository.close();
  });
  it("an original missing account producer remains UNBOUND without substituting the viewer", async () => {
    const v = await fixture();
    v.tables.financial_operation.shift();
    const reply = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(reply.history.originalPurchase.binding).toBe("UNBOUND");
    expect(reply.history.currentKnowledge).toBe("UNAVAILABLE");
    expect(reply.history.coverage.payments).toBe("UNAVAILABLE");
    expect(reply.history.retainedPayments).toEqual([]);
    expect(reply.history.validatedHistoricalReceipts).toEqual([]);
    await v.repository.close();
  });
  it.each([
    [
      "foreign original account",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.receiving_account[0].site_id = "foreign-site";
      },
    ],
    [
      "changed original quote",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.gift_quote_record[0].total_cents = 10240;
      },
    ],
    [
      "changed checkout hash",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_operation[1].request_hash = "c".repeat(64);
      },
    ],
    [
      "contradictory retained pre-dispatch rejection",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        const snapshot = v.tables.financial_operation[1]
          .request_snapshot as Record<string, unknown>;
        snapshot.preDispatchRejection = {
          source: "backend",
          kind: "PRE_DISPATCH_REJECTION",
          noProviderCall: true,
        };
      },
    ],
    [
      "foreign destination",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.receiving_destination[0].bank_reference = "different-bank";
      },
    ],
    [
      "changed original operator",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.receiving_account[0].operator_user_id = "viewer-one";
      },
    ],
    [
      "foreign payment",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.gift_payment_record[0].site_id = "foreign-site";
      },
    ],
    [
      "wrong actual allocation",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.gift_payment_record[0].recipient_net_cents = 9999;
      },
    ],
    [
      "wrong ledger amount",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_ledger_entry[0].amount_cents = 9999;
      },
    ],
    [
      "foreign event",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_event_inbox[0].environment = "live";
      },
    ],
    [
      "invalid event hash",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_event_inbox[0].payload_hash = "0".repeat(64);
      },
    ],
    [
      "event not processed",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_event_inbox[0].state = "RETRY";
      },
    ],
    [
      "future observation",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.gift_payment_record[0].observed_at =
          "2026-10-13T14:00:00.000124Z";
      },
    ],
    [
      "duplicate immutable effect",
      (v: Awaited<ReturnType<typeof fixture>>) => {
        v.tables.financial_ledger_entry.push({
          ...v.tables.financial_ledger_entry[0],
          id: "effect-duplicate",
        });
      },
    ],
  ])(
    "rejects %s before slice/projection and hides the private failure",
    async (_name, change) => {
      const v = await fixture();
      change(v);
      await expect(
        v.repository.readPurchaseDetailPage(v.scope, "order-one", null),
      ).rejects.toMatchObject({ message: "Purchase history unavailable" });
      await v.repository.close();
    },
  );
  it("retains the prior receipt beside a newly authenticated unresolved event", async () => {
    const v = await fixture();
    v.tables.financial_event_inbox.push({
      ...v.tables.financial_event_inbox[0],
      id: "event-later",
      provider_event_reference: "evt_later",
      payload_hash: hashAsaasEventIdentity(
        "evt_later",
        "PAYMENT_RECEIVED",
        "provider-account-old",
        v.tables.financial_event_inbox[0].payload as Record<string, string>,
      ),
      state: "RECEIVED",
      processed_at: null,
    });
    const reply = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(reply.history.currentKnowledge).toBe("UNKNOWN");
    expect(reply.history.validatedHistoricalReceipts).toHaveLength(1);
    await v.repository.close();
  });
  it("serves at most50 combined facts and validates beyond the issued cursor before slicing", async () => {
    const v = await fixture();
    for (let index = 0; index < 55; index++)
      v.tables.gift_payment_record.push({
        ...v.tables.gift_payment_record[0],
        id: `payment-extra-${index.toString().padStart(2, "0")}`,
        provider_payment_reference: `pay_extra_${index}`,
        provider_status: null,
        verification_status: "UNVERIFIED",
        observed_at: null,
        gross_cents: null,
        processing_cents: null,
        commission_cents: null,
        recipient_net_cents: null,
        split_provider_reference: null,
        split_fixed_cents: null,
      });
    const first = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      null,
    );
    expect(
      first.history.retainedPayments.length +
        first.history.validatedHistoricalReceipts.length,
    ).toBe(50);
    expect(first.history.nextCursor).toBeTruthy();
    const second = await v.repository.readPurchaseDetailPage(
      v.scope,
      "order-one",
      first.history.nextCursor,
    );
    expect(
      second.history.retainedPayments.length +
        second.history.validatedHistoricalReceipts.length,
    ).toBe(7);
    v.tables.financial_event_inbox[0].payload_hash = "d".repeat(64);
    await expect(
      v.repository.readPurchaseDetailPage(
        v.scope,
        "order-one",
        first.history.nextCursor,
      ),
    ).rejects.toThrow();
    await v.repository.close();
  });
  it("a foreign/stale navigation cursor never grants authority or creates a financial revision", async () => {
    const v = await fixture();
    await expect(
      v.repository.readPurchasePage(v.scope, "opaque-but-not-issued"),
    ).rejects.toThrow("Purchase history unavailable");
    await v.repository.close();
  });
  it("close drains the actual pending read-only transaction and refuses late exposure", async () => {
    const v = await fixture();
    let release!: () => void;
    v.state.pauseClock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = v.repository.readPurchasePage(v.scope, null);
    await vi.waitFor(() =>
      expect(v.queries.some((q) => /^begin/i.test(q.sql))).toBe(true),
    );
    let closed = false;
    const close = v.repository.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(v.queries.some((q) => /^commit|^rollback/i.test(q.sql))).toBe(false);
    release();
    await expect(read).rejects.toThrow("Purchase history unavailable");
    await close;
    expect(v.queries.some((q) => /^commit/i.test(q.sql))).toBe(true);
    await expect(v.repository.readPurchasePage(v.scope, null)).rejects.toThrow(
      "Purchase history unavailable",
    );
  });
  it("lost read-only COMMIT acknowledgment is unavailable without retry or leaking the driver cause", async () => {
    const v = await fixture();
    v.state.loseCommit = true;
    await expect(v.repository.readPurchasePage(v.scope, null)).rejects.toThrow(
      "Purchase history unavailable",
    );
    expect(v.queries.filter((q) => /^begin/i.test(q.sql))).toHaveLength(1);
    await v.repository.close();
  });
});
