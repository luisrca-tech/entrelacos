import type { GiftQuote } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  pendingGiftCheckoutSchema,
  writePendingGiftCheckout,
} from "./giftCheckoutStorage";
import { submitGiftCheckout } from "./giftCheckoutSubmission";
import { WeddingGiftsApi } from "./gifts";

const recoveryToken = "A".repeat(43);
const pending = {
  quoteId: "quote-a",
  requestId: "request-a",
  recoveryToken,
  giftId: "gift-a",
  method: "CREDIT_CARD",
  mode: "sandbox",
} as const;
const quote = {
  id: pending.quoteId,
  giftId: "gift-a",
  siteId: "wedding-a",
  method: "CREDIT_CARD",
  mode: "sandbox",
  installmentCount: 3,
  settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
} as GiftQuote;
const billingAddress = {
  zipCode: "01310100",
  street: "Avenida Paulista",
  streetNumber: "1000",
  neighborhood: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};
const buyer = {
  name: "Ana Souza",
  email: "ana@example.com",
  cpf: "52998224725",
  phone: "11987654321",
};

function storage(value: unknown = pending) {
  return {
    getItem: vi.fn().mockReturnValue(JSON.stringify(value)),
    removeItem: vi.fn(),
  };
}

describe("transparent checkout submission", () => {
  it("sends only the card token, the billing address, the buyer and the recovery identity", async () => {
    const createCheckout = vi
      .fn()
      .mockResolvedValue({ checkoutId: "checkout-a", status: "RECEIVED" });
    const event = await submitGiftCheckout(
      { createCheckout },
      quote,
      pending,
      () => storage(),
      () => true,
      { buyer, cardToken: "token_abc123", billingAddress },
    );
    expect(createCheckout).toHaveBeenCalledWith(
      {
        quoteId: "quote-a",
        requestId: "request-a",
        recoveryToken,
        method: "CREDIT_CARD",
        installments: 3,
        cardToken: "token_abc123",
        billingAddress,
        buyer,
      },
      quote,
    );
    expect(event).toEqual({
      type: "CHECKOUT_RESOLVED",
      checkout: { checkoutId: "checkout-a", status: "RECEIVED" },
    });
  });

  it("asks for a fresh quote when the card is declined", async () => {
    const target = storage();
    const event = await submitGiftCheckout(
      {
        createCheckout: vi.fn().mockResolvedValue({
          checkoutId: "checkout-a",
          status: "CLOSED_UNPAID",
        }),
      },
      quote,
      pending,
      () => target,
      () => true,
      { buyer, cardToken: "token_abc123" },
    );
    expect(target.removeItem).toHaveBeenCalledTimes(1);
    expect(event).toMatchObject({
      type: "CHECKOUT_FAILED",
      unknown: false,
      invalidateQuote: true,
      requote: true,
      message:
        "O cartão não foi aprovado. Confira os dados ou use outro cartão.",
    });
  });
});

describe("couple-site API client", () => {
  it("posts the new checkout contract and reads the flat creation result", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        checkoutId: "checkout-a",
        status: "AWAITING_PAYMENT",
        pix: {
          qrCode: "000201",
          qrCodeUrl: "https://api.pagar.me/qr.png",
          expiresAt: "2026-10-12T15:30:00.000Z",
        },
      }),
    );
    const api = new WeddingGiftsApi({
      apiOrigin: "https://api.example.test",
      siteId: "wedding-a",
      fetcher,
    });
    const input = {
      quoteId: "quote-a",
      requestId: "request-a",
      recoveryToken,
      method: "PIX" as const,
      installments: 1,
      buyer,
    };
    await expect(
      api.createCheckout(input, {
        ...quote,
        method: "PIX",
        installmentCount: undefined,
      }),
    ).resolves.toMatchObject({ checkoutId: "checkout-a" });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.example.test/v1/public/sites/wedding-a/gift-checkouts",
    );
    expect(JSON.parse(String(init.body))).toEqual(input);
    // A Pix QR on a card checkout is a contradiction.
    await expect(
      api.createCheckout(
        {
          ...input,
          method: "CREDIT_CARD",
          installments: 3,
          cardToken: "token_x1",
          billingAddress,
        },
        quote,
      ),
    ).rejects.toMatchObject({ code: "INVALID_API_RESPONSE" });
  });

  it("refuses raw card fields before any request", async () => {
    const fetcher = vi.fn();
    const api = new WeddingGiftsApi({
      apiOrigin: "https://api.example.test",
      siteId: "wedding-a",
      fetcher,
    });
    await expect(
      api.createCheckout(
        {
          quoteId: "quote-a",
          requestId: "request-a",
          recoveryToken,
          method: "CREDIT_CARD",
          installments: 3,
          cardToken: "token_x1",
          billingAddress,
          buyer,
          card: { number: "4000000000000010", cvv: "123" },
        } as never,
        quote,
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("recovery storage", () => {
  it("keeps the request id and recovery token and refuses any card field", () => {
    expect(pendingGiftCheckoutSchema.parse(pending)).toEqual(pending);
    for (const extra of [
      { cardToken: "token_abc123" },
      { number: "4000000000000010" },
      { cvv: "123" },
      { card: { number: "4000000000000010" } },
      { buyer },
    ])
      expect(
        pendingGiftCheckoutSchema.safeParse({ ...pending, ...extra }).success,
      ).toBe(false);
    const target = { setItem: vi.fn() };
    expect(() =>
      writePendingGiftCheckout(target, "wedding-a", {
        ...pending,
        cvv: "123",
      } as never),
    ).toThrow();
    expect(target.setItem).not.toHaveBeenCalled();
  });
});
