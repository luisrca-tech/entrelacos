import { describe, expect, it, vi } from "vitest";
import {
  type AsaasCheckoutClientOptions,
  createAsaasCheckoutClient,
} from "./asaasCheckoutClient";
import { platformTariffPolicy, quoteGiftPurchaseAmounts } from "./giftMoney";
import { buildGiftV2Settlement, type GiftQuoteSnapshot } from "./giftQuotes";

// PLATFORM_ACCOUNT_SPLIT_V2: charges are created in the platform (main)
// account with a fixed split to the couple wallet.

const instant = "2026-10-12T12:00:00.000Z";
const planId = "ece84bcb-b18e-4e82-b5fc-79722fb4dad2";
const checkoutId = "131ca662-56c8-4479-b5b3-fd61a413fce7";
const platformKey = "$aact_hmlg_platform-synthetic";
const unavailable = { code: "PROVIDER_CHECKOUT_UNAVAILABLE", status: 503 };
const payer = {
  name: "Guest Example",
  email: "guest@example.test",
  cpfCnpj: "24971563792",
};
const customer = "cus_test1";

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function v2Fixture(method: "PIX" | "CREDIT_CARD", installmentCount?: number) {
  const receiving = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-one",
    environment: "sandbox" as const,
    accountReference: "account-one",
    recipientReference: "recipient-one",
    destinationVersion: 1,
    bankReference: "bank-one",
  };
  const policy = platformTariffPolicy(method);
  const amounts = quoteGiftPurchaseAmounts(
    { nominalCents: 10000, method, policy },
    installmentCount,
  );
  const quote = {
    id: "quote-one",
    siteId: "site-one",
    giftId: "gift-one",
    title: "Symbolic gift",
    method,
    currency: "BRL",
    commissionBasisPoints: 200,
    expiresAt: "2026-10-12T12:05:00.000Z",
    mode: "sandbox",
    settlementVersion: "PLATFORM_ACCOUNT_SPLIT_V2",
    ...amounts,
  } as GiftQuoteSnapshot["quote"];
  const snapshot: GiftQuoteSnapshot = {
    quote,
    gift: {
      id: "gift-one",
      siteId: "site-one",
      title: "Symbolic gift",
      description: "Symbolic contribution",
      nominalCents: 10000,
      currency: "BRL",
      image: null,
      sortOrder: 0,
    },
    receiving,
    pricing: {
      ...receiving,
      verification: "verified",
      provenance: "platform-tariff-table",
      observedAt: "2026-10-12T11:59:00.000Z",
      expiresAt: "2026-10-12T12:10:00.000Z",
      policy,
    },
    settlement: buildGiftV2Settlement(quote),
    createdAt: instant,
    expiresAt: "2026-10-12T12:05:00.000Z",
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    json({ id: checkoutId }),
  );
  const options: AsaasCheckoutClientOptions = {
    mode: "sandbox",
    binding: { ...receiving, accountBindingId: "binding.one:1" },
    credentials: { kind: "PLATFORM_ACCOUNT", accessToken: platformKey },
    payload: {
      environment: "sandbox",
      platformWalletId: "platform-wallet",
      publicOrigin: "https://wedding.example.test",
      minutesToExpire: 10,
      callbacks: {
        successUrl: "https://wedding.example.test/gifts/return",
        cancelUrl: "https://wedding.example.test/gifts/canceled",
        expiredUrl: "https://wedding.example.test/gifts/expired",
      },
    },
    fetch,
    timeoutMs: 1000,
    maxResponseBytes: 16384,
    now: vi.fn(() => new Date(instant)),
  };
  const command = {
    siteId: "site-one",
    requestId: "request.one:1",
    orderId: "order.one:1",
    attemptId: "attempt.one:1",
    quoteSnapshot: snapshot,
  };
  return { options, command, snapshot, fetch };
}

type Payment = Record<string, unknown> & {
  id: string;
  split: Record<string, unknown>[];
};

// A stateful stand-in for the Asaas platform account endpoints used by the
// installment flow. Lists are returned out of order on purpose.
function fakeAsaas(
  values: ReturnType<typeof v2Fixture>,
  faults: {
    failPutAt?: number;
    corruptSplitAt?: number;
    putEchoesOtherId?: boolean;
  } = {},
) {
  const { snapshot, command } = values;
  const cents = snapshot.quote.installmentCents ?? [];
  const nominal = snapshot.quote.nominalCents;
  const even = Math.floor(nominal / cents.length);
  const payments: Payment[] = cents.map((value, index) => ({
    object: "payment",
    id: `pay_${index + 1}`,
    customer,
    installment: planId,
    installmentNumber: index + 1,
    status: "PENDING",
    billingType: "CREDIT_CARD",
    externalReference: command.attemptId,
    value: value / 100,
    dueDate: `2026-${String(10 + index).padStart(2, "0")}-12`,
    deleted: false,
    invoiceUrl: `https://sandbox.asaas.com/i/inv${index + 1}`,
    fine: { value: 0, type: "FIXED" },
    interest: { value: 0, type: "PERCENTAGE" },
    split: [
      {
        id: `split-${index}`,
        walletId: "recipient-one",
        fixedValue: even / 100,
        percentualValue: null,
        totalValue: even / 100,
        status: "PENDING",
      },
    ],
  }));
  let putCount = 0;
  let deleted = false;
  values.fetch.mockImplementation(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const method = init?.method ?? "GET";
    if (method === "POST" && path === "/v3/customers")
      return json({ id: customer, externalReference: command.attemptId });
    if (method === "POST" && path === "/v3/payments") return json(payments[0]);
    if (method === "GET" && path === `/v3/installments/${planId}/payments`)
      return json({
        object: "list",
        hasMore: false,
        totalCount: payments.length,
        limit: 100,
        offset: 0,
        data: [...payments].reverse(),
      });
    if (method === "PUT" && path.startsWith("/v3/payments/")) {
      putCount++;
      if (faults.failPutAt === putCount)
        return json({ errors: [{ code: "invalid_split" }] }, 400);
      const id = path.slice("/v3/payments/".length);
      const payment = payments.find((item) => item.id === id);
      if (!payment) return json({ errors: [] }, 404);
      const body = JSON.parse(String(init?.body));
      const fixedValue =
        faults.corruptSplitAt === payment.installmentNumber
          ? body.split[0].fixedValue + 0.01
          : body.split[0].fixedValue;
      payment.split = [
        {
          id: `split-put-${id}`,
          walletId: body.split[0].walletId,
          fixedValue,
          percentualValue: null,
          totalValue: fixedValue,
          status: "PENDING",
        },
      ];
      return json({
        ...payment,
        id: faults.putEchoesOtherId ? "pay_other" : payment.id,
      });
    }
    if (method === "DELETE" && path === `/v3/installments/${planId}`) {
      deleted = true;
      return json({ deleted: true, id: planId });
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  return { payments, isDeleted: () => deleted };
}

function calls(fetch: ReturnType<typeof v2Fixture>["fetch"]) {
  return fetch.mock.calls.map(([url, init]) => [
    new URL(String(url)).pathname,
    init?.method,
  ]);
}

describe("PLATFORM_ACCOUNT_SPLIT_V2 checkout creation", () => {
  it.each([
    ["PIX", undefined],
    ["CREDIT_CARD", 1],
  ] as const)(
    "creates the %s hosted checkout with the platform key and a nominal split to the couple",
    async (method, count) => {
      const values = v2Fixture(method, count);
      const result = await createAsaasCheckoutClient(
        values.options,
      ).createHostedCheckout(values.command);
      expect(result.providerReference).toBe(checkoutId);
      expect(calls(values.fetch)).toEqual([["/v3/checkouts", "POST"]]);
      const init = values.fetch.mock.calls[0][1];
      expect(new Headers(init?.headers).get("access_token")).toBe(platformKey);
      const body = JSON.parse(String(init?.body));
      expect(body.splits).toEqual([
        { walletId: "recipient-one", fixedValue: 100 },
      ]);
      expect(body.items[0].value).toBe(values.snapshot.quote.totalCents / 100);
      expect(body.externalReference).toBe("attempt.one:1");
      expect(String(init?.body)).not.toContain("platform-wallet");
    },
  );

  it("refuses a V2 quote with sub-account credentials and a V1 quote with the platform key before any request", async () => {
    const v2 = v2Fixture("PIX");
    v2.options.credentials = {
      context: {
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "binding.one:1",
        environment: "sandbox",
      },
      accessToken: "$aact_hmlg_subaccount",
    };
    await expect(
      createAsaasCheckoutClient(v2.options).createHostedCheckout(v2.command),
    ).rejects.toMatchObject(unavailable);
    expect(v2.fetch).not.toHaveBeenCalled();

    const v1 = v2Fixture("PIX");
    Object.assign(v1.snapshot.quote, {
      settlementVersion: "PLATFORM_FEE_GUARANTEE_V1",
    });
    await expect(
      createAsaasCheckoutClient(v1.options).createHostedCheckout(v1.command),
    ).rejects.toMatchObject(unavailable);
    expect(v1.fetch).not.toHaveBeenCalled();
  });

  it("refuses a platform key from the wrong environment", () => {
    const values = v2Fixture("PIX");
    values.options.credentials = {
      kind: "PLATFORM_ACCOUNT",
      accessToken: "$aact_prod_platform",
    };
    expect(() => createAsaasCheckoutClient(values.options)).toThrow();
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it("creates the installment plan, applies the frozen per-installment split to every child and verifies it before returning the invoice", async () => {
    const values = v2Fixture("CREDIT_CARD", 3);
    const fake = fakeAsaas(values);
    const split = values.snapshot.settlement?.recipientSplitCents ?? [];
    expect(split).toHaveLength(3);
    const result = await createAsaasCheckoutClient(
      values.options,
    ).createHostedCheckout({ ...values.command, payer });
    expect(result).toMatchObject({
      providerReference: planId,
      installmentPaymentReferences: ["pay_1", "pay_2", "pay_3"],
      checkout: {
        hostedUrl: "https://sandbox.asaas.com/i/inv1",
        method: "CREDIT_CARD",
      },
    });
    expect(calls(values.fetch)).toEqual([
      ["/v3/customers", "POST"],
      ["/v3/payments", "POST"],
      [`/v3/installments/${planId}/payments`, "GET"],
      ["/v3/payments/pay_1", "PUT"],
      ["/v3/payments/pay_2", "PUT"],
      ["/v3/payments/pay_3", "PUT"],
      [`/v3/installments/${planId}/payments`, "GET"],
    ]);
    for (const [, init] of values.fetch.mock.calls)
      expect(new Headers(init?.headers).get("access_token")).toBe(platformKey);
    expect(JSON.parse(String(values.fetch.mock.calls[0][1]?.body))).toEqual({
      ...payer,
      notificationDisabled: true,
      externalReference: "attempt.one:1",
    });
    expect(JSON.parse(String(values.fetch.mock.calls[1][1]?.body))).toEqual({
      customer,
      billingType: "CREDIT_CARD",
      dueDate: "2026-10-12",
      description: "Symbolic gift",
      externalReference: "attempt.one:1",
      installmentCount: 3,
      totalValue: values.snapshot.quote.totalCents / 100,
      interest: { value: 0 },
      fine: { value: 0 },
      split: [{ walletId: "recipient-one", totalFixedValue: 100 }],
    });
    for (const index of [0, 1, 2])
      expect(
        JSON.parse(String(values.fetch.mock.calls[3 + index][1]?.body)),
      ).toEqual({
        billingType: "CREDIT_CARD",
        value: (values.snapshot.quote.installmentCents?.[index] ?? 0) / 100,
        dueDate: fake.payments[index].dueDate,
        split: [
          { walletId: "recipient-one", fixedValue: (split[index] ?? 0) / 100 },
        ],
      });
    expect(fake.isDeleted()).toBe(false);
    expect(JSON.stringify(values.fetch.mock.calls)).not.toContain(
      "platform-wallet",
    );
  });

  it.each([{ failPutAt: 2 }, { putEchoesOtherId: true }])(
    "removes the installment plan and returns no invoice when a split update fails (%j)",
    async (faults) => {
      const values = v2Fixture("CREDIT_CARD", 3);
      const fake = fakeAsaas(values, faults);
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout({
          ...values.command,
          payer,
        }),
      ).rejects.toMatchObject(unavailable);
      expect(fake.isDeleted()).toBe(true);
      expect(calls(values.fetch).at(-1)).toEqual([
        `/v3/installments/${planId}`,
        "DELETE",
      ]);
      expect(
        calls(values.fetch).filter(([, method]) => method === "PUT").length,
      ).toBe(faults.failPutAt ?? 1);
    },
  );

  it("removes the installment plan when the re-read split does not match the frozen schedule", async () => {
    const values = v2Fixture("CREDIT_CARD", 3);
    const fake = fakeAsaas(values, { corruptSplitAt: 3 });
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout({
        ...values.command,
        payer,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(fake.isDeleted()).toBe(true);
    expect(calls(values.fetch).slice(-2)).toEqual([
      [`/v3/installments/${planId}/payments`, "GET"],
      [`/v3/installments/${planId}`, "DELETE"],
    ]);
  });

  it("removes the installment plan when a child value differs from the quoted installment", async () => {
    const values = v2Fixture("CREDIT_CARD", 3);
    const fake = fakeAsaas(values);
    fake.payments[1].value = Number(fake.payments[1].value) + 0.01;
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout({
        ...values.command,
        payer,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(fake.isDeleted()).toBe(true);
    expect(
      calls(values.fetch).filter(([, method]) => method === "PUT"),
    ).toEqual([]);
  });

  it("still fails without an invoice when the rollback itself fails", async () => {
    const values = v2Fixture("CREDIT_CARD", 3);
    fakeAsaas(values, { failPutAt: 1 });
    const fake = values.fetch.getMockImplementation();
    values.fetch.mockImplementation(async (url, init) =>
      init?.method === "DELETE"
        ? json({ errors: [] }, 500)
        : (fake as typeof globalThis.fetch)(url, init),
    );
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout({
        ...values.command,
        payer,
      }),
    ).rejects.toMatchObject(unavailable);
    expect(calls(values.fetch).at(-1)).toEqual([
      `/v3/installments/${planId}`,
      "DELETE",
    ]);
  });
});
