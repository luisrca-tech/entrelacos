import { describe, expect, it } from "vitest";
import { GIFT_PLATFORM_TARIFFS } from "./giftTariffs";
import {
  giftCheckoutCreateInputSchema,
  giftMaximumInstallments,
  giftQuoteInputSchema,
} from "./internalGifts";

// D7: card from 1x to 6x. Only the API's own check used to stop 7x–12x.
describe("gift installment limit", () => {
  it("matches the Pagar.me tariff limit", () => {
    expect(giftMaximumInstallments).toBe(GIFT_PLATFORM_TARIFFS.maxInstallments);
    expect(giftMaximumInstallments).toBe(6);
  });

  it("rejects 7 or more installments in the public quote and checkout inputs", () => {
    const quote = { giftId: "gift-1", method: "CREDIT_CARD" };
    expect(
      giftQuoteInputSchema.safeParse({ ...quote, installmentCount: 6 }).success,
    ).toBe(true);
    expect(
      giftQuoteInputSchema.safeParse({ ...quote, installmentCount: 7 }).success,
    ).toBe(false);
    const checkout = {
      quoteId: "quote-1",
      requestId: "8c0d6f52-37f3-4e0e-9b6d-6f2a1f3c9b10",
      recoveryToken: `${"a".repeat(42)}A`,
      method: "CREDIT_CARD",
      cardToken: "token_abc123",
      buyer: {
        name: "Ana Souza",
        email: "ana@example.com",
        cpf: "52998224725",
        phone: "11987654321",
      },
    };
    expect(
      giftCheckoutCreateInputSchema.safeParse({ ...checkout, installments: 12 })
        .success,
    ).toBe(false);
  });
});
