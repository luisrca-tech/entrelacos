import { describe, expect, it } from "vitest";
import {
  giftCheckoutCreateInputSchema,
  giftCheckoutCreateResultSchema,
  giftCheckoutStatusSchema,
  internalGiftsEndpointPaths,
} from "./internalGifts";

const base = {
  quoteId: "quote-1",
  requestId: "request-1",
  recoveryToken: `${"a".repeat(42)}A`,
  buyer: {
    name: "Maria Convidada",
    email: "maria@example.com",
    cpf: "12345678909",
    phone: "11987654321",
  },
};

describe("transparent gift checkout contract", () => {
  it("accepts a Pix checkout and a tokenized card checkout", () => {
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "PIX",
        installments: 1,
      }).success,
    ).toBe(true);
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "CREDIT_CARD",
        installments: 6,
        cardToken: "token_abc123",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["number", { number: "4000000000000010" }],
    ["cvv", { cvv: "123" }],
    ["card object", { card: { number: "4000000000000010", cvv: "123" } }],
    ["holder name", { holder_name: "Maria" }],
    ["expiry", { exp_month: 1, exp_year: 30 }],
  ])("rejects raw card data (%s)", (_label, extra) => {
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "CREDIT_CARD",
        installments: 1,
        cardToken: "token_abc123",
        ...extra,
      }).success,
    ).toBe(false);
  });

  it("rejects raw card data inside the buyer", () => {
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        buyer: { ...base.buyer, cvv: "123" },
        method: "CREDIT_CARD",
        installments: 1,
        cardToken: "token_abc123",
      }).success,
    ).toBe(false);
  });

  it("requires a token for cards and forbids it (and installments) on Pix", () => {
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "CREDIT_CARD",
        installments: 2,
      }).success,
    ).toBe(false);
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "PIX",
        installments: 1,
        cardToken: "token_abc123",
      }).success,
    ).toBe(false);
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "PIX",
        installments: 2,
      }).success,
    ).toBe(false);
    expect(
      giftCheckoutCreateInputSchema.safeParse({
        ...base,
        method: "CREDIT_CARD",
        installments: 1,
        cardToken: "4000000000000010",
      }).success,
    ).toBe(false);
  });

  it("returns the checkout id, status and the Pix QR data", () => {
    expect(
      giftCheckoutCreateResultSchema.parse({
        checkoutId: "attempt-1",
        status: "AWAITING_PAYMENT",
        pix: {
          qrCode: "00020101021226820014br.gov.bcb.pix",
          qrCodeUrl: "https://api.pagar.me/core/v5/transactions/tran_1/qrcode",
          expiresAt: "2026-11-18T12:05:00.000Z",
        },
      }).pix?.qrCode,
    ).toContain("br.gov.bcb.pix");
  });

  it("only exposes Pix data while a Pix checkout awaits payment", () => {
    const status = {
      siteId: "site-1",
      quoteId: "quote-1",
      requestId: "request-1",
      checkoutId: "attempt-1",
      method: "PIX",
      mode: "sandbox",
      state: "RECEIVED",
      observedAt: "2026-11-18T12:00:00.000Z",
      closedReason: null,
      mayStartNewAttempt: false,
      pix: null,
    };
    expect(giftCheckoutStatusSchema.safeParse(status).success).toBe(true);
    expect(
      giftCheckoutStatusSchema.safeParse({
        ...status,
        pix: {
          qrCode: "x",
          qrCodeUrl: "https://example.com/qr",
          expiresAt: "2026-11-18T12:05:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  it("routes the webhook to the Pagar.me endpoint", () => {
    expect(internalGiftsEndpointPaths.pagarmeWebhook).toBe(
      "POST /v1/webhooks/pagarme",
    );
  });
});
