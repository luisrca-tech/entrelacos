import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AsaasCheckoutClientError,
  type AsaasCheckoutClientOptions,
  createAsaasCheckoutClient,
} from "./asaasCheckoutClient";
import { buildAsaasCheckoutPayload } from "./asaasCheckoutPayload";
import {
  createGiftCheckoutService,
  type GiftCheckoutRecord,
  type GiftCheckoutServiceDependencies,
} from "./giftCheckouts";
import { quoteGiftAmounts } from "./giftMoney";
import type {
  GiftQuoteReceivingContext,
  GiftQuoteSnapshot,
} from "./giftQuotes";

const instant = "2026-10-12T12:00:00.000Z";
const providerId = "131ca662-56c8-4479-b5b3-fd61a413fce7";
const unavailable = { code: "PROVIDER_CHECKOUT_UNAVAILABLE", status: 503 };

function json(value: unknown = { id: providerId }, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function fixture(mode: "sandbox" | "live" = "sandbox") {
  const receiving = {
    siteId: "site-one",
    provider: "ASAAS",
    operatorReference: "operator-one",
    environment: mode,
    accountReference: "account-one",
    recipientReference: "recipient-one",
    destinationVersion: 1,
    bankReference: "bank-one",
  };
  const snapshot: GiftQuoteSnapshot = {
    quote: {
      id: "quote-one",
      siteId: "site-one",
      giftId: "gift-one",
      title: "Symbolic gift",
      method: "PIX",
      currency: "BRL",
      nominalCents: 10000,
      commissionBasisPoints: 200,
      commissionCents: 200,
      processingCents: 0,
      totalCents: 10200,
      policyVersion: "verified-one",
      expiresAt: "2026-10-12T12:05:00.000Z",
      mode,
    },
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
      provenance: "provider",
      observedAt: "2026-10-12T11:59:00.000Z",
      expiresAt: "2026-10-12T12:10:00.000Z",
      policy: {
        version: "verified-one",
        method: "PIX",
        commissionBasisPoints: 200,
        processingBasisPoints: 0,
        processingFixedCents: 0,
        rounding: "CEILING",
      },
    },
    createdAt: instant,
    expiresAt: "2026-10-12T12:05:00.000Z",
  };
  const fetch = vi.fn<typeof globalThis.fetch>(async () => json());
  const options: AsaasCheckoutClientOptions = {
    mode,
    binding: { ...receiving, accountBindingId: "binding.one:1" },
    credentials: {
      context: {
        provider: "ASAAS",
        siteId: "site-one",
        accountBindingId: "binding.one:1",
        environment: mode,
      },
      accessToken:
        mode === "sandbox" ? "$aact_hmlg_synthetic" : "$aact_prod_synthetic",
    },
    payload: {
      environment: mode,
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
    maxResponseBytes: 4096,
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

describe("native Asaas hosted checkout creation", () => {
  it.each(["sandbox", "live"] as const)(
    "keeps bounded local receiving references out of the %s provider payload",
    async (mode) => {
      const values = fixture(mode);
      const references = {
        operatorReference: "consent:holder.one:1",
        bankReference: "simulation:demo-checkout:binding.one:1",
      };
      Object.assign(values.options.binding, references);
      Object.assign(values.snapshot.receiving, references);
      Object.assign(values.snapshot.pricing, references);
      await createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      );
      expect(values.fetch).toHaveBeenCalledTimes(1);
      const body = String(values.fetch.mock.calls[0][1]?.body);
      for (const value of Object.values(references))
        expect(body).not.toContain(value);
    },
  );
  it.each(["accountReference", "recipientReference"] as const)(
    "retains the strict native provider format for %s",
    (field) => {
      const values = fixture();
      values.options.binding[field] = "native:invalid";
      expect(() => createAsaasCheckoutClient(values.options)).toThrow();
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["sandbox", "live"] as const)(
    "dispatches once with the stored %s quote and reconstructs only the documented hosted origin",
    async (mode) => {
      const values = fixture(mode);
      const result = await createAsaasCheckoutClient(
        values.options,
      ).createHostedCheckout(values.command);
      expect(result).toEqual({
        providerReference: providerId,
        checkout: {
          orderId: "order.one:1",
          attemptId: "attempt.one:1",
          quoteId: "quote-one",
          method: "PIX",
          mode,
          hostedUrl:
            mode === "sandbox"
              ? `https://sandbox.asaas.com/checkoutSession/show/${providerId}`
              : `https://asaas.com/checkoutSession/show?id=${providerId}`,
        },
      });
      expect(values.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = values.fetch.mock.calls[0];
      expect(url).toBe(
        mode === "sandbox"
          ? "https://api-sandbox.asaas.com/v3/checkouts"
          : "https://api.asaas.com/v3/checkouts",
      );
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      expect(new Headers(init?.headers).get("access_token")).toBe(
        values.options.credentials.accessToken,
      );
      expect(new Headers(init?.headers).get("Content-Type")).toBe(
        "application/json",
      );
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual(
        buildAsaasCheckoutPayload(values.command, values.options.payload),
      );
      expect(String(init?.body)).not.toMatch(
        /accountReference|bankReference|recoveryToken|creditCard|customerData|percentualValue|aact_/,
      );
      expect(JSON.stringify(result)).not.toMatch(
        /PAID|RECEIVED|READY|split|balance|aact_/,
      );
    },
  );

  it.each([
    [
      "sandbox",
      `https://sandbox.asaas.com/000/checkoutSession/show/${providerId}`,
    ],
    [
      "sandbox",
      `https://sandbox.asaas.com/region-next/checkoutSession/show/${providerId}`,
    ],
    ["live", `https://www.asaas.com/001/checkoutSession/show/${providerId}`],
    ["live", `https://asaas.com/checkoutSession/show?id=${providerId}`],
  ] as const)(
    "preserves the complete returned %s link %s",
    async (mode, link) => {
      const values = fixture(mode);
      values.fetch.mockResolvedValue(json({ id: providerId, link }));
      const result = await createAsaasCheckoutClient(
        values.options,
      ).createHostedCheckout(values.command);
      expect(result.checkout.hostedUrl).toBe(link);
      expect(values.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    42,
    "",
    "https://evil.example/secret",
    "https://sandbox.asaas.com.evil.example/checkout",
    "https://asaas.com/checkout",
    "https://www.asaas.com/checkout",
    "http://sandbox.asaas.com/checkout",
    "https://user:password@sandbox.asaas.com/checkout",
    "https://sandbox.asaas.com:8443/checkout",
    "https://sandbox.asaas.com/checkout#secret",
    " https://sandbox.asaas.com/checkout",
    "https://sandbox.asaas.com/checkout\n",
    "https://sandbox.asaas.com\\evil.example/checkout",
  ])("rejects unsafe or wrong-environment supplied links: %j", async (link) => {
    const values = fixture();
    values.fetch.mockResolvedValue(json({ id: providerId, link }));
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a Sandbox link returned for live checkout creation", async () => {
    const values = fixture("live");
    values.fetch.mockResolvedValue(
      json({
        id: providerId,
        link: `https://sandbox.asaas.com/000/checkoutSession/show/${providerId}`,
      }),
    );
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
  });

  it("preserves the quoted card gross-up and nominal fixed split without recalculating commercial terms", async () => {
    const values = fixture();
    values.snapshot.pricing.policy.method = "CREDIT_CARD";
    values.snapshot.pricing.policy.processingBasisPoints = 300;
    values.snapshot.pricing.policy.processingFixedCents = 49;
    values.snapshot.quote.method = "CREDIT_CARD";
    Object.assign(
      values.snapshot.quote,
      quoteGiftAmounts({
        nominalCents: 10000,
        method: "CREDIT_CARD",
        policy: values.snapshot.pricing.policy,
      }),
    );
    const result = await createAsaasCheckoutClient(
      values.options,
    ).createHostedCheckout(values.command);
    const payload = JSON.parse(String(values.fetch.mock.calls[0][1]?.body));
    expect(payload.billingTypes).toEqual(["CREDIT_CARD"]);
    expect(payload.chargeTypes).toEqual(["DETACHED"]);
    expect(payload.items[0].value).toBe(values.snapshot.quote.totalCents / 100);
    expect(payload.splits).toEqual([
      { walletId: "platform-wallet", fixedValue: 2 },
    ]);
    expect(result.checkout.method).toBe("CREDIT_CARD");
  });

  it("discards private response fields while preserving the native checkout link", async () => {
    const values = fixture();
    values.fetch.mockResolvedValue(
      json({
        id: providerId,
        link: `https://sandbox.asaas.com/000/checkoutSession/show/${providerId}`,
        customerData: { cpfCnpj: "private" },
        status: "ACTIVE",
        externalReference: values.command.attemptId,
        billingTypes: ["PIX"],
        chargeTypes: ["DETACHED"],
        minutesToExpire: 10,
      }),
    );
    const result = await createAsaasCheckoutClient(
      values.options,
    ).createHostedCheckout(values.command);
    expect(JSON.stringify(result)).not.toMatch(
      /evil|private|customerData|ACTIVE/,
    );
    expect(result.checkout.hostedUrl).toBe(
      `https://sandbox.asaas.com/000/checkoutSession/show/${providerId}`,
    );
  });

  it.each([
    "siteId",
    "provider",
    "operatorReference",
    "environment",
    "accountReference",
    "recipientReference",
    "destinationVersion",
    "bankReference",
  ] as const)("rejects mismatched stored %s before dispatch", async (field) => {
    const values = fixture();
    Object.assign(values.options.binding, {
      [field]: field === "destinationVersion" ? 2 : "other",
    });
    await expect(async () =>
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it.each(["provider", "siteId", "accountBindingId", "environment"] as const)(
    "rejects a foreign credential %s before dispatch",
    async (field) => {
      const values = fixture();
      Object.assign(values.options.credentials.context, { [field]: "other" });
      expect(() => createAsaasCheckoutClient(values.options)).toThrow(
        AsaasCheckoutClientError,
      );
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "",
    "$aact_prod_wrong",
    "$aact_hmlg_",
    "$aact_hmlg_bad\n",
    "$aact_hmlg_ bad",
    `$aact_hmlg_${"x".repeat(8192)}`,
  ])("rejects invalid synthetic credential %s", (accessToken) => {
    const values = fixture();
    values.options.credentials.accessToken = accessToken;
    expect(() => createAsaasCheckoutClient(values.options)).toThrow(
      AsaasCheckoutClientError,
    );
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, 30001, NaN])(
    "rejects invalid timeout %s",
    (timeoutMs) => {
      const values = fixture();
      values.options.timeoutMs = timeoutMs;
      expect(() => createAsaasCheckoutClient(values.options)).toThrow(
        AsaasCheckoutClientError,
      );
    },
  );
  it.each([0, -1, 1.5, 1048577, NaN])(
    "rejects invalid byte bound %s",
    (maxResponseBytes) => {
      const values = fixture();
      values.options.maxResponseBytes = maxResponseBytes;
      expect(() => createAsaasCheckoutClient(values.options)).toThrow(
        AsaasCheckoutClientError,
      );
    },
  );

  it("fails disabled mode before accessing credentials or network ports", () => {
    const options = {
      mode: "disabled",
      get credentials() {
        throw new Error("private");
      },
    } as unknown as AsaasCheckoutClientOptions;
    expect(() => createAsaasCheckoutClient(options)).toThrow(
      AsaasCheckoutClientError,
    );
  });

  it.each(["siteId", "requestId", "orderId", "attemptId"] as const)(
    "rejects unsafe command %s",
    async (field) => {
      const values = fixture();
      Object.assign(values.command, { [field]: "bad/secret" });
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );
  it.each(["recoveryToken", "creditCard", "amount", "customerData"])(
    "rejects extra command field %s",
    async (field) => {
      const values = fixture();
      Object.assign(values.command, { [field]: "private" });
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(values.fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    "2026-10-12T11:59:59.999Z",
    "2026-10-12T12:05:00.000Z",
    "2026-10-12T12:10:00.000Z",
    "invalid",
  ])("rejects invalid or expired dispatch clock %s", async (clock) => {
    const values = fixture();
    values.options.now = () => new Date(clock);
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it.each([
    "pricing",
    "method",
    "amount",
    "callback",
    "split",
    "payload-environment",
  ])("rejects invalid quote or payload %s before dispatch", async (kind) => {
    const values = fixture();
    if (kind === "pricing") values.snapshot.pricing.provenance = "local-test";
    if (kind === "method") values.snapshot.quote.method = "CREDIT_CARD";
    if (kind === "amount") values.snapshot.quote.totalCents++;
    if (kind === "callback")
      values.options.payload.callbacks.successUrl =
        "https://evil.example/return";
    if (kind === "split")
      values.options.payload.platformWalletId =
        values.options.binding.recipientReference;
    if (kind === "payload-environment")
      values.options.payload.environment = "live";
    await expect(async () =>
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it("copies options and the command before awaiting the provider", async () => {
    const values = fixture();
    const client = createAsaasCheckoutClient(values.options);
    values.options.binding.accountReference = "other";
    values.options.credentials.accessToken = "$aact_hmlg_other";
    values.options.payload.callbacks.successUrl = "https://evil.example/return";
    values.options.fetch = async () => {
      throw new Error("wrong fetch");
    };
    let resolve!: (response: Response) => void;
    values.fetch.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = client.createHostedCheckout(values.command);
    values.command.orderId = "other";
    values.snapshot.quote.totalCents = 1;
    resolve(json());
    expect((await pending).checkout.orderId).toBe("order.one:1");
    expect(
      JSON.parse(String(values.fetch.mock.calls[0][1]?.body)).items[0].value,
    ).toBe(102);
    expect(
      new Headers(values.fetch.mock.calls[0][1]?.headers).get("access_token"),
    ).toBe("$aact_hmlg_synthetic");
  });

  it("projects only the provider item name without changing the editable title or immutable quote", async () => {
    const values = fixture();
    values.snapshot.quote.title = "x".repeat(31);
    values.snapshot.gift.title = values.snapshot.quote.title;
    values.fetch.mockResolvedValue(
      json({
        id: providerId,
        items: [{ name: "x".repeat(30), quantity: 1, value: 102 }],
      }),
    );
    expect(
      (
        await createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        )
      ).providerReference,
    ).toBe(providerId);
    const payload = JSON.parse(String(values.fetch.mock.calls[0][1]?.body));
    expect(payload.items).toEqual([
      { name: "x".repeat(30), quantity: 1, value: 102 },
    ]);
    expect(values.fetch).toHaveBeenCalledTimes(1);
    expect(values.snapshot.gift.title).toHaveLength(31);
    expect(values.snapshot.quote.title).toHaveLength(31);
  });

  it.each([
    { title: `${"a".repeat(29)}💝`, expected: "a".repeat(29) },
    { title: "😀".repeat(16), expected: "😀".repeat(15) },
    { title: "é".repeat(31), expected: "é".repeat(30) },
    { title: `a${"\u0301".repeat(30)}`, expected: "Gift" },
  ])(
    "preserves grapheme boundaries in the provider display name %j",
    async ({ title, expected }) => {
      const values = fixture();
      values.snapshot.quote.title = title;
      values.snapshot.gift.title = title;
      await createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      );
      const payload = JSON.parse(String(values.fetch.mock.calls[0][1]?.body));
      expect(payload.items[0].name).toBe(expected);
      expect(payload.items[0].name.length).toBeLessThanOrEqual(30);
      expect(values.snapshot.quote.title).toBe(title);
      expect(values.snapshot.gift.title).toBe(title);
    },
  );

  it("rejects a malformed platform provider wallet before dispatch", async () => {
    const values = fixture();
    values.options.payload.platformWalletId = "wallet.with:local-punctuation";
    await expect(async () =>
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).not.toHaveBeenCalled();
  });

  it("accepts matching optional item, callback and fixed split echoes as hosting only", async () => {
    const values = fixture();
    const payload = buildAsaasCheckoutPayload(
      values.command,
      values.options.payload,
    );
    values.fetch.mockResolvedValue(
      json({
        id: providerId,
        items: payload.items,
        callback: payload.callback,
        split: payload.splits.map((split) => ({
          ...split,
          percentageValue: null,
          percentualValue: null,
          totalFixedValue: null,
        })),
        subscription: null,
        installment: null,
      }),
    );
    expect(
      (
        await createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        )
      ).providerReference,
    ).toBe(providerId);
  });

  it.each([
    { items: [{ name: "Symbolic gift", quantity: 1, value: 1 }] },
    { items: [{ name: "Wrong gift", quantity: 1, value: 102 }] },
    { items: [{ name: "Symbolic gift", quantity: 2, value: 102 }] },
    { items: [] },
    { items: null },
    { callback: { successUrl: "https://evil.example/return" } },
    { callback: null },
    { split: [{ walletId: "wrong-wallet", fixedValue: 2 }] },
    { split: [{ walletId: "platform-wallet", fixedValue: 1 }] },
    {
      split: [
        { walletId: "platform-wallet", fixedValue: 2, percentageValue: 2 },
      ],
    },
    {
      split: [
        { walletId: "platform-wallet", fixedValue: 2, percentualValue: 2 },
      ],
    },
    {
      split: [
        { walletId: "platform-wallet", fixedValue: 2, totalFixedValue: 2 },
      ],
    },
    { split: [] },
    { split: null },
    { subscription: { cycle: "MONTHLY" } },
    { installment: { maxInstallmentCount: 2 } },
  ])("rejects contradictory optional provider echoes %j", async (echo) => {
    const values = fixture();
    values.fetch.mockResolvedValue(json({ id: providerId, ...echo }));
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [],
    {},
    { id: "" },
    { id: 12 },
    { id: "../secret" },
    { id: "bad?token=secret" },
    { id: "x".repeat(129) },
    { id: providerId, status: "PAID" },
    { id: providerId, status: "CANCELED" },
    { id: providerId, externalReference: "other" },
    { id: providerId, billingTypes: ["PIX", "CREDIT_CARD"] },
    { id: providerId, chargeTypes: ["RECURRENT"] },
    { id: providerId, minutesToExpire: 11 },
  ])(
    "rejects malformed or contradictory hosting response %j without retry",
    async (body) => {
      const values = fixture();
      values.fetch.mockResolvedValue(json(body));
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(values.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([201, 204, 302, 400, 401, 429, 500])(
    "rejects unsupported HTTP status %s without retry",
    async (status) => {
      const values = fixture();
      values.fetch.mockResolvedValue(
        new Response(status === 204 ? null : "private", { status }),
      );
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(values.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "text/html",
    "application/json; charset=latin1",
    "application/json; charset=utf-8; secret=x",
    "",
  ])("rejects unsupported MIME %s", async (mime) => {
    const values = fixture();
    values.fetch.mockResolvedValue(
      json(undefined, { headers: { "Content-Type": mime } }),
    );
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
  });
  it.each([
    "application/json; charset=utf-8",
    'application/json; charset="utf-8"',
  ])("accepts documented UTF-8 JSON MIME %s", async (mime) => {
    const values = fixture();
    values.fetch.mockResolvedValue(
      json(undefined, { headers: { "Content-Type": mime } }),
    );
    expect(
      (
        await createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        )
      ).providerReference,
    ).toBe(providerId);
  });

  it.each(["-1", "invalid", "4097", "9007199254740992"])(
    "rejects invalid advertised response length %s and cancels",
    async (length) => {
      const values = fixture();
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        headers: {
          "Content-Type": "application/json",
          "Content-Length": length,
        },
      });
      values.fetch.mockResolvedValue(response);
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(cancel).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["bytes", "utf8", "json", "chunks", "redirect", "foreign-url"])(
    "rejects unsafe streamed response %s",
    async (kind) => {
      const values = fixture();
      const cancel = vi.fn();
      let chunks = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (kind === "chunks") {
            controller.enqueue(new Uint8Array());
            chunks++;
            return;
          }
          const body =
            kind === "bytes"
              ? new Uint8Array(4097)
              : kind === "utf8"
                ? new Uint8Array([0xff])
                : new TextEncoder().encode(
                    kind === "json" ? "{" : JSON.stringify({ id: providerId }),
                  );
          controller.enqueue(body);
          if (kind === "json" || kind === "utf8") controller.close();
        },
        cancel,
      });
      const response = new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
      if (kind === "redirect")
        Object.defineProperty(response, "redirected", { value: true });
      if (kind === "foreign-url")
        Object.defineProperty(response, "url", {
          value: "https://evil.example/",
        });
      values.fetch.mockResolvedValue(response);
      await expect(
        createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        ),
      ).rejects.toMatchObject(unavailable);
      expect(values.fetch).toHaveBeenCalledTimes(1);
      if (!["json", "utf8"].includes(kind))
        expect(cancel).toHaveBeenCalledTimes(1);
      if (kind === "chunks") expect(chunks).toBeLessThanOrEqual(4097);
    },
  );

  it("bounds a hanging fetch and cancels a late acknowledgment without retry", async () => {
    vi.useFakeTimers();
    try {
      const values = fixture();
      let resolve!: (response: Response) => void;
      values.fetch.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const pending = createAsaasCheckoutClient(
        values.options,
      ).createHostedCheckout(values.command);
      const assertion = expect(pending).rejects.toMatchObject(unavailable);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(values.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
      const cancel = vi.fn();
      resolve(
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(values.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["fetch", "body"])(
    "rejects a late %s acknowledgment even before the timer callback can run",
    async (stage) => {
      const values = fixture();
      let elapsed = 0;
      const monotonic = vi
        .spyOn(performance, "now")
        .mockImplementation(() => elapsed);
      const cancel = vi.fn();
      try {
        values.fetch.mockImplementation(async () => {
          if (stage === "fetch") elapsed = 1001;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (stage === "body") elapsed = 1001;
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify({ id: providerId }),
                    ),
                  );
                  controller.close();
                },
                cancel,
              },
              { highWaterMark: 0 },
            ),
            { headers: { "Content-Type": "application/json" } },
          );
        });
        await expect(
          createAsaasCheckoutClient(values.options).createHostedCheckout(
            values.command,
          ),
        ).rejects.toMatchObject(unavailable);
        expect(values.fetch).toHaveBeenCalledTimes(1);
        expect(values.fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        if (stage === "fetch") expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        monotonic.mockRestore();
      }
    },
  );

  it("applies the same deadline to a hanging response body", async () => {
    vi.useFakeTimers();
    try {
      const values = fixture();
      const cancel = vi.fn();
      values.fetch.mockResolvedValue(
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      const pending = createAsaasCheckoutClient(
        values.options,
      ).createHostedCheckout(values.command);
      const assertion = expect(pending).rejects.toMatchObject(unavailable);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(values.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sanitizes thrown network/provider errors and never includes credentials or private bodies", async () => {
    const values = fixture();
    values.fetch.mockRejectedValue(
      new Error(`private payer ${values.options.credentials.accessToken}`),
    );
    const error = await createAsaasCheckoutClient(values.options)
      .createHostedCheckout(values.command)
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AsaasCheckoutClientError);
    expect(error).toMatchObject(unavailable);
    expect(JSON.stringify(error)).not.toMatch(/payer|aact_/);
    expect(String(error)).toBe(
      "AsaasCheckoutClientError: Provider checkout is unavailable",
    );
    expect(values.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a reversed completion clock without interpreting the created checkout as unpaid", async () => {
    const values = fixture();
    values.options.now = vi
      .fn()
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValueOnce(new Date(Date.parse(instant) - 1));
    await expect(
      createAsaasCheckoutClient(values.options).createHostedCheckout(
        values.command,
      ),
    ).rejects.toMatchObject(unavailable);
    expect(values.fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps a valid creation acknowledged after quote expiry as hosting only", async () => {
    const values = fixture();
    values.options.now = vi
      .fn()
      .mockReturnValueOnce(new Date(instant))
      .mockReturnValueOnce(new Date("2026-10-12T12:05:01.000Z"));
    expect(
      (
        await createAsaasCheckoutClient(values.options).createHostedCheckout(
          values.command,
        )
      ).providerReference,
    ).toBe(providerId);
  });
});

function serviceFixture() {
  const values = fixture();
  let record: GiftCheckoutRecord | null = null;
  const receiving = values.snapshot.receiving;
  const context: GiftQuoteReceivingContext = {
    isDemo: false,
    environment: "test",
    mode: "sandbox",
    providerBinding: receiving,
    evidence: {
      ...receiving,
      verification: "verified",
      provenance: "provider",
      accountState: "approved",
      bankState: "verified",
      observedAt: new Date(values.snapshot.pricing.observedAt),
      bankObservedAt: new Date(values.snapshot.pricing.observedAt),
      capabilities: { receiving: true, withdrawal: true },
      commercialEnabled: true,
    },
    freshnessMs: 120000,
  };
  const gift = {
    gift: values.snapshot.gift,
    publicationState: "PUBLISHED" as const,
    siteActive: true,
  };
  const dependencies: GiftCheckoutServiceDependencies = {
    repository: {
      findByRequest: async () => record,
      findQuote: async () => values.snapshot,
      sealUncreatedRequest: async () => {
        throw new Error("Unexpected seal");
      },
      reserve: async (reservation, assertEligible) => {
        if (record) return { created: false, record };
        assertEligible({
          quoteSnapshot: values.snapshot,
          receivingContext: context,
          gift,
        });
        record = {
          ...reservation,
          state: "CREATING",
          observedAt: null,
          closedReason: null,
          checkout: null,
          evidence: null,
        };
        return { created: true, record };
      },
      saveHostedCheckout: async (outcome) => {
        if (!record) throw new Error("Missing reservation");
        record = {
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
            provider: "ASAAS",
            accountReference: receiving.accountReference,
            environment: "sandbox",
            providerCheckoutReference: outcome.providerReference,
            observedAt: outcome.observedAt,
          },
        };
        return record;
      },
      markOutcomeUnknown: async (_identity, observedAt) => {
        if (record?.state === "CREATING")
          record = { ...record, state: "OUTCOME_UNKNOWN", observedAt };
      },
    },
    loadReceivingContext: async () => context,
    findPublishedGift: async () => gift,
    createHostedCheckout: createAsaasCheckoutClient(values.options)
      .createHostedCheckout,
    now: () => new Date(instant),
    generateId: (kind) => `${kind}.one:1`,
  };
  const recoveryToken = Buffer.alloc(32, 7).toString("base64url");
  const input = {
    quoteId: "quote-one",
    requestId: "request.one:1",
    recoveryToken,
  };
  return { ...values, dependencies, input, readRecord: () => record };
}

describe("native checkout transport behind the actual durable checkout service", () => {
  it("hosts a valid long-title quote instead of trapping an undispatched reservation as UNKNOWN", async () => {
    const values = serviceFixture();
    const title = "x".repeat(31);
    values.snapshot.quote.title = title;
    values.snapshot.gift.title = title;
    const service = createGiftCheckoutService(values.dependencies);
    const result = await service.createCheckout("site-one", values.input);
    expect(values.readRecord()?.state).toBe("AWAITING_PAYMENT");
    expect(values.readRecord()?.quoteSnapshot.quote.title).toBe(title);
    expect(values.readRecord()?.quoteSnapshot.gift.title).toBe(title);
    expect(
      JSON.parse(String(values.fetch.mock.calls[0][1]?.body)).items[0].name,
    ).toBe("x".repeat(30));
    expect(await service.createCheckout("site-one", values.input)).toEqual(
      result,
    );
    expect(values.fetch).toHaveBeenCalledTimes(1);
  });
  it("retains UNKNOWN on the native deadline and ignores a late ACK across concurrent and repeated recovery", async () => {
    vi.useFakeTimers();
    try {
      const values = serviceFixture();
      let resolve!: (response: Response) => void;
      values.fetch.mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      const save = vi.spyOn(
        values.dependencies.repository,
        "saveHostedCheckout",
      );
      const service = createGiftCheckoutService(values.dependencies);
      const pending = service.createCheckout("site-one", values.input);
      const assertion = expect(pending).rejects.toMatchObject({
        code: "EXTERNAL_OUTCOME_UNKNOWN",
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(values.readRecord()?.state).toBe("CREATING");
      await expect(
        service.createCheckout("site-one", values.input),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(values.readRecord()?.state).toBe("OUTCOME_UNKNOWN");
      const cancel = vi.fn();
      resolve(
        new Response(new ReadableStream({ cancel }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      await expect(
        service.createCheckout("site-one", values.input),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect((await service.getStatus("site-one", values.input)).state).toBe(
        "OUTCOME_UNKNOWN",
      );
      expect(values.readRecord()?.evidence).toBeNull();
      expect(save).not.toHaveBeenCalled();
      expect(values.fetch).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires the reservation before the POST and records hosting only, with repeat recovery performing no POST", async () => {
    const values = serviceFixture();
    const link = `https://sandbox.asaas.com/000/checkoutSession/show/${providerId}`;
    values.fetch.mockImplementation(async () => {
      expect(values.readRecord()?.state).toBe("CREATING");
      expect(values.readRecord()?.recoveryTokenHash).toBe(
        createHash("sha256").update(values.input.recoveryToken).digest("hex"),
      );
      return json({ id: providerId, link });
    });
    const service = createGiftCheckoutService(values.dependencies);
    const result = await service.createCheckout("site-one", values.input);
    expect(result.hostedUrl).toBe(link);
    expect(values.readRecord()?.state).toBe("AWAITING_PAYMENT");
    expect(values.readRecord()?.evidence?.kind).toBe("HOSTED_CHECKOUT");
    expect(await service.createCheckout("site-one", values.input)).toEqual(
      result,
    );
    expect((await service.getStatus("site-one", values.input)).state).toBe(
      "AWAITING_PAYMENT",
    );
    expect(values.fetch).toHaveBeenCalledTimes(1);
    expect(String(values.fetch.mock.calls[0][1]?.body)).not.toContain(
      values.input.recoveryToken,
    );
  });

  it.each(["lost-ack", "invalid-response", "lost-commit"])(
    "retains UNKNOWN after %s and never replaces the committed attempt",
    async (kind) => {
      const values = serviceFixture();
      if (kind === "lost-ack")
        values.fetch.mockRejectedValue(
          new Error("Provider may have created the checkout"),
        );
      if (kind === "invalid-response")
        values.fetch.mockResolvedValue(json({ id: "bad/path" }));
      if (kind === "lost-commit")
        values.dependencies.repository.saveHostedCheckout = async () => {
          throw new Error("Persistence acknowledgment lost");
        };
      const service = createGiftCheckoutService(values.dependencies);
      await expect(
        service.createCheckout("site-one", values.input),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect(values.readRecord()?.state).toBe("OUTCOME_UNKNOWN");
      await expect(
        service.createCheckout("site-one", values.input),
      ).rejects.toMatchObject({ code: "EXTERNAL_OUTCOME_UNKNOWN" });
      expect((await service.getStatus("site-one", values.input)).state).toBe(
        "OUTCOME_UNKNOWN",
      );
      expect(values.readRecord()?.attemptId).toBe("attempt.one:1");
      expect(values.fetch).toHaveBeenCalledTimes(1);
      expect(values.readRecord()?.evidence).toBeNull();
    },
  );
});
