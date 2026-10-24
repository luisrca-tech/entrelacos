import { createHash } from "node:crypto";
import {
  checkoutResultSchema,
  checkoutStatusSchema,
} from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createGiftCheckoutService,
  type GiftCheckoutEvidence,
  type GiftCheckoutRecord,
  type GiftCheckoutServiceDependencies,
  GiftCheckoutServiceError,
  type GiftHostedCheckout,
  readGiftQuoteSnapshot,
} from "./giftCheckouts";
import type {
  GiftQuoteReceivingContext,
  GiftQuoteSnapshot,
  StoredGiftForQuote,
} from "./giftQuotes";

const instant = "2026-10-12T16:00:00.000Z";
const observation = "2026-10-12T15:59:30.000Z";
const token = Buffer.alloc(32, 7).toString("base64url");
const body = {
  quoteId: "quote-one",
  requestId: "request-one",
  recoveryToken: token,
};

function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined)
    throw new Error("Missing fixture value");
  return value;
}

function fixture() {
  const receiving = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-private",
    environment: "sandbox" as const,
    accountReference: "account-private",
    recipientReference: "recipient-private",
    destinationVersion: 1,
    bankReference: "bank-private",
  };
  const snapshot: GiftQuoteSnapshot = {
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
      processingCents: 0,
      totalCents: 10_200,
      policyVersion: "verified-policy-v1",
      expiresAt: "2026-10-12T16:05:00.000Z",
      mode: "sandbox",
    },
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Symbolic trip",
      description: "A contribution to our trip",
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
      observedAt: observation,
      expiresAt: "2026-10-12T16:10:00.000Z",
      policy: {
        version: "verified-policy-v1",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 0,
        rounding: "CEILING",
      },
    },
    createdAt: instant,
    expiresAt: "2026-10-12T16:05:00.000Z",
  };
  const context: GiftQuoteReceivingContext = {
    isDemo: false,
    environment: "test",
    mode: "sandbox",
    providerBinding: { ...receiving },
    evidence: {
      ...receiving,
      verification: "verified",
      provenance: "provider",
      accountState: "approved",
      bankState: "verified",
      observedAt: new Date(observation),
      bankObservedAt: new Date(observation),
      capabilities: { receiving: true, withdrawal: true },
      commercialEnabled: true,
    },
    freshnessMs: 60_000,
  };
  const gift: StoredGiftForQuote = {
    gift: structuredClone(snapshot.gift),
    publicationState: "PUBLISHED",
    siteActive: true,
  };
  const records = new Map<string, GiftCheckoutRecord>();
  const key = (siteId: string, requestId: string) =>
    JSON.stringify([siteId, requestId]);
  const dependencies: GiftCheckoutServiceDependencies = {
    repository: {
      findByRequest: vi.fn(
        async (siteId, requestId) =>
          records.get(key(siteId, requestId)) ?? null,
      ),
      findQuote: vi.fn(async () => snapshot),
      sealUncreatedRequest: vi.fn(async (reservation) => {
        const existing = records.get(
          key(reservation.siteId, reservation.requestId),
        );
        if (existing) return existing;
        if (
          [...records.values()].some(
            (record) =>
              record.siteId === reservation.siteId &&
              record.quoteId === reservation.quoteId,
          )
        )
          throw new GiftCheckoutServiceError("REQUEST_CONFLICT");
        const closedReason =
          Date.parse(reservation.quoteSnapshot.expiresAt) <=
          Date.parse(reservation.createdAt)
            ? "EXPIRED"
            : "CANCELED";
        const record: GiftCheckoutRecord = {
          ...reservation,
          state: "CLOSED_UNPAID",
          observedAt: reservation.createdAt,
          closedReason,
          checkout: null,
          evidence: {
            source: "backend",
            kind: "PRE_DISPATCH_REJECTION",
            siteId: reservation.siteId,
            quoteId: reservation.quoteId,
            requestId: reservation.requestId,
            orderId: reservation.orderId,
            attemptId: reservation.attemptId,
            recoveryTokenHash: reservation.recoveryTokenHash,
            observedAt: reservation.createdAt,
            noProviderCall: true,
            closedReason,
          },
        };
        records.set(key(record.siteId, record.requestId), record);
        return record;
      }),
      reserve: vi.fn(async (reservation, assertEligible) => {
        const existing = records.get(
          key(reservation.siteId, reservation.requestId),
        );
        if (existing) return { created: false, record: existing };
        if (
          [...records.values()].some(
            (record) =>
              record.siteId === reservation.siteId &&
              record.quoteId === reservation.quoteId,
          )
        ) {
          throw new GiftCheckoutServiceError("REQUEST_CONFLICT");
        }
        assertEligible({
          quoteSnapshot: snapshot,
          receivingContext: context,
          gift,
        });
        const record: GiftCheckoutRecord = {
          ...reservation,
          state: "CREATING",
          observedAt: null,
          closedReason: null,
          checkout: null,
          evidence: null,
        };
        records.set(key(record.siteId, record.requestId), record);
        return { created: true, record };
      }),
      saveHostedCheckout: vi.fn(async (outcome) => {
        const record = records.get(key(outcome.siteId, outcome.requestId));
        if (!record) throw new Error("Missing reservation");
        const saved: GiftCheckoutRecord = {
          ...record,
          state: "AWAITING_PAYMENT",
          observedAt: outcome.observedAt,
          checkout: outcome.checkout,
          evidence: {
            kind: "HOSTED_CHECKOUT",
            source: "provider",
            siteId: record.siteId,
            orderId: record.orderId,
            attemptId: record.attemptId,
            provider: receiving.provider,
            accountReference: receiving.accountReference,
            environment: receiving.environment,
            providerCheckoutReference: outcome.providerReference,
            observedAt: outcome.observedAt,
          },
        };
        records.set(key(saved.siteId, saved.requestId), saved);
        return saved;
      }),
      markOutcomeUnknown: vi.fn(async (identity, observedAt) => {
        const record = records.get(key(identity.siteId, identity.requestId));
        if (record?.state === "CREATING") {
          records.set(key(identity.siteId, identity.requestId), {
            ...record,
            state: "OUTCOME_UNKNOWN",
            observedAt,
          });
        }
      }),
    },
    loadReceivingContext: vi.fn(async () => context),
    findPublishedGift: vi.fn(async () => gift),
    createHostedCheckout: vi.fn(async (command) => {
      const record = records.get(key(command.siteId, command.requestId));
      expect(record?.state).toBe("CREATING");
      expect(record?.attemptId).toBe(command.attemptId);
      return {
        providerReference: "provider-checkout-private",
        checkout: {
          orderId: command.orderId,
          attemptId: command.attemptId,
          quoteId: command.quoteSnapshot.quote.id,
          method: command.quoteSnapshot.quote.method,
          mode: command.quoteSnapshot.quote.mode,
          hostedUrl: "https://sandbox.example.test/checkout/one",
        },
      };
    }),
    now: vi.fn(() => new Date(instant)),
    generateId: vi.fn((kind) => `${kind}-one`),
  };
  return { dependencies, snapshot, context, gift, records, key };
}

describe("quote fee allocation compatibility", () => {
  it("reads a live provider-observed recipient-deducted snapshot without changing its gift total", () => {
    const { snapshot } = fixture();
    snapshot.quote.mode = "live";
    snapshot.receiving.environment = "live";
    snapshot.pricing.environment = "live";
    Object.assign(snapshot.quote, {
      feeAllocation: "RECIPIENT_DEDUCTED",
      totalCents: 10000,
    });
    Object.assign(snapshot.pricing.policy, {
      feeAllocation: "RECIPIENT_DEDUCTED",
      feeBasis: "OBSERVED_ESTIMATE",
    });
    expect(readGiftQuoteSnapshot(snapshot)).toEqual(snapshot);
    const fabricated = structuredClone(snapshot);
    fabricated.pricing.provenance = "local-test";
    expect(() => readGiftQuoteSnapshot(fabricated)).toThrow();
    const surcharge = structuredClone(snapshot);
    delete surcharge.quote.feeAllocation;
    delete surcharge.pricing.policy.feeAllocation;
    surcharge.quote.totalCents = 10200;
    expect(() => readGiftQuoteSnapshot(surcharge)).toThrow();
  });
  it("preserves historical unmarked snapshots without adding a new policy", () => {
    const { snapshot } = fixture();
    expect(readGiftQuoteSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.quote.totalCents).toBe(10200);
  });

  it("retains recipient deductions and rejects mixed or missing allocation markers", () => {
    const { snapshot } = fixture();
    Object.assign(snapshot.quote, {
      totalCents: 10000,
      feeAllocation: "RECIPIENT_DEDUCTED",
    });
    snapshot.pricing.policy.feeAllocation = "RECIPIENT_DEDUCTED";
    expect(readGiftQuoteSnapshot(snapshot)).toEqual(snapshot);
    const mixed = structuredClone(snapshot);
    delete mixed.pricing.policy.feeAllocation;
    expect(() => readGiftQuoteSnapshot(mixed)).toThrow();
    const missing = structuredClone(snapshot);
    delete missing.quote.feeAllocation;
    expect(() => readGiftQuoteSnapshot(missing)).toThrow();
    const inconsistent = structuredClone(snapshot);
    inconsistent.quote.processingCents = 99;
    expect(() => readGiftQuoteSnapshot(inconsistent)).toThrow();
  });
});

describe("durable gift checkout orchestration", () => {
  it("reserves immutable identities and only a capability hash before hosting", async () => {
    const values = fixture();
    const checkout = await createGiftCheckoutService(
      values.dependencies,
    ).createCheckout("site-one", body);
    expect(checkoutResultSchema.safeParse(checkout).success).toBe(true);
    expect(checkout).toEqual({
      orderId: "order-one",
      attemptId: "attempt-one",
      quoteId: "quote-one",
      method: "PIX",
      mode: "sandbox",
      hostedUrl: "https://sandbox.example.test/checkout/one",
    });
    expect(values.dependencies.repository.reserve).toHaveBeenCalledTimes(1);
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    const record = values.records.get(values.key("site-one", body.requestId));
    expect(record?.recoveryTokenHash).toBe(
      createHash("sha256").update(token).digest("hex"),
    );
    expect(record?.state).toBe("AWAITING_PAYMENT");
    expect(record?.quoteSnapshot).toEqual(values.snapshot);
    for (const value of [
      checkout,
      record,
      vi.mocked(values.dependencies.createHostedCheckout).mock.calls,
    ]) {
      expect(JSON.stringify(value)).not.toContain(token);
    }
  });

  it("allows only one creator when concurrent reservations race", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    let release = () => {};
    let announce = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const original = vi
      .mocked(values.dependencies.createHostedCheckout)
      .getMockImplementation();
    vi.mocked(values.dependencies.createHostedCheckout).mockImplementation(
      async (command) => {
        announce();
        await gate;
        if (!original) throw new Error("Missing fixture provider");
        return original(command);
      },
    );
    const completed = Promise.allSettled([
      service.createCheckout("site-one", body),
      service.createCheckout("site-one", body),
    ]);
    await started;
    const status = await service.getStatus("site-one", body);
    expect(status).toMatchObject({
      state: "CREATING",
      mayStartNewAttempt: false,
      checkout: null,
    });
    release();
    const results = await completed;
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(values.records.size).toBe(1);
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it("recovers an awaiting operation before expiry, publication or readiness checks", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    const first = await service.createCheckout("site-one", body);
    values.gift.publicationState = "ARCHIVED";
    values.gift.siteActive = false;
    values.context.mode = "disabled";
    vi.mocked(values.dependencies.now).mockReturnValue(
      new Date("2026-10-13T16:00:00.000Z"),
    );
    vi.mocked(values.dependencies.repository.findQuote).mockClear();
    vi.mocked(values.dependencies.loadReceivingContext).mockClear();
    vi.mocked(required(values.dependencies.findPublishedGift)).mockClear();
    expect(await service.createCheckout("site-one", body)).toEqual(first);
    expect(await service.getStatus("site-one", body)).toMatchObject({
      state: "AWAITING_PAYMENT",
      checkout: first,
      mayStartNewAttempt: false,
    });
    expect(values.dependencies.repository.findQuote).not.toHaveBeenCalled();
    expect(values.dependencies.loadReceivingContext).not.toHaveBeenCalled();
    expect(values.dependencies.findPublishedGift).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it.each([
    { quoteId: "quote-other" },
    { requestId: "request-other" },
    { recoveryToken: Buffer.alloc(32, 9).toString("base64url") },
  ])(
    "denies mismatching recovery identity %o without loading a new quote",
    async (override) => {
      const values = fixture();
      const service = createGiftCheckoutService(values.dependencies);
      await service.createCheckout("site-one", body);
      const record = required(
        values.records.get(values.key("site-one", body.requestId)),
      );
      vi.mocked(values.dependencies.repository.findByRequest).mockResolvedValue(
        record,
      );
      vi.mocked(values.dependencies.repository.findQuote).mockClear();
      for (const operation of [service.createCheckout, service.getStatus]) {
        await expect(
          operation("site-one", { ...body, ...override }),
        ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
      }
      await expect(service.getStatus("site-two", body)).rejects.toMatchObject({
        code: "REQUEST_CONFLICT",
      });
      expect(values.dependencies.repository.findQuote).not.toHaveBeenCalled();
      expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { recoveryToken: undefined },
    { recoveryToken: `${token}=` },
    { recoveryToken: `${"A".repeat(42)}B` },
    { walletId: "browser-wallet" },
    { price: 1 },
    { mode: "live" },
    { method: "PIX" },
  ])(
    "rejects noncanonical or additional caller fields %o",
    async (override) => {
      const values = fixture();
      const service = createGiftCheckoutService(values.dependencies);
      for (const operation of [service.createCheckout, service.getStatus]) {
        await expect(
          operation("site-one", { ...body, ...override }),
        ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
      }
      expect(
        values.dependencies.repository.findByRequest,
      ).not.toHaveBeenCalled();
      expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
    },
  );

  it("does not invent a status for an unknown request", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.repository.findQuote).mockResolvedValue(null);
    await expect(
      createGiftCheckoutService(values.dependencies).getStatus(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(
      values.dependencies.repository.sealUncreatedRequest,
    ).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("durably closes a lost pre-reservation rejection and blocks a delayed original POST", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.now).mockReturnValue(
      new Date(values.snapshot.expiresAt),
    );
    const service = createGiftCheckoutService(values.dependencies);
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    const status = await service.getStatus("site-one", body);
    expect(status).toMatchObject({
      state: "CLOSED_UNPAID",
      closedReason: "EXPIRED",
      mayStartNewAttempt: true,
      checkout: null,
    });
    expect(
      values.dependencies.repository.sealUncreatedRequest,
    ).toHaveBeenCalledTimes(1);
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("returns an existing commitment if reserve wins the status-sealing race", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    await service.createCheckout("site-one", body);
    vi.mocked(
      values.dependencies.repository.findByRequest,
    ).mockResolvedValueOnce(null);
    const status = await service.getStatus("site-one", body);
    expect(status.state).toBe("AWAITING_PAYMENT");
    expect(status.mayStartNewAttempt).toBe(false);
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it("seals an uncreated valid quote before any provider call", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    expect(await service.getStatus("site-one", body)).toMatchObject({
      state: "CLOSED_UNPAID",
      closedReason: "CANCELED",
      mayStartNewAttempt: true,
    });
    await expect(
      service.createCheckout("site-one", body),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    await expect(
      service.getStatus("site-one", {
        ...body,
        recoveryToken: Buffer.alloc(32, 8).toString("base64url"),
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it.each([
    "requestId",
    "quoteId",
    "orderId",
    "attemptId",
    "recoveryTokenHash",
    "observedAt",
    "noProviderCall",
    "closedReason",
  ])("does not unlock from malformed pre-dispatch proof: %s", async (field) => {
    const values = fixture();
    const original = vi
      .mocked(values.dependencies.repository.sealUncreatedRequest)
      .getMockImplementation();
    vi.mocked(
      values.dependencies.repository.sealUncreatedRequest,
    ).mockImplementation(async (reservation) => {
      const record = await required(original)(reservation);
      return {
        ...record,
        evidence: { ...record.evidence, [field]: null },
      } as GiftCheckoutRecord;
    });
    await expect(
      createGiftCheckoutService(values.dependencies).getStatus(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
  });

  it("rejects a new checkout from an expired quote", async () => {
    const values = fixture();
    values.snapshot.quote.expiresAt = instant;
    Object.assign(values.snapshot, {
      expiresAt: instant,
      createdAt: "2026-10-12T15:59:40.000Z",
    });
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
    expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it.each([
    { accountReference: "account-new" },
    { recipientReference: "recipient-new" },
    { provider: "another-provider" },
    { operatorReference: "operator-new" },
    { bankReference: "bank-new" },
    { destinationVersion: 2 },
  ])(
    "requires current READY evidence to match the quote binding %o",
    async (override) => {
      const values = fixture();
      Object.assign(required(values.context.providerBinding), override);
      Object.assign(required(values.context.evidence), override);
      await expect(
        createGiftCheckoutService(values.dependencies).createCheckout(
          "site-one",
          body,
        ),
      ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
      expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
      expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
    },
  );

  it("denies an archived gift in the locked eligibility recheck", async () => {
    const values = fixture();
    const original = required(
      vi.mocked(values.dependencies.repository.reserve).getMockImplementation(),
    );
    vi.mocked(values.dependencies.repository.reserve).mockImplementation(
      async (reservation, validate) => {
        values.gift.publicationState = "ARCHIVED";
        return original(reservation, validate);
      },
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
    expect(values.records.size).toBe(0);
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("rejects a different immutable quote returned under the reservation lock", async () => {
    const values = fixture();
    const original = required(
      vi.mocked(values.dependencies.repository.reserve).getMockImplementation(),
    );
    vi.mocked(values.dependencies.repository.reserve).mockImplementation(
      async (reservation, validate) =>
        original(reservation, (locked) => {
          const altered = structuredClone(locked.quoteSnapshot);
          altered.quote.title = "Another frozen title";
          altered.gift.title = "Another frozen title";
          validate({ ...locked, quoteSnapshot: altered });
        }),
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("requires the reservation's locked callback before a winner can call the provider", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.repository.reserve).mockImplementation(
      async (reservation) => ({
        created: true,
        record: {
          ...reservation,
          state: "CREATING",
          observedAt: null,
          checkout: null,
          evidence: null,
          closedReason: null,
        },
      }),
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("rejects different winner identities before hosting", async () => {
    const values = fixture();
    const original = required(
      vi.mocked(values.dependencies.repository.reserve).getMockImplementation(),
    );
    vi.mocked(values.dependencies.repository.reserve).mockImplementation(
      async (reservation, validate) => {
        const result = await original(reservation, validate);
        return {
          ...result,
          record: { ...result.record, orderId: "other-order" },
        };
      },
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it.each(["provider error", "saving error", "saving and marking error"])(
    "retains commitments and refuses automatic retry after %s",
    async (failure) => {
      const values = fixture();
      if (failure === "provider error")
        vi.mocked(values.dependencies.createHostedCheckout).mockRejectedValue(
          new Error("Lost response"),
        );
      else
        vi.mocked(
          values.dependencies.repository.saveHostedCheckout,
        ).mockRejectedValue(new Error("Lost durable outcome"));
      if (failure === "saving and marking error")
        vi.mocked(
          values.dependencies.repository.markOutcomeUnknown,
        ).mockRejectedValue(new Error("Storage unavailable"));
      const service = createGiftCheckoutService(values.dependencies);
      for (let retry = 0; retry < 2; retry += 1) {
        await expect(
          service.createCheckout("site-one", body),
        ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      }
      const status = await service.getStatus("site-one", body);
      expect(["CREATING", "OUTCOME_UNKNOWN"]).toContain(status.state);
      expect(status.mayStartNewAttempt).toBe(false);
      expect(values.records.size).toBe(1);
      expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    { method: "CREDIT_CARD" },
    { quoteId: "another-quote" },
    { orderId: "another-order" },
    { attemptId: "another-attempt" },
    { mode: "live" },
    { hostedUrl: "http://unsafe.example.test" },
    { apiKey: "private-key" },
    { hostedUrl: `https://sandbox.example.test/${token}` },
  ])(
    "does not persist mismatching or unsafe hosted projection %o",
    async (override) => {
      const values = fixture();
      const original = required(
        vi
          .mocked(values.dependencies.createHostedCheckout)
          .getMockImplementation(),
      );
      vi.mocked(values.dependencies.createHostedCheckout).mockImplementation(
        async (command) => {
          const hosted = await original(command);
          return {
            ...hosted,
            checkout: { ...hosted.checkout, ...override },
          } as GiftHostedCheckout;
        },
      );
      await expect(
        createGiftCheckoutService(values.dependencies).createCheckout(
          "site-one",
          body,
        ),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(
        values.dependencies.repository.saveHostedCheckout,
      ).not.toHaveBeenCalled();
      expect(
        values.records.get(values.key("site-one", body.requestId))?.state,
      ).toBe("OUTCOME_UNKNOWN");
    },
  );

  it("denies a blank provider reference before persisting the hosted outcome", async () => {
    const values = fixture();
    const original = required(
      vi
        .mocked(values.dependencies.createHostedCheckout)
        .getMockImplementation(),
    );
    vi.mocked(values.dependencies.createHostedCheckout).mockImplementation(
      async (command) => ({
        ...(await original(command)),
        providerReference: "",
      }),
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(
      values.dependencies.repository.saveHostedCheckout,
    ).not.toHaveBeenCalled();
  });

  it("keeps an uncertain operation locked if the clock fails after a provider call", async () => {
    const values = fixture();
    const original = required(
      vi
        .mocked(values.dependencies.createHostedCheckout)
        .getMockImplementation(),
    );
    vi.mocked(values.dependencies.createHostedCheckout).mockImplementation(
      async (command) => {
        const result = await original(command);
        vi.mocked(values.dependencies.now).mockReturnValue(
          new Date(Number.NaN),
        );
        return result;
      },
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    expect(values.records.size).toBe(1);
  });

  it("returns only detached public status and checkout fields", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    const result = await service.createCheckout("site-one", body);
    result.hostedUrl = "https://changed.example.test";
    const status = await service.getStatus("site-one", body);
    expect(checkoutStatusSchema.safeParse(status).success).toBe(true);
    expect(status.checkout?.hostedUrl).toBe(
      "https://sandbox.example.test/checkout/one",
    );
    const text = JSON.stringify(status);
    for (const privateValue of [
      token,
      "recoveryTokenHash",
      "account-private",
      "recipient-private",
      "operator-private",
      "bank-private",
      "provider-checkout-private",
    ]) {
      expect(text).not.toContain(privateValue);
    }
  });

  it.each([
    token,
    Array.from(token)
      .map((character) => `%${character.charCodeAt(0).toString(16)}`)
      .join(""),
  ])(
    "denies a persisted capability-bearing hosted URL during every recovery",
    async (embeddedToken) => {
      const values = fixture();
      const service = createGiftCheckoutService(values.dependencies);
      await service.createCheckout("site-one", body);
      const record = required(
        values.records.get(values.key("site-one", body.requestId)),
      );
      required(record.checkout).hostedUrl =
        `https://sandbox.example.test/checkout?private=${embeddedToken}`;
      for (const operation of [service.getStatus, service.createCheckout]) {
        await expect(operation("site-one", body)).rejects.toMatchObject({
          code: "EXTERNAL_OUTCOME_UNKNOWN",
        });
      }
      expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["CONFIRMED", "RECEIVED", "CLOSED_UNPAID", "REFUNDED"] as const)(
    "does not trust %s without durable terminal evidence",
    async (state) => {
      const values = fixture();
      const service = createGiftCheckoutService(values.dependencies);
      await service.createCheckout("site-one", body);
      const record = required(
        values.records.get(values.key("site-one", body.requestId)),
      );
      values.records.set(values.key("site-one", body.requestId), {
        ...record,
        state,
        checkout: null,
        evidence: null,
        closedReason: state === "CLOSED_UNPAID" ? "EXPIRED" : null,
      });
      await expect(service.getStatus("site-one", body)).rejects.toMatchObject({
        code: "EXTERNAL_OUTCOME_UNKNOWN",
      });
      await expect(
        service.createCheckout("site-one", body),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "PAYMENT_CONFIRMATION",
    "SETTLEMENT",
    "CLOSED_UNPAID",
    "REFUND",
  ] as const)(
    "projects recorded %s evidence and never rehosts the same request",
    async (kind) => {
      const values = fixture();
      const service = createGiftCheckoutService(values.dependencies);
      await service.createCheckout("site-one", body);
      const record = required(
        values.records.get(values.key("site-one", body.requestId)),
      );
      const evidence = {
        ...required(record.evidence),
        kind,
        providerPaymentReference: "payment-private",
        providerEventReference: "event-private",
        eventId: "event-one",
        providerRefundReference: "refund-private",
        ledgerEntryId: "ledger-one",
        noOutstandingPayment: true,
        closedReason: "EXPIRED",
      } as GiftCheckoutEvidence;
      const state =
        kind === "PAYMENT_CONFIRMATION"
          ? "CONFIRMED"
          : kind === "SETTLEMENT"
            ? "RECEIVED"
            : kind === "REFUND"
              ? "REFUNDED"
              : "CLOSED_UNPAID";
      values.records.set(values.key("site-one", body.requestId), {
        ...record,
        state,
        evidence,
        checkout: null,
        closedReason: state === "CLOSED_UNPAID" ? "EXPIRED" : null,
      });
      expect(await service.getStatus("site-one", body)).toMatchObject({
        state,
        mayStartNewAttempt: state === "CLOSED_UNPAID",
        checkout: null,
      });
      await expect(
        service.createCheckout("site-one", body),
      ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
      expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it("rejects provider checkout completion as settlement proof", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    await service.createCheckout("site-one", body);
    const record = required(
      values.records.get(values.key("site-one", body.requestId)),
    );
    values.records.set(values.key("site-one", body.requestId), {
      ...record,
      state: "RECEIVED",
      checkout: null,
    });
    await expect(service.getStatus("site-one", body)).rejects.toMatchObject({
      code: "EXTERNAL_OUTCOME_UNKNOWN",
    });
  });

  it.each([
    { kind: "HOSTED_CHECKOUT" },
    { providerPaymentReference: "" },
    { providerEventReference: "" },
    { eventId: "" },
    { accountReference: "foreign-account" },
    { attemptId: "foreign-attempt" },
    { observedAt: "2026-10-12T12:00:00.000Z" },
  ])(
    "rejects incomplete or unbound card confirmation proof %o",
    async (override) => {
      const values = fixture();
      const service = createGiftCheckoutService(values.dependencies);
      await service.createCheckout("site-one", body);
      const record = required(
        values.records.get(values.key("site-one", body.requestId)),
      );
      values.records.set(values.key("site-one", body.requestId), {
        ...record,
        state: "CONFIRMED",
        checkout: null,
        evidence: {
          ...required(record.evidence),
          kind: "PAYMENT_CONFIRMATION",
          providerPaymentReference: "payment-private",
          providerEventReference: "event-private",
          eventId: "event-one",
          ...override,
        } as GiftCheckoutEvidence,
      });
      await expect(service.getStatus("site-one", body)).rejects.toMatchObject({
        code: "EXTERNAL_OUTCOME_UNKNOWN",
      });
      expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes repository failures without exposing raw error causes", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.repository.findByRequest).mockRejectedValue(
      new Error(`Raw storage failure ${token} account-private`),
    );
    try {
      await createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      );
      throw new Error("Expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(GiftCheckoutServiceError);
      expect((error as Error).cause).toBeUndefined();
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).message).not.toContain("account-private");
    }
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("keeps the repository's quote claim when a different request targets the same quote", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    await service.createCheckout("site-one", body);
    await expect(
      service.createCheckout("site-one", {
        ...body,
        requestId: "another-request",
      }),
    ).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
    expect(values.records.size).toBe(1);
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it("denies absent authoritative receiving context", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.loadReceivingContext).mockResolvedValue(null);
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("denies demo/live even with provider-backed approval", async () => {
    const values = fixture();
    values.context.isDemo = true;
    values.context.mode = "live";
    required(values.context.providerBinding).environment = "live";
    required(values.context.evidence).environment = "live";
    values.snapshot.quote.mode = "live";
    values.snapshot.receiving.environment = "live";
    values.snapshot.pricing.environment = "live";
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "RECEIVING_NOT_READY" });
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("does not reuse local-test pricing for a real sandbox wedding", async () => {
    const values = fixture();
    values.snapshot.pricing.provenance = "local-test";
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
    expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("uses the current clock after asynchronous authoritative loading", async () => {
    const values = fixture();
    const freshInstant = "2026-10-12T16:00:20.000Z";
    vi.mocked(values.dependencies.loadReceivingContext).mockImplementation(
      async () => {
        vi.mocked(values.dependencies.now).mockReturnValue(
          new Date(freshInstant),
        );
        required(values.context.evidence).observedAt = new Date(freshInstant);
        required(values.context.evidence).bankObservedAt = new Date(
          freshInstant,
        );
        return values.context;
      },
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).resolves.toMatchObject({ attemptId: "attempt-one" });
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it("retains a reservation if readiness expires before the provider call", async () => {
    const values = fixture();
    const original = required(
      vi.mocked(values.dependencies.repository.reserve).getMockImplementation(),
    );
    vi.mocked(values.dependencies.repository.reserve).mockImplementation(
      async (reservation, validate) => {
        const result = await original(reservation, validate);
        vi.mocked(values.dependencies.now).mockReturnValue(
          new Date("2026-10-12T16:00:30.001Z"),
        );
        return result;
      },
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
    expect(values.dependencies.repository.reserve).toHaveBeenCalledTimes(1);
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
    expect(
      values.records.get(values.key("site-one", body.requestId))?.state,
    ).toBe("OUTCOME_UNKNOWN");
  });

  it.each([
    { accountReference: "different-account" },
    { environment: "live" },
    { siteId: "another-site" },
    { attemptId: "another-attempt" },
    { ledgerEntryId: "" },
    { providerPaymentReference: "" },
    { source: "browser" },
  ])("refuses inconsistent settlement proof %o", async (override) => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    await service.createCheckout("site-one", body);
    const record = required(
      values.records.get(values.key("site-one", body.requestId)),
    );
    values.records.set(values.key("site-one", body.requestId), {
      ...record,
      state: "RECEIVED",
      checkout: null,
      evidence: {
        ...required(record.evidence),
        kind: "SETTLEMENT",
        providerPaymentReference: "payment-one",
        ledgerEntryId: "ledger-one",
        ...override,
      } as GiftCheckoutEvidence,
    });
    await expect(service.getStatus("site-one", body)).rejects.toMatchObject({
      code: "EXTERNAL_OUTCOME_UNKNOWN",
    });
    expect(values.dependencies.createHostedCheckout).toHaveBeenCalledTimes(1);
  });

  it("does not unlock a closed checkout without absence-of-payment proof", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    await service.createCheckout("site-one", body);
    const record = required(
      values.records.get(values.key("site-one", body.requestId)),
    );
    values.records.set(values.key("site-one", body.requestId), {
      ...record,
      state: "CLOSED_UNPAID",
      closedReason: "EXPIRED",
      checkout: null,
      evidence: {
        ...required(record.evidence),
        kind: "CLOSED_UNPAID",
        closedReason: "EXPIRED",
        noOutstandingPayment: false,
      } as unknown as GiftCheckoutEvidence,
    });
    await expect(service.getStatus("site-one", body)).rejects.toMatchObject({
      code: "EXTERNAL_OUTCOME_UNKNOWN",
    });
  });

  it("refuses future persisted observations", async () => {
    const values = fixture();
    const service = createGiftCheckoutService(values.dependencies);
    await service.createCheckout("site-one", body);
    const record = required(
      values.records.get(values.key("site-one", body.requestId)),
    );
    const future = "2026-10-12T16:00:00.001Z";
    values.records.set(values.key("site-one", body.requestId), {
      ...record,
      observedAt: future,
      evidence: { ...required(record.evidence), observedAt: future },
    });
    await expect(service.getStatus("site-one", body)).rejects.toMatchObject({
      code: "EXTERNAL_OUTCOME_UNKNOWN",
    });
  });

  it("freezes provider inputs and preserves an immutable snapshot after source edits", async () => {
    const values = fixture();
    const original = required(
      vi
        .mocked(values.dependencies.createHostedCheckout)
        .getMockImplementation(),
    );
    vi.mocked(values.dependencies.createHostedCheckout).mockImplementation(
      async (command) => {
        expect(Object.isFrozen(command)).toBe(true);
        expect(Object.isFrozen(command.quoteSnapshot.quote)).toBe(true);
        expect(Object.isFrozen(command.quoteSnapshot.pricing.policy)).toBe(
          true,
        );
        values.snapshot.quote.title = "Edited after reservation";
        values.snapshot.gift.title = "Edited after reservation";
        values.snapshot.pricing.policy.processingFixedCents = 1;
        expect(command.quoteSnapshot.quote.title).toBe("Symbolic trip");
        return original(command);
      },
    );
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).resolves.toMatchObject({ quoteId: "quote-one" });
    expect(
      values.records.get(values.key("site-one", body.requestId))?.quoteSnapshot
        .quote.title,
    ).toBe("Symbolic trip");
  });

  it("rejects a future-created immutable quote before reservation", async () => {
    const values = fixture();
    Object.assign(values.snapshot, { createdAt: "2026-10-12T16:00:00.001Z" });
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
    expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });

  it("rejects invalid generated references before writing a durable reservation", async () => {
    const values = fixture();
    vi.mocked(values.dependencies.generateId).mockReturnValue("invalid id");
    await expect(
      createGiftCheckoutService(values.dependencies).createCheckout(
        "site-one",
        body,
      ),
    ).rejects.toMatchObject({ code: "QUOTE_INVALID" });
    expect(values.dependencies.repository.reserve).not.toHaveBeenCalled();
    expect(values.dependencies.createHostedCheckout).not.toHaveBeenCalled();
  });
});
