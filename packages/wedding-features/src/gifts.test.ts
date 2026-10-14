import { giftQuoteSchema, publicGiftItemSchema } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { recoverGiftCheckout } from "./giftCheckoutRecovery";
import {
  createGiftCheckoutState,
  type GiftCheckoutEvent,
  giftCheckoutReducer,
} from "./giftCheckoutState";
import {
  giftPendingStorageKey,
  writePendingGiftCheckout,
} from "./giftCheckoutStorage";
import { submitGiftCheckout } from "./giftCheckoutSubmission";
import { WeddingGiftsApi, WeddingGiftsApiError } from "./gifts";

const gift = {
  id: "gift-a",
  siteId: "wedding-a",
  title: "Jantar especial",
  description: "Presente simbólico",
  nominalCents: 10000,
  currency: "BRL",
  image: null,
  sortOrder: 0,
};
const quote = {
  id: "quote-a",
  giftId: "gift-a",
  siteId: "wedding-a",
  title: "Jantar especial",
  method: "PIX",
  currency: "BRL",
  nominalCents: 10000,
  commissionBasisPoints: 200,
  commissionCents: 200,
  processingCents: 150,
  totalCents: 10350,
  policyVersion: "test-v1",
  expiresAt: "2026-10-12T22:00:00.000Z",
  mode: "sandbox",
};
const checkout = {
  orderId: "order-a",
  attemptId: "attempt-a",
  quoteId: "quote-a",
  method: "PIX",
  hostedUrl: "https://sandbox.example.test/checkout",
  mode: "sandbox",
};
const api = (fetcher: typeof fetch) =>
  new WeddingGiftsApi({
    apiOrigin: "https://api.example.test",
    siteId: "wedding-a",
    fetcher,
  });

const recoveryToken = "A".repeat(43);
const catalogPage = (gifts: Array<typeof gift>, mode = "sandbox") => ({
  siteId: "wedding-a",
  gifts,
  mode,
  page: 1,
  pageSize: 20,
  q: "",
  total: gifts.length,
  totalPages: Math.max(1, Math.ceil(gifts.length / 20)),
  hasNext: gifts.length > 20,
});
describe("public gifts API boundary", () => {
  it("posts recovery capability only in the body and validates operation/status binding", async () => {
    const status = {
      siteId: "wedding-a",
      quoteId: "quote-a",
      requestId: "request-a",
      orderId: "order-a",
      attemptId: "attempt-a",
      method: "PIX",
      mode: "sandbox",
      state: "OUTCOME_UNKNOWN",
      observedAt: null,
      closedReason: null,
      mayStartNewAttempt: false,
      checkout: null,
    };
    const fetcher = vi.fn().mockResolvedValue(Response.json({ status }));
    const identity = {
      quoteId: "quote-a",
      requestId: "request-a",
      recoveryToken,
    };
    const expected = { method: "PIX", mode: "sandbox" } as const;
    await expect(
      api(fetcher).getCheckoutStatus(identity, expected),
    ).resolves.toEqual(status);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v1/public/sites/wedding-a/gift-checkouts/status",
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        body: JSON.stringify(identity),
      }),
    );
    expect(fetcher.mock.calls[0][0]).not.toContain(recoveryToken);
    for (const invalid of [
      { ...status, siteId: "wedding-b" },
      { ...status, requestId: "request-b" },
      { ...status, quoteId: "quote-b" },
      { ...status, method: "CREDIT_CARD" },
      { ...status, mode: "live" },
      { ...status, recoveryToken },
      { ...status, mayStartNewAttempt: true },
    ]) {
      fetcher.mockResolvedValue(Response.json({ status: invalid }));
      await expect(
        api(fetcher).getCheckoutStatus(identity, expected),
      ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    }
  });
  it("loads runtime gifts without invitation cookies and rejects cross-site/private data", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json(catalogPage([gift])));
    await expect(api(fetcher).getCatalog()).resolves.toEqual(
      catalogPage([gift]),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.example.test/v1/public/sites/wedding-a/gifts",
      expect.objectContaining({
        credentials: "omit",
        cache: "no-store",
        method: "GET",
      }),
    );
    for (const item of [
      { ...gift, siteId: "wedding-b" },
      { ...gift, stagingKey: "private" },
    ]) {
      fetcher.mockResolvedValue(Response.json(catalogPage([item])));
      await expect(api(fetcher).getCatalog()).rejects.toMatchObject({
        code: "INVALID_API_RESPONSE",
      });
    }
  });
  it("quotes only a stored item and selected method with no browser price or wallet", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ quote }));
    await expect(
      api(fetcher).quoteGift({ giftId: "gift-a", method: "PIX" }),
    ).resolves.toEqual(quote);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/gift-quotes"),
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        body: JSON.stringify({ giftId: "gift-a", method: "PIX" }),
      }),
    );
    await expect(
      api(fetcher).quoteGift({
        giftId: "gift-a",
        method: "PIX",
        nominalCents: 1,
      } as never),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(
      Response.json({ quote: { ...quote, method: "CREDIT_CARD" } }),
    );
    await expect(
      api(fetcher).quoteGift({ giftId: "gift-a", method: "PIX" }),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });
  it("creates method/quote/mode-bound hosted checkout and rejects unexpected redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ checkout }));
    const expected = {
      id: "quote-a",
      siteId: "wedding-a",
      method: "PIX",
      mode: "sandbox",
    } as const;
    await expect(
      api(fetcher).createCheckout(
        { quoteId: "quote-a", requestId: "request-a", recoveryToken },
        expected,
      ),
    ).resolves.toEqual(checkout);
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/gift-checkouts"),
      expect.objectContaining({
        body: JSON.stringify({
          quoteId: "quote-a",
          requestId: "request-a",
          recoveryToken,
        }),
      }),
    );
    for (const invalid of [
      { ...checkout, method: "CREDIT_CARD" },
      { ...checkout, quoteId: "quote-b" },
      { ...checkout, mode: "live" },
      { ...checkout, hostedUrl: "javascript:alert(1)" },
    ]) {
      fetcher.mockResolvedValue(Response.json({ checkout: invalid }));
      await expect(
        api(fetcher).createCheckout(
          { quoteId: "quote-a", requestId: "request-a", recoveryToken },
          expected,
        ),
      ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
    }
  });
  it("sanitizes network/provider errors without converting redirects into paid status", async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error("private diagnostic"));
    await expect(api(fetcher).getCatalog()).rejects.toEqual(
      new WeddingGiftsApiError(0, "NETWORK_ERROR"),
    );
    fetcher.mockResolvedValue(
      Response.json(
        { code: "RECEIVING_NOT_READY", title: "private bank account" },
        { status: 409 },
      ),
    );
    await expect(api(fetcher).getCatalog()).rejects.toMatchObject({
      status: 409,
      code: "RECEIVING_NOT_READY",
    });
  });
  it("refuses live results in the explicitly marked demo consumer", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json(catalogPage([gift], "live")));
    const demo = new WeddingGiftsApi({
      apiOrigin: "https://api.example.test",
      siteId: "wedding-a",
      fetcher,
      demo: true,
    });
    await expect(demo.getCatalog()).rejects.toMatchObject({
      code: "LIVE_DEMO_FORBIDDEN",
    });
  });
});

describe("failed checkout wire responses preserve the original operation", () => {
  const observedAt = "2026-10-12T21:00:00.000Z";
  function submissionFixture(fetcher: typeof fetch) {
    const currentQuote = giftQuoteSchema.parse(quote);
    let state = giftCheckoutReducer(createGiftCheckoutState(), {
      type: "SELECT_GIFT",
      gift: publicGiftItemSchema.parse(gift),
    });
    state = giftCheckoutReducer(state, {
      type: "SELECT_METHOD",
      method: "PIX",
    });
    state = giftCheckoutReducer(state, {
      type: "QUOTE_RESOLVED",
      quote: currentQuote,
      revision: state.revision,
    });
    state = giftCheckoutReducer(state, {
      type: "CHECKOUT_STARTED",
      requestId: "request-a",
      recoveryToken,
      now: observedAt,
    });
    if (!state.pending)
      throw new Error("Valid checkout fixture must have an original operation");
    const pending = state.pending;
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    };
    writePendingGiftCheckout(storage, "wedding-a", pending);
    const key = giftPendingStorageKey("wedding-a");
    const originalMarker = values.get(key);
    return {
      client: api(fetcher),
      currentQuote,
      state,
      pending,
      storage,
      values,
      key,
      originalMarker,
    };
  }
  function assertUnknown(
    f: ReturnType<typeof submissionFixture>,
    event: GiftCheckoutEvent | null,
  ) {
    expect(f.values.get(f.key)).toBe(f.originalMarker);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(f.storage.setItem).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      type: "CHECKOUT_FAILED",
      unknown: true,
      invalidateQuote: false,
    });
    if (!event)
      throw new Error("Current wire failure must return an unknown event");
    const unknown = giftCheckoutReducer(f.state, event);
    expect(unknown).toMatchObject({
      phase: "UNKNOWN",
      quote: f.currentQuote,
      pending: f.pending,
      requestId: f.pending.requestId,
      recoveryToken: f.pending.recoveryToken,
      checkout: null,
      checkoutStatus: null,
    });
    const blocked: GiftCheckoutEvent[] = [
      { type: "CLOSE" },
      {
        type: "SELECT_GIFT",
        gift: publicGiftItemSchema.parse({ ...gift, id: "gift-b" }),
      },
      { type: "SELECT_METHOD", method: "CREDIT_CARD" },
      {
        type: "CHECKOUT_STARTED",
        requestId: "request-b",
        recoveryToken: `${"B".repeat(42)}A`,
        now: observedAt,
      },
    ];
    for (const action of blocked)
      expect(giftCheckoutReducer(unknown, action)).toBe(unknown);
    return unknown;
  }
  const failedCreates = [
    ...[
      "QUOTE_INVALID",
      "QUOTE_EXPIRED",
      "RECEIVING_NOT_READY",
      "DESTINATION_UNVERIFIED",
      "PROVIDER_MODE_UNAVAILABLE",
      "POLICY_UNAVAILABLE",
      "VALIDATION_ERROR",
      "SITE_INACTIVE",
      "SITE_EXPIRED",
    ].map((code) => ({ status: 500, code })),
    { status: 400, code: "VALIDATION_ERROR" },
    { status: 409, code: "QUOTE_EXPIRED" },
    ...[302, 401, 403, 404, 422, 429, 502, 503].map((status) => ({
      status,
      code: "RECEIVING_NOT_READY",
    })),
  ];
  it.each(failedCreates)(
    "keeps wire $status/$code unknown even with a valid-looking problem",
    async ({ status, code }) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json(
          {
            type: "about:blank",
            title: "private upstream diagnostic",
            status,
            code,
          },
          { status },
        ),
      );
      const f = submissionFixture(fetcher);
      const create = vi.spyOn(f.client, "createCheckout");
      try {
        const event = await submitGiftCheckout(
          f.client,
          f.currentQuote,
          f.pending,
          () => f.storage,
        );
        assertUnknown(f, event);
        const error = await create.mock.results[0].value.catch(
          (cause: unknown) => cause,
        );
        expect(error).toEqual(
          new WeddingGiftsApiError(status, "EXTERNAL_OUTCOME_UNKNOWN"),
        );
        expect(JSON.stringify(event)).not.toMatch(
          /private|QUOTE_EXPIRED|RECEIVING_NOT_READY/,
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher).toHaveBeenCalledWith(
          "https://api.example.test/v1/public/sites/wedding-a/gift-checkouts",
          expect.objectContaining({
            method: "POST",
            credentials: "omit",
            cache: "no-store",
            body: JSON.stringify({
              quoteId: f.pending.quoteId,
              requestId: f.pending.requestId,
              recoveryToken: f.pending.recoveryToken,
            }),
          }),
        );
      } finally {
        create.mockRestore();
      }
    },
  );
  it.each([
    {
      label: "partial problem",
      response: () => Response.json({ code: "QUOTE_EXPIRED" }, { status: 409 }),
    },
    {
      label: "private non-problem",
      response: () =>
        Response.json(
          { code: "VALIDATION_ERROR", account: "private bank" },
          { status: 400 },
        ),
    },
    {
      label: "malformed JSON",
      response: () =>
        new Response('{"code":"QUOTE_EXPIRED",', {
          status: 409,
          headers: { "Content-Type": "application/json" },
        }),
    },
    {
      label: "absent body",
      response: () => new Response(null, { status: 503 }),
    },
  ])(
    "keeps $label creation failures unknown and sanitizes the code",
    async ({ response }) => {
      const fetcher = vi.fn<typeof fetch>(async () => response());
      const f = submissionFixture(fetcher);
      const create = vi.spyOn(f.client, "createCheckout");
      try {
        const event = await submitGiftCheckout(
          f.client,
          f.currentQuote,
          f.pending,
          () => f.storage,
        );
        assertUnknown(f, event);
        const error = await create.mock.results[0].value.catch(
          (cause: unknown) => cause,
        );
        expect(error).toBeInstanceOf(WeddingGiftsApiError);
        expect(error.code).toBe("EXTERNAL_OUTCOME_UNKNOWN");
        expect(error.message).toBe("EXTERNAL_OUTCOME_UNKNOWN");
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        create.mockRestore();
      }
    },
  );
  it.each([
    {
      label: "network failure",
      fetcher: () =>
        vi.fn<typeof fetch>(async () => {
          throw new Error("private transport failure");
        }),
      code: "NETWORK_ERROR",
    },
    {
      label: "malformed success",
      fetcher: () =>
        vi.fn<typeof fetch>(async () => new Response('{"checkout":')),
      code: "INVALID_API_RESPONSE",
    },
    {
      label: "invalid success binding",
      fetcher: () =>
        vi.fn<typeof fetch>(async () =>
          Response.json({ checkout: { ...checkout, quoteId: "quote-b" } }),
        ),
      code: "INVALID_API_RESPONSE",
    },
  ])(
    "preserves existing $label as unknown without creating another request",
    async ({ fetcher: transport, code }) => {
      const fetcher = transport();
      const f = submissionFixture(fetcher);
      const create = vi.spyOn(f.client, "createCheckout");
      try {
        const event = await submitGiftCheckout(
          f.client,
          f.currentQuote,
          f.pending,
          () => f.storage,
        );
        assertUnknown(f, event);
        const error = await create.mock.results[0].value.catch(
          (cause: unknown) => cause,
        );
        expect(error.code).toBe(code);
        expect(error.message).not.toContain("private");
        expect(fetcher).toHaveBeenCalledTimes(1);
      } finally {
        create.mockRestore();
      }
    },
  );
  it("preserves valid creation as hosted continuation with its original marker", async () => {
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ checkout }),
    );
    const f = submissionFixture(fetcher);
    const event = await submitGiftCheckout(
      f.client,
      f.currentQuote,
      f.pending,
      () => f.storage,
    );
    expect(event).toMatchObject({ type: "CHECKOUT_RESOLVED", checkout });
    if (!event)
      throw new Error("Current valid creation must return its checkout");
    const resolved = giftCheckoutReducer(f.state, event);
    expect(resolved).toMatchObject({
      phase: "REDIRECTING",
      checkout,
      checkoutStatus: null,
      pending: f.pending,
    });
    expect(f.values.get(f.key)).toBe(f.originalMarker);
    expect(f.storage.removeItem).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([
    "CLOSED_UNPAID",
    "RECEIVED",
    "REFUNDED",
    "AWAITING_PAYMENT",
  ] as const)(
    "retains fully correlated %s recovery authority after a failed creation",
    async (state) => {
      const status = {
        siteId: "wedding-a",
        quoteId: "quote-a",
        requestId: "request-a",
        orderId: "order-a",
        attemptId: "attempt-a",
        method: "PIX",
        mode: "sandbox",
        state,
        observedAt,
        closedReason: state === "CLOSED_UNPAID" ? "EXPIRED" : null,
        mayStartNewAttempt: state === "CLOSED_UNPAID",
        checkout: state === "AWAITING_PAYMENT" ? checkout : null,
      };
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({ code: "QUOTE_EXPIRED" }, { status: 409 }),
        )
        .mockResolvedValueOnce(Response.json({ status }));
      const f = submissionFixture(fetcher);
      const failed = await submitGiftCheckout(
        f.client,
        f.currentQuote,
        f.pending,
        () => f.storage,
      );
      const unknown = assertUnknown(f, failed);
      const event = await recoverGiftCheckout(
        f.client,
        unknown,
        () => f.storage,
      );
      expect(event).toEqual({ type: "STATUS_RESOLVED", status });
      if (!event)
        throw new Error("Exact recovery must return an accepted status");
      const recovered = giftCheckoutReducer(unknown, event);
      expect(recovered.phase).toBe(
        state === "CLOSED_UNPAID" ? "IDLE" : "UNKNOWN",
      );
      expect(recovered.checkoutStatus).toEqual(status);
      if (state === "CLOSED_UNPAID") {
        expect(f.values.has(f.key)).toBe(false);
        expect(f.storage.removeItem).toHaveBeenCalledTimes(1);
      } else {
        expect(f.storage.removeItem).not.toHaveBeenCalled();
        expect(f.values.has(f.key)).toBe(true);
        if (state === "RECEIVED" || state === "REFUNDED") {
          expect(recovered.pending?.terminalStatus).toEqual(status);
        } else {
          expect(f.values.get(f.key)).toBe(f.originalMarker);
        }
      }
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        "https://api.example.test/v1/public/sites/wedding-a/gift-checkouts",
        "https://api.example.test/v1/public/sites/wedding-a/gift-checkouts/status",
      ]);
    },
  );
  it.each(["gifts", "gift-quotes", "gift-checkouts/status"])(
    "preserves non-success behavior for the other %s resource",
    async (resource) => {
      const fetcher = vi.fn<typeof fetch>(async () =>
        Response.json({ code: "QUOTE_EXPIRED" }, { status: 409 }),
      );
      const client = api(fetcher);
      const work =
        resource === "gifts"
          ? client.getCatalog()
          : resource === "gift-quotes"
            ? client.quoteGift({ giftId: "gift-a", method: "PIX" })
            : client.getCheckoutStatus(
                { quoteId: "quote-a", requestId: "request-a", recoveryToken },
                { method: "PIX", mode: "sandbox" },
              );
      await expect(work).rejects.toEqual(
        new WeddingGiftsApiError(409, "QUOTE_EXPIRED"),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("suppresses a late failed wire creation before touching current recovery storage", async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const f = submissionFixture(fetcher);
    let current = true;
    const create = vi.spyOn(f.client, "createCheckout");
    const work = submitGiftCheckout(
      f.client,
      f.currentQuote,
      f.pending,
      () => f.storage,
      () => current,
    );
    current = false;
    resolve(Response.json({ code: "QUOTE_EXPIRED" }, { status: 409 }));
    try {
      expect(await work).toBeNull();
      expect(f.storage.getItem).not.toHaveBeenCalled();
      expect(f.storage.removeItem).not.toHaveBeenCalled();
      expect(f.values.get(f.key)).toBe(f.originalMarker);
      const error = await create.mock.results[0].value.catch(
        (cause: unknown) => cause,
      );
      expect(error.code).toBe("EXTERNAL_OUTCOME_UNKNOWN");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      await work;
      create.mockRestore();
    }
  });
});

describe("catalog raw stream admission and actual ownership", () => {
  describe("catalog page query and signal ownership", () => {
    const page = {
      siteId: "wedding-a",
      mode: "sandbox",
      gifts: [],
      page: 2,
      pageSize: 20,
      q: "e\u0301 %_",
      total: 0,
      totalPages: 1,
      hasNext: false,
    };
    async function ticks() {
      for (let i = 0; i < 16; i++) await Promise.resolve();
    }
    it("serializes canonical query without NFC and matches the captured page/site/q", async () => {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(page));
      await expect(
        api(fetcher).getCatalog({ page: 2, q: " e\u0301 %_ " }),
      ).resolves.toEqual(page);
      const url = new URL(fetcher.mock.calls[0][0] as string);
      expect(url.searchParams.get("page")).toBe("2");
      expect(url.searchParams.get("q")).toBe(page.q);
      for (const mismatch of [
        { siteId: "other-site" },
        { page: 3 },
        { q: "é %_" },
      ]) {
        fetcher.mockResolvedValueOnce(Response.json({ ...page, ...mismatch }));
        await expect(
          api(fetcher).getCatalog({ page: 2, q: page.q }),
        ).rejects.toMatchObject({ status: 502, code: "INVALID_API_RESPONSE" });
      }
    });
    it("does not dispatch a catalog fetch when its captured signal was already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const fetcher = vi.fn(async () => Response.json(page));
      await expect(
        api(fetcher).getCatalog({}, controller.signal),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(fetcher).not.toHaveBeenCalled();
    });
    it.each(["fetch", "read"] as const)(
      "holds aborted %s work until actual fetch/read and native cancellation settlement",
      async (boundary) => {
        let resolveFetch!: (response: Response) => void;
        const fetchCompletion = new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        });
        let release!: () => void;
        const cancelCompletion = new Promise<void>((resolve) => {
          release = resolve;
        });
        const cancel = vi.fn(() => cancelCompletion);
        let source!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              source = controller;
              if (boundary === "read")
                controller.enqueue(
                  new TextEncoder().encode(
                    JSON.stringify({ ...page, page: 1, q: "" }),
                  ),
                );
            },
            cancel,
          },
          { highWaterMark: 0 },
        );
        const response = new Response(body);
        const controller = new AbortController();
        const removal = vi.spyOn(controller.signal, "removeEventListener");
        const fetcher = vi.fn<typeof fetch>(() =>
          boundary === "fetch" ? fetchCompletion : Promise.resolve(response),
        );
        const work = api(fetcher as typeof fetch).getCatalog(
          {},
          controller.signal,
        );
        const settled = vi.fn();
        void work.then(settled, settled);
        try {
          await ticks();
          controller.abort();
          await ticks();
          expect(settled).not.toHaveBeenCalled();
          if (boundary === "fetch") {
            expect(cancel).not.toHaveBeenCalled();
            resolveFetch(response);
            await ticks();
          }
          expect(cancel).toHaveBeenCalledTimes(1);
          expect(settled).not.toHaveBeenCalled();
          expect(removal).not.toHaveBeenCalled();
          expect(fetcher).toHaveBeenCalledTimes(1);
          expect(fetcher.mock.calls[0][1]).toMatchObject({
            signal: controller.signal,
          });
        } finally {
          resolveFetch(response);
          release();
          try {
            source.close();
          } catch {}
          await work.catch(() => {});
          removal.mockRestore();
        }
        await expect(work).rejects.toMatchObject({
          status: 502,
          code: "INVALID_API_RESPONSE",
        });
        expect(body.locked).toBe(false);
        expect(cancel).toHaveBeenCalledTimes(1);
      },
    );
  });

  const catalog = catalogPage([{ ...gift, title: 'Café "especial"' }]);
  const invalid = new WeddingGiftsApiError(502, "INVALID_API_RESPONSE");
  async function ticks() {
    for (let tick = 0; tick < 16; tick++) await Promise.resolve();
  }
  it.each(
    [200, 409, 500].flatMap((status) =>
      ["application/json", "text/plain", "application/octet-stream"].map(
        (mime) => ({ status, mime }),
      ),
    ),
  )(
    "counts512KiB/byte+1 before parsing every catalog $status/$mime",
    async ({ status, mime }) => {
      const value =
        status === 200
          ? catalog
          : { code: "RECEIVING_NOT_READY", title: "private diagnostic" };
      const json = JSON.stringify(value);
      let text =
        json + " ".repeat(524288 - new TextEncoder().encode(json).byteLength);
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response(text, {
            status,
            headers: { "Content-Type": mime, "Content-Length": "1" },
          }),
      );
      const client = api(fetcher);
      if (status === 200)
        await expect(client.getCatalog()).resolves.toEqual(catalog);
      else
        await expect(client.getCatalog()).rejects.toEqual(
          new WeddingGiftsApiError(status, "RECEIVING_NOT_READY"),
        );
      text += " ";
      await expect(client.getCatalog()).rejects.toEqual(invalid);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("uses raw bytes without json/text/arrayBuffer convenience or field/card truncation", async () => {
    const many = {
      ...catalogPage([]),
      total: 201,
      totalPages: 11,
      hasNext: true,
      gifts: Array.from({ length: 20 }, (_, index) => ({
        ...gift,
        id: `gift-${index}`,
        sortOrder: index,
      })),
      mode: "sandbox",
    };
    const response = new Response(JSON.stringify(many));
    const convenience = vi.fn(async () => {
      throw new Error("private convenience invoked");
    });
    Object.defineProperties(response, {
      json: { value: convenience },
      text: { value: convenience },
      arrayBuffer: { value: convenience },
    });
    await expect(
      api(vi.fn(async () => response)).getCatalog(),
    ).resolves.toEqual(many);
    expect(convenience).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
  it.each([false, true])(
    "counts4096 actual chunks including zero-length=%s",
    async (empty) => {
      let count = 4096;
      const fetcher = vi.fn<typeof fetch>(async () => {
        const json = new TextEncoder().encode(JSON.stringify(catalog));
        return new Response(
          new ReadableStream<Uint8Array>(
            {
              start(controller) {
                controller.enqueue(json);
                for (let chunk = 1; chunk < count; chunk++)
                  controller.enqueue(
                    empty ? new Uint8Array(0) : new Uint8Array([32]),
                  );
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
        );
      });
      const client = api(fetcher);
      await expect(client.getCatalog()).resolves.toEqual(catalog);
      count++;
      await expect(client.getCatalog()).rejects.toEqual(invalid);
    },
  );
  it.each([200, 409])(
    "rejects malformed UTF-8 at status%s rather than replacing text",
    async (status) => {
      const text = JSON.stringify(
        status === 200 ? catalogPage([{ ...gift, title: "X" }]) : { code: "X" },
      );
      const bytes = new TextEncoder().encode(text);
      bytes[text.indexOf('"X"') + 1] = 255;
      await expect(
        api(vi.fn(async () => new Response(bytes, { status }))).getCatalog(),
      ).rejects.toEqual(invalid);
    },
  );
  it("separates natural EOF from JSON success and releases the reader after malformed JSON", async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>(
        {
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"private":'));
            controller.close();
          },
          cancel,
        },
        { highWaterMark: 0 },
      ),
    );
    await expect(api(vi.fn(async () => response)).getCatalog()).rejects.toEqual(
      invalid,
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(response.body?.locked).toBe(false);
  });
  it("does not accept complete JSON before the actual final read/EOF", async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          source = controller;
        },
        cancel,
      },
      { highWaterMark: 0 },
    );
    const response = new Response(body);
    const work = api(vi.fn(async () => response)).getCatalog();
    const settled = vi.fn();
    void work.then(settled, settled);
    try {
      await ticks();
      source.enqueue(new TextEncoder().encode(JSON.stringify(catalog)));
      await ticks();
      expect(settled).not.toHaveBeenCalled();
      expect(body.locked).toBe(true);
      source.close();
      await expect(work).resolves.toEqual(catalog);
      expect(body.locked).toBe(false);
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      try {
        source.close();
      } catch {}
      await work.catch(() => {});
    }
  });
  it.each([
    "counterfeit frame and EOF",
    "counterfeit EOF after a native frame",
  ] as const)(
    "refuses %s without publishing or releasing before actual cancellation",
    async (boundary) => {
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancel = vi.fn(() => completion);
      const nativeFrame = boundary === "counterfeit EOF after a native frame";
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
            if (nativeFrame)
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(catalog)),
              );
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body);
      const getReader = ReadableStream.prototype.getReader;
      const counterfeitRead = vi.fn(() =>
        Promise.resolve(
          !nativeFrame && counterfeitRead.mock.calls.length === 1
            ? {
                done: false,
                value: new TextEncoder().encode(JSON.stringify(catalog)),
              }
            : { done: true, value: undefined },
        ),
      );
      let accesses = 0;
      // Instrument the platform seam while preserving native acquisition from the exact original body.
      const acquisition = vi
        .spyOn(ReadableStream.prototype, "getReader")
        .mockImplementation(function (this: ReadableStream<Uint8Array>) {
          expect(this).toBe(body);
          const reader = Reflect.apply(
            getReader,
            this,
            [],
          ) as ReadableStreamDefaultReader<Uint8Array>;
          const nativeRead = reader.read;
          Object.defineProperty(reader, "read", {
            get: () => {
              accesses++;
              return nativeFrame && accesses === 1
                ? nativeRead
                : counterfeitRead;
            },
          });
          return reader;
        } as typeof ReadableStream.prototype.getReader);
      const work = api(vi.fn(async () => response)).getCatalog();
      const settled = vi.fn();
      void work.then(settled, settled);
      try {
        await ticks();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(counterfeitRead).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(body.locked).toBe(true);
        expect(accesses).toBe(nativeFrame ? 2 : 1);
        expect(acquisition).toHaveBeenCalledTimes(1);
      } finally {
        acquisition.mockRestore();
        release();
        try {
          source.close();
        } catch {}
        await work.catch(() => {});
      }
      await expect(work).rejects.toEqual(invalid);
      expect(body.locked).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(counterfeitRead).not.toHaveBeenCalled();
    },
  );
  it.each(["overflow", "bad chunk", "read rejection"] as const)(
    "holds %s through the actual native operation and deferred source cancellation",
    async (boundary) => {
      let source!: ReadableStreamDefaultController<Uint8Array>;
      let release!: () => void;
      const completion = new Promise<void>((resolve) => {
        release = resolve;
      });
      const cancel = vi.fn(() => completion);
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
            if (boundary !== "read rejection")
              controller.enqueue(
                boundary === "overflow"
                  ? new Uint8Array(524289)
                  : ("private chunk" as never),
              );
          },
          cancel,
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body);
      const getReader = ReadableStream.prototype.getReader;
      // Instrument the platform seam while preserving native acquisition from the exact original body.
      const acquisition = vi
        .spyOn(ReadableStream.prototype, "getReader")
        .mockImplementation(function (this: ReadableStream<Uint8Array>) {
          expect(this).toBe(body);
          const reader = Reflect.apply(
            getReader,
            this,
            [],
          ) as ReadableStreamDefaultReader<Uint8Array>;
          if (boundary === "read rejection")
            Object.defineProperty(reader, "read", {
              value: () => Promise.reject(new Error("private read failure")),
            });
          return reader;
        } as typeof ReadableStream.prototype.getReader);
      const work = api(vi.fn(async () => response)).getCatalog();
      const settled = vi.fn();
      void work.then(settled, settled);
      try {
        await ticks();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(settled).not.toHaveBeenCalled();
        expect(body.locked).toBe(true);
        expect(acquisition).toHaveBeenCalledTimes(1);
      } finally {
        acquisition.mockRestore();
        release();
        try {
          source.close();
        } catch {}
        await work.catch(() => {});
      }
      await expect(work).rejects.toEqual(invalid);
      expect(body.locked).toBe(false);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "throw",
    "forged",
    "reject",
    "never",
    "fulfilled counterfeit",
  ] as const)(
    "retains uncertainty for %s cancellation rather than certifying cleanup",
    async (boundary) => {
      let source!: ReadableStreamDefaultController<Uint8Array>;
      const actualCancel = vi.fn();
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            source = controller;
            controller.enqueue(new Uint8Array(524289));
          },
          cancel: actualCancel,
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body);
      const getReader = ReadableStream.prototype.getReader;
      const forgedThen = vi.fn((resolve: () => void) => {
        resolve();
      });
      let requested = 0,
        nativeCancel: (() => Promise<void>) | undefined;
      // Instrument the platform seam while preserving native acquisition from the exact original body.
      const acquisition = vi
        .spyOn(ReadableStream.prototype, "getReader")
        .mockImplementation(function (this: ReadableStream<Uint8Array>) {
          expect(this).toBe(body);
          const reader = Reflect.apply(
            getReader,
            this,
            [],
          ) as ReadableStreamDefaultReader<Uint8Array>;
          nativeCancel = reader.cancel.bind(reader);
          Object.defineProperty(reader, "cancel", {
            value: () => {
              requested++;
              if (boundary === "throw")
                throw new Error("private cancel failure");
              if (boundary === "reject")
                return Promise.reject(new Error("private cancel rejection"));
              if (boundary === "never") return new Promise<void>(() => {});
              if (boundary === "fulfilled counterfeit")
                return Promise.resolve();
              // biome-ignore lint/suspicious/noThenProperty: forged cleanup must never certify native cancellation.
              return { then: forgedThen };
            },
          });
          return reader;
        } as typeof ReadableStream.prototype.getReader);
      const work = api(vi.fn(async () => response)).getCatalog();
      const settled = vi.fn();
      void work.then(settled, settled);
      try {
        await ticks();
        expect(requested).toBe(1);
        expect(actualCancel).not.toHaveBeenCalled();
        expect(settled).not.toHaveBeenCalled();
        expect(body.locked).toBe(true);
        expect(forgedThen).not.toHaveBeenCalled();
        expect(acquisition).toHaveBeenCalledTimes(1);
      } finally {
        acquisition.mockRestore();
        // Physically close the synthetic stream; this cannot turn a failed reported cancellation into certified job completion.
        if (nativeCancel) await nativeCancel().catch(() => {});
        else {
          try {
            source.close();
          } catch {}
        }
        await ticks();
      }
      expect(settled).not.toHaveBeenCalled();
      expect(forgedThen).not.toHaveBeenCalled();
    },
  );
});

describe("catalog body ownership when reader acquisition fails", () => {
  it("refuses a foreign native reader and real foreign EOF while owning original-body cancellation", async () => {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalCancel = vi.fn(() => completion);
    const originalBody = new ReadableStream<Uint8Array>(
      { cancel: originalCancel },
      { highWaterMark: 0 },
    );
    const foreignPull = vi.fn(
      (controller: ReadableStreamDefaultController<Uint8Array>) => {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify(catalogPage([]))),
        );
        controller.close();
      },
    );
    const foreignBody = new ReadableStream<Uint8Array>(
      { pull: foreignPull },
      { highWaterMark: 0 },
    );
    const response = new Response(originalBody);
    const replacement = vi.fn(() =>
      ReadableStream.prototype.getReader.call(foreignBody),
    );
    Object.defineProperty(originalBody, "getReader", { value: replacement });
    const work = api(vi.fn(async () => response)).getCatalog();
    const settled = vi.fn();
    void work.then(settled, settled);
    try {
      for (let tick = 0; tick < 16; tick++) await Promise.resolve();
      expect(originalCancel).toHaveBeenCalledTimes(1);
      expect(replacement).not.toHaveBeenCalled();
      expect(foreignPull).not.toHaveBeenCalled();
      expect(foreignBody.locked).toBe(false);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      release();
      await work.catch(() => {});
      await ReadableStream.prototype.cancel.call(originalBody).catch(() => {});
      await ReadableStream.prototype.cancel.call(foreignBody).catch(() => {});
    }
    await expect(work).rejects.toEqual(
      new WeddingGiftsApiError(502, "INVALID_API_RESPONSE"),
    );
    expect(originalCancel).toHaveBeenCalledTimes(1);
    expect(replacement).not.toHaveBeenCalled();
    expect(foreignPull).not.toHaveBeenCalled();
  });
  it("awaits genuine body cancellation before returning reader-acquisition failure", async () => {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cancel = vi.fn(() => completion);
    const body = new ReadableStream<Uint8Array>(
      { cancel },
      { highWaterMark: 0 },
    );
    const response = new Response(body);
    Object.defineProperty(body, "getReader", {
      value: () => {
        throw new Error("private reader failure");
      },
    });
    const work = api(vi.fn(async () => response)).getCatalog();
    const settled = vi.fn();
    void work.then(settled, settled);
    try {
      for (let tick = 0; tick < 16; tick++) await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();
    } finally {
      release();
      await work.catch(() => {});
    }
    await expect(work).rejects.toEqual(
      new WeddingGiftsApiError(502, "INVALID_API_RESPONSE"),
    );
  });
  it.each([
    "throw",
    "forged",
    "reject",
    "never",
    "fulfilled counterfeit",
  ] as const)("does not certify %s body cleanup", async (boundary) => {
    const actualCancel = vi.fn();
    const body = new ReadableStream<Uint8Array>(
      { cancel: actualCancel },
      { highWaterMark: 0 },
    );
    const response = new Response(body);
    const nativeCancel = body.cancel.bind(body);
    Object.defineProperty(body, "getReader", {
      value: () => {
        throw new Error("private reader failure");
      },
    });
    const forgedThen = vi.fn((resolve: () => void) => {
      resolve();
    });
    const cancel = vi.fn(() => {
      if (boundary === "throw") throw new Error("private cleanup failure");
      if (boundary === "reject")
        return Promise.reject(new Error("private cleanup rejection"));
      if (boundary === "never") return new Promise<void>(() => {});
      if (boundary === "fulfilled counterfeit") return Promise.resolve();
      // biome-ignore lint/suspicious/noThenProperty: forged cleanup must never certify native cancellation.
      return { then: forgedThen };
    });
    Object.defineProperty(body, "cancel", { value: cancel });
    const work = api(vi.fn(async () => response)).getCatalog();
    const settled = vi.fn();
    void work.then(settled, settled);
    try {
      for (let tick = 0; tick < 16; tick++) await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(actualCancel).not.toHaveBeenCalled();
      expect(settled).not.toHaveBeenCalled();
      expect(forgedThen).not.toHaveBeenCalled();
    } finally {
      await nativeCancel();
    }
  });
});
