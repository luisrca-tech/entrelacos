import type {
  GiftPurchaseHistoryDetailPage,
  GiftPurchaseHistoryPage,
  GiftPurchaseHistoryPayment,
  GiftPurchaseHistoryPurchase,
  GiftPurchaseHistoryReceipt,
  MeResponse,
  SiteAccess,
} from "@entrelacos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGiftPaymentHistoryHttpRouter } from "../../../api/src/giftPaymentHistoryHttp";
import { ApiError } from "../lib/apiClient";
import { proxyApiRequest } from "../server/apiProxy";
import {
  createGiftPaymentHistoryController,
  createGiftPaymentHistorySession,
  type HistoryPorts,
} from "./giftPaymentHistory";
import { createPanelActorOwner } from "./panelActor";

const now = Date.parse("2026-10-13T16:00:00Z");
const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "member-a",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: false,
  },
};
const actor: MeResponse = {
  user: {
    id: "admin-a",
    name: "Admin",
    email: "admin@example.test",
    role: "SITE_ADMIN",
  },
  session: { id: "session-a", expiresAt: "2026-10-20T16:00:00Z" },
  siteId: access.siteId,
  memberships: [access],
};
function purchase(
  orderId = "order-z",
  purchasedAtMicros = "100",
): GiftPurchaseHistoryPurchase {
  return {
    siteId: access.siteId,
    mode: "sandbox",
    orderId,
    quoteId: `quote-${orderId}`,
    giftId: "gift-a",
    titleSnapshot: "Presente original",
    method: "PIX",
    currency: "BRL",
    purchasedAtMicros,
    destinationVersion: 1,
    policyVersion: "policy-a",
    binding: "AVAILABLE",
    quoted: {
      nominalCents: 10000,
      commissionCents: 1000,
      processingCents: 0,
      totalCents: 11000,
    },
  };
}
function page(
  items = [purchase()],
  nextCursor: string | null = null,
): GiftPurchaseHistoryPage {
  return {
    scope: { siteId: access.siteId, mode: "sandbox", policy: "SITE_HISTORY" },
    consistency: "PER_READ",
    readObservedAtMicros: "10000",
    currentKnowledge: "UNKNOWN",
    sourceOrdering: "UNAVAILABLE",
    items,
    nextCursor,
  };
}
function payment(
  overrides: Partial<GiftPurchaseHistoryPayment> = {},
): GiftPurchaseHistoryPayment {
  return {
    paymentId: "payment-a",
    attemptId: "attempt-a",
    orderId: "order-z",
    currency: "BRL",
    recordedState: "RECEIVED",
    createdAtMicros: "200",
    observedAtMicros: "300",
    grossCents: 11000,
    commissionCents: 1000,
    processingCents: 0,
    recipientNetCents: 10000,
    ...overrides,
  };
}
function receipt(
  overrides: Partial<GiftPurchaseHistoryReceipt> = {},
): GiftPurchaseHistoryReceipt {
  return {
    effectId: "effect-a",
    paymentId: "payment-a",
    orderId: "order-z",
    currency: "BRL",
    recipientCreditCents: 10000,
    postedAtMicros: "400",
    sourceObservedAtMicros: "300",
    source: "CORRELATED_STORED_POSTING",
    ...overrides,
  };
}
function detail(
  overrides: Partial<GiftPurchaseHistoryDetailPage> = {},
): GiftPurchaseHistoryDetailPage {
  const { items: _items, ...envelope } = page();
  return {
    ...envelope,
    originalPurchase: purchase(),
    coverage: {
      payments: "AVAILABLE",
      receipts: "AVAILABLE",
      reversals: "UNAVAILABLE",
      bankSettlement: "UNAVAILABLE",
    },
    retainedPayments: [payment()],
    validatedHistoricalReceipts: [receipt()],
    ...overrides,
  };
}
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
async function fixture(
  request: NonNullable<HistoryPorts["request"]> = vi.fn(async () => ({
    history: page(),
  })),
) {
  const owner = createPanelActorOwner({
    request: async () => structuredClone(actor),
    now: () => now,
  });
  await owner.load();
  const scope = {
    siteId: access.siteId,
    access: structuredClone(access) as SiteAccess | null,
    sessionEpoch: owner.getSnapshot().sessionEpoch,
  };
  const ports = { owner, request, now: () => now };
  const onState = vi.fn();
  const session = createGiftPaymentHistorySession();
  const controller = createGiftPaymentHistoryController(
    scope,
    onState,
    ports,
    session,
  );
  cleanups.push(() => {
    controller.dispose();
    owner.dispose();
  });
  return { controller, owner, scope, ports, request, onState, session };
}

describe("private gift payment history", () => {
  it("admits an exact C1 page only through a verified current native owner", async () => {
    const f = await fixture();
    expect(await f.controller.loadFirstIndex()).toBe(true);
    expect(f.controller.getState()).toMatchObject({
      status: "ready",
      purchases: [purchase()],
    });
    expect(f.request).toHaveBeenCalledWith(
      "/v1/sites/wedding-a/finance/purchases",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
  it.each([
    null,
    { ...access, siteId: "foreign" },
    { ...access, userId: "other" },
    { ...access, membershipRole: "OWNER" },
    { ...access, membershipRole: "SITE_ASSISTANT" },
    { ...access, membershipId: null },
    { ...access, capabilities: { ...access.capabilities, readFinance: false } },
  ])("denies forged or missing props without dispatch", async (candidate) => {
    const f = await fixture();
    f.scope.access = candidate as SiteAccess | null;
    expect(await f.controller.loadFirstIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([]);
    expect(f.request).not.toHaveBeenCalled();
  });
  it("denies an unverified owner and stale epoch, regardless of props", async () => {
    const f = await fixture();
    f.owner.invalidate(false);
    expect(await f.controller.loadFirstIndex()).toBe(false);
    const other = createGiftPaymentHistoryController(
      { ...f.scope, sessionEpoch: 99 },
      vi.fn(),
      f.ports,
    );
    cleanups.push(() => other.dispose());
    expect(await other.loadFirstIndex()).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([
    { ...page(), scope: { ...page().scope, siteId: "foreign" } },
    { ...page(), currentKnowledge: "KNOWN" },
    {
      ...page(),
      items: Array.from({ length: 26 }, (_, i) =>
        purchase(`order-${26 - i}`, String(200 - i)),
      ),
    },
    { ...page(), privateAccount: "secret" },
  ])("rejects invalid C1 without partial admission", async (history) => {
    const f = await fixture(vi.fn(async () => ({ history })));
    expect(await f.controller.loadFirstIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([]);
  });
  it("keeps a receipt-only page through missing, unavailable, failure, retry and both restarts", async () => {
    let reply: unknown = { history: page() };
    let fail = false;
    const f = await fixture(
      vi.fn(async () => {
        if (fail) throw new Error("private diagnostic");
        return reply;
      }),
    );
    await f.controller.loadFirstIndex();
    reply = { history: detail({ retainedPayments: [] }) };
    expect(await f.controller.openPurchase("order-z")).toBe(true);
    expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
    reply = {
      history: detail({
        retainedPayments: [],
        validatedHistoricalReceipts: [],
      }),
    };
    await f.controller.restartDetail("order-z");
    expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
    reply = {
      history: detail({
        retainedPayments: [],
        validatedHistoricalReceipts: [],
        currentKnowledge: "UNAVAILABLE",
        coverage: {
          ...detail().coverage,
          payments: "UNAVAILABLE",
          receipts: "UNAVAILABLE",
        },
      }),
    };
    await f.controller.restartDetail("order-z");
    expect(f.controller.getState().detail?.coverage.receipts).toBe(
      "UNAVAILABLE",
    );
    expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
    fail = true;
    expect(await f.controller.restartDetail("order-z")).toBe(false);
    expect(await f.controller.retryFailedRead()).toBe(false);
    expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
    fail = false;
    reply = { history: page([], null) };
    await f.controller.restartIndex();
    reply = {
      history: detail({
        retainedPayments: [],
        validatedHistoricalReceipts: [],
      }),
    };
    await f.controller.openPurchase("order-z");
    expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
  });
  it("retains incomparable samples beside historical receipts without validating an invented aggregate", async () => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = { history: detail() };
    await f.controller.openPurchase("order-z");
    for (const observedAtMicros of ["300", "700", "250"]) {
      reply = {
        history: detail({
          readObservedAtMicros: "9000",
          retainedPayments: [
            payment({
              recordedState: "RESTRICTED",
              observedAtMicros,
              grossCents: 7000,
              recipientNetCents: 6000,
            }),
          ],
          validatedHistoricalReceipts: [],
        }),
      };
      expect(await f.controller.restartDetail("order-z")).toBe(true);
    }
    const state = f.controller.getState();
    expect(state.detail?.samples).toHaveLength(4);
    expect(state.detail?.samples[0]).toEqual(payment());
    expect(state.detail?.receipts).toEqual([receipt()]);
    expect(state.detail?.currentKnowledge).toBe("UNKNOWN");
    expect(JSON.stringify(state)).not.toMatch(/balance|refundable|:"KNOWN"/);
  });
  it.each([
    { titleSnapshot: "Changed" },
    { giftId: "gift-b" },
    { quoteId: "quote-new" },
    { destinationVersion: 2 },
    { policyVersion: "policy-new" },
    { method: "CREDIT_CARD" },
  ])("quarantines changed purchase fields atomically", async (changes) => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = {
      history: page([
        { ...purchase(), ...changes } as GiftPurchaseHistoryPurchase,
        purchase("order-a", "50"),
      ]),
    };
    expect(await f.controller.restartIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([purchase()]);
    expect(f.controller.getState().status).toBe("conflict");
  });
  it("compares parsed field values independently of input key order", async () => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    const reordered = Object.fromEntries(Object.entries(purchase()).reverse());
    reply = { history: { ...page(), items: [reordered] } };
    expect(await f.controller.restartIndex()).toBe(true);
    expect(f.controller.getState().purchases).toHaveLength(1);
  });
  it("rejects cross-page quote collisions and retains the original floor", async () => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = {
      history: page([
        { ...purchase("order-a", "50"), quoteId: purchase().quoteId },
      ]),
    };
    expect(await f.controller.restartIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([purchase()]);
  });
  it.each([
    { effectId: "effect-b" },
    { postedAtMicros: "401" },
    { sourceObservedAtMicros: "301" },
    { paymentId: "payment-b" },
  ])(
    "rejects receipt identity or credited-payment contradictions without partial updates",
    async (changes) => {
      let reply: unknown = { history: page() };
      const f = await fixture(vi.fn(async () => reply));
      await f.controller.loadFirstIndex();
      reply = { history: detail({ retainedPayments: [] }) };
      await f.controller.openPurchase("order-z");
      reply = {
        history: detail({
          retainedPayments: [],
          validatedHistoricalReceipts: [receipt(changes)],
        }),
      };
      expect(await f.controller.restartDetail("order-z")).toBe(false);
      expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
    },
  );
  it("rejects cross-purchase payment/effect/attempt associations", async () => {
    let reply: unknown = {
      history: page([purchase(), purchase("order-a", "50")]),
    };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = { history: detail() };
    await f.controller.openPurchase("order-z");
    reply = {
      history: detail({
        originalPurchase: purchase("order-a", "50"),
        retainedPayments: [payment({ orderId: "order-a" })],
        validatedHistoricalReceipts: [receipt({ orderId: "order-a" })],
      }),
    };
    expect(await f.controller.openPurchase("order-a")).toBe(false);
    expect(f.controller.getState().status).toBe("conflict");
  });
  it("requires a known purchase and opaque privately issued cursor, with no auto traversal", async () => {
    const request = vi.fn(async () => ({ history: page([], "gh1.next") }));
    const f = await fixture(request);
    expect(await f.controller.openPurchase("unknown")).toBe(false);
    expect(await f.controller.loadFirstIndex()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(await f.controller.loadMoreIndex("foreign")).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
    request.mockResolvedValueOnce({ history: page([], "gh1.next") });
    expect(await f.controller.loadMoreIndex("gh1.next")).toBe(false);
    expect(f.controller.getState().nextIndexCursor).toBe("gh1.next");
  });
  it("enforces index cross-page descending boundaries", async () => {
    let reply: unknown = { history: page([purchase()], "gh1.1") };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = { history: page([purchase("order-new", "150")]) };
    expect(await f.controller.loadMoreIndex("gh1.1")).toBe(false);
    expect(f.controller.getState().purchases).toEqual([purchase()]);
    reply = { history: page([purchase("order-a", "100")]) };
    expect(await f.controller.retryFailedRead()).toBe(true);
    expect(f.controller.getState().purchases.map((p) => p.orderId)).toEqual([
      "order-z",
      "order-a",
    ]);
  });
  it("enforces public detail micros/kind/local-ID boundaries without observation chronology", async () => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = {
      history: detail({
        retainedPayments: [payment({ createdAtMicros: "400" })],
        validatedHistoricalReceipts: [],
        nextCursor: "gh1.1",
      }),
    };
    await f.controller.openPurchase("order-z");
    reply = {
      history: detail({
        retainedPayments: [],
        validatedHistoricalReceipts: [receipt()],
      }),
    };
    expect(await f.controller.loadMoreDetail("order-z", "gh1.1")).toBe(true);
    reply = {
      history: detail({
        retainedPayments: [payment()],
        validatedHistoricalReceipts: [],
        nextCursor: "gh1.2",
      }),
    };
    await f.controller.restartDetail("order-z");
    reply = {
      history: detail({
        retainedPayments: [
          payment({
            paymentId: "payment-0",
            attemptId: "attempt-0",
            createdAtMicros: "200",
          }),
        ],
        validatedHistoricalReceipts: [],
      }),
    };
    expect(await f.controller.loadMoreDetail("order-z", "gh1.2")).toBe(false);
  });
  it("charges64 dispatched reads including failures/duplicates and denies65 before restart mutates bookkeeping", async () => {
    let reply: unknown = { history: page([purchase()], "gh1.first") };
    let failure = false;
    const request = vi.fn(async () => {
      if (failure) throw new Error("unavailable");
      return reply;
    });
    const f = await fixture(request);
    await f.controller.loadFirstIndex();
    for (let i = 1; i < 64; i++) {
      failure = i % 3 === 0;
      reply = { history: page([purchase()], `gh1.${i}`) };
      await f.controller.restartIndex();
    }
    const before = f.controller.getState();
    expect(before.admissions).toBe(64);
    expect(await f.controller.restartIndex()).toBe(false);
    expect(await f.controller.retryFailedRead()).toBe(false);
    expect(request).toHaveBeenCalledTimes(64);
    expect(f.controller.getState()).toMatchObject({
      status: "local_limit",
      admissions: 64,
      purchases: before.purchases,
      nextIndexCursor: before.nextIndexCursor,
    });
  });
  it("preserves holder facts/admissions through same-owner controller and port replacement", async () => {
    const f = await fixture();
    await f.controller.loadFirstIndex();
    f.controller.dispose();
    const next = createGiftPaymentHistoryController(
      f.scope,
      vi.fn(),
      { ...f.ports, request: vi.fn(async () => ({ history: page([]) })) },
      f.session,
    );
    cleanups.push(() => next.dispose());
    expect(next.getState()).toMatchObject({
      purchases: [purchase()],
      admissions: 1,
    });
    expect(await next.loadFirstIndex()).toBe(false);
    expect(await next.restartIndex()).toBe(true);
    expect(next.getState()).toMatchObject({
      purchases: [purchase()],
      admissions: 2,
    });
  });
  it("masks and discards facts synchronously on native scope replacement", async () => {
    const f = await fixture();
    await f.controller.loadFirstIndex();
    f.owner.invalidate(false);
    expect(f.controller.getState()).toMatchObject({
      status: "denied",
      purchases: [],
      detail: null,
      admissions: 0,
    });
    await f.owner.load();
    const nextScope = {
      ...f.scope,
      sessionEpoch: f.owner.getSnapshot().sessionEpoch,
    };
    const next = createGiftPaymentHistoryController(
      nextScope,
      vi.fn(),
      f.ports,
      f.session,
    );
    cleanups.push(() => next.dispose());
    expect(next.getState().purchases).toEqual([]);
    expect(await next.loadFirstIndex()).toBe(true);
    expect(next.getState().admissions).toBe(1);
  });
  it("holds actual deferred client work after disposal and masks obsolete401", async () => {
    let reject!: (cause: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise<unknown>((_resolve, no) => {
          reject = no;
        }),
    );
    const f = await fixture(request);
    const work = f.controller.loadFirstIndex();
    f.controller.dispose();
    const drained = vi.fn();
    void f.controller.whenSettled().then(drained);
    const next = createGiftPaymentHistoryController(
      f.scope,
      vi.fn(),
      f.ports,
      f.session,
    );
    cleanups.push(() => next.dispose());
    expect(await next.restartIndex()).toBe(false);
    expect(drained).not.toHaveBeenCalled();
    reject(new ApiError(401, "UNAUTHENTICATED"));
    await work;
    await f.controller.whenSettled();
    expect(f.owner.getSnapshot().status).toBe("verified");
    expect(drained).toHaveBeenCalledTimes(1);
    expect(next.getState().admissions).toBe(1);
  });
  it("reports only current native401/403 through the captured owner", async () => {
    const f = await fixture(
      vi.fn(async () => {
        throw new ApiError(403, "FORBIDDEN");
      }),
    );
    expect(await f.controller.loadFirstIndex()).toBe(false);
    expect(f.owner.getSnapshot().status).toBe("denied");
    expect(f.controller.getState().purchases).toEqual([]);
  });
  it.each(["owner", "request", "now"] as const)(
    "fences synchronous %s port changes",
    async (name) => {
      const f = await fixture();
      const original = f.ports[name];
      Object.defineProperty(f.ports, name, {
        configurable: true,
        get() {
          f.owner.invalidate(false);
          return original;
        },
      });
      expect(await f.controller.loadFirstIndex()).toBe(false);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.controller.getState().purchases).toEqual([]);
    },
  );
  it("fences clock expiry, rewind and mutations in onState before commit", async () => {
    const f = await fixture();
    await f.controller.loadFirstIndex();
    f.ports.now = () => 0;
    expect(await f.controller.restartIndex()).toBe(false);
    expect(f.controller.getState().status).toBe("unavailable");
    const g = await fixture();
    g.onState.mockImplementation(() => g.owner.invalidate(false));
    expect(await g.controller.loadFirstIndex()).toBe(false);
    expect(g.controller.getState().purchases).toEqual([]);
  });
  it("admits fifty combined facts, retains a larger cross-page receipt union, and rejects51", async () => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    const receipts = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) =>
        receipt({
          effectId: `effect-${start + i}`,
          paymentId: `payment-${start + i}`,
          postedAtMicros: String(400 + start + i),
        }),
      );
    reply = {
      history: detail({
        retainedPayments: [],
        validatedHistoricalReceipts: receipts(0, 50),
        nextCursor: "gh1.1",
      }),
    };
    expect(await f.controller.openPurchase("order-z")).toBe(true);
    reply = {
      history: detail({
        retainedPayments: [],
        validatedHistoricalReceipts: receipts(50, 50),
      }),
    };
    expect(await f.controller.loadMoreDetail("order-z", "gh1.1")).toBe(true);
    expect(f.controller.getState().detail?.receipts).toHaveLength(100);
    reply = {
      history: detail({
        retainedPayments: [
          payment({ paymentId: "payment-other", attemptId: "attempt-other" }),
        ],
        validatedHistoricalReceipts: receipts(0, 50),
      }),
    };
    expect(await f.controller.restartDetail("order-z")).toBe(false);
    expect(f.controller.getState().detail?.receipts).toHaveLength(100);
  });
  it("rejects a late batch conflict without admitting its earlier new record", async () => {
    let reply: unknown = { history: page() };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = {
      history: page([
        purchase("order-new", "150"),
        { ...purchase(), titleSnapshot: "Contradiction" },
      ]),
    };
    expect(await f.controller.restartIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([purchase()]);
  });
  it.each([{ attemptId: "attempt-new" }, { createdAtMicros: "201" }])(
    "rejects incompatible immutable payment binding",
    async (changes) => {
      let reply: unknown = { history: page() };
      const f = await fixture(vi.fn(async () => reply));
      await f.controller.loadFirstIndex();
      reply = { history: detail() };
      await f.controller.openPurchase("order-z");
      reply = {
        history: detail({
          retainedPayments: [payment(changes)],
          validatedHistoricalReceipts: [],
        }),
      };
      expect(await f.controller.restartDetail("order-z")).toBe(false);
      expect(f.controller.getState().detail?.samples).toEqual([payment()]);
      expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
    },
  );
  it("keeps repeated gifts distinct and deduplicates exact samples/receipts", async () => {
    let reply: unknown = {
      history: page([purchase(), purchase("order-a", "50")]),
    };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    expect(f.controller.getState().purchases).toHaveLength(2);
    reply = { history: detail() };
    await f.controller.openPurchase("order-z");
    await f.controller.restartDetail("order-z");
    expect(f.controller.getState().detail?.samples).toHaveLength(1);
    expect(f.controller.getState().detail?.receipts).toHaveLength(1);
  });
  it("presents UNBOUND originals without manufactured UNKNOWN or financial facts", async () => {
    const original = { ...purchase(), binding: "UNBOUND" as const };
    let reply: unknown = { history: page([original]) };
    const f = await fixture(vi.fn(async () => reply));
    await f.controller.loadFirstIndex();
    reply = {
      history: detail({
        originalPurchase: original,
        retainedPayments: [],
        validatedHistoricalReceipts: [],
        currentKnowledge: "UNAVAILABLE",
        coverage: {
          payments: "UNAVAILABLE",
          receipts: "UNAVAILABLE",
          reversals: "UNAVAILABLE",
          bankSettlement: "UNAVAILABLE",
        },
      }),
    };
    expect(await f.controller.openPurchase("order-z")).toBe(true);
    expect(f.controller.getState().detail).toMatchObject({
      currentKnowledge: "UNAVAILABLE",
      samples: [],
      receipts: [],
    });
  });
  it("holds one slot across owner replacement and drains obsolete success without restoring facts", async () => {
    let resolve!: (value: unknown) => void;
    const f = await fixture(
      vi.fn(
        () =>
          new Promise<unknown>((yes) => {
            resolve = yes;
          }),
      ),
    );
    const old = f.controller.loadFirstIndex();
    f.owner.invalidate(false);
    await f.owner.load();
    const ports = {
      ...f.ports,
      request: vi.fn(async () => ({ history: page([]) })),
    };
    const next = createGiftPaymentHistoryController(
      { ...f.scope, sessionEpoch: f.owner.getSnapshot().sessionEpoch },
      vi.fn(),
      ports,
      f.session,
    );
    cleanups.push(() => next.dispose());
    expect(await next.loadFirstIndex()).toBe(false);
    expect(ports.request).not.toHaveBeenCalled();
    resolve({ history: page() });
    expect(await old).toBe(false);
    await next.whenSettled();
    expect(next.getState().purchases).toEqual([]);
    expect(await next.loadFirstIndex()).toBe(true);
    expect(next.getState().admissions).toBe(1);
  });
  it("rejects mutations in response getters before atomic map assignment", async () => {
    const f = await fixture();
    await f.controller.loadFirstIndex();
    const candidate = { ...page(), items: [purchase("order-new", "150")] };
    Object.defineProperty(candidate, "items", {
      enumerable: true,
      get() {
        f.owner.invalidate(false);
        return [purchase("order-new", "150")];
      },
    });
    f.ports.request = vi.fn(async () => ({ history: candidate }));
    f.controller.dispose();
    const next = createGiftPaymentHistoryController(
      f.scope,
      vi.fn(),
      f.ports,
      f.session,
    );
    cleanups.push(() => next.dispose());
    expect(await next.restartIndex()).toBe(false);
    expect(next.getState().purchases).toEqual([]);
  });
  it("uses current native expiration and fences synchronous getSnapshot invalidation", async () => {
    const f = await fixture();
    const native = f.owner.getSnapshot;
    vi.spyOn(f.owner, "getSnapshot").mockImplementationOnce(() => {
      f.owner.invalidate(false);
      return native();
    });
    expect(await f.controller.loadFirstIndex()).toBe(false);
    expect(f.request).not.toHaveBeenCalled();
    const g = await fixture();
    g.ports.now = () => Date.parse(actor.session.expiresAt);
    expect(await g.controller.loadFirstIndex()).toBe(false);
    expect(g.controller.getState().purchases).toEqual([]);
  });
  it("never exposes cached facts when a port getter silently disposes the native owner", async () => {
    let exercised = 0;
    for (let boundary = 1; boundary <= 30; boundary++) {
      const f = await fixture();
      await f.controller.loadFirstIndex();
      let reads = 0,
        disposed = false;
      const request = f.ports.request;
      Object.defineProperty(f.ports, "request", {
        configurable: true,
        get() {
          if (++reads === boundary) {
            disposed = true;
            f.owner.dispose();
          }
          return request;
        },
      });
      const state = f.controller.getState();
      if (disposed) {
        exercised++;
        expect(state.purchases, `getter boundary ${boundary}`).toEqual([]);
      }
      f.controller.dispose();
    }
    expect(exercised).toBeGreaterThan(0);
  });
  it("makes late same-owner replacement settlement unavailable and retryable", async () => {
    let resolve!: (value: unknown) => void;
    const f = await fixture(
      vi.fn(
        () =>
          new Promise<unknown>((yes) => {
            resolve = yes;
          }),
      ),
    );
    const work = f.controller.loadFirstIndex();
    f.controller.dispose();
    const request = vi.fn(async () => ({ history: page() }));
    f.ports.request = request;
    const next = createGiftPaymentHistoryController(
      f.scope,
      vi.fn(),
      f.ports,
      f.session,
    );
    cleanups.push(() => next.dispose());
    expect(await next.loadFirstIndex()).toBe(false);
    resolve({ history: page() });
    expect(await work).toBe(false);
    await next.whenSettled();
    expect(next.getState()).toMatchObject({
      status: "unavailable",
      busy: false,
      admissions: 1,
    });
    expect(await next.retryFailedRead()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
    expect(next.getState()).toMatchObject({ status: "ready", admissions: 2 });
  });
  it.each(["request", "owner", "access"] as const)(
    "masks late native-getter %s mutation during cached projection",
    async (target) => {
      let exercised = 0;
      for (let boundary = 1; boundary <= 16; boundary++) {
        const f = await fixture();
        await f.controller.loadFirstIndex();
        const other = await fixture();
        const native = f.owner.getSnapshot;
        let reads = 0,
          changed = false;
        Object.defineProperty(f.owner, "getSnapshot", {
          configurable: true,
          get() {
            if (++reads === boundary) {
              changed = true;
              if (target === "request")
                f.ports.request = vi.fn(async () => ({ history: page([]) }));
              else if (target === "owner") f.ports.owner = other.owner;
              else f.scope.access = null;
            }
            return native;
          },
        });
        const state = f.controller.getState();
        if (changed) {
          exercised++;
          expect(
            state.purchases,
            `native getter ${target}/${boundary}`,
          ).toEqual([]);
        }
        f.controller.dispose();
        other.controller.dispose();
      }
      expect(exercised).toBeGreaterThan(1);
    },
  );
  it("never dispatches through old ports after a pre-dispatch native getter replaces them", async () => {
    let exercised = 0;
    for (let boundary = 1; boundary <= 35; boundary++) {
      let dispatched = false,
        invalidatedBeforeDispatch = false,
        reads = 0;
      const request = vi.fn(async () => {
        dispatched = true;
        return { history: page() };
      });
      const f = await fixture(request);
      const native = f.owner.getSnapshot;
      Object.defineProperty(f.owner, "getSnapshot", {
        configurable: true,
        get() {
          if (++reads === boundary) {
            invalidatedBeforeDispatch = !dispatched;
            f.ports.request = vi.fn(async () => ({ history: page([]) }));
          }
          return native;
        },
      });
      await f.controller.loadFirstIndex();
      if (invalidatedBeforeDispatch) {
        exercised++;
        expect(request, `dispatch getter ${boundary}`).not.toHaveBeenCalled();
      }
      f.controller.dispose();
    }
    expect(exercised).toBeGreaterThan(1);
  });
  it("never calls onState after argument evaluation disposes its controller", async () => {
    let exercised = 0;
    for (let boundary = 1; boundary <= 40; boundary++) {
      const f = await fixture();
      let reads = 0,
        disposed = false,
        staleCallbacks = 0;
      const request = f.ports.request;
      f.onState.mockImplementation(() => {
        if (disposed) staleCallbacks++;
      });
      Object.defineProperty(f.ports, "request", {
        configurable: true,
        get() {
          if (++reads === boundary) {
            disposed = true;
            f.controller.dispose();
          }
          return request;
        },
      });
      await f.controller.loadFirstIndex();
      if (disposed) exercised++;
      expect(staleCallbacks, `callback getter ${boundary}`).toBe(0);
      f.controller.dispose();
    }
    expect(exercised).toBeGreaterThan(1);
  });
  it("preserves receipts and exhausted admissions across transient request-getter failure", async () => {
    let reply: unknown = { history: page() };
    const request = vi.fn(async () => reply);
    const f = await fixture(request);
    await f.controller.loadFirstIndex();
    reply = { history: detail({ retainedPayments: [] }) };
    await f.controller.openPurchase("order-z");
    for (let i = 2; i < 64; i++) await f.controller.restartDetail("order-z");
    expect(f.controller.getState()).toMatchObject({
      admissions: 64,
      detail: { receipts: [receipt()] },
    });
    let fail = true;
    Object.defineProperty(f.ports, "request", {
      configurable: true,
      get() {
        if (fail) {
          fail = false;
          throw new Error("transport getter unavailable");
        }
        return request;
      },
    });
    const masked = f.controller.getState();
    expect(masked.status).toBe("unavailable");
    expect(f.controller.getState()).toMatchObject({
      admissions: 64,
      detail: { receipts: [receipt()] },
    });
    expect(await f.controller.restartDetail("order-z")).toBe(false);
    expect(request).toHaveBeenCalledTimes(64);
    expect(f.controller.getState()).toMatchObject({
      admissions: 64,
      status: "local_limit",
      detail: { receipts: [receipt()] },
    });
  });
  it("canonically encodes a retained original through a parsed request port", async () => {
    const original = purchase("order..colon:1");
    const request = vi
      .fn()
      .mockResolvedValueOnce({ history: page([original]) })
      .mockResolvedValueOnce({
        history: detail({
          originalPurchase: original,
          retainedPayments: [],
          validatedHistoricalReceipts: [],
        }),
      });
    const f = await fixture(request);
    expect(await f.controller.loadFirstIndex()).toBe(true);
    expect(await f.controller.openPurchase(original.orderId)).toBe(true);
    expect(f.controller.getState()).toMatchObject({
      status: "ready",
      admissions: 2,
      detail: { purchase: original },
    });
    expect(request.mock.calls[1][0]).toBe(
      "/v1/sites/wedding-a/finance/purchases/order%2E%2Ecolon%3A1/history",
    );
  });
});

describe("default bounded history transport", () => {
  async function rawFixture(fetcher: typeof fetch) {
    vi.stubGlobal("fetch", fetcher);
    const f = await fixture();
    delete (f.ports as HistoryPorts).request;
    f.controller.dispose();
    const controller = createGiftPaymentHistoryController(
      f.scope,
      vi.fn(),
      f.ports,
      f.session,
    );
    cleanups.push(() => controller.dispose());
    return { ...f, controller };
  }
  it("uses real apiRequest GET/no-store credentials and streams before parsing", async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ history: page() })),
    );
    const f = await rawFixture(fetcher);
    expect(await f.controller.loadFirstIndex()).toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      "/api/v1/sites/wedding-a/finance/purchases",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
  });
  it("consumes accepted HTTP through the real frozen proxy/default transport for safe identities", async () => {
    const reads = vi.fn();
    const router = createGiftPaymentHistoryHttpRouter({
      adminOrigin: "https://admin.example.test",
      giftPaymentHistory: {
        available: true,
        readPurchasePage(input) {
          reads(input);
          return {
            result: Promise.resolve({ history: page() }),
            completion: Promise.resolve(),
            cancel() {},
          };
        },
        readPurchaseDetailPage(input) {
          reads(input);
          return {
            result: Promise.resolve({ history: detail() }),
            completion: Promise.resolve(),
            cancel() {},
          };
        },
        close: async () => {},
      },
    });
    const fetcher: typeof fetch = async (input, options) => {
      const url = new URL(String(input), "https://admin.example.test");
      const request = new Request(url, options);
      return url.origin === "https://admin.example.test"
        ? proxyApiRequest(request, {
            apiBaseUrl: "https://api.example.test",
            adminOrigin: "https://admin.example.test",
          })
        : router.fetch(request);
    };
    try {
      const f = await rawFixture(fetcher);
      expect(await f.controller.loadFirstIndex()).toBe(true);
      expect(await f.controller.openPurchase("order-z")).toBe(true);
      expect(f.controller.getState().detail?.receipts).toEqual([receipt()]);
      expect(reads).toHaveBeenCalledTimes(2);
      expect(
        reads.mock.calls.every(
          ([input]) =>
            input.request.headers.get("origin") ===
            "https://admin.example.test",
        ),
      ).toBe(true);
    } finally {
      await router.close();
    }
  });
  it("rejects malformed UTF-8 instead of silently changing an immutable title", async () => {
    const json = JSON.stringify({
      history: page([{ ...purchase(), titleSnapshot: "X" }]),
    });
    const bytes = new TextEncoder().encode(json);
    const index =
      json.indexOf('"titleSnapshot":"X"') + '"titleSnapshot":"'.length;
    bytes[index] = 255;
    const f = await rawFixture(vi.fn(async () => new Response(bytes)));
    expect(await f.controller.loadFirstIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([]);
  });
  it.each([200, 503])(
    "rejects streamed bytes above128KiB for status%s despite lying length",
    async (status) => {
      const cancel = vi.fn();
      const bytes = new TextEncoder().encode("á".repeat(65537));
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(bytes);
              },
              cancel,
            }),
            { status, headers: { "Content-Length": "1" } },
          ),
      );
      const f = await rawFixture(fetcher);
      expect(await f.controller.loadFirstIndex()).toBe(false);
      expect(f.controller.getState().purchases).toEqual([]);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it("accepts exactly131072 raw UTF-8 bytes and rejects the next byte", async () => {
    const json = JSON.stringify({ history: page() });
    let body =
      json + " ".repeat(131072 - new TextEncoder().encode(json).byteLength);
    const f = await rawFixture(vi.fn(async () => new Response(body)));
    expect(await f.controller.loadFirstIndex()).toBe(true);
    body += " ";
    expect(await f.controller.restartIndex()).toBe(false);
    expect(f.controller.getState().purchases).toEqual([purchase()]);
  });
  it("retains slot after45000ms feedback until actual body cancellation settles", async () => {
    vi.useFakeTimers();
    let cancelFinish!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          cancelFinish = resolve;
        }),
    );
    const f = await rawFixture(
      vi.fn(async () => new Response(new ReadableStream({ cancel }))),
    );
    const work = f.controller.loadFirstIndex();
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(45000);
    expect(f.controller.getState()).toMatchObject({
      status: "unavailable",
      busy: true,
      admissions: 1,
    });
    expect(await f.controller.restartIndex()).toBe(false);
    const done = vi.fn();
    void f.controller.whenSettled().then(done);
    await Promise.resolve();
    expect(done).not.toHaveBeenCalled();
    cancelFinish();
    expect(await work).toBe(false);
    await f.controller.whenSettled();
    expect(done).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("bounds error JSON and invalidates only current503-safe or401-owned errors", async () => {
    const f = await rawFixture(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), {
            status: 401,
          }),
      ),
    );
    expect(await f.controller.loadFirstIndex()).toBe(false);
    expect(f.owner.getSnapshot().status).toBe("unauthenticated");
  });
  it("encodes opaque cursor dots without decoding gh1 contents", async () => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ history: page([], "gh1..opaque:next") })),
    );
    const f = await rawFixture(fetcher);
    await f.controller.loadFirstIndex();
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ history: page([]) })),
    );
    expect(await f.controller.loadMoreIndex("gh1..opaque:next")).toBe(true);
    expect(fetcher.mock.calls[1][0]).toBe(
      "/api/v1/sites/wedding-a/finance/purchases?cursor=gh1%2E%2Eopaque%3Anext",
    );
  });

  async function encodedBridge(
    orderId: string,
    readDetail?: (reply: { history: GiftPurchaseHistoryDetailPage }) => {
      result: Promise<{ history: GiftPurchaseHistoryDetailPage }>;
      completion: Promise<void>;
      cancel(): void;
    },
  ) {
    const original = { ...purchase(orderId), quoteId: "quote-original" };
    const archived = detail({
      originalPurchase: original,
      retainedPayments: [],
      validatedHistoricalReceipts: [receipt({ orderId })],
    });
    const reads = vi.fn();
    const origin = "https://admin.example.test";
    const router = createGiftPaymentHistoryHttpRouter({
      adminOrigin: origin,
      giftPaymentHistory: {
        available: true,
        readPurchasePage(input) {
          reads(input);
          return {
            result: Promise.resolve({ history: page([original]) }),
            completion: Promise.resolve(),
            cancel() {},
          };
        },
        readPurchaseDetailPage(input) {
          reads(input);
          const reply = { history: archived };
          return (
            readDetail?.(reply) ?? {
              result: Promise.resolve(reply),
              completion: Promise.resolve(),
              cancel() {},
            }
          );
        },
        async close() {},
      },
    });
    const fetcher = vi.fn<typeof fetch>(async (input, options) => {
      const url = new URL(String(input), origin);
      const request = new Request(url, options);
      return url.origin === origin
        ? proxyApiRequest(request, {
            apiBaseUrl: "https://api.example.test",
            adminOrigin: origin,
          })
        : router.fetch(request);
    });
    try {
      const f = await rawFixture(fetcher);
      return { ...f, original, archived, reads, fetcher, router };
    } catch (cause) {
      await router.close();
      throw cause;
    }
  }

  it.each([
    "order:colon",
    "order.single",
    "order..double",
    `order:a..${"x".repeat(119)}`,
  ])(
    "preserves original%s through the actual default controller/proxy/HTTP bridge",
    async (orderId) => {
      const f = await encodedBridge(orderId);
      try {
        expect(f.ports.request).toBeUndefined();
        expect(await f.controller.loadFirstIndex()).toBe(true);
        expect(await f.controller.openPurchase(orderId)).toBe(true);
        expect(f.controller.getState()).toMatchObject({
          status: "ready",
          admissions: 2,
          busy: false,
          purchases: [f.original],
          detail: {
            purchase: f.original,
            receipts: f.archived.validatedHistoricalReceipts,
          },
        });
        const encoded = encodeURIComponent(orderId).replaceAll(".", "%2E");
        expect(f.fetcher.mock.calls.map(([input]) => String(input))).toEqual([
          "/api/v1/sites/wedding-a/finance/purchases",
          "https://api.example.test/v1/sites/wedding-a/finance/purchases",
          `/api/v1/sites/wedding-a/finance/purchases/${encoded}/history`,
          `https://api.example.test/v1/sites/wedding-a/finance/purchases/${encoded}/history`,
        ]);
        expect(
          f.reads.mock.calls.map(([input]) => [
            input.siteId,
            input.orderId,
            input.request.headers.get("origin"),
          ]),
        ).toEqual([
          [access.siteId, undefined, "https://admin.example.test"],
          [access.siteId, orderId, "https://admin.example.test"],
        ]);
        expect(f.fetcher.mock.calls[2][1]).toMatchObject({
          method: "GET",
          credentials: "same-origin",
          cache: "no-store",
          signal: expect.any(AbortSignal),
        });
      } finally {
        f.controller.dispose();
        await f.controller.whenSettled();
        await f.router.close();
      }
    },
  );
  it.each([
    "",
    "..",
    "order%foo",
    "order/a",
    "order\\a",
    "x".repeat(129),
    "order:unowned",
    "order..unowned",
    "x".repeat(128),
  ])(
    "does not dispatch or charge invalid/unowned original%s",
    async (orderId) => {
      const f = await encodedBridge("order:a..b");
      try {
        expect(await f.controller.loadFirstIndex()).toBe(true);
        expect(await f.controller.openPurchase(orderId)).toBe(false);
        expect(f.controller.getState()).toMatchObject({
          status: "ready",
          admissions: 1,
          busy: false,
          purchases: [f.original],
          detail: null,
        });
        expect(f.reads).toHaveBeenCalledTimes(1);
        expect(f.fetcher).toHaveBeenCalledTimes(2);
      } finally {
        f.controller.dispose();
        await f.controller.whenSettled();
        await f.router.close();
      }
    },
  );
  it("charges one encoded read per dispatch and retains receipts across failure/retry", async () => {
    let fail = false;
    const f = await encodedBridge("order:a..b", (reply) => ({
      result: fail
        ? Promise.reject(new Error("synthetic unavailable"))
        : Promise.resolve(reply),
      completion: Promise.resolve(),
      cancel() {},
    }));
    try {
      expect(await f.controller.loadFirstIndex()).toBe(true);
      expect(await f.controller.openPurchase(f.original.orderId)).toBe(true);
      fail = true;
      expect(await f.controller.restartDetail(f.original.orderId)).toBe(false);
      expect(f.controller.getState()).toMatchObject({
        status: "unavailable",
        admissions: 3,
        detail: { receipts: f.archived.validatedHistoricalReceipts },
      });
      expect(f.owner.getSnapshot().status).toBe("verified");
      fail = false;
      expect(await f.controller.retryFailedRead()).toBe(true);
      expect(f.controller.getState()).toMatchObject({
        status: "ready",
        admissions: 4,
        detail: { receipts: f.archived.validatedHistoricalReceipts },
      });
      expect(f.reads).toHaveBeenCalledTimes(4);
      expect(f.fetcher).toHaveBeenCalledTimes(8);
    } finally {
      f.controller.dispose();
      await f.controller.whenSettled();
      await f.router.close();
    }
  });
  it("retains encoded receipts/admissions and the actual slot through deadline and replacement", async () => {
    vi.useFakeTimers();
    let hold = false,
      release!: () => void;
    const completion = new Promise<void>((done) => {
      release = done;
    });
    const cancel = vi.fn();
    const f = await encodedBridge("order:a..b", (reply) => ({
      result: Promise.resolve(reply),
      completion: hold ? completion : Promise.resolve(),
      cancel,
    }));
    let replacement:
      | ReturnType<typeof createGiftPaymentHistoryController>
      | undefined;
    try {
      expect(await f.controller.loadFirstIndex()).toBe(true);
      expect(await f.controller.openPurchase(f.original.orderId)).toBe(true);
      hold = true;
      const work = f.controller.restartDetail(f.original.orderId);
      const settled = vi.fn();
      void f.controller.whenSettled().then(settled);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
      expect(f.controller.getState()).toMatchObject({
        status: "unavailable",
        admissions: 3,
        busy: true,
        detail: { receipts: f.archived.validatedHistoricalReceipts },
      });
      f.controller.dispose();
      replacement = createGiftPaymentHistoryController(
        f.scope,
        vi.fn(),
        f.ports,
        f.session,
      );
      expect(await replacement.retryFailedRead()).toBe(false);
      expect(replacement.getState()).toMatchObject({
        admissions: 3,
        busy: true,
        detail: { receipts: f.archived.validatedHistoricalReceipts },
      });
      expect(f.reads).toHaveBeenCalledTimes(3);
      release();
      expect(await work).toBe(false);
      await replacement.whenSettled();
      expect(replacement.getState()).toMatchObject({
        admissions: 3,
        busy: false,
        detail: { receipts: f.archived.validatedHistoricalReceipts },
      });
      hold = false;
      expect(await replacement.retryFailedRead()).toBe(true);
      expect(replacement.getState().admissions).toBe(4);
    } finally {
      release();
      replacement?.dispose();
      f.controller.dispose();
      await f.controller.whenSettled();
      await f.router.close();
    }
  });
  it("denies encoded read65 before navigation reset without refunding64 charges", async () => {
    const f = await encodedBridge("order:a..b");
    try {
      expect(await f.controller.loadFirstIndex()).toBe(true);
      expect(await f.controller.openPurchase(f.original.orderId)).toBe(true);
      for (let read = 2; read < 64; read++)
        expect(await f.controller.restartDetail(f.original.orderId)).toBe(true);
      const before = f.controller.getState();
      expect(before.admissions).toBe(64);
      expect(await f.controller.restartDetail(f.original.orderId)).toBe(false);
      expect(f.controller.getState()).toMatchObject({
        status: "local_limit",
        admissions: 64,
        detail: before.detail,
        nextDetailCursor: before.nextDetailCursor,
      });
      expect(f.reads).toHaveBeenCalledTimes(64);
      expect(f.fetcher).toHaveBeenCalledTimes(128);
    } finally {
      f.controller.dispose();
      await f.controller.whenSettled();
      await f.router.close();
    }
  });
});
