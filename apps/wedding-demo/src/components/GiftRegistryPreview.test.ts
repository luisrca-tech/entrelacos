import {
  GiftRecoveryView,
  WeddingGiftsApi,
  WeddingGiftsApiError,
} from "@entrelacos/wedding-features";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  type CheckoutStatus,
  checkoutCreateInputSchema,
  giftQuoteResponseSchema,
  publicGiftCatalogPageResponseSchema,
} from "../../../../packages/contracts/src/index";
import { recoverGiftCheckout } from "../../../../packages/wedding-features/src/giftCheckoutRecovery";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "../../../../packages/wedding-features/src/giftCheckoutState";
import {
  loadPendingGiftCheckout,
  writePendingGiftCheckout,
} from "../../../../packages/wedding-features/src/giftCheckoutStorage";
import {
  createGiftPreviewFetcher,
  GiftRegistryPreview,
} from "./GiftRegistryPreview";

const apiOrigin = "https://gift-preview.invalid";
const siteId = "local-gift-preview";
const catalogUrl = `${apiOrigin}/v1/public/sites/${siteId}/gifts`;
const quoteUrl = `${apiOrigin}/v1/public/sites/${siteId}/gift-quotes`;
const checkoutUrl = `${apiOrigin}/v1/public/sites/${siteId}/gift-checkouts`;
const fixedNow = new Date("2026-10-12T12:00:00.000Z");

async function readJson(response: Response) {
  return (await response.json()) as unknown;
}

describe("local gift registry preview", () => {
  it("renders a clear local demo notice without doing browser work on the server", () => {
    const html = renderToStaticMarkup(createElement(GiftRegistryPreview));
    expect(html).toContain(
      "Prévia local — dados fictícios, sem pagamentos reais",
    );
    expect(html).toContain("Cenário da prévia");
    expect(html).toContain("Erro de catálogo");
    expect(html).toContain("Erro de cotação");
    expect(html).toContain("Cotação lenta");
    expect(html).toContain("Cotação expira em 3 segundos");
    expect(html).toContain("Resposta de outro casamento");
    expect(html).toContain("Consulta de pagamento lenta");
    expect(html).toContain("Recebimento seguido de verificação");
    expect(html).toContain("Reembolso seguido de verificação");
    expect(html).toContain("Tentativas de checkout nesta prévia: 0");
  });

  it.each(["RECEIVED", "REFUNDED"] as const)(
    "projects fictional %s to uncertainty across close/remount and never pays again",
    async (paymentState) => {
      let clock = fixedNow.getTime();
      let nextStatus: CheckoutStatus["state"] = paymentState;
      const scenario =
        paymentState === "RECEIVED" ? "received-history" : "refunded-history";
      const requests = vi.fn();
      const network = vi.fn();
      vi.stubGlobal("fetch", network);
      try {
        const fetcher = () =>
          createGiftPreviewFetcher(
            () => new Date(clock),
            scenario,
            requests,
            () => nextStatus,
          );
        let api = new WeddingGiftsApi({
          siteId,
          apiOrigin,
          demo: true,
          fetcher: fetcher(),
        });
        const quote = await api.quoteGift({
          giftId: "gift-preview-dinner",
          method: "PIX",
        });
        const pending = {
          quoteId: quote.id,
          requestId: "history-preview-request",
          recoveryToken: "A".repeat(43),
          method: quote.method,
          mode: quote.mode,
        };
        const values = new Map<string, string>();
        const target = {
          getItem: (key: string) => values.get(key) ?? null,
          setItem: (key: string, value: string) => {
            values.set(key, value);
          },
          removeItem: vi.fn((key: string) => {
            values.delete(key);
          }),
        };
        writePendingGiftCheckout(target, siteId, pending);
        await expect(
          api.createCheckout(
            {
              quoteId: pending.quoteId,
              requestId: pending.requestId,
              recoveryToken: pending.recoveryToken,
            },
            quote,
          ),
        ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
        let state = giftCheckoutReducer(createGiftCheckoutState(), {
          type: "RESTORE_UNKNOWN",
          siteId,
          pending,
        });
        async function consult() {
          const event = await recoverGiftCheckout(api, state, () => target);
          if (event) state = giftCheckoutReducer(state, event);
          return renderToStaticMarkup(
            createElement(GiftRecoveryView, {
              siteId,
              status: state.checkoutStatus,
              onContinue: vi.fn(),
            }),
          );
        }
        expect(await consult()).toContain(
          paymentState === "RECEIVED"
            ? "Recebimento confirmado"
            : "Reembolso confirmado",
        );
        nextStatus = "OUTCOME_UNKNOWN";
        clock += 1000;
        const unknown = await consult();
        expect(unknown).toContain("Pagamento em verificação");
        expect(unknown).not.toMatch(
          /Recebimento confirmado|Reembolso confirmado|Continuar para pagamento/,
        );
        expect(state.pending?.terminalStatus?.state).toBe(paymentState);
        expect(giftCheckoutReducer(state, { type: "CLOSE" })).toBe(state);
        const stored = loadPendingGiftCheckout(() => target, siteId);
        if (!stored) throw new Error("Expected retained fixture operation");
        state = giftCheckoutReducer(createGiftCheckoutState(), {
          type: "RESTORE_UNKNOWN",
          siteId,
          pending: stored,
        });
        api = new WeddingGiftsApi({
          siteId,
          apiOrigin,
          demo: true,
          fetcher: fetcher(),
        });
        expect(state.checkoutStatus).toBeNull();
        for (const status of ["CLOSED_UNPAID", "AWAITING_PAYMENT"] as const) {
          nextStatus = status;
          clock += 1000;
          expect(await consult()).toContain("Pagamento em verificação");
          expect(state.phase).toBe("UNKNOWN");
          expect(state.pending).toEqual(stored);
        }
        nextStatus = paymentState;
        clock = fixedNow.getTime() + 1000;
        expect(await consult()).toContain("Pagamento em verificação");
        clock += 1;
        expect(await consult()).toContain(
          paymentState === "RECEIVED"
            ? "Recebimento confirmado"
            : "Reembolso confirmado",
        );
        expect(state.phase).toBe("UNKNOWN");
        expect(target.removeItem).not.toHaveBeenCalled();
        expect(requests).toHaveBeenCalledTimes(1);
        expect(network).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("serves a strictly valid Portuguese catalog with varied responsive content", async () => {
    const fetcher = createGiftPreviewFetcher(() => fixedNow);
    const response = await fetcher(catalogUrl);
    const catalog = publicGiftCatalogPageResponseSchema.parse(
      await readJson(response),
    );

    expect(response.status).toBe(200);
    expect(catalog.mode).toBe("sandbox");
    expect(catalog.gifts).toHaveLength(3);
    expect(catalog.gifts.map((gift) => gift.title)).toEqual([
      "Jantar especial para celebrar",
      "Um passeio tranquilo a dois pela cidade",
      "Uma experiência de fim de semana com bastante tempo para descansar",
    ]);
    expect(catalog.gifts[2].description.length).toBeGreaterThan(120);
    expect(catalog.gifts.every((gift) => gift.image === null)).toBe(true);
  });
  it("keeps card-method recovery bound to the exact fixture quote and never returns the capability", async () => {
    const fetcher = createGiftPreviewFetcher(
      () => fixedNow,
      "refunded-history",
    );
    const api = new WeddingGiftsApi({ siteId, apiOrigin, demo: true, fetcher });
    const quote = await api.quoteGift({
      giftId: "gift-preview-dinner",
      method: "CREDIT_CARD",
    });
    const status = await api.getCheckoutStatus(
      {
        quoteId: quote.id,
        requestId: "fixture-card-request",
        recoveryToken: "A".repeat(43),
      },
      { method: quote.method, mode: "sandbox" },
    );
    expect(status).toMatchObject({
      siteId,
      quoteId: quote.id,
      requestId: "fixture-card-request",
      method: "CREDIT_CARD",
      mode: "sandbox",
      state: "REFUNDED",
      checkout: null,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /recoveryToken|AAAAAAAA|wallet|payer/,
    );
  });
  it("rejects unknown quotes and private status-input fields in history scenarios", async () => {
    const fetcher = createGiftPreviewFetcher(
      () => fixedNow,
      "received-history",
    );
    for (const input of [
      {
        quoteId: "foreign-quote",
        requestId: "fixture-request",
        recoveryToken: "A".repeat(43),
      },
      {
        quoteId: "gift-preview-gift-preview-dinner-pix",
        requestId: "fixture-request",
        recoveryToken: "A".repeat(43),
        walletId: "private",
      },
    ]) {
      const response = await fetcher(`${checkoutUrl}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toEqual({ code: "VALIDATION_ERROR" });
    }
  });

  it("validates C1 quote input and returns the exact sandbox gift quote", async () => {
    const fetcher = createGiftPreviewFetcher(() => fixedNow);
    const catalog = publicGiftCatalogPageResponseSchema.parse(
      await readJson(await fetcher(catalogUrl)),
    );
    const gift = catalog.gifts[0];
    const input = { giftId: gift.id, method: "PIX" };
    const response = await fetcher(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const quote = giftQuoteResponseSchema.parse(await readJson(response)).quote;

    expect(response.status).toBe(200);
    expect(quote).toMatchObject({
      giftId: gift.id,
      siteId,
      title: gift.title,
      method: "PIX",
      currency: "BRL",
      nominalCents: gift.nominalCents,
      commissionBasisPoints: 200,
      commissionCents: Math.round((gift.nominalCents * 200) / 10000),
      processingCents: 90,
      totalCents: gift.nominalCents,
      feeAllocation: "RECIPIENT_DEDUCTED",
      policyVersion: "local-gift-policy-v1",
      expiresAt: "2026-10-12T12:05:00.000Z",
      mode: "sandbox",
    });

    const cardResponse = await fetcher(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giftId: gift.id, method: "CREDIT_CARD" }),
    });
    const cardQuote = giftQuoteResponseSchema.parse(
      await readJson(cardResponse),
    ).quote;
    expect(cardQuote).toMatchObject({
      giftId: gift.id,
      method: "CREDIT_CARD",
      processingCents: 290,
      mode: "sandbox",
    });
  });

  it("rejects malformed quote input and unknown fixture gifts", async () => {
    const fetcher = createGiftPreviewFetcher(() => fixedNow);
    const invalidInput = await fetcher(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giftId: "gift-preview-dinner", method: "BANK" }),
    });
    expect(invalidInput.status).toBe(400);
    expect(await readJson(invalidInput)).toEqual({ code: "VALIDATION_ERROR" });

    const unknownGift = await fetcher(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giftId: "not-in-this-preview", method: "PIX" }),
    });
    expect(unknownGift.status).toBe(409);
    expect(await readJson(unknownGift)).toEqual({ code: "QUOTE_INVALID" });
  });

  it("offers controlled catalog and quote failure scenarios", async () => {
    const catalogFailure = await createGiftPreviewFetcher(
      () => fixedNow,
      "catalog-error",
    )(catalogUrl);
    expect(catalogFailure.status).toBe(503);
    expect(await readJson(catalogFailure)).toEqual({
      code: "CATALOG_UNAVAILABLE",
    });

    const quoteFailure = await createGiftPreviewFetcher(
      () => fixedNow,
      "quote-error",
    )(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giftId: "gift-preview-dinner", method: "PIX" }),
    });
    expect(quoteFailure.status).toBe(503);
    expect(await readJson(quoteFailure)).toEqual({
      code: "PROVIDER_MODE_UNAVAILABLE",
    });
  });

  it("delays quote resolution by a controlled 500 milliseconds", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = createGiftPreviewFetcher(() => fixedNow, "slow-quote");
      const responsePromise = fetcher(quoteUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ giftId: "gift-preview-dinner", method: "PIX" }),
      });
      await vi.advanceTimersByTimeAsync(499);
      let resolved = false;
      void responsePromise.then(() => {
        resolved = true;
      });
      await Promise.resolve();
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await responsePromise;
      expect(response.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("delays only valid recovery consultation without creating another checkout", async () => {
    vi.useFakeTimers();
    try {
      const created = vi.fn();
      const fetcher = createGiftPreviewFetcher(
        () => fixedNow,
        "slow-recovery",
        created,
      );
      const url = `${checkoutUrl}/status`;
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          quoteId: "quote-preview",
          requestId: "request-preview",
          recoveryToken: "A".repeat(43),
        }),
      };
      let resolved = false;
      const responsePromise = fetcher(url, options).then((response) => {
        resolved = true;
        return response;
      });
      await vi.advanceTimersByTimeAsync(1499);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const response = await responsePromise;
      expect(response.status).toBe(409);
      expect(await readJson(response)).toEqual({
        code: "PROVIDER_MODE_UNAVAILABLE",
      });
      expect(created).not.toHaveBeenCalled();
      const invalid = await fetcher(url, { ...options, body: "{}" });
      expect(invalid.status).toBe(400);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns an exact three-second expiry and rejects a quote bound to another wedding", async () => {
    const expiring = await createGiftPreviewFetcher(
      () => fixedNow,
      "expiring-quote",
    )(quoteUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ giftId: "gift-preview-dinner", method: "PIX" }),
    });
    const expiringQuote = giftQuoteResponseSchema.parse(
      await readJson(expiring),
    ).quote;
    expect(expiringQuote.expiresAt).toBe("2026-10-12T12:00:03.000Z");

    const api = new WeddingGiftsApi({
      siteId,
      apiOrigin,
      demo: true,
      fetcher: createGiftPreviewFetcher(() => fixedNow, "foreign-site"),
    });
    await expect(
      api.quoteGift({ giftId: "gift-preview-dinner", method: "PIX" }),
    ).rejects.toMatchObject(
      new WeddingGiftsApiError(502, "INVALID_API_RESPONSE"),
    );
  });

  it("validates checkout recovery input then reports an unknown external outcome without redirect data", async () => {
    const onCheckoutRequest = vi.fn();
    const fetcher = createGiftPreviewFetcher(
      () => fixedNow,
      "normal",
      onCheckoutRequest,
    );
    const validInput = checkoutCreateInputSchema.parse({
      quoteId: "gift-preview-gift-preview-dinner-pix",
      requestId: "gift-preview-request-1",
      recoveryToken: "A".repeat(43),
    });
    const response = await fetcher(checkoutUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validInput),
    });

    expect(response.status).toBe(409);
    expect(await readJson(response)).toEqual({
      code: "EXTERNAL_OUTCOME_UNKNOWN",
    });
    expect(onCheckoutRequest).toHaveBeenCalledTimes(1);

    const invalid = await fetcher(checkoutUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validInput, recoveryToken: "invalid" }),
    });
    expect(invalid.status).toBe(400);
    expect(await readJson(invalid)).toEqual({ code: "VALIDATION_ERROR" });
    expect(onCheckoutRequest).toHaveBeenCalledTimes(1);
  });

  it("fails closed for other origins, methods, and resources without calling global fetch", async () => {
    const networkFetch = vi.fn();
    const originalFetch = globalThis.fetch;
    vi.stubGlobal("fetch", networkFetch);

    try {
      const fetcher = createGiftPreviewFetcher(() => fixedNow);
      const responses = await Promise.all([
        fetcher("https://example.com/v1/public/sites/local-gift-preview/gifts"),
        fetcher(`${apiOrigin}/v1/public/sites/${siteId}/unknown-resource`),
        fetcher(catalogUrl, { method: "POST", body: "{}" }),
      ]);

      expect(responses.map((response) => response.status)).toEqual([
        404, 404, 404,
      ]);
      expect(networkFetch).not.toHaveBeenCalled();
    } finally {
      vi.stubGlobal("fetch", originalFetch);
    }
  });
});

describe("synthetic SERVER catalog paging", () => {
  it("filters before building the page response and echoes an empty out-of-range page", async () => {
    const fetcher = createGiftPreviewFetcher(() => fixedNow);
    const api = new WeddingGiftsApi({ apiOrigin, siteId, fetcher, demo: true });
    const match = await api.getCatalog({ page: 1, q: " cidade " });
    expect(match.q).toBe("cidade");
    expect(match.total).toBe(1);
    expect(match.gifts).toHaveLength(1);
    expect(match.gifts[0].id).toBe("gift-preview-city-walk");
    const empty = await api.getCatalog({ page: 2, q: "cidade" });
    expect(empty).toMatchObject({
      page: 2,
      total: 1,
      totalPages: 1,
      hasNext: false,
      gifts: [],
    });
  });
  it.each([
    "?page=01",
    "?q=a&q=b",
    "?scope=private",
    "?q=%FF",
    `?q=${"%20".repeat(683)}`,
  ])("rejects raw catalog query %s", async (query) => {
    const response = await createGiftPreviewFetcher(() => fixedNow)(
      catalogUrl + query,
    );
    expect(response.status).toBe(400);
  });
});
