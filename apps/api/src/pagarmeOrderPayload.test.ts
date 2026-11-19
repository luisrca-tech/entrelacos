import { describe, expect, it } from "vitest";
import {
  buildPagarmeOrderRequest,
  type PagarmeOrderCommand,
  pagarmeSplitAmounts,
} from "./pagarmeOrderPayload";

const now = new Date("2026-11-18T12:00:00.000Z");
const buyer = {
  name: "Maria Convidada",
  email: "maria@example.com",
  cpf: "12345678909",
  phone: "11987654321",
};
// R$ 100,00 gift; G and C from quoteGiftV2 (Phase 1 table).
const pix: PagarmeOrderCommand = {
  checkoutId: "attempt-1",
  giftId: "gift-1",
  giftTitle: "Jantar no Porto",
  method: "PIX",
  installments: 1,
  totalCents: 10369,
  coupleSplitCents: 10000,
  quoteExpiresAt: new Date("2026-11-18T12:05:00.000Z"),
  now,
  buyer,
  platformRecipientId: "rp_platform",
  coupleRecipientId: "rp_couple",
};
const card: PagarmeOrderCommand = {
  ...pix,
  method: "CREDIT_CARD",
  installments: 6,
  totalCents: 11890,
  coupleSplitCents: 11031,
  cardToken: "token_abc123",
};

describe("Pagar.me order payload", () => {
  it("builds a closed Pix order with the quote expiry and the D2 split", () => {
    const request = buildPagarmeOrderRequest(pix);
    expect(request.idempotencyKey).toBe("attempt-1");
    expect(request.body).toEqual({
      code: "attempt-1",
      closed: true,
      customer: {
        name: "Maria Convidada",
        email: "maria@example.com",
        document: "12345678909",
        document_type: "CPF",
        type: "individual",
        phones: {
          mobile_phone: {
            country_code: "55",
            area_code: "11",
            number: "987654321",
          },
        },
      },
      items: [
        {
          amount: 10369,
          description: "Jantar no Porto",
          quantity: 1,
          code: "gift-1",
        },
      ],
      payments: [
        {
          payment_method: "pix",
          amount: 10369,
          pix: { expires_in: 300 },
          split: [
            {
              recipient_id: "rp_platform",
              type: "flat",
              amount: 369,
              options: {
                liable: true,
                charge_processing_fee: true,
                charge_remainder_fee: true,
              },
            },
            {
              recipient_id: "rp_couple",
              type: "flat",
              amount: 10000,
              options: {
                liable: false,
                charge_processing_fee: false,
                charge_remainder_fee: false,
              },
            },
          ],
        },
      ],
    });
  });

  it("accepts the re_ and pp_ recipient id formats in split rules", () => {
    const request = buildPagarmeOrderRequest({
      ...pix,
      platformRecipientId: "re_platform",
      coupleRecipientId: "pp_couple",
    });
    expect(
      request.body.payments[0].split.map((rule) => rule.recipient_id),
    ).toEqual(["re_platform", "pp_couple"]);
  });

  it("builds a tokenized card order with installments and descriptor", () => {
    const { body } = buildPagarmeOrderRequest(card);
    const [payment] = body.payments;
    expect(payment.payment_method).toBe("credit_card");
    expect(payment.amount).toBe(11890);
    expect(payment.credit_card).toEqual({
      card_token: "token_abc123",
      installments: 6,
      statement_descriptor: "ENTRELACOS",
      operation_type: "auth_and_capture",
    });
    expect(payment.pix).toBeUndefined();
    expect(body.items[0].amount).toBe(11890);
    expect(payment.split.map((rule) => rule.amount)).toEqual([859, 11031]);
    expect(JSON.stringify(body)).not.toMatch(
      /"(cvv|card)"|"number":"\d{13,19}"/,
    );
  });

  it("keeps the two flat split amounts equal to the guest total", () => {
    for (const command of [pix, card]) {
      const [payment] = buildPagarmeOrderRequest(command).body.payments;
      expect(payment.split.reduce((sum, rule) => sum + rule.amount, 0)).toBe(
        command.totalCents,
      );
      expect(payment.split.every((rule) => rule.amount > 0)).toBe(true);
    }
  });

  it("states both rules per installment in per_installment mode", () => {
    const [payment] = buildPagarmeOrderRequest({
      ...card,
      splitMode: "per_installment",
    }).body.payments;
    // Each installment is ceil(G / n); the couple gets ceil(C / n) of it.
    expect(payment.split[1].amount).toBe(Math.ceil(11031 / 6));
    expect(payment.split[0].amount).toBe(
      Math.ceil(11890 / 6) - Math.ceil(11031 / 6),
    );
  });

  it.each([1, 2, 3, 4, 5, 6])(
    "pays each recipient C and G − C across %ix under either split mode",
    (installments) => {
      const command = { ...card, installments };
      const whole = pagarmeSplitAmounts({
        ...command,
        splitMode: "charge_total",
      });
      expect(whole).toEqual({
        platformCents: 11890 - 11031,
        coupleCents: 11031,
        ruleTotalCents: 11890,
      });
      const each = pagarmeSplitAmounts({
        ...command,
        splitMode: "per_installment",
      });
      const coupleReceives = each.coupleCents * installments;
      const platformReceives = each.platformCents * installments;
      // Rounding up per installment only ever favours the couple (< n cents)
      // and the platform rule absorbs the remainder fee.
      expect(coupleReceives - 11031).toBeGreaterThanOrEqual(0);
      expect(coupleReceives - 11031).toBeLessThan(installments);
      expect(Math.abs(platformReceives - (11890 - 11031))).toBeLessThan(
        2 * installments,
      );
      expect(each.platformCents + each.coupleCents).toBe(each.ruleTotalCents);
    },
  );

  it("rounds the Pix expiry down to whole seconds", () => {
    const [payment] = buildPagarmeOrderRequest({
      ...pix,
      quoteExpiresAt: new Date(now.getTime() + 299_999),
    }).body.payments;
    expect(payment.pix?.expires_in).toBe(299);
  });

  it.each<[string, Partial<PagarmeOrderCommand>]>([
    ["an expired quote", { quoteExpiresAt: now }],
    ["more than 6 installments", { installments: 7 }],
    ["a couple split above the total", { coupleSplitCents: 11890 }],
    ["a card checkout without a token", { cardToken: undefined }],
    [
      "the platform recipient as the couple",
      { coupleRecipientId: "rp_platform" },
    ],
    ["a malformed recipient", { coupleRecipientId: "acc_1" }],
    ["a malformed CPF", { buyer: { ...buyer, cpf: "123" } }],
  ])("refuses %s", (_label, change) => {
    expect(() => buildPagarmeOrderRequest({ ...card, ...change })).toThrow();
  });

  it("refuses installments or a token on Pix", () => {
    expect(() =>
      buildPagarmeOrderRequest({ ...pix, installments: 2 }),
    ).toThrow();
    expect(() =>
      buildPagarmeOrderRequest({ ...pix, cardToken: "token_abc123" }),
    ).toThrow();
  });
});
