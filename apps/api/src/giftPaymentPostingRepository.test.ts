import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import { hashAsaasEventIdentity } from "./asaasWebhook";
import {
  createGiftPaymentPostingRepository,
  type GiftPaymentPostingInput,
  type GiftPaymentPostingOptions,
} from "./giftPaymentPostingRepository";
import type { GiftQuoteSnapshot } from "./giftQuotes";

const time = new Date("2026-10-12T17:05:00.000Z");
const scope = {
  siteId: "site-one",
  accountId: "account-one",
  environment: "sandbox" as const,
};

function quoteSnapshot(): GiftQuoteSnapshot {
  const receiving = {
    siteId: scope.siteId,
    environment: scope.environment,
    provider: "ASAAS",
    operatorReference: "operator-one",
    accountReference: "provider-account-one",
    recipientReference: "recipient-one",
    bankReference: "bank-one",
    destinationVersion: 1,
  };
  return {
    quote: {
      id: "quote-one",
      siteId: scope.siteId,
      giftId: "gift-one",
      title: "A contribution",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10_000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 39,
      totalCents: 10_239,
      policyVersion: "test-policy-one",
      mode: "sandbox",
      expiresAt: "2026-10-12T17:00:00.000Z",
    },
    gift: {
      id: "gift-one",
      siteId: scope.siteId,
      title: "A contribution",
      description: "",
      currency: "BRL",
      nominalCents: 10_000,
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
        version: "test-policy-one",
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
}

function fixture(rawTimestamps = false) {
  const snapshot = quoteSnapshot();
  const payload = {
    paymentId: "pay_one",
    checkoutId: "checkout-one",
    externalReference: "attempt-one",
  };
  const inbox = {
    ...scope,
    id: "event-one",
    providerEventReference: "evt_one",
    eventType: "PAYMENT_RECEIVED",
    payload,
    payloadHash: hashAsaasEventIdentity(
      "evt_one",
      "PAYMENT_RECEIVED",
      "provider-account-one",
      payload,
    ),
    receivedAt: new Date("2026-10-12T17:04:00.000Z"),
    authenticatedAt: new Date("2026-10-12T17:04:00.000Z"),
    paymentId: null as string | null,
    state: "CLAIMED",
    leaseOwner: "worker-one",
    leaseToken: "original-claim-one",
    leaseExpiresAt: new Date("2026-10-12T17:06:00.000Z"),
    processedAt: null as Date | null,
    nextAttemptAt: new Date("2026-10-12T17:04:00.000Z"),
    lastErrorCode: null as string | null,
  };
  const binding = {
    ...scope,
    quoteId: snapshot.quote.id,
    orderId: "order-one",
    attemptId: "attempt-one",
    operationId: "attempt-one",
    operationKind: "CHECKOUT_CREATE",
    operationState: "SUCCEEDED",
    provider: "ASAAS",
    accountReference: "provider-account-one",
    providerCheckoutReference: "checkout-one",
    providerOperationReference: "checkout-one",
    snapshot,
    orderCreatedAt: new Date("2026-10-12T16:55:10.000Z"),
    destinationVersion: 1,
    giftId: "gift-one",
    method: "PIX",
    currency: "BRL",
    nominalCents: 10_000,
    commissionBasisPoints: 200,
    commissionCents: 200,
    processingCents: 39,
    totalCents: 10_239,
    policyVersion: "test-policy-one",
    quoteCreatedAt: new Date(snapshot.createdAt),
    quoteExpiresAt: new Date(snapshot.expiresAt),
  };
  const input: GiftPaymentPostingInput = {
    claim: {
      ...scope,
      eventId: "event-one",
      leaseOwner: "worker-one",
      leaseToken: "original-claim-one",
    },
    checkout: {
      ...scope,
      orderId: "order-one",
      attemptId: "attempt-one",
      accountReference: "provider-account-one",
      providerCheckoutReference: "checkout-one",
    },
    observation: {
      source: "provider",
      provider: "ASAAS",
      siteId: scope.siteId,
      accountReference: "provider-account-one",
      environment: "sandbox",
      currency: "BRL",
      observedAt: new Date("2026-10-12T17:04:30.000Z"),
      payment: {
        id: "pay_one",
        checkoutSession: "checkout-one",
        externalReference: "attempt-one",
        billingType: "PIX",
        status: "RECEIVED",
        value: "102.39",
        netValue: "102.00",
        split: [
          {
            id: "split-one",
            walletId: "platform-one",
            fixedValue: "2.00",
            totalValue: "2.00",
            status: "DONE",
          },
        ],
        customer: "payer-private-data",
        apiKey: "must-not-persist",
      },
    },
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    gift_payment_record: [],
    financial_ledger_entry: [],
    financial_event_inbox: [inbox],
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const faults = { failInsert: "", casMiss: false, commitAfterApplied: false };
  const clock = { value: new Date(time) };
  let before: typeof tables | null = null;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      if (/^begin/i.test(text)) {
        before = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(text)) {
        before = null;
        if (faults.commitAfterApplied)
          throw new Error("private SQL commit failure");
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
        if (before)
          for (const key of Object.keys(tables)) tables[key] = before[key];
        before = null;
        return { rows: [] };
      }
      if (/FROM "gift_order" o/i.test(text))
        return {
          rows: /INNER JOIN/i.test(text)
            ? [structuredClone(binding)]
            : [{ ...scope, orderId: "order-one" }],
        };
      if (/FROM "financial_event_inbox" e/i.test(text)) {
        const columns = Array.from(
          text.split(/FROM/i)[0].matchAll(/e\.([a-z_]+)(?: AS "([^"]+)")?/g),
          (match) =>
            match[2] ??
            match[1].replace(/_([a-z])/g, (_, letter: string) =>
              letter.toUpperCase(),
            ),
        );
        return {
          rows: tables.financial_event_inbox
            .filter((row) => params.includes(row.id))
            .map((row) =>
              Object.fromEntries(
                columns.map((column) => [column, row[column]]),
              ),
            ),
        };
      }
      if (/FROM "financial_ledger_entry" l/i.test(text)) {
        const direct = tables.financial_ledger_entry.filter((row) =>
          params.includes(row.paymentId),
        );
        return {
          rows: tables.financial_ledger_entry.filter(
            (row) =>
              direct.includes(row) ||
              direct.some((original) => row.compensatesEntryId === original.id),
          ),
        };
      }
      if (/FROM "gift_payment_record" p/i.test(text))
        return {
          rows: tables.gift_payment_record.filter((row) =>
            params.includes(row.providerPaymentReference),
          ),
        };
      const insert = text.match(
        /INSERT INTO "([a-z_]+)"\s*\((.*?)\)\s*VALUES\s*\((.*?)\)/is,
      );
      if (insert) {
        if (faults.failInsert === insert[1])
          throw new Error("private SQL insert failure");
        const columns = insert[2].split(",").map((column) =>
          column
            .trim()
            .replaceAll('"', "")
            .replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        );
        const values = insert[3].split(",").map((part) => {
          const match = part.match(/\$(\d+)/);
          return match ? params[Number(match[1]) - 1] : null;
        });
        const row = Object.fromEntries(
          columns.map((column, index) => [
            column,
            column.endsWith("At")
              ? new Date(values[index] as string)
              : values[index],
          ]),
        );
        if (insert[1] === "financial_ledger_entry") {
          row.compensatesEntryId = null;
          row.withdrawalIntentId = null;
        }
        const key =
          insert[1] === "gift_payment_record"
            ? "providerPaymentReference"
            : "effectKey";
        if (tables[insert[1]].some((existing) => existing[key] === row[key]))
          return { rows: [] };
        tables[insert[1]].push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/UPDATE "financial_event_inbox" e/i.test(text)) {
        const parameter = (column: string) => {
          const match = text.match(new RegExp(`e\\.${column} = \\$(\\d+)`));
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        const event = tables.financial_event_inbox.find(
          (row) =>
            row.id === parameter("id") &&
            row.siteId === parameter("site_id") &&
            row.accountId === parameter("account_id") &&
            row.environment === parameter("environment") &&
            row.leaseOwner === parameter("lease_owner") &&
            row.leaseToken === parameter("lease_token") &&
            row.state === "CLAIMED",
        );
        if (
          !event ||
          faults.casMiss ||
          (event.leaseExpiresAt as Date).getTime() < clock.value.getTime()
        )
          return { rows: [] };
        event.state = /SET state = 'RETRY'/i.test(text) ? "RETRY" : "PROCESSED";
        for (const column of ["payment_id", "processed_at"]) {
          const match = text.match(new RegExp(`${column} = \\$(\\d+)`));
          if (match)
            event[column === "payment_id" ? "paymentId" : "processedAt"] =
              column === "payment_id"
                ? params[Number(match[1]) - 1]
                : new Date(params[Number(match[1]) - 1] as string);
        }
        for (const column of ["next_attempt_at", "last_error_code"]) {
          const match = text.match(new RegExp(`${column} = \\$(\\d+)`));
          if (match)
            event[
              column === "next_attempt_at" ? "nextAttemptAt" : "lastErrorCode"
            ] =
              column === "next_attempt_at"
                ? new Date(params[Number(match[1]) - 1] as string)
                : params[Number(match[1]) - 1];
        }
        return { rows: [{ id: event.id }] };
      }
      if (/UPDATE "gift_payment_record" p/i.test(text)) {
        const parameter = (column: string) => {
          const match = text.match(new RegExp(`p\\.${column} = \\$(\\d+)`));
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        const payment = tables.gift_payment_record.find(
          (row) =>
            row.id === parameter("id") &&
            row.siteId === parameter("site_id") &&
            row.accountId === parameter("account_id") &&
            row.environment === parameter("environment") &&
            row.orderId === parameter("order_id") &&
            row.attemptId === parameter("attempt_id") &&
            row.providerPaymentReference ===
              parameter("provider_payment_reference"),
        );
        if (!payment) return { rows: [] };
        for (const column of [
          "provider_status",
          "verification_status",
          "observed_at",
          "currency",
          "gross_cents",
          "processing_cents",
          "commission_cents",
          "recipient_net_cents",
          "split_provider_reference",
          "split_fixed_cents",
        ]) {
          const match = text.match(
            new RegExp(`(?:SET|,)\\s*${column} = \\$(\\d+)`),
          );
          if (match)
            payment[
              column.replace(/_([a-z])/g, (_, letter: string) =>
                letter.toUpperCase(),
              )
            ] =
              column === "observed_at"
                ? new Date(params[Number(match[1]) - 1] as string)
                : params[Number(match[1]) - 1];
        }
        return { rows: [{ id: payment.id }] };
      }
      throw new Error(`Unexpected fixture query: ${text}`);
    },
  );
  const options: GiftPaymentPostingOptions = {
    environment: "sandbox",
    platformWalletId: "platform-one",
    retryDelayMs: 30_000,
    now: () => new Date(clock.value),
    generateId: vi.fn((kind) => `${kind}-local-one`),
  };
  return {
    input,
    binding,
    tables,
    queries,
    faults,
    clock,
    options,
    db: drizzle({
      query: async (...args: Parameters<typeof query>) => {
        const result = await query(...args);
        if (!rawTimestamps) return result;
        return {
          ...result,
          rows: result.rows.map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([key, value]) => [
                key,
                value instanceof Date
                  ? value.toISOString().replace("T", " ").replace("Z", "+00")
                  : value,
              ]),
            ),
          ),
        };
      },
    } as unknown as NodePgClient),
    query,
  };
}

describe("gift payment receipt posting repository", () => {
  it("consumes confirmed payments as awaiting release without creating a receipt or ledger credit", async () => {
    const values = fixture();
    const event = values.tables.financial_event_inbox[0];
    event.eventType = "PAYMENT_CONFIRMED";
    event.payloadHash = hashAsaasEventIdentity(
      String(event.providerEventReference),
      "PAYMENT_CONFIRMED",
      "provider-account-one",
      event.payload as Record<string, string>,
    );
    (values.input.observation.payment as Record<string, unknown>).status =
      "CONFIRMED";
    const result = await createGiftPaymentPostingRepository(
      values.db,
      values.options,
    ).postReceivedPayment(values.input);
    expect(result.outcome).toBe("OBSERVED");
    expect(values.tables.financial_event_inbox[0]).toMatchObject({
      state: "PROCESSED",
    });
    expect(values.tables.gift_payment_record[0]).toMatchObject({
      providerStatus: "CONFIRMED",
      recipientNetCents: 10000,
    });
    expect(values.tables.financial_ledger_entry).toEqual([]);
  });

  it("posts and recovers one actual receipt using raw Drizzle timestamp strings", async () => {
    const v = fixture(true);
    const repository = createGiftPaymentPostingRepository(v.db, v.options);
    expect((await repository.postReceivedPayment(v.input)).outcome).toBe(
      "POSTED",
    );
    expect((await repository.postReceivedPayment(v.input)).outcome).toBe(
      "DUPLICATE",
    );
    expect(v.tables.financial_ledger_entry).toHaveLength(1);
  });

  it("rejects sub-millisecond divergence in stored immutable quote expiry", async () => {
    const v = fixture(true);
    v.binding.quoteExpiresAt = v.binding.quoteExpiresAt
      .toISOString()
      .replace("T", " ")
      .replace(".000Z", ".000001+00") as unknown as Date;
    await expect(
      createGiftPaymentPostingRepository(v.db, v.options).postReceivedPayment(
        v.input,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    expect(v.tables.financial_ledger_entry).toHaveLength(0);
  });
  it.each(["CONFIRMED", "RECEIVED"])(
    "persists actual fee allocation once for %s without changing the buyer quote",
    async (status) => {
      const values = fixture();
      const quote = values.binding.snapshot.quote;
      Object.assign(quote, {
        nominalCents: 1000,
        commissionCents: 20,
        processingCents: 0,
        totalCents: 1020,
      });
      values.binding.snapshot.gift.nominalCents = 1000;
      values.binding.snapshot.pricing.policy.processingFixedCents = 0;
      Object.assign(values.binding, {
        nominalCents: 1000,
        commissionCents: 20,
        processingCents: 0,
        totalCents: 1020,
      });
      const raw = values.input.observation.payment as Record<string, unknown>;
      Object.assign(raw, { status, value: "10.20", netValue: "9.21" });
      Object.assign((raw.split as Record<string, unknown>[])[0], {
        fixedValue: "0.20",
        totalValue: "0.20",
      });
      const event = values.tables.financial_event_inbox[0];
      event.eventType =
        status === "RECEIVED" ? "PAYMENT_RECEIVED" : "PAYMENT_CONFIRMED";
      event.payloadHash = hashAsaasEventIdentity(
        String(event.providerEventReference),
        String(event.eventType),
        "provider-account-one",
        event.payload as Record<string, string>,
      );
      const frozenQuote = structuredClone(quote);
      const repository = createGiftPaymentPostingRepository(
        values.db,
        values.options,
      );
      expect((await repository.postReceivedPayment(values.input)).outcome).toBe(
        status === "RECEIVED" ? "POSTED" : "OBSERVED",
      );
      expect(values.tables.gift_payment_record[0]).toMatchObject({
        grossCents: 1020,
        processingCents: 99,
        recipientNetCents: 901,
        splitFixedCents: 20,
      });
      expect(event.state).toBe("PROCESSED");
      expect((await repository.postReceivedPayment(values.input)).outcome).toBe(
        "DUPLICATE",
      );
      expect(values.tables.financial_ledger_entry).toEqual(
        status === "RECEIVED"
          ? [
              expect.objectContaining({
                kind: "GIFT_RECEIVED",
                amountCents: 901,
              }),
            ]
          : [],
      );
      expect(values.binding.snapshot.quote).toEqual(frozenQuote);
    },
  );

  it("posts the actual verified allocation, one receipt and the correlated event atomically", async () => {
    const values = fixture();
    const result = await createGiftPaymentPostingRepository(
      values.db,
      values.options,
    ).postReceivedPayment(values.input);
    expect(result).toEqual({
      outcome: "POSTED",
      paymentId: "payment-local-one",
      ledgerEntryId: "ledger-local-one",
    });
    expect(values.tables.gift_payment_record).toEqual([
      expect.objectContaining({
        ...scope,
        id: "payment-local-one",
        orderId: "order-one",
        attemptId: "attempt-one",
        providerPaymentReference: "pay_one",
        providerStatus: "RECEIVED",
        verificationStatus: "VERIFIED",
        grossCents: 10_239,
        processingCents: 39,
        commissionCents: 200,
        recipientNetCents: 10_000,
        splitFixedCents: 200,
        splitProviderReference: "split-one",
      }),
    ]);
    expect(values.tables.financial_ledger_entry).toEqual([
      expect.objectContaining({
        ...scope,
        kind: "GIFT_RECEIVED",
        direction: "CREDIT",
        amountCents: 10_000,
        currency: "BRL",
        paymentId: "payment-local-one",
        operationId: "attempt-one",
        eventId: "event-one",
      }),
    ]);
    expect(values.tables.financial_event_inbox[0]).toMatchObject({
      state: "PROCESSED",
      paymentId: "payment-local-one",
      processedAt: time,
      leaseOwner: "worker-one",
      leaseToken: "original-claim-one",
    });
    const orderLock = values.queries.findIndex((entry) =>
      /FROM "gift_order" o[\s\S]*FOR UPDATE/i.test(entry.sql),
    );
    const insert = values.queries.findIndex((entry) =>
      /INSERT INTO/i.test(entry.sql),
    );
    expect(orderLock).toBeGreaterThan(0);
    expect(insert).toBeGreaterThan(orderLock);
    const cas = values.queries.find((entry) =>
      /UPDATE "financial_event_inbox"/i.test(entry.sql),
    );
    expect(cas?.sql).toMatch(/lease_expires_at >= clock_timestamp\(\)/);
    expect(cas?.params).toContain("original-claim-one");
    expect(cas?.params).toContain("worker-one");
    expect(values.queries.at(-1)?.sql).toBe("commit");
    expect(JSON.stringify(values.tables)).not.toMatch(
      /payer-private-data|must-not-persist/,
    );
  });
});

describe("gift payment posting recovery and fences", () => {
  it.each(["attempt.1", "attempt:1"])(
    "posts valid C1 local correlation %s",
    async (attemptId) => {
      const values = fixture();
      values.binding.attemptId = attemptId;
      values.binding.operationId = attemptId;
      values.input.checkout.attemptId = attemptId;
      (
        values.input.observation.payment as Record<string, unknown>
      ).externalReference = attemptId;
      const event = values.tables.financial_event_inbox[0];
      (event.payload as Record<string, string>).externalReference = attemptId;
      event.payloadHash = hashAsaasEventIdentity(
        "evt_one",
        "PAYMENT_RECEIVED",
        "provider-account-one",
        event.payload as Record<string, string>,
      );
      const repository = createGiftPaymentPostingRepository(
        values.db,
        values.options,
      );
      expect((await repository.postReceivedPayment(values.input)).outcome).toBe(
        "POSTED",
      );
      expect(values.tables.financial_ledger_entry).toHaveLength(1);
    },
  );
  it("recovers the exact processed event after response loss without another credit", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    values.faults.commitAfterApplied = true;
    await expect(
      repository.postReceivedPayment(values.input),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    values.faults.commitAfterApplied = false;
    values.clock.value = new Date("2026-10-12T18:00:00.000Z");
    expect(await repository.postReceivedPayment(values.input)).toEqual({
      outcome: "DUPLICATE",
      paymentId: "payment-local-one",
      ledgerEntryId: "ledger-local-one",
    });
    expect(values.tables.gift_payment_record).toHaveLength(1);
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
  });

  it("processes a second authenticated event for the same payment without double credit", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    const event = {
      ...values.tables.financial_event_inbox[0],
      id: "event-two",
      providerEventReference: "evt_two",
      state: "CLAIMED",
      paymentId: null,
      leaseToken: "second-claim",
      processedAt: null,
      payloadHash: hashAsaasEventIdentity(
        "evt_two",
        "PAYMENT_RECEIVED",
        "provider-account-one",
        values.tables.financial_event_inbox[0].payload as Record<
          string,
          string
        >,
      ),
    };
    values.tables.financial_event_inbox.push(event);
    const input = {
      ...values.input,
      claim: {
        ...values.input.claim,
        eventId: "event-two",
        leaseToken: "second-claim",
      },
    };
    expect(await repository.postReceivedPayment(input)).toEqual({
      outcome: "DUPLICATE",
      paymentId: "payment-local-one",
      ledgerEntryId: "ledger-local-one",
    });
    expect(values.tables.financial_event_inbox[1]).toMatchObject({
      state: "PROCESSED",
      paymentId: "payment-local-one",
    });
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
  });

  it.each(["REFUNDED", "DISPUTED", "CANCELLED"])(
    "does not regress a verified terminal payment %s",
    async (status) => {
      const values = fixture();
      values.tables.gift_payment_record.push({
        ...scope,
        id: "payment-existing",
        orderId: "order-one",
        attemptId: "attempt-one",
        providerPaymentReference: "pay_one",
        providerStatus: status,
        verificationStatus: "VERIFIED",
        observedAt: new Date("2026-10-12T17:04:15.000Z"),
        currency: "BRL",
        grossCents: 10_239,
        processingCents: 39,
        commissionCents: 200,
        recipientNetCents: 10_000,
        splitFixedCents: 200,
        splitProviderReference: "split-one",
      });
      expect(
        await createGiftPaymentPostingRepository(
          values.db,
          values.options,
        ).postReceivedPayment(values.input),
      ).toEqual({
        outcome: "NO_REGRESSION",
        paymentId: "payment-existing",
        ledgerEntryId: null,
      });
      expect(values.tables.gift_payment_record[0].providerStatus).toBe(status);
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
      expect(values.tables.financial_event_inbox[0]).toMatchObject({
        state: "PROCESSED",
        paymentId: "payment-existing",
      });
    },
  );

  it.each([
    "owner",
    "token",
    "expired",
    "event",
    "payment",
    "checkout",
    "hash",
    "authentication",
    "account",
    "environment",
  ])(
    "denies an invalid original claim or authenticated correlation: %s",
    async (caseName) => {
      const values = fixture();
      const event = values.tables.financial_event_inbox[0];
      if (caseName === "owner") event.leaseOwner = "new-worker";
      if (caseName === "token") event.leaseToken = "new-claim";
      if (caseName === "expired")
        values.clock.value = new Date("2026-10-12T17:07:00.000Z");
      if (caseName === "event") event.eventType = "PAYMENT_CREATED";
      if (caseName === "payment")
        (event.payload as Record<string, string>).paymentId = "another-payment";
      if (caseName === "checkout")
        (event.payload as Record<string, string>).checkoutId =
          "another-checkout";
      if (caseName === "hash") event.payloadHash = "f".repeat(64);
      if (caseName === "authentication") event.authenticatedAt = null;
      if (caseName === "account") event.accountId = "another-account";
      if (caseName === "environment") event.environment = "live";
      await expect(
        createGiftPaymentPostingRepository(
          values.db,
          values.options,
        ).postReceivedPayment(values.input),
      ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
      expect(values.tables.gift_payment_record).toHaveLength(0);
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
    },
  );

  it("defers an authenticated payment event until saved checkout creation evidence exists", async () => {
    const values = fixture();
    values.binding.operationState = "PROCESSING";
    values.binding.providerOperationReference = null as unknown as string;
    await expect(
      createGiftPaymentPostingRepository(
        values.db,
        values.options,
      ).postReceivedPayment(values.input),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    expect(values.tables.gift_payment_record).toHaveLength(0);
    expect(values.tables.financial_ledger_entry).toHaveLength(0);
    expect(values.tables.financial_event_inbox[0].state).toBe("CLAIMED");
  });

  it.each(["financial_ledger_entry", "final-fence"])(
    "rolls back the whole posting when %s fails",
    async (failure) => {
      const values = fixture();
      if (failure === "final-fence") values.faults.casMiss = true;
      else values.faults.failInsert = failure;
      const error = await createGiftPaymentPostingRepository(
        values.db,
        values.options,
      )
        .postReceivedPayment(values.input)
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({
        code: "PAYMENT_POSTING_UNAVAILABLE",
        message: "Payment posting unavailable",
      });
      expect(JSON.stringify(error)).not.toMatch(
        /SQL|private|payer|must-not-persist/,
      );
      expect(values.tables.gift_payment_record).toHaveLength(0);
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
      expect(values.tables.financial_event_inbox[0].state).toBe("CLAIMED");
    },
  );
});

describe("observed allocations remain pending", () => {
  it.each([
    "pending",
    "split-pending",
    "missing-net",
    "gross-divergence",
    "fixed-divergence",
    "wallet-divergence",
  ])(
    "records actual values and a fenced RETRY without credit for %s",
    async (caseName) => {
      const values = fixture();
      const raw = values.input.observation.payment as Record<string, unknown>;
      const split = (raw.split as Record<string, unknown>[])[0];
      if (caseName === "pending") {
        raw.status = "PENDING";
        delete raw.netValue;
      }
      if (caseName === "split-pending") split.status = "PENDING";
      if (caseName === "missing-net") delete raw.netValue;
      if (caseName === "gross-divergence") raw.value = "103.39";
      if (caseName === "fixed-divergence") {
        split.fixedValue = "3.00";
        split.totalValue = "3.00";
      }
      if (caseName === "wallet-divergence") split.walletId = "another-wallet";
      expect(
        await createGiftPaymentPostingRepository(
          values.db,
          values.options,
        ).postReceivedPayment(values.input),
      ).toEqual({
        outcome: "OBSERVED",
        paymentId: "payment-local-one",
        ledgerEntryId: null,
      });
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
      expect(values.tables.financial_event_inbox[0]).toMatchObject({
        state: "RETRY",
        paymentId: "payment-local-one",
        processedAt: null,
        nextAttemptAt: new Date(time.getTime() + 30_000),
        leaseOwner: "worker-one",
        leaseToken: "original-claim-one",
      });
      expect(values.tables.financial_event_inbox[0].lastErrorCode).toMatch(
        /^[A-Z_]+$/,
      );
      if (["pending", "missing-net"].includes(caseName))
        expect(values.tables.gift_payment_record[0].processingCents).toBeNull();
      if (["pending", "split-pending", "wallet-divergence"].includes(caseName))
        expect(
          values.tables.gift_payment_record[0].recipientNetCents,
        ).toBeNull();
      if (caseName === "gross-divergence")
        expect(values.tables.gift_payment_record[0]).toMatchObject({
          processingCents: 139,
          recipientNetCents: 10_000,
        });
      if (caseName === "fixed-divergence")
        expect(values.tables.gift_payment_record[0]).toMatchObject({
          commissionCents: 300,
          recipientNetCents: 9_900,
        });
    },
  );

  it("recovers its consistent RETRY after a lost commit response without a second write", async () => {
    const values = fixture();
    (values.input.observation.payment as Record<string, unknown>).netValue =
      null;
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    values.faults.commitAfterApplied = true;
    await expect(
      repository.postReceivedPayment(values.input),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    values.faults.commitAfterApplied = false;
    values.clock.value = new Date("2026-10-12T18:00:00.000Z");
    const writes = values.queries.filter((entry) =>
      /^\s*(INSERT INTO|UPDATE)\s/i.test(entry.sql),
    ).length;
    expect(await repository.postReceivedPayment(values.input)).toMatchObject({
      outcome: "OBSERVED",
      paymentId: "payment-local-one",
      ledgerEntryId: null,
    });
    expect(
      values.queries.filter((entry) =>
        /^\s*(INSERT INTO|UPDATE)\s/i.test(entry.sql),
      ),
    ).toHaveLength(writes);
    expect(values.tables.financial_event_inbox[0].state).toBe("RETRY");
  });

  it("updates an uncredited actual payment only under a newly acquired original claim", async () => {
    const values = fixture();
    const raw = values.input.observation.payment as Record<string, unknown>;
    const split = (raw.split as Record<string, unknown>[])[0];
    split.status = "PENDING";
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    values.tables.financial_event_inbox[0].state = "CLAIMED";
    values.tables.financial_event_inbox[0].leaseToken = "second-claim";
    const input = {
      ...values.input,
      claim: { ...values.input.claim, leaseToken: "second-claim" },
    };
    split.status = "DONE";
    input.observation.observedAt = new Date("2026-10-12T17:04:45.000Z");
    expect(await repository.postReceivedPayment(input)).toMatchObject({
      outcome: "POSTED",
      paymentId: "payment-local-one",
      ledgerEntryId: "ledger-local-one",
    });
    expect(values.tables.gift_payment_record).toHaveLength(1);
    expect(values.tables.gift_payment_record[0].recipientNetCents).toBe(10_000);
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
  });

  it("preserves a credited receipt on a later divergent observation and keeps the new event RETRY", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    const original = structuredClone(values.tables.gift_payment_record[0]);
    const event = {
      ...values.tables.financial_event_inbox[0],
      id: "event-two",
      providerEventReference: "evt_two",
      state: "CLAIMED",
      paymentId: null,
      processedAt: null,
      leaseToken: "second-claim",
      payloadHash: hashAsaasEventIdentity(
        "evt_two",
        "PAYMENT_RECEIVED",
        "provider-account-one",
        values.tables.financial_event_inbox[0].payload as Record<
          string,
          string
        >,
      ),
    };
    values.tables.financial_event_inbox.push(event);
    const input = {
      ...values.input,
      claim: {
        ...values.input.claim,
        eventId: "event-two",
        leaseToken: "second-claim",
      },
    };
    (input.observation.payment as Record<string, unknown>).netValue = "101.00";
    expect(await repository.postReceivedPayment(input)).toMatchObject({
      outcome: "OBSERVED",
      paymentId: "payment-local-one",
      ledgerEntryId: "ledger-local-one",
    });
    expect(values.tables.gift_payment_record[0]).toEqual(original);
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
    expect(values.tables.financial_event_inbox[1]).toMatchObject({
      state: "RETRY",
      lastErrorCode: "PAYMENT_RECEIPT_MISMATCH",
    });
  });
});

function nextEvent(values: ReturnType<typeof fixture>, reference = "evt_two") {
  const first = values.tables.financial_event_inbox[0];
  values.tables.financial_event_inbox.push({
    ...first,
    id: "event-two",
    providerEventReference: reference,
    state: "CLAIMED",
    paymentId: null,
    processedAt: null,
    leaseToken: "second-claim",
    payloadHash: hashAsaasEventIdentity(
      reference,
      "PAYMENT_RECEIVED",
      "provider-account-one",
      first.payload as Record<string, string>,
    ),
  });
  return {
    ...values.input,
    claim: {
      ...values.input.claim,
      eventId: "event-two",
      leaseToken: "second-claim",
    },
  };
}

describe("stored financial proof and bounded observation input", () => {
  it.each(["missing-total", "null-total", "contradictory-total"])(
    "does not confuse split configuration with observed transfer: %s",
    async (caseName) => {
      const values = fixture();
      const split = (
        (values.input.observation.payment as Record<string, unknown>)
          .split as Record<string, unknown>[]
      )[0];
      if (caseName === "missing-total") delete split.totalValue;
      if (caseName === "null-total") split.totalValue = null;
      if (caseName === "contradictory-total") split.totalValue = "3.00";
      expect(
        await createGiftPaymentPostingRepository(
          values.db,
          values.options,
        ).postReceivedPayment(values.input),
      ).toMatchObject({ outcome: "OBSERVED", ledgerEntryId: null });
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
      expect(values.tables.financial_event_inbox[0].state).toBe("RETRY");
      if (caseName === "contradictory-total")
        expect(values.tables.gift_payment_record[0]).toMatchObject({
          commissionCents: 300,
          recipientNetCents: 9_900,
          splitFixedCents: 200,
        });
      else
        expect(values.tables.gift_payment_record[0].commissionCents).toBeNull();
    },
  );

  it("validates an existing receipt's allocation before treating it as financial proof", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    values.tables.gift_payment_record[0].recipientNetCents = 9_999;
    await expect(
      repository.postReceivedPayment(nextEvent(values)),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
    expect(values.tables.financial_event_inbox[1].state).toBe("CLAIMED");
  });

  it.each([
    { processingCents: 40, recipientNetCents: 10_000 },
    { processingCents: -1, recipientNetCents: 10_040 },
    { processingCents: 39.5, recipientNetCents: 9_999.5 },
    { processingCents: 10_039, recipientNetCents: 0 },
  ])("rejects invalid stored receipt conservation: %j", async (allocation) => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    Object.assign(values.tables.gift_payment_record[0], allocation);
    values.tables.financial_ledger_entry[0].amountCents =
      allocation.recipientNetCents;
    await expect(
      repository.postReceivedPayment(nextEvent(values)),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
    expect(values.tables.financial_event_inbox[1].state).toBe("CLAIMED");
  });

  it("validates the authenticated origin of an existing receipt before processing a duplicate", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    values.tables.financial_event_inbox[0].payloadHash = "f".repeat(64);
    await expect(
      repository.postReceivedPayment(nextEvent(values)),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
    expect(values.tables.financial_event_inbox[1].state).toBe("CLAIMED");
  });

  it("keeps normalized event IDs at the webhook's accepted 256-character bound", async () => {
    const values = fixture();
    const event = values.tables.financial_event_inbox[0];
    event.providerEventReference = "x".repeat(256);
    event.payloadHash = hashAsaasEventIdentity(
      event.providerEventReference as string,
      "PAYMENT_RECEIVED",
      "provider-account-one",
      event.payload as Record<string, string>,
    );
    expect(
      await createGiftPaymentPostingRepository(
        values.db,
        values.options,
      ).postReceivedPayment(values.input),
    ).toMatchObject({ outcome: "POSTED" });
  });

  it.each(["REFUND_REQUESTED", "CHARGEBACK_REQUESTED", "CHARGEBACK_DISPUTE"])(
    "does not clear stored reversal uncertainty %s through a receipt-only observation",
    async (status) => {
      const values = fixture();
      values.tables.gift_payment_record.push({
        ...scope,
        id: "payment-existing",
        orderId: "order-one",
        attemptId: "attempt-one",
        providerPaymentReference: "pay_one",
        providerStatus: status,
        verificationStatus: "VERIFIED",
        observedAt: new Date("2026-10-12T17:04:15.000Z"),
        currency: "BRL",
        grossCents: 10_239,
        processingCents: 39,
        commissionCents: 200,
        recipientNetCents: 10_000,
        splitFixedCents: 200,
        splitProviderReference: "split-one",
      });
      expect(
        await createGiftPaymentPostingRepository(
          values.db,
          values.options,
        ).postReceivedPayment(values.input),
      ).toMatchObject({
        outcome: "OBSERVED",
        paymentId: "payment-existing",
        ledgerEntryId: null,
      });
      expect(values.tables.gift_payment_record[0].providerStatus).toBe(status);
      expect(values.tables.financial_event_inbox[0]).toMatchObject({
        state: "RETRY",
        lastErrorCode: "PAYMENT_RESTRICTED",
      });
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
    },
  );

  it("keeps an older observation from replacing a newer uncredited observation", async () => {
    const values = fixture();
    const raw = values.input.observation.payment as Record<string, unknown>;
    raw.status = "PENDING";
    values.input.observation.observedAt = new Date("2026-10-12T17:04:45.000Z");
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    const original = structuredClone(values.tables.gift_payment_record[0]);
    const input = nextEvent(values);
    raw.status = "RECEIVED";
    input.observation.observedAt = new Date("2026-10-12T17:04:30.000Z");
    expect(await repository.postReceivedPayment(input)).toMatchObject({
      outcome: "OBSERVED",
      ledgerEntryId: null,
    });
    expect(values.tables.gift_payment_record[0]).toEqual(original);
    expect(values.tables.financial_ledger_entry).toHaveLength(0);
    expect(values.tables.financial_event_inbox[1]).toMatchObject({
      state: "RETRY",
      lastErrorCode: "PAYMENT_OBSERVATION_STALE",
    });
  });

  it.each([
    "site",
    "account",
    "environment",
    "method",
    "checkout",
    "source",
    "future",
    "decision",
  ])(
    "rejects mismatched or client-selected observation input: %s",
    async (caseName) => {
      const values = fixture();
      const raw = values.input.observation.payment as Record<string, unknown>;
      if (caseName === "site") values.input.observation.siteId = "another-site";
      if (caseName === "account")
        values.input.observation.accountReference = "another-account";
      if (caseName === "environment")
        values.input.observation.environment = "live";
      if (caseName === "method") raw.billingType = "CREDIT_CARD";
      if (caseName === "checkout") raw.checkoutSession = "another-checkout";
      if (caseName === "source")
        (
          values.input.observation as unknown as Record<string, unknown>
        ).source = "browser";
      if (caseName === "future")
        values.input.observation.observedAt = new Date(time.getTime() + 1);
      if (caseName === "decision")
        (values.input as unknown as Record<string, unknown>).decision = {
          outcome: "RECEIVED",
          amountCents: 10_000,
        };
      await expect(
        createGiftPaymentPostingRepository(
          values.db,
          values.options,
        ).postReceivedPayment(values.input),
      ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
      expect(values.tables.gift_payment_record).toHaveLength(0);
      expect(values.tables.financial_ledger_entry).toHaveLength(0);
    },
  );

  it.each([0, -1, 300_001, Number.NaN, Number.POSITIVE_INFINITY])(
    "requires a bounded server retry delay: %s",
    (delay) => {
      const values = fixture();
      expect(() =>
        createGiftPaymentPostingRepository(values.db, {
          ...values.options,
          retryDelayMs: delay,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "PAYMENT_POSTING_UNAVAILABLE" }),
      );
      expect(values.queries).toHaveLength(0);
    },
  );

  it("copies caller observations and server configuration before asynchronous work", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    values.options.platformWalletId = "changed-wallet";
    values.options.environment = "live";
    values.options.retryDelayMs = 1;
    const execute = values.query.getMockImplementation();
    if (!execute) throw new Error("missing harness");
    values.query.mockImplementation(async (statement, params) => {
      (values.input.observation.payment as Record<string, unknown>).netValue =
        "1.00";
      values.input.claim.leaseToken = "mutated-caller-token";
      return execute(statement, params);
    });
    expect(await repository.postReceivedPayment(values.input)).toMatchObject({
      outcome: "POSTED",
    });
    expect(values.tables.gift_payment_record[0].recipientNetCents).toBe(10_000);
    expect(values.tables.financial_event_inbox[0].leaseToken).toBe(
      "original-claim-one",
    );
  });

  it("rereads the injected clock at the final fence after asynchronous writes", async () => {
    const values = fixture();
    const execute = values.query.getMockImplementation();
    if (!execute) throw new Error("missing harness");
    values.query.mockImplementation(async (statement, params) => {
      const text = typeof statement === "string" ? statement : statement.text;
      const result = await execute(statement, params);
      if (/INSERT INTO "gift_payment_record"/i.test(text))
        values.clock.value = new Date("2026-10-12T17:07:00.000Z");
      return result;
    });
    await expect(
      createGiftPaymentPostingRepository(
        values.db,
        values.options,
      ).postReceivedPayment(values.input),
    ).rejects.toMatchObject({ code: "PAYMENT_POSTING_UNAVAILABLE" });
    expect(values.tables.gift_payment_record).toHaveLength(0);
    expect(values.tables.financial_ledger_entry).toHaveLength(0);
    expect(values.tables.financial_event_inbox[0].state).toBe("CLAIMED");
  });
});

// One fake connection models serialized transactions; real PostgreSQL locks need separate acceptance.
class SerialPostingPool {
  private tail = Promise.resolve();
  constructor(readonly query: ReturnType<typeof fixture>["query"]) {}
  async connect() {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return { query: this.query, release };
  }
}

describe("payment effect uniqueness", () => {
  it("posts one payment and effect under concurrent identical original claims", async () => {
    const values = fixture();
    const db = drizzle(
      new SerialPostingPool(values.query) as unknown as NodePgClient,
    );
    const repository = createGiftPaymentPostingRepository(db, values.options);
    const results = await Promise.all([
      repository.postReceivedPayment(values.input),
      repository.postReceivedPayment(values.input),
    ]);
    expect(results.map((result) => result.outcome).sort()).toEqual([
      "DUPLICATE",
      "POSTED",
    ]);
    expect(values.tables.gift_payment_record).toHaveLength(1);
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
  });

  it("retains different actual provider payments independently for the same checkout", async () => {
    const values = fixture();
    const repository = createGiftPaymentPostingRepository(
      values.db,
      values.options,
    );
    await repository.postReceivedPayment(values.input);
    const input = nextEvent(values);
    (input.observation.payment as Record<string, unknown>).id = "pay_two";
    values.tables.financial_event_inbox[1].payload = {
      paymentId: "pay_two",
      checkoutId: "checkout-one",
      externalReference: "attempt-one",
    };
    values.tables.financial_event_inbox[1].payloadHash = hashAsaasEventIdentity(
      "evt_two",
      "PAYMENT_RECEIVED",
      "provider-account-one",
      values.tables.financial_event_inbox[1].payload as Record<string, string>,
    );
    vi.mocked(values.options.generateId).mockImplementation(
      (kind) => `${kind}-local-two`,
    );
    expect(await repository.postReceivedPayment(input)).toMatchObject({
      outcome: "POSTED",
      paymentId: "payment-local-two",
      ledgerEntryId: "ledger-local-two",
    });
    expect(values.tables.gift_payment_record).toHaveLength(2);
    expect(values.tables.financial_ledger_entry).toHaveLength(2);
    expect(
      new Set(values.tables.financial_ledger_entry.map((row) => row.effectKey))
        .size,
    ).toBe(2);
    expect(await repository.postReceivedPayment(input)).toMatchObject({
      outcome: "DUPLICATE",
      paymentId: "payment-local-two",
    });
    expect(values.tables.financial_ledger_entry).toHaveLength(2);
  });

  it("upgrades a scoped unverified payment from the fetched facts instead of copying unknown values", async () => {
    const values = fixture();
    values.tables.gift_payment_record.push({
      ...scope,
      id: "payment-existing",
      orderId: "order-one",
      attemptId: "attempt-one",
      providerPaymentReference: "pay_one",
      providerStatus: null,
      verificationStatus: "UNVERIFIED",
      observedAt: null,
      currency: "BRL",
      grossCents: null,
      processingCents: null,
      commissionCents: null,
      recipientNetCents: null,
      splitFixedCents: null,
      splitProviderReference: null,
    });
    expect(
      await createGiftPaymentPostingRepository(
        values.db,
        values.options,
      ).postReceivedPayment(values.input),
    ).toMatchObject({ outcome: "POSTED", paymentId: "payment-existing" });
    expect(values.tables.gift_payment_record[0]).toMatchObject({
      providerStatus: "RECEIVED",
      verificationStatus: "VERIFIED",
      grossCents: 10_239,
      recipientNetCents: 10_000,
    });
    expect(values.tables.financial_ledger_entry).toHaveLength(1);
  });
});
