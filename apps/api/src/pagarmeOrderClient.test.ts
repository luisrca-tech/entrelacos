import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  PagarmeRejectedError,
  PagarmeUnknownOutcomeError,
} from "./pagarmeHttpClient";
import { createPagarmeOrderClient } from "./pagarmeOrderClient";
import { buildPagarmeOrderRequest } from "./pagarmeOrderPayload";

const secretKey = "sk_test_fixtureSecretKey";

function fixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
      "utf8",
    ),
  );
}

function respond(status: number, body: unknown) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

const request = buildPagarmeOrderRequest({
  checkoutId: "checkout-fixture-1",
  giftId: "gift-fixture-1",
  giftTitle: "Jogo de jantar",
  method: "PIX",
  installments: 1,
  totalCents: 10369,
  coupleSplitCents: 10000,
  quoteExpiresAt: new Date("2026-11-18T12:30:00.000Z"),
  now: new Date("2026-11-18T12:00:00.000Z"),
  buyer: {
    name: "Maria Convidada",
    email: "maria@example.com",
    cpf: "12345678909",
    phone: "11987654321",
  },
  platformRecipientId: "rp_platformFixture01",
  coupleRecipientId: "rp_fixtureRecipient01",
});

describe("Pagar.me order client", () => {
  it("creates an order with the checkout id as Idempotency-Key", async () => {
    const fetch = respond(200, fixture("order-pix-pending"));
    const order = await createPagarmeOrderClient({
      secretKey,
      fetch,
    }).createOrder(request);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.pagar.me/core/v5/orders");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe(
      "checkout-fixture-1",
    );
    expect(JSON.parse(String(init?.body))).toEqual(request.body);
    expect(order).toMatchObject({
      id: "or_fixtureOrder0001",
      code: "checkout-fixture-1",
      status: "pending",
      amountCents: 10369,
    });
    expect(order.charges[0]).toMatchObject({
      id: "ch_fixtureCharge001",
      status: "pending",
      paymentMethod: "pix",
      pix: {
        qrCode: "00020101021226820014br.gov.bcb.pix2560fixture",
        qrCodeUrl:
          "https://api.pagar.me/core/v5/transactions/tran_fixtureTx0001/qrcode?payment_method=pix",
        expiresAt: "2026-11-18T12:30:00.000Z",
      },
    });
  });

  it("reads a paid card order with installments and the split rules", async () => {
    const fetch = respond(200, fixture("order-card-paid"));
    const order = await createPagarmeOrderClient({
      secretKey,
      fetch,
    }).getOrder("or_fixtureOrder0002");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.pagar.me/core/v5/orders/or_fixtureOrder0002",
    );
    expect(fetch.mock.calls[0][1]?.method).toBe("GET");
    expect(order.status).toBe("paid");
    expect(order.charges[0]).toMatchObject({
      id: "ch_fixtureCharge002",
      status: "paid",
      paidAmountCents: 11890,
      installments: 6,
      pix: null,
      split: [
        { recipientId: "rp_platformFixture01", amountCents: 859 },
        { recipientId: "rp_fixtureRecipient01", amountCents: 11031 },
      ],
    });
  });

  it("reads split rules echoed for re_ and pp_ recipients", async () => {
    const body = JSON.parse(
      JSON.stringify(fixture("order-card-paid"))
        .replaceAll('"rp_platformFixture01"', '"re_platformFixture01"')
        .replaceAll('"rp_fixtureRecipient01"', '"pp_fixtureRecipient01"'),
    );
    const order = await createPagarmeOrderClient({
      secretKey,
      fetch: respond(200, body),
    }).getOrder("or_fixtureOrder0002");
    expect(order.charges[0].split).toEqual([
      { recipientId: "re_platformFixture01", amountCents: 859 },
      { recipientId: "pp_fixtureRecipient01", amountCents: 11031 },
    ]);
  });

  it("finds an order by its code and returns null when absent", async () => {
    const found = respond(200, fixture("orders-list-by-code"));
    expect(
      (
        await createPagarmeOrderClient({
          secretKey,
          fetch: found,
        }).findOrderByCode("checkout-fixture-2")
      )?.id,
    ).toBe("or_fixtureOrder0002");
    expect(found.mock.calls[0][0]).toBe(
      "https://api.pagar.me/core/v5/orders?code=checkout-fixture-2",
    );
    expect(
      await createPagarmeOrderClient({
        secretKey,
        fetch: respond(200, fixture("orders-list-empty")),
      }).findOrderByCode("checkout-fixture-9"),
    ).toBeNull();
  });

  it("cancels (refunds) a whole charge with DELETE /charges/{id}", async () => {
    const fetch = respond(200, fixture("charge-canceled"));
    const charge = await createPagarmeOrderClient({
      secretKey,
      fetch,
    }).cancelCharge("ch_fixtureCharge002", "refund-op-1");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.pagar.me/core/v5/charges/ch_fixtureCharge002",
    );
    expect(fetch.mock.calls[0][1]?.method).toBe("DELETE");
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("idempotency-key"),
    ).toBe("refund-op-1");
    expect(charge).toMatchObject({
      id: "ch_fixtureCharge002",
      status: "canceled",
      transactionStatus: "refunded",
      canceledAmountCents: 11890,
    });
  });

  it("keeps 4xx as a rejection and 5xx as an unknown outcome", async () => {
    await expect(
      createPagarmeOrderClient({
        secretKey,
        fetch: respond(422, fixture("error-422-validation")),
      }).createOrder(request),
    ).rejects.toBeInstanceOf(PagarmeRejectedError);
    await expect(
      createPagarmeOrderClient({
        secretKey,
        fetch: respond(500, fixture("error-500")),
      }).createOrder(request),
    ).rejects.toBeInstanceOf(PagarmeUnknownOutcomeError);
  });

  it("treats a malformed order body as an unknown outcome", async () => {
    await expect(
      createPagarmeOrderClient({
        secretKey,
        fetch: respond(200, { id: "not-an-order", charges: "x" }),
      }).createOrder(request),
    ).rejects.toBeInstanceOf(PagarmeUnknownOutcomeError);
  });

  it("refuses unsafe identifiers before calling the API", async () => {
    const fetch = respond(200, {});
    const client = createPagarmeOrderClient({ secretKey, fetch });
    await expect(client.getOrder("../recipients")).rejects.toThrow();
    await expect(client.cancelCharge("or_1", "key")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
