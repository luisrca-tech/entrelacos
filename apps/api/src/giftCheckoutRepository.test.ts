import { createHash } from "node:crypto";
import { drizzle, type NodePgClient } from "drizzle-orm/node-postgres";
import { describe, expect, it, vi } from "vitest";
import {
  createGiftCheckoutRepository,
  type GiftCheckoutRepositoryOptions,
  giftReceivedEffectKey,
} from "./giftCheckoutRepository";
import {
  createGiftCheckoutService,
  type GiftCheckoutHostedOutcome,
  type GiftCheckoutReservation,
} from "./giftCheckouts";
import type {
  GiftQuoteReceivingContext,
  StoredGiftForQuote,
} from "./giftQuotes";

vi.mock("./giftQuoteLookup", () => ({ findPublishedGiftForQuote: vi.fn() }));

import { findPublishedGiftForQuote } from "./giftQuoteLookup";

const instant = "2026-10-12T17:00:00.000Z";
const now = new Date(instant);
const tokenHash = createHash("sha256")
  .update("test-only-browser-capability")
  .digest("hex");

function reservation(): GiftCheckoutReservation {
  const receiving = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-one",
    environment: "sandbox" as const,
    accountReference: "provider-account-one",
    recipientReference: "recipient-one",
    destinationVersion: 1,
    bankReference: "bank-one",
  };
  return {
    siteId: "site-one",
    quoteId: "quote-one",
    requestId: "request-one",
    orderId: "order-one",
    attemptId: "attempt-one",
    recoveryTokenHash: tokenHash,
    createdAt: instant,
    quoteSnapshot: {
      quote: {
        id: "quote-one",
        siteId: "site-one",
        giftId: "gift-one",
        title: "Symbolic trip",
        method: "PIX",
        currency: "BRL",
        nominalCents: 10_000,
        commissionBasisPoints: 200,
        commissionCents: 200,
        processingCents: 39,
        totalCents: 10_239,
        policyVersion: "policy-one",
        expiresAt: "2026-10-12T17:05:00.000Z",
        mode: "sandbox",
      },
      gift: {
        id: "gift-one",
        siteId: "site-one",
        title: "Symbolic trip",
        description: "Our trip",
        nominalCents: 10_000,
        currency: "BRL",
        image: null,
        sortOrder: 0,
      },
      receiving,
      pricing: {
        ...receiving,
        verification: "verified",
        provenance: "provider",
        observedAt: "2026-10-12T16:59:30.000Z",
        expiresAt: "2026-10-12T17:10:00.000Z",
        policy: {
          version: "policy-one",
          method: "PIX",
          commissionBasisPoints: 200,
          processingBasisPoints: 0,
          processingFixedCents: 39,
          rounding: "CEILING",
        },
      },
      createdAt: instant,
      expiresAt: "2026-10-12T17:05:00.000Z",
    },
  };
}

function camel(column: string) {
  return column.replace(/_([a-z])/g, (_, letter: string) =>
    letter.toUpperCase(),
  );
}

function fixture(rawTimestamps = false) {
  const input = reservation();
  const quote = input.quoteSnapshot.quote;
  const context: GiftQuoteReceivingContext = {
    isDemo: false,
    environment: "test",
    mode: "sandbox",
    freshnessMs: 60_000,
    providerBinding: { ...input.quoteSnapshot.receiving },
    evidence: {
      ...input.quoteSnapshot.receiving,
      verification: "verified",
      provenance: "provider",
      accountState: "approved",
      bankState: "verified",
      capabilities: { receiving: true, withdrawal: true },
      commercialEnabled: true,
      observedAt: new Date("2026-10-12T16:59:30.000Z"),
      bankObservedAt: new Date("2026-10-12T16:59:30.000Z"),
    },
  };
  const storedGift: StoredGiftForQuote = {
    gift: structuredClone(input.quoteSnapshot.gift),
    publicationState: "PUBLISHED",
    siteActive: true,
  };
  const tables: Record<string, Record<string, unknown>[]> = {
    gift_quote_record: [
      {
        id: input.quoteId,
        siteId: input.siteId,
        accountId: "account-one",
        environment: "sandbox",
        giftId: quote.giftId,
        destinationVersion: input.quoteSnapshot.receiving.destinationVersion,
        method: quote.method,
        currency: quote.currency,
        nominalCents: quote.nominalCents,
        commissionBasisPoints: quote.commissionBasisPoints,
        commissionCents: quote.commissionCents,
        processingCents: quote.processingCents,
        totalCents: quote.totalCents,
        policyVersion: quote.policyVersion,
        snapshot: structuredClone(input.quoteSnapshot),
        createdAt: now,
        expiresAt: new Date(quote.expiresAt),
      },
    ],
    gift_order: [],
    financial_operation: [],
    gift_checkout_attempt: [],
    gift_payment_record: [],
    financial_ledger_entry: [],
    financial_event_inbox: [],
  };
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const clock = { value: new Date(now) };
  const faults = {
    updateMiss: false,
    commitAfterApplied: false,
    failInsert: "",
  };
  let beforeTransaction: typeof tables | null = null;
  const query = vi.fn(
    async (statement: string | { text: string }, params: unknown[] = []) => {
      const text = typeof statement === "string" ? statement : statement.text;
      queries.push({ sql: text, params });
      if (/^begin/i.test(text)) {
        beforeTransaction = structuredClone(tables);
        return { rows: [] };
      }
      if (/^commit/i.test(text)) {
        beforeTransaction = null;
        if (faults.commitAfterApplied)
          throw new Error("SQL password=test-secret commit response lost");
        return { rows: [] };
      }
      if (/^rollback/i.test(text)) {
        if (beforeTransaction)
          for (const name of Object.keys(tables))
            tables[name] = beforeTransaction[name];
        beforeTransaction = null;
        return { rows: [] };
      }
      if (/pg_advisory_xact_lock/i.test(text)) return { rows: [] };
      if (/FROM site WHERE/i.test(text))
        return { rows: [{ id: input.siteId }] };
      if (/SELECT id FROM "gift_order"/i.test(text))
        return { rows: [{ id: input.orderId }] };
      if (/FROM "receiving_account"/i.test(text))
        return {
          rows: [
            {
              id: "account-one",
              isCurrent: true,
              ...input.quoteSnapshot.receiving,
            },
          ],
        };
      if (/FROM "receiving_destination"/i.test(text))
        return { rows: [{ id: "destination-one" }] };
      if (/FROM "receiving_verification_evidence"/i.test(text))
        return { rows: [{ id: "proof-one" }] };
      if (/FROM "gift_item"/i.test(text))
        return { rows: [{ id: quote.giftId }] };
      const insert = text.match(
        /^insert into "([a-z_]+)" \((.*?)\) values \((.*?)\)/i,
      );
      if (insert) {
        if (faults.failInsert === insert[1])
          throw new Error("SQL password=test-secret insertion failed");
        const columns = [...insert[2].matchAll(/"([a-z_]+)"/g)].map((match) =>
          camel(match[1]),
        );
        const values = insert[3].split(",").map((part) => {
          const parameter = part.trim().match(/^\$(\d+)$/);
          return parameter ? params[Number(parameter[1]) - 1] : null;
        });
        const row = Object.fromEntries(
          columns.map((column, index) => {
            const raw = values[index];
            const value =
              column.endsWith("At") && typeof raw === "string"
                ? new Date(raw)
                : column === "requestSnapshot" && typeof raw === "string"
                  ? JSON.parse(raw)
                  : raw;
            return [column, value];
          }),
        );
        if (
          insert[1] === "gift_order" &&
          tables.gift_order.some(
            (existing) =>
              existing.siteId === row.siteId &&
              (existing.requestId === row.requestId ||
                existing.quoteId === row.quoteId),
          )
        ) {
          throw Object.assign(
            new Error("SQL duplicate contains private database details"),
            { code: "23505" },
          );
        }
        tables[insert[1]].push(row);
        return { rows: [] };
      }
      if (/UPDATE "financial_operation" op/i.test(text)) {
        const binding = (column: string) => {
          const match = text.match(new RegExp(`op\\.${column} = \\$(\\d+)`));
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        const operation = tables.financial_operation.find(
          (row) =>
            row.id === binding("id") &&
            row.siteId === binding("site_id") &&
            row.accountId === binding("account_id") &&
            row.environment === binding("environment") &&
            row.orderId === binding("order_id") &&
            row.requestId === binding("request_id") &&
            row.leaseOwner === binding("lease_owner") &&
            row.leaseToken === binding("lease_token") &&
            row.kind === "CHECKOUT_CREATE" &&
            row.state === "PROCESSING",
        );
        const expired =
          /lease_expires_at >=/i.test(text) &&
          operation &&
          (operation.leaseExpiresAt as Date).getTime() <
            options.now().getTime();
        if (
          !operation ||
          faults.updateMiss ||
          expired ||
          tables.gift_payment_record.length ||
          tables.financial_ledger_entry.length
        )
          return { rows: [] };
        operation.state = /SET state = 'SUCCEEDED'/i.test(text)
          ? "SUCCEEDED"
          : "UNKNOWN";
        const reference = text.match(/provider_operation_reference = \$(\d+)/);
        if (reference)
          operation.providerOperationReference =
            params[Number(reference[1]) - 1];
        const updated = text.match(/updated_at = \$(\d+)/);
        if (updated)
          operation.updatedAt = new Date(
            params[Number(updated[1]) - 1] as string,
          );
        return { rows: [{ id: operation.id }] };
      }
      if (/UPDATE "gift_checkout_attempt" a/i.test(text)) {
        const binding = (column: string) => {
          const match = text.match(new RegExp(`a\\.${column} = \\$(\\d+)`));
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        const attempt = tables.gift_checkout_attempt.find(
          (row) =>
            row.id === binding("id") &&
            row.siteId === binding("site_id") &&
            row.accountId === binding("account_id") &&
            row.environment === binding("environment") &&
            row.orderId === binding("order_id") &&
            row.operationId === binding("operation_id") &&
            row.operationKind === "CHECKOUT_CREATE",
        );
        if (
          !attempt ||
          attempt.providerReference !== null ||
          attempt.hostedUrl !== null
        )
          return { rows: [] };
        for (const column of ["provider_reference", "hosted_url"]) {
          const match = text.match(new RegExp(`${column} = \\$(\\d+)`));
          if (match) attempt[camel(column)] = params[Number(match[1]) - 1];
        }
        return { rows: [{ id: attempt.id }] };
      }
      if (/FROM "gift_order" o/i.test(text)) {
        const order = tables.gift_order.find(
          (row) => row.siteId === params[0] && row.requestId === params[1],
        );
        if (!order) return { rows: [] };
        const stored = tables.gift_quote_record.find(
          (row) => row.id === order.quoteId,
        );
        return {
          rows: [
            {
              ...stored,
              quoteId: stored?.id,
              orderId: order.id,
              requestId: order.requestId,
              requestHash: order.requestHash,
              recoveryTokenHash: order.recoveryTokenHash,
              orderCreatedAt: order.createdAt,
            },
          ],
        };
      }
      if (/FROM "gift_quote_record" q/i.test(text)) {
        return {
          rows: tables.gift_quote_record
            .filter((row) => row.siteId === params[0] && row.id === params[1])
            .map((row) => ({ ...row, quoteId: row.id })),
        };
      }
      if (/FROM "gift_checkout_attempt" a/i.test(text)) {
        return {
          rows: tables.gift_checkout_attempt.map((attempt) => {
            const operation = tables.financial_operation.find(
              (row) => row.id === attempt.operationId,
            );
            return {
              ...attempt,
              attemptId: attempt.id,
              operationState: operation?.state,
              operationKind: operation?.kind,
              operationAttempts: operation?.attempts,
              operationRequestId: operation?.requestId,
              operationRequestHash: operation?.requestHash,
              requestSnapshot: operation?.requestSnapshot,
              providerOperationReference:
                operation?.providerOperationReference ?? null,
              leaseOwner: operation?.leaseOwner,
              leaseToken: operation?.leaseToken,
              leaseExpiresAt: operation?.leaseExpiresAt,
              updatedAt: operation?.updatedAt,
            };
          }),
        };
      }
      if (/FROM "financial_ledger_entry" l/i.test(text))
        return { rows: tables.financial_ledger_entry };
      if (/FROM "gift_payment_record" p/i.test(text))
        return { rows: tables.gift_payment_record };
      if (
        /FROM "financial_event_inbox" e/i.test(text) &&
        /e.state <> 'PROCESSED'/i.test(text)
      ) {
        const binding = (column: string) => {
          const match = text.match(new RegExp(`e\\.${column} = \\$(\\d+)`));
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        const payloadBinding = (key: string) => {
          const match = text.match(
            new RegExp(`e\\.payload->>'${key}' = \\$(\\d+)`),
          );
          return match ? params[Number(match[1]) - 1] : undefined;
        };
        return {
          rows: tables.financial_event_inbox
            .filter((event) => {
              const payload = event.payload as
                | Record<string, string>
                | undefined;
              return (
                event.siteId === binding("site_id") &&
                event.accountId === binding("account_id") &&
                event.environment === binding("environment") &&
                event.authenticatedAt !== null &&
                event.authenticatedAt !== undefined &&
                event.state !== "PROCESSED" &&
                /^(PAYMENT_|CHECKOUT_)/.test(event.eventType as string) &&
                (tables.gift_payment_record.some(
                  (payment) =>
                    payment.id === event.paymentId ||
                    payment.providerPaymentReference === payload?.paymentId,
                ) ||
                  payload?.externalReference ===
                    payloadBinding("externalReference") ||
                  (payloadBinding("checkoutId") !== null &&
                    payload?.checkoutId === payloadBinding("checkoutId")))
              );
            })
            .slice(0, 1),
        };
      }
      if (/FROM "financial_event_inbox" e/i.test(text)) {
        const eventId = text.match(/e\.id = \$(\d+)/);
        return {
          rows: tables.financial_event_inbox.filter(
            (event) =>
              event.siteId === params[0] &&
              event.accountId === params[1] &&
              event.environment === params[2] &&
              (!eventId || event.id === params[Number(eventId[1]) - 1]),
          ),
        };
      }
      throw new Error(`Unexpected fixture query: ${text}`);
    },
  );
  const db = drizzle({
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
  } as unknown as NodePgClient);
  const options: GiftCheckoutRepositoryOptions = {
    instanceId: "api-instance-one",
    leaseMs: 60_000,
    now: () => new Date(clock.value),
    loadStoredReceivingContext: vi.fn(async () => context),
  };
  vi.mocked(findPublishedGiftForQuote)
    .mockReset()
    .mockResolvedValue(storedGift);
  return {
    input,
    context,
    storedGift,
    tables,
    queries,
    query,
    db,
    options,
    faults,
    clock,
  };
}

function outcome(): GiftCheckoutHostedOutcome {
  return {
    siteId: "site-one",
    quoteId: "quote-one",
    requestId: "request-one",
    orderId: "order-one",
    attemptId: "attempt-one",
    providerReference: "provider-checkout-one",
    observedAt: instant,
    checkout: {
      orderId: "order-one",
      attemptId: "attempt-one",
      quoteId: "quote-one",
      method: "PIX",
      mode: "sandbox",
      hostedUrl: "https://checkout.asaas.com/example",
    },
  };
}

async function reserved() {
  const values = fixture();
  const repository = createGiftCheckoutRepository(values.db, values.options);
  await repository.reserve(values.input, () => {});
  return { ...values, repository };
}

function receipt(values: Awaited<ReturnType<typeof reserved>>) {
  const scope = {
    siteId: "site-one",
    accountId: "account-one",
    environment: "sandbox",
  };
  values.tables.gift_payment_record.push({
    ...scope,
    id: "payment-one",
    orderId: "order-one",
    attemptId: "attempt-one",
    providerPaymentReference: "provider-payment-one",
    providerStatus: "RECEIVED",
    verificationStatus: "VERIFIED",
    observedAt: now,
    currency: "BRL",
    grossCents: 10_239,
    processingCents: 39,
    commissionCents: 200,
    recipientNetCents: 10_000,
    splitProviderReference: "split-one",
    splitFixedCents: 200,
  });
  values.tables.financial_ledger_entry.push({
    ...scope,
    id: "ledger-one",
    paymentId: "payment-one",
    operationId: null,
    eventId: "event-one",
    compensatesEntryId: null,
    direction: "CREDIT",
    kind: "GIFT_RECEIVED",
    amountCents: 10_000,
    currency: "BRL",
    effectKey: giftReceivedEffectKey("provider-payment-one"),
  });
  values.tables.financial_event_inbox.push({
    ...scope,
    id: "event-one",
    paymentId: "payment-one",
    eventType: "PAYMENT_RECEIVED",
    state: "PROCESSED",
    authenticatedAt: now,
    processedAt: now,
  });
}

// Model a pool with one connection; production advisory locks and unique constraints
// require separate PostgreSQL acceptance tests, not this deterministic SQL harness.
class SerializedQueryPool {
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

describe("PostgreSQL gift checkout repository", () => {
  it("normalizes raw Drizzle PostgreSQL timestamps across reservation, hosting and authenticated receipt", async () => {
    const values = fixture(true);
    const repository = createGiftCheckoutRepository(values.db, values.options);
    const reservedValue = await repository.reserve(values.input, () => {});
    expect(reservedValue.record.state).toBe("CREATING");
    expect((await repository.saveHostedCheckout(outcome())).state).toBe(
      "AWAITING_PAYMENT",
    );
    receipt({ ...values, repository });
    expect(
      (await repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("RECEIVED");
  });

  it("normalizes raw timestamps for a committed pre-dispatch seal without authorizing the late creator", async () => {
    const values = fixture(true);
    const repository = createGiftCheckoutRepository(values.db, values.options);
    const sealed = await repository.sealUncreatedRequest(values.input);
    expect(sealed.state).toBe("CLOSED_UNPAID");
    expect((await repository.reserve(values.input, () => {})).created).toBe(
      false,
    );
    expect(values.tables.financial_operation[0].state).toBe("CANCELLED");
  });

  it("does not accept text as an injected server clock", async () => {
    const values = fixture(true);
    values.options.now = () => instant as unknown as Date;
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.tables.gift_order).toHaveLength(0);
  });

  it("does not truncate away a future receipt observation within the current millisecond", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    receipt(values);
    values.tables.gift_payment_record[0].observedAt =
      "2026-10-12 17:00:00.000001+00";
    expect(
      (await values.repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("OUTCOME_UNKNOWN");
  });

  it("does not truncate away receipt processing before authentication within one millisecond", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    receipt(values);
    values.clock.value = new Date(now.getTime() + 1);
    values.tables.financial_event_inbox[0].authenticatedAt =
      "2026-10-12 17:00:00.000002+00";
    values.tables.financial_event_inbox[0].processedAt =
      "2026-10-12 17:00:00.000001+00";
    expect(
      (await values.repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("OUTCOME_UNKNOWN");
  });

  it.each(["createdAt", "expiresAt"] as const)(
    "rejects stored quote %s precision diverging from its immutable snapshot",
    async (field) => {
      const values = fixture(true);
      values.tables.gift_quote_record[0][field] =
        field === "createdAt"
          ? "2026-10-12 17:00:00.000001+00"
          : "2026-10-12 17:05:00.000001+00";
      await expect(
        createGiftCheckoutRepository(values.db, values.options).reserve(
          values.input,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(values.tables.gift_order).toHaveLength(0);
    },
  );
  it("commits the order, leased operation and attempt after locked eligibility", async () => {
    const values = fixture();
    const validate = vi.fn();
    const result = await createGiftCheckoutRepository(
      values.db,
      values.options,
    ).reserve(values.input, validate);
    expect(result).toMatchObject({
      created: true,
      record: {
        state: "CREATING",
        orderId: "order-one",
        attemptId: "attempt-one",
        recoveryTokenHash: tokenHash,
      },
    });
    expect(validate).toHaveBeenCalledWith({
      quoteSnapshot: values.input.quoteSnapshot,
      receivingContext: values.context,
      gift: values.storedGift,
    });
    expect(values.tables.gift_order).toHaveLength(1);
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
    expect(values.tables.financial_operation[0]).toMatchObject({
      id: "attempt-one",
      kind: "CHECKOUT_CREATE",
      state: "PROCESSING",
      leaseOwner: "api-instance-one",
      leaseToken: "attempt-one",
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    expect(values.queries.at(-1)?.sql).toBe("commit");
    expect(
      values.queries.some((entry) => /pg_advisory_xact_lock/i.test(entry.sql)),
    ).toBe(true);
    const siteLock = values.queries.findIndex((entry) =>
      /FROM site WHERE.*FOR UPDATE/is.test(entry.sql),
    );
    const quoteLock = values.queries.findIndex((entry) =>
      /FROM "gift_quote_record" q[\s\S]*FOR UPDATE/is.test(entry.sql),
    );
    expect(siteLock).toBeGreaterThan(0);
    expect(quoteLock).toBeGreaterThan(siteLock);
    const firstInsert = values.queries.findIndex((entry) =>
      /^insert/i.test(entry.sql),
    );
    expect(firstInsert).toBeGreaterThan(quoteLock);
    expect(values.options.loadStoredReceivingContext).toHaveBeenCalledWith(
      expect.anything(),
      {
        siteId: "site-one",
        accountId: "account-one",
        environment: "sandbox",
      },
    );
    expect(values.tables.gift_checkout_attempt[0].expiresAt).toBeNull();
  });

  it("recovers the winning immutable identity before any current eligibility checks", async () => {
    const values = await reserved();
    values.clock.value = new Date("2026-10-12T18:00:00.000Z");
    vi.mocked(values.options.loadStoredReceivingContext).mockRejectedValue(
      new Error("archived account"),
    );
    const calls = vi.mocked(values.options.loadStoredReceivingContext).mock
      .calls.length;
    const result = await values.repository.reserve(
      {
        ...values.input,
        orderId: "different-order",
        attemptId: "different-attempt",
      },
      () => {
        throw new Error("must not run");
      },
    );
    expect(result).toMatchObject({
      created: false,
      record: {
        orderId: "order-one",
        attemptId: "attempt-one",
        state: "OUTCOME_UNKNOWN",
      },
    });
    expect(values.options.loadStoredReceivingContext).toHaveBeenCalledTimes(
      calls,
    );
    expect(values.tables.gift_order).toHaveLength(1);
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
  });

  it.each(["quoteId", "recoveryTokenHash"] as const)(
    "rejects a conflicting replay %s",
    async (field) => {
      const values = await reserved();
      const altered = {
        ...values.input,
        [field]: field === "quoteId" ? "another-quote" : "f".repeat(64),
      };
      await expect(
        values.repository.reserve(altered, () => {}),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
      expect(values.tables.gift_order).toHaveLength(1);
    },
  );

  it.each([
    "expired",
    "snapshot",
    "readiness",
    "binding",
    "callback",
    "async-callback",
  ])("inserts nothing for invalid locked eligibility: %s", async (caseName) => {
    const values = fixture();
    if (caseName === "expired")
      values.clock.value = new Date("2026-10-12T17:06:00.000Z");
    if (caseName === "snapshot")
      values.input.quoteSnapshot.quote.title = "Caller replaced title";
    if (caseName === "readiness") values.context.evidence = null;
    if (caseName === "binding")
      values.context.providerBinding = {
        ...values.input.quoteSnapshot.receiving,
        accountReference: "different-account",
      };
    const validate =
      caseName === "callback"
        ? () => {
            throw new Error("policy rejected");
          }
        : caseName === "async-callback"
          ? async () => {}
          : () => {};
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        validate,
      ),
    ).rejects.toBeDefined();
    expect(values.tables.gift_order).toHaveLength(0);
    expect(values.tables.financial_operation).toHaveLength(0);
    expect(values.tables.gift_checkout_attempt).toHaveLength(0);
  });

  it("rolls back all commitments on an insert failure without exposing SQL secrets", async () => {
    const values = fixture();
    values.faults.failInsert = "gift_checkout_attempt";
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.tables.gift_order).toHaveLength(0);
    expect(values.tables.financial_operation).toHaveLength(0);
  });

  it("persists creation proof with the original lease fence before returning hosting", async () => {
    const values = await reserved();
    const result = await values.repository.saveHostedCheckout(outcome());
    expect(result).toMatchObject({
      state: "AWAITING_PAYMENT",
      checkout: outcome().checkout,
      evidence: {
        kind: "HOSTED_CHECKOUT",
        providerCheckoutReference: "provider-checkout-one",
        accountReference: "provider-account-one",
      },
    });
    expect(values.tables.financial_operation[0]).toMatchObject({
      state: "SUCCEEDED",
      providerOperationReference: "provider-checkout-one",
    });
    expect(values.tables.gift_checkout_attempt[0]).toMatchObject({
      providerReference: "provider-checkout-one",
      hostedUrl: outcome().checkout.hostedUrl,
      expiresAt: null,
    });
    const cas = values.queries.find((entry) =>
      /UPDATE "financial_operation" op/i.test(entry.sql),
    );
    expect(cas?.sql).toMatch(/lease_owner = \$\d+/);
    expect(cas?.sql).toMatch(/lease_token = \$\d+/);
    expect(cas?.sql).toMatch(/lease_expires_at >= clock_timestamp\(\)/);
    expect(cas?.sql).toMatch(/kind = 'CHECKOUT_CREATE'/);
    expect(cas?.params).toContain("api-instance-one");
    expect(cas?.params).toContain("attempt-one");
    expect(values.queries.at(-1)?.sql).toBe("commit");
    values.clock.value = new Date("2026-10-12T18:00:00.000Z");
    expect(
      await values.repository.findByRequest("site-one", "request-one"),
    ).toMatchObject({
      state: "AWAITING_PAYMENT",
      checkout: outcome().checkout,
    });
  });

  it.each(["owner", "token", "expired", "identity", "cas-miss"])(
    "does not save hosting after losing the original fence: %s",
    async (caseName) => {
      const values = await reserved();
      if (caseName === "owner")
        values.tables.financial_operation[0].leaseOwner = "new-worker";
      if (caseName === "token")
        values.tables.financial_operation[0].leaseToken = "new-token";
      if (caseName === "expired")
        values.clock.value = new Date("2026-10-12T17:02:00.000Z");
      if (caseName === "cas-miss") values.faults.updateMiss = true;
      const input = {
        ...outcome(),
        ...(caseName === "identity" ? { quoteId: "other-quote" } : {}),
      };
      await expect(
        values.repository.saveHostedCheckout(input),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(values.tables.gift_checkout_attempt[0].hostedUrl).toBeNull();
      expect(values.tables.financial_operation[0].state).toBe("PROCESSING");
    },
  );

  it("retains a committed outcome when the commit response is lost", async () => {
    const values = await reserved();
    values.faults.commitAfterApplied = true;
    await expect(
      values.repository.saveHostedCheckout(outcome()),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    values.faults.commitAfterApplied = false;
    expect(
      await values.repository.findByRequest("site-one", "request-one"),
    ).toMatchObject({
      state: "AWAITING_PAYMENT",
      checkout: outcome().checkout,
    });
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
  });

  it("marks only its original PROCESSING commitment unknown, with no deletion or requeue", async () => {
    const values = await reserved();
    await values.repository.markOutcomeUnknown(outcome(), instant);
    expect(values.tables.financial_operation[0]).toMatchObject({
      state: "UNKNOWN",
      leaseOwner: "api-instance-one",
      leaseToken: "attempt-one",
    });
    expect(
      (await values.repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("OUTCOME_UNKNOWN");
    expect(values.tables.gift_order).toHaveLength(1);
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
  });

  it("does not regress saved hosting or a received ledger while marking unknown", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    receipt(values);
    await values.repository.markOutcomeUnknown(outcome(), instant);
    expect(values.tables.financial_operation[0].state).toBe("SUCCEEDED");
    expect(
      (await values.repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("RECEIVED");
  });

  it("projects RECEIVED only from exact payment allocation and the authenticated processed receipt", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    receipt(values);
    expect(
      await values.repository.findByRequest("site-one", "request-one"),
    ).toMatchObject({
      state: "RECEIVED",
      checkout: null,
      evidence: {
        kind: "SETTLEMENT",
        ledgerEntryId: "ledger-one",
        providerPaymentReference: "provider-payment-one",
      },
    });
  });

  it.each(["RECEIVED", "CLAIMED", "RETRY", "DEAD_LETTER"])(
    "keeps a receipt unknown while correlated event remains %s",
    async (state) => {
      const values = await reserved();
      await values.repository.saveHostedCheckout(outcome());
      receipt(values);
      values.clock.value = new Date("2026-10-12T17:01:00.000Z");
      values.tables.financial_event_inbox.push({
        siteId: "site-one",
        accountId: "account-one",
        environment: "sandbox",
        id: "pending-event",
        paymentId: "payment-one",
        eventType: "PAYMENT_RECEIVED",
        state,
        authenticatedAt: now,
        payload: { paymentId: "provider-payment-one" },
      });
      expect(
        await values.repository.findByRequest("site-one", "request-one"),
      ).toMatchObject({
        state: "OUTCOME_UNKNOWN",
        observedAt: values.clock.value.toISOString(),
      });
      expect(values.tables.financial_ledger_entry).toHaveLength(1);
      expect(values.tables.gift_payment_record[0].providerStatus).toBe(
        "RECEIVED",
      );
    },
  );

  it.each(["paymentId", "externalReference", "checkoutId"])(
    "blocks awaiting-payment while an unresolved event correlates by %s",
    async (key) => {
      const values = await reserved();
      await values.repository.saveHostedCheckout(outcome());
      if (key === "paymentId") receipt(values);
      const payload = {
        [key]:
          key === "paymentId"
            ? "provider-payment-one"
            : key === "externalReference"
              ? "attempt-one"
              : outcome().providerReference,
      };
      values.tables.financial_event_inbox.push({
        siteId: "site-one",
        accountId: "account-one",
        environment: "sandbox",
        id: "pending-event",
        paymentId: null,
        eventType: "PAYMENT_REFUNDED",
        state: "RETRY",
        authenticatedAt: now,
        payload,
      });
      expect(
        (await values.repository.findByRequest("site-one", "request-one"))
          ?.state,
      ).toBe("OUTCOME_UNKNOWN");
    },
  );

  it.each([
    "site",
    "account",
    "environment",
    "processed",
    "uncorrelated",
    "unauthenticated",
  ])(
    "preserves a receipt when pending evidence is unrelated: %s",
    async (variant) => {
      const values = await reserved();
      await values.repository.saveHostedCheckout(outcome());
      receipt(values);
      const event: Record<string, unknown> = {
        siteId: "site-one",
        accountId: "account-one",
        environment: "sandbox",
        id: "pending-event",
        paymentId: null,
        eventType: "PAYMENT_REFUNDED",
        state: "RETRY",
        authenticatedAt: now,
        payload: { externalReference: "attempt-one" },
      };
      if (variant === "site") event.siteId = "another-site";
      if (variant === "account") event.accountId = "another-account";
      if (variant === "environment") event.environment = "live";
      if (variant === "processed") event.state = "PROCESSED";
      if (variant === "uncorrelated")
        event.payload = { externalReference: "another-attempt" };
      if (variant === "unauthenticated") event.authenticatedAt = null;
      values.tables.financial_event_inbox.push(event);
      expect(
        (await values.repository.findByRequest("site-one", "request-one"))
          ?.state,
      ).toBe("RECEIVED");
    },
  );

  it.each([
    "unverified",
    "gross",
    "commission",
    "processing",
    "net",
    "split",
    "split-reference",
    "ledger",
    "effect",
    "event",
    "account",
    "later-refund",
  ])(
    "does not fabricate RECEIVED from incomplete or superseded proof: %s",
    async (caseName) => {
      const values = await reserved();
      await values.repository.saveHostedCheckout(outcome());
      receipt(values);
      const payment = values.tables.gift_payment_record[0];
      const ledger = values.tables.financial_ledger_entry[0];
      if (caseName === "unverified") payment.verificationStatus = "UNVERIFIED";
      if (caseName === "gross") payment.grossCents = 10_000;
      if (caseName === "commission") payment.commissionCents = null;
      if (caseName === "processing") payment.processingCents = 40;
      if (caseName === "net") payment.recipientNetCents = 9_999;
      if (caseName === "split") payment.splitFixedCents = 199;
      if (caseName === "split-reference") payment.splitProviderReference = null;
      if (caseName === "ledger") ledger.amountCents = 9_999;
      if (caseName === "effect") ledger.effectKey = "unrelated-effect";
      if (caseName === "event")
        values.tables.financial_event_inbox[0].state = "RECEIVED";
      if (caseName === "account") payment.accountId = "another-account";
      if (caseName === "later-refund")
        values.tables.gift_payment_record.push({
          ...payment,
          id: "later-payment",
          providerStatus: "REFUNDED",
        });
      const result = await values.repository
        .findByRequest("site-one", "request-one")
        .catch(() => null);
      expect(result?.state).not.toBe("RECEIVED");
      if (result) expect(result.state).toBe("OUTCOME_UNKNOWN");
    },
  );

  it.each(["FAILED", "CANCELLED", "UNKNOWN"])(
    "does not derive CLOSED_UNPAID from operation %s",
    async (state) => {
      const values = await reserved();
      values.tables.financial_operation[0].state = state;
      expect(
        await values.repository.findByRequest("site-one", "request-one"),
      ).toMatchObject({
        state: "OUTCOME_UNKNOWN",
        checkout: null,
        evidence: null,
      });
    },
  );

  it("rejects a second request for the same immutable quote atomically", async () => {
    const values = await reserved();
    await expect(
      values.repository.reserve(
        {
          ...values.input,
          requestId: "second-request",
          orderId: "second-order",
          attemptId: "second-attempt",
        },
        () => {},
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(values.tables.gift_order).toHaveLength(1);
    expect(values.tables.financial_operation).toHaveLength(1);
  });

  it.each(["gift", "publication", "site", "scope", "local-policy"])(
    "requires stored catalog and pricing eligibility even with a no-op policy callback: %s",
    async (caseName) => {
      const values = fixture();
      if (caseName === "gift")
        vi.mocked(findPublishedGiftForQuote).mockResolvedValue(
          null as unknown as StoredGiftForQuote,
        );
      if (caseName === "publication")
        values.storedGift.publicationState = "DRAFT";
      if (caseName === "site") values.storedGift.siteActive = false;
      if (caseName === "scope") values.storedGift.gift.siteId = "another-site";
      if (caseName === "local-policy") {
        values.input.quoteSnapshot.pricing.provenance = "local-test";
        (
          values.tables.gift_quote_record[0]
            .snapshot as GiftCheckoutReservation["quoteSnapshot"]
        ).pricing.provenance = "local-test";
      }
      await expect(
        createGiftCheckoutRepository(values.db, values.options).reserve(
          values.input,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
      expect(values.tables.gift_order).toHaveLength(0);
    },
  );

  it("rereads its clock after the asynchronous catalog lookup before accepting quote expiry", async () => {
    const values = fixture();
    values.context.freshnessMs = 600_000;
    vi.mocked(findPublishedGiftForQuote).mockImplementationOnce(async () => {
      values.clock.value = new Date("2026-10-12T17:06:00.000Z");
      return values.storedGift;
    });
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
    expect(values.tables.gift_order).toHaveLength(0);
  });

  it("rereads receiving freshness after an asynchronous catalog lookup", async () => {
    const values = fixture();
    vi.mocked(findPublishedGiftForQuote).mockImplementationOnce(async () => {
      values.clock.value = new Date("2026-10-12T17:00:31.000Z");
      return values.storedGift;
    });
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        () => {},
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    expect(values.tables.gift_order).toHaveLength(0);
  });

  it("preserves an ambiguous reservation commit without authorizing another attempt", async () => {
    const values = fixture();
    const repository = createGiftCheckoutRepository(values.db, values.options);
    values.faults.commitAfterApplied = true;
    await expect(
      repository.reserve(values.input, () => {}),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    values.faults.commitAfterApplied = false;
    expect(
      await repository.reserve(
        {
          ...values.input,
          orderId: "second-order",
          attemptId: "second-attempt",
        },
        () => {},
      ),
    ).toMatchObject({
      created: false,
      record: { orderId: "order-one", attemptId: "attempt-one" },
    });
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
  });

  it.each(["hash", "createdAt", "siteId"] as const)(
    "rejects malformed reservation %s before SQL",
    async (field) => {
      const values = fixture();
      const input = {
        ...values.input,
        ...(field === "hash"
          ? { recoveryTokenHash: "raw-browser-token" }
          : field === "createdAt"
            ? { createdAt: "invalid" }
            : { siteId: " site-one" }),
      };
      await expect(
        createGiftCheckoutRepository(values.db, values.options).reserve(
          input,
          () => {},
        ),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(values.queries).toHaveLength(0);
    },
  );

  it("returns copied whitelisted snapshots and never persisted incidental secrets", async () => {
    const values = fixture();
    const stored = values.tables.gift_quote_record[0].snapshot as Record<
      string,
      unknown
    >;
    stored.credential = "server-private-credential";
    const repository = createGiftCheckoutRepository(values.db, values.options);
    const result = await repository.findQuote("site-one", "quote-one");
    expect(JSON.stringify(result)).not.toContain("server-private-credential");
    if (!result) throw new Error("quote missing");
    result.gift.title = "Returned mutation";
    expect(
      (await repository.findQuote("site-one", "quote-one"))?.gift.title,
    ).toBe("Symbolic trip");
    expect(values.input.quoteSnapshot.gift.title).toBe("Symbolic trip");
  });

  it.each(["method", "mode", "quote", "url", "hash-url", "future"])(
    "does not persist malformed or leaking provider projection: %s",
    async (caseName) => {
      const values = await reserved();
      const input = outcome();
      if (caseName === "method") input.checkout.method = "CREDIT_CARD";
      if (caseName === "mode") input.checkout.mode = "live";
      if (caseName === "quote") input.checkout.quoteId = "different-quote";
      if (caseName === "url")
        input.checkout.hostedUrl = "http://checkout.asaas.com/example";
      if (caseName === "hash-url")
        input.checkout.hostedUrl += `?token=${tokenHash.replace(/./g, (character) => `%${character.charCodeAt(0).toString(16)}`)}`;
      if (caseName === "future") input.observedAt = "2026-10-12T17:00:01.000Z";
      await expect(
        values.repository.saveHostedCheckout(input),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(values.tables.gift_checkout_attempt[0].hostedUrl).toBeNull();
      expect(values.tables.financial_operation[0].state).toBe("PROCESSING");
    },
  );

  it("copies instance ownership instead of adopting a mutated caller configuration", async () => {
    const values = await reserved();
    values.tables.financial_operation[0].leaseOwner = "another-instance";
    values.options.instanceId = "another-instance";
    await expect(
      values.repository.saveHostedCheckout(outcome()),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
  });

  it.each([
    "request-snapshot",
    "attempt-scope",
    "quote-column",
    "destination",
    "hash",
  ])("sanitizes malformed persisted storage: %s", async (caseName) => {
    const values = await reserved();
    if (caseName === "request-snapshot")
      values.tables.financial_operation[0].requestSnapshot = {
        recoveryToken: "secret-browser-token",
      };
    if (caseName === "attempt-scope")
      values.tables.gift_checkout_attempt[0].accountId = "another-account";
    if (caseName === "quote-column")
      values.tables.gift_quote_record[0].totalCents = 10_000;
    if (caseName === "destination")
      values.tables.gift_quote_record[0].destinationVersion = 2;
    if (caseName === "hash")
      values.tables.gift_order[0].recoveryTokenHash = "secret-browser-token";
    const error = await values.repository
      .findByRequest("site-one", "request-one")
      .catch((failure: unknown) => failure);
    expect(error).toMatchObject({
      code: "EXTERNAL_OUTCOME_UNKNOWN",
      message: "Gift checkout outcome is unresolved",
    });
    expect(JSON.stringify(error)).not.toMatch(
      /secret-browser-token|SQL|password/,
    );
  });

  it("does not return an earlier receipt when a compensating debit has been recorded", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    receipt(values);
    values.tables.financial_ledger_entry.push({
      ...values.tables.financial_ledger_entry[0],
      id: "debit-one",
      paymentId: null,
      kind: "GIFT_REFUNDED",
      direction: "DEBIT",
      compensatesEntryId: "ledger-one",
    });
    expect(
      (await values.repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("OUTCOME_UNKNOWN");
  });

  it("commits exactly one creator before the hosted provider under concurrent callers", async () => {
    const values = fixture();
    const db = drizzle(
      new SerializedQueryPool(values.query) as unknown as NodePgClient,
    );
    const repository = createGiftCheckoutRepository(db, values.options);
    const createHostedCheckout = vi.fn(async () => {
      const lastInsert = values.queries
        .map((entry) => /^insert/i.test(entry.sql))
        .lastIndexOf(true);
      expect(
        values.queries
          .slice(lastInsert + 1)
          .some((entry) => entry.sql === "commit"),
      ).toBe(true);
      expect(values.tables.gift_order).toHaveLength(1);
      expect(values.tables.gift_checkout_attempt).toHaveLength(1);
      expect(values.tables.financial_operation[0].state).toBe("PROCESSING");
      return outcome();
    });
    let id = 0;
    const service = createGiftCheckoutService({
      repository,
      now: values.options.now,
      generateId: (kind) => (id++ < 2 ? `${kind}-one` : `${kind}-second`),
      loadReceivingContext: async () => values.context,
      findPublishedGift: async () => values.storedGift,
      createHostedCheckout,
    });
    const body = {
      quoteId: "quote-one",
      requestId: "request-one",
      recoveryToken: "A".repeat(43),
    };
    const results = await Promise.allSettled([
      service.createCheckout("site-one", body),
      service.createCheckout("site-one", body),
    ]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(createHostedCheckout).toHaveBeenCalledTimes(1);
    expect(values.tables.gift_order).toHaveLength(1);
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
    expect(await service.createCheckout("site-one", body)).toEqual(
      outcome().checkout,
    );
    expect(createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it("keeps provider response loss unknown through recovery with no second call", async () => {
    const values = fixture();
    const repository = createGiftCheckoutRepository(values.db, values.options);
    const createHostedCheckout = vi.fn(async () => {
      throw new Error("provider key=private lost response");
    });
    const service = createGiftCheckoutService({
      repository,
      now: values.options.now,
      generateId: (kind) => `${kind}-one`,
      loadReceivingContext: async () => values.context,
      createHostedCheckout,
    });
    const body = {
      quoteId: "quote-one",
      requestId: "request-one",
      recoveryToken: "A".repeat(43),
    };
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(createHostedCheckout).toHaveBeenCalledTimes(1);
    expect(values.tables.financial_operation[0].state).toBe("UNKNOWN");
    expect(values.tables.gift_checkout_attempt).toHaveLength(1);
    expect(JSON.stringify(values.tables)).not.toContain(body.recoveryToken);
  });

  it("does not reuse caller or returned mutable data after asynchronous storage reads", async () => {
    const values = fixture();
    vi.mocked(values.options.loadStoredReceivingContext).mockImplementationOnce(
      async () => {
        values.input.quoteSnapshot.quote.title = "Mutation during await";
        values.input.recoveryTokenHash = "f".repeat(64);
        return values.context;
      },
    );
    const repository = createGiftCheckoutRepository(values.db, values.options);
    const result = await repository.reserve(values.input, (eligibility) => {
      eligibility.quoteSnapshot.gift.title = "Callback mutation";
    });
    expect(result.record.quoteSnapshot.quote.title).toBe("Symbolic trip");
    expect(result.record.recoveryTokenHash).toBe(tokenHash);
    result.record.quoteSnapshot.gift.title = "Returned mutation";
    expect(
      (await repository.findByRequest("site-one", "request-one"))?.quoteSnapshot
        .gift.title,
    ).toBe("Symbolic trip");
  });

  it("keeps database parameters separate from provider references and hosted URLs", async () => {
    const values = await reserved();
    const input = outcome();
    input.providerReference = "checkout'; SELECT credential_ciphertext; --";
    input.checkout.hostedUrl = "https://checkout.asaas.com/example?value=%27";
    await values.repository.saveHostedCheckout(input);
    const update = values.queries.find((entry) =>
      /UPDATE "financial_operation" op/i.test(entry.sql),
    );
    expect(update?.sql).not.toContain(input.providerReference);
    expect(update?.params).toContain(input.providerReference);
    expect(values.tables.gift_checkout_attempt[0].providerReference).toBe(
      input.providerReference,
    );
  });

  it("keeps an expired provider checkout unresolved without deriving unpaid closure", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    values.tables.gift_checkout_attempt[0].expiresAt = new Date(
      now.getTime() - 1,
    );
    expect(
      await values.repository.findByRequest("site-one", "request-one"),
    ).toMatchObject({
      state: "OUTCOME_UNKNOWN",
      closedReason: null,
      checkout: null,
    });
  });

  it("accepts an exact verified receipt without inventing an absent event link", async () => {
    const values = await reserved();
    await values.repository.saveHostedCheckout(outcome());
    receipt(values);
    values.tables.financial_ledger_entry[0].eventId = null;
    values.tables.financial_event_inbox = [];
    expect(
      (await values.repository.findByRequest("site-one", "request-one"))?.state,
    ).toBe("RECEIVED");
  });

  it.each(["payment", "type", "authentication", "processed"])(
    "requires matching receipt event proof when a link is stored: %s",
    async (caseName) => {
      const values = await reserved();
      await values.repository.saveHostedCheckout(outcome());
      receipt(values);
      const event = values.tables.financial_event_inbox[0];
      if (caseName === "payment") event.paymentId = "other-payment";
      if (caseName === "type") event.eventType = "CHECKOUT_PAID";
      if (caseName === "authentication") event.authenticatedAt = null;
      if (caseName === "processed") event.processedAt = null;
      expect(
        (await values.repository.findByRequest("site-one", "request-one"))
          ?.state,
      ).toBe("OUTCOME_UNKNOWN");
    },
  );

  it.each(["CANCELED", "EXPIRED"] as const)(
    "durably seals an uncreated request as %s without current eligibility",
    async (reason) => {
      const values = fixture();
      if (reason === "EXPIRED") {
        values.clock.value = new Date("2026-10-12T18:00:00.000Z");
        values.input.createdAt = values.clock.value.toISOString();
      }
      vi.mocked(values.options.loadStoredReceivingContext).mockRejectedValue(
        new Error("inactive account"),
      );
      vi.mocked(findPublishedGiftForQuote).mockRejectedValue(
        new Error("archived gift"),
      );
      const repository = createGiftCheckoutRepository(
        values.db,
        values.options,
      );
      const record = await repository.sealUncreatedRequest(values.input);
      expect(record).toMatchObject({
        state: "CLOSED_UNPAID",
        checkout: null,
        observedAt: values.input.createdAt,
        closedReason: reason,
        evidence: {
          source: "backend",
          kind: "PRE_DISPATCH_REJECTION",
          noProviderCall: true,
          recoveryTokenHash: tokenHash,
          orderId: "order-one",
          attemptId: "attempt-one",
          closedReason: reason,
        },
      });
      expect(values.tables.financial_operation[0]).toMatchObject({
        state: "CANCELLED",
        attempts: 0,
        leaseOwner: null,
        leaseToken: null,
        leaseExpiresAt: null,
        providerOperationReference: null,
      });
      expect(values.tables.gift_checkout_attempt[0]).toMatchObject({
        attemptNumber: 1,
        hostedUrl: null,
        providerReference: null,
        expiresAt: null,
      });
      expect(values.options.loadStoredReceivingContext).not.toHaveBeenCalled();
      expect(findPublishedGiftForQuote).not.toHaveBeenCalled();
      expect(values.queries.at(-1)?.sql).toBe("commit");
      expect(
        await repository.reserve(
          { ...values.input, orderId: "late-order", attemptId: "late-attempt" },
          () => {
            throw new Error("must not validate");
          },
        ),
      ).toMatchObject({
        created: false,
        record: {
          state: "CLOSED_UNPAID",
          orderId: "order-one",
          attemptId: "attempt-one",
        },
      });
      expect(values.tables.gift_order).toHaveLength(1);
      expect(values.tables.gift_checkout_attempt).toHaveLength(1);
    },
  );

  it("preserves an existing PROCESSING request when a recovery seal races its creator", async () => {
    const values = await reserved();
    expect(
      await values.repository.sealUncreatedRequest({
        ...values.input,
        orderId: "seal-order",
        attemptId: "seal-attempt",
      }),
    ).toMatchObject({
      state: "CREATING",
      orderId: "order-one",
      attemptId: "attempt-one",
      evidence: null,
    });
    expect(values.tables.financial_operation[0].state).toBe("PROCESSING");
    expect(values.tables.financial_operation).toHaveLength(1);
  });

  it("conflicts when another request has consumed the quote before the seal", async () => {
    const values = await reserved();
    await expect(
      values.repository.sealUncreatedRequest({
        ...values.input,
        requestId: "different-request",
        orderId: "seal-order",
        attemptId: "seal-attempt",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(values.tables.gift_order).toHaveLength(1);
  });

  it.each([
    "hash",
    "identity",
    "counter",
    "reference",
    "lease",
    "operation",
    "payment",
    "ledger",
  ])(
    "never projects closed proof from a tampered or dispatched seal: %s",
    async (caseName) => {
      const values = fixture();
      const repository = createGiftCheckoutRepository(
        values.db,
        values.options,
      );
      await repository.sealUncreatedRequest(values.input);
      const operation = values.tables.financial_operation[0];
      const proof = (
        operation.requestSnapshot as {
          preDispatchRejection: Record<string, unknown>;
        }
      ).preDispatchRejection;
      if (caseName === "hash") proof.recoveryTokenHash = "f".repeat(64);
      if (caseName === "identity") proof.quoteId = "different-quote";
      if (caseName === "counter") operation.attempts = 1;
      if (caseName === "reference")
        values.tables.gift_checkout_attempt[0].providerReference =
          "possibly-created-checkout";
      if (caseName === "lease")
        operation.leaseOwner = "possibly-dispatched-worker";
      if (caseName === "operation") operation.state = "SUCCEEDED";
      const scope = {
        siteId: "site-one",
        accountId: "account-one",
        environment: "sandbox",
      };
      if (caseName === "payment")
        values.tables.gift_payment_record.push({
          ...scope,
          id: "payment-one",
          orderId: "order-one",
          attemptId: "attempt-one",
        });
      if (caseName === "ledger")
        values.tables.financial_ledger_entry.push({
          ...scope,
          id: "ledger-one",
          operationId: "attempt-one",
        });
      const record = await repository
        .findByRequest("site-one", "request-one")
        .catch(() => null);
      expect(record?.state).not.toBe("CLOSED_UNPAID");
      if (record) expect(record.state).toBe("OUTCOME_UNKNOWN");
    },
  );

  it("recovers a sealed result after a lost seal commit response and never dispatches the late POST", async () => {
    const values = fixture();
    const repository = createGiftCheckoutRepository(values.db, values.options);
    values.faults.commitAfterApplied = true;
    await expect(
      repository.sealUncreatedRequest(values.input),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    values.faults.commitAfterApplied = false;
    expect(
      await repository.findByRequest("site-one", "request-one"),
    ).toMatchObject({ state: "CLOSED_UNPAID", closedReason: "CANCELED" });
    expect(
      await repository.reserve(values.input, () => {
        throw new Error("no dispatch");
      }),
    ).toMatchObject({ created: false, record: { state: "CLOSED_UNPAID" } });
    expect(values.tables.financial_operation[0].attempts).toBe(0);
  });

  it("closes a lost pre-reservation rejection through status without allowing the late request to dispatch", async () => {
    const values = fixture();
    values.clock.value = new Date("2026-10-12T18:00:00.000Z");
    const createHostedCheckout = vi.fn(async () => outcome());
    const repository = createGiftCheckoutRepository(values.db, values.options);
    const service = createGiftCheckoutService({
      repository,
      now: values.options.now,
      generateId: (kind) => `${kind}-one`,
      loadReceivingContext: async () => values.context,
      createHostedCheckout,
    });
    const body = {
      quoteId: "quote-one",
      requestId: "request-one",
      recoveryToken: "A".repeat(43),
    };
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(values.tables.gift_order).toHaveLength(0);
    const status = await service.getStatus("site-one", body);
    expect(status).toMatchObject({
      state: "CLOSED_UNPAID",
      closedReason: "EXPIRED",
      mayStartNewAttempt: true,
      checkout: null,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /recoveryTokenHash|preDispatchRejection|accountReference/,
    );
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toBeDefined();
    expect(createHostedCheckout).not.toHaveBeenCalled();
    expect(values.tables.financial_operation[0].attempts).toBe(0);
  });

  it("checks receiving freshness after synchronous policy validation", async () => {
    const values = fixture();
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        () => {
          values.clock.value = new Date("2026-10-12T17:00:31.000Z");
        },
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    expect(values.tables.gift_order).toHaveLength(0);
  });

  it("contains rejected asynchronous policy failures without escaping the transaction", async () => {
    const values = fixture();
    await expect(
      createGiftCheckoutRepository(values.db, values.options).reserve(
        values.input,
        async () => {
          throw new Error("Invalid asynchronous server policy");
        },
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.tables.gift_order).toHaveLength(0);
    await new Promise((resolve) => setImmediate(resolve));
  });
});
