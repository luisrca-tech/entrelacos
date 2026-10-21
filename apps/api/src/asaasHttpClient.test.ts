import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AsaasHttpClientOptions,
  AsaasHttpClientServiceError,
  createAsaasHttpClient,
} from "./asaasHttpClient";

const now = new Date("2026-10-12T12:00:00.000Z");
// Synthetic credentials are used only with the injected fetch mock.
const token = "$aact_hmlg_offline-test-token";

function json(value: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function payment(overrides: Record<string, unknown> = {}) {
  return {
    id: "pay_1",
    checkoutSession: "checkout-1",
    externalReference: "attempt-1",
    status: "RECEIVED",
    billingType: "PIX",
    value: 103.55,
    netValue: 102,
    split: [
      {
        id: "split-1",
        walletId: "platform-wallet",
        fixedValue: 2,
        percentualValue: null,
        totalValue: 2,
        status: "DONE",
      },
    ],
    ...overrides,
  };
}

async function rejected(action: Promise<unknown>) {
  const error = await action.catch((error: unknown) => error);
  expect(error).toBeInstanceOf(AsaasHttpClientServiceError);
  expect(error).toMatchObject({
    code: "PROVIDER_HTTP_UNAVAILABLE",
    status: 503,
    message: "Provider response is unavailable",
  });
  expect(error).not.toHaveProperty("cause");
  expect(JSON.stringify(error)).not.toContain(token);
  return error;
}

afterEach(() => vi.useRealTimers());

describe("complete checkout payment correlation reads", () => {
  it("reads a complete filtered account-scoped list and retains only correlation references", async () => {
    const values = fixture(
      json({ hasMore: false, totalCount: 1, data: [payment()] }),
    );
    const result = await createAsaasHttpClient(
      values.options,
    ).listCheckoutPayments("checkout-1");
    expect(result.payments).toEqual([
      {
        id: "pay_1",
        checkoutSession: "checkout-1",
        externalReference: "attempt-1",
        status: "RECEIVED",
      },
    ]);
    expect(String(values.fetch.mock.calls[0][0])).toBe(
      "https://api-sandbox.asaas.com/v3/payments?checkoutSession=checkout-1&limit=100&offset=0",
    );
    expect(result).toMatchObject({
      siteId: "site-1",
      accountBindingId: "account-1",
      environment: "sandbox",
      accountReference: "remote-account-1",
    });
  });
  it.each([
    { hasMore: true, totalCount: 0, data: [] },
    { hasMore: false, totalCount: 1, data: [] },
    {
      hasMore: false,
      totalCount: 1,
      data: [payment({ checkoutSession: "another" })],
    },
  ])("rejects incomplete or contradictory provider lists: %j", async (body) => {
    const values = fixture(json(body));
    await rejected(
      createAsaasHttpClient(values.options).listCheckoutPayments("checkout-1"),
    );
  });
});

function fixture(
  response = new Response('{"balance":123.45}', {
    headers: { "content-type": "application/json" },
  }),
) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  const context = {
    provider: "ASAAS" as const,
    siteId: "site-1",
    accountBindingId: "account-1",
    environment: "sandbox" as const,
  };
  const options: AsaasHttpClientOptions = {
    mode: "sandbox",
    binding: { ...context, accountReference: "remote-account-1" },
    credentials: { context: { ...context }, accessToken: token },
    fetch,
    timeoutMs: 100,
    maxResponseBytes: 32_768,
    now: () => new Date(now),
  };
  return { options, fetch };
}

describe("native Asaas read client", () => {
  it.each([
    { method: "balance", stage: "fetch" },
    { method: "balance", stage: "body" },
    { method: "payment", stage: "fetch" },
    { method: "payment", stage: "body" },
  ] as const)(
    "rejects a late $method $stage ACK before the timer callback runs",
    async ({ method, stage }) => {
      const { options, fetch } = fixture();
      let elapsed = 0;
      const monotonic = vi
        .spyOn(performance, "now")
        .mockImplementation(() => elapsed);
      const cancel = vi.fn();
      try {
        fetch.mockImplementation(async () => {
          if (stage === "fetch") elapsed = options.timeoutMs;
          return new Response(
            new ReadableStream<Uint8Array>(
              {
                pull(controller) {
                  if (stage === "body") elapsed = options.timeoutMs;
                  controller.enqueue(
                    new TextEncoder().encode(
                      JSON.stringify(
                        method === "balance" ? { balance: 123.45 } : payment(),
                      ),
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
        const client = createAsaasHttpClient(options);
        await rejected(
          method === "balance"
            ? client.getBalance()
            : client.getPayment("pay_1"),
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
        if (stage === "fetch") expect(cancel).toHaveBeenCalledTimes(1);
      } finally {
        monotonic.mockRestore();
      }
    },
  );

  it("rejects a JSON parse finishing after the monotonic deadline before the timer runs", async () => {
    const { options, fetch } = fixture();
    let elapsed = 0;
    const monotonic = vi
      .spyOn(performance, "now")
      .mockImplementation(() => elapsed);
    const originalParse = JSON.parse;
    const parse = vi
      .spyOn(JSON, "parse")
      .mockImplementation((text, reviver) => {
        const value = originalParse(text, reviver);
        if (text === '{"balance":123.45}') elapsed = options.timeoutMs;
        return value;
      });
    try {
      await rejected(createAsaasHttpClient(options).getBalance());
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    } finally {
      parse.mockRestore();
      monotonic.mockRestore();
    }
  });

  it("uses the start of a balance GET as its conservative observation watermark", async () => {
    const { options, fetch } = fixture();
    let current = now.getTime();
    options.now = () => new Date(current);
    fetch.mockImplementation(async () => {
      // A withdrawal may complete while this earlier balance response is in flight.
      current += 30_000;
      return json({ balance: 150 });
    });
    const result = await createAsaasHttpClient(options).getBalance();
    expect(result.observedAt).toEqual(now);
    expect(result.balanceCents).toBe(15_000);
  });

  it("rejects a server clock moving backwards during the balance GET", async () => {
    const { options, fetch } = fixture();
    let current = now.getTime();
    options.now = () => new Date(current);
    fetch.mockImplementation(async () => {
      current -= 1;
      return json({ balance: 150 });
    });
    await rejected(createAsaasHttpClient(options).getBalance());
  });

  it("validates its balance observation clock before issuing the GET", async () => {
    const { options, fetch } = fixture();
    options.now = () => "2026-10-12T12:00:00.000Z" as unknown as Date;
    await rejected(createAsaasHttpClient(options).getBalance());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches documented balance from the fixed sandbox origin with server authentication", async () => {
    const { options, fetch } = fixture();
    expect(await createAsaasHttpClient(options).getBalance()).toEqual({
      source: "provider",
      provider: "ASAAS",
      siteId: "site-1",
      accountBindingId: "account-1",
      accountReference: "remote-account-1",
      environment: "sandbox",
      currency: "BRL",
      observedAt: now,
      balanceCents: 12_345,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0];
    expect(url).toBe("https://api-sandbox.asaas.com/v3/finance/balance");
    expect(request).toMatchObject({
      method: "GET",
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
    });
    expect(request).not.toHaveProperty("body");
    expect(new Headers(request?.headers).get("access_token")).toBe(token);
    expect(new Headers(request?.headers).get("user-agent")).toBe(
      "EntreLacos-API",
    );
    expect(new Headers(request?.headers).get("accept")).toBe(
      "application/json",
    );
  });

  it("reads actual zero balance and uses only the fixed live origin for live credentials", async () => {
    const { options, fetch } = fixture(json({ balance: 0 }));
    options.mode = "live";
    options.binding.environment = "live";
    options.credentials.context.environment = "live";
    options.credentials.accessToken = "$aact_prod_offline-test-token";
    expect(
      (await createAsaasHttpClient(options).getBalance()).balanceCents,
    ).toBe(0);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.asaas.com/v3/finance/balance",
    );
  });

  it.each([
    [
      "disabled",
      (o: AsaasHttpClientOptions) => {
        o.mode = "disabled";
      },
    ],
    [
      "site mismatch",
      (o: AsaasHttpClientOptions) => {
        o.credentials.context.siteId = "other";
      },
    ],
    [
      "local account mismatch",
      (o: AsaasHttpClientOptions) => {
        o.credentials.context.accountBindingId = "other";
      },
    ],
    [
      "environment mismatch",
      (o: AsaasHttpClientOptions) => {
        o.credentials.context.environment = "live";
      },
    ],
    [
      "provider mismatch",
      (o: AsaasHttpClientOptions) => {
        Object.assign(o.credentials.context, { provider: "OTHER" });
      },
    ],
    [
      "binding mode mismatch",
      (o: AsaasHttpClientOptions) => {
        o.binding.environment = "live";
      },
    ],
    [
      "missing local identity",
      (o: AsaasHttpClientOptions) => {
        Object.assign(o.binding, { siteId: undefined });
        Object.assign(o.credentials.context, { siteId: undefined });
      },
    ],
    [
      "remote account missing",
      (o: AsaasHttpClientOptions) => {
        o.binding.accountReference = "";
      },
    ],
    [
      "context extra browser claim",
      (o: AsaasHttpClientOptions) => {
        Object.assign(o.credentials.context, { approved: true });
      },
    ],
    [
      "binding extra secret",
      (o: AsaasHttpClientOptions) => {
        Object.assign(o.binding, { accessToken: token });
      },
    ],
    [
      "wrong key environment",
      (o: AsaasHttpClientOptions) => {
        o.credentials.accessToken = "$aact_prod_offline-test-token";
      },
    ],
    [
      "header injection",
      (o: AsaasHttpClientOptions) => {
        o.credentials.accessToken = `${token}\r\nx-secret: leaked`;
      },
    ],
    [
      "trailing newline in credential",
      (o: AsaasHttpClientOptions) => {
        o.credentials.accessToken = `${token}\n`;
      },
    ],
    [
      "trailing newline in identity",
      (o: AsaasHttpClientOptions) => {
        o.binding.siteId = "site-1\n";
        o.credentials.context.siteId = "site-1\n";
      },
    ],
    [
      "empty key suffix",
      (o: AsaasHttpClientOptions) => {
        o.credentials.accessToken = "$aact_hmlg_";
      },
    ],
    [
      "oversized key",
      (o: AsaasHttpClientOptions) => {
        o.credentials.accessToken = `$aact_hmlg_${"x".repeat(8192)}`;
      },
    ],
    [
      "no injected fetch",
      (o: AsaasHttpClientOptions) => {
        Object.assign(o, { fetch: undefined });
      },
    ],
    [
      "zero timeout",
      (o: AsaasHttpClientOptions) => {
        o.timeoutMs = 0;
      },
    ],
    [
      "unbounded timeout",
      (o: AsaasHttpClientOptions) => {
        o.timeoutMs = 30_001;
      },
    ],
    [
      "fractional bound",
      (o: AsaasHttpClientOptions) => {
        o.maxResponseBytes = 1.5;
      },
    ],
    [
      "unbounded response",
      (o: AsaasHttpClientOptions) => {
        o.maxResponseBytes = 1_048_577;
      },
    ],
  ])(
    "rejects invalid server configuration before fetch: %s",
    (_name, change) => {
      const { options, fetch } = fixture();
      change(options);
      expect(() => createAsaasHttpClient(options)).toThrow(
        AsaasHttpClientServiceError,
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("captures the approved configuration so later caller mutation cannot change origin, credential or scope", async () => {
    const { options, fetch } = fixture();
    const client = createAsaasHttpClient(options);
    options.mode = "live";
    options.binding.siteId = "other";
    options.binding.environment = "live";
    options.credentials.accessToken = "$aact_prod_other";
    options.timeoutMs = 1;
    options.maxResponseBytes = 1;
    const result = await client.getBalance();
    expect(result.siteId).toBe("site-1");
    expect(result.environment).toBe("sandbox");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/finance/balance",
    );
    expect(
      new Headers(fetch.mock.calls[0][1]?.headers).get("access_token"),
    ).toBe(token);
  });

  it.each([
    {},
    { balance: null },
    { balance: -1 },
    { balance: 1.001 },
    { balance: "1e2" },
    { balance: "1,00" },
    { balance: "21474836.48" },
  ])(
    "does not invent a balance from malformed or missing money: %j",
    async (body) => {
      const { options } = fixture(json(body));
      await rejected(createAsaasHttpClient(options).getBalance());
    },
  );

  it.each([201, 202, 204, 206, 301, 400, 401, 404, 429, 500])(
    "rejects unresolved or unsuccessful HTTP status %i without retry",
    async (status) => {
      const { options, fetch } = fixture(
        new Response(
          status === 204
            ? null
            : JSON.stringify({ balance: 12, access_token: token }),
          { status, headers: { "content-type": "application/json" } },
        ),
      );
      await rejected(createAsaasHttpClient(options).getBalance());
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    "",
    "text/html",
    "application/problem+json",
    "application/json; charset=iso-8859-1",
    "text/json",
  ])("rejects response MIME %s", async (mime) => {
    const { options } = fixture(
      new Response('{"balance":1}', { headers: { "content-type": mime } }),
    );
    await rejected(createAsaasHttpClient(options).getBalance());
  });

  it.each(["[]", "null", "true", "", "{invalid}"])(
    "requires a complete JSON object: %s",
    async (body) => {
      const { options } = fixture(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
      await rejected(createAsaasHttpClient(options).getBalance());
    },
  );

  it("rejects redirected or foreign-origin responses even if fetch ignores redirect:error", async () => {
    for (const attributes of [
      { redirected: true },
      { url: "https://unapproved.example/v3/finance/balance" },
    ]) {
      const response = json({ balance: 1 });
      Object.defineProperties(
        response,
        Object.fromEntries(
          Object.entries(attributes).map(([key, value]) => [key, { value }]),
        ),
      );
      const { options } = fixture(response);
      await rejected(createAsaasHttpClient(options).getBalance());
    }
  });

  it("sanitizes transport and clock errors without storing the raw cause", async () => {
    const { options, fetch } = fixture();
    fetch.mockRejectedValueOnce(
      new Error(`provider secret ${token}; card=private`),
    );
    const error = await rejected(createAsaasHttpClient(options).getBalance());
    expect(String(error)).not.toContain("private");
    expect(String(error)).not.toContain(token);
    const clock = fixture();
    clock.options.now = () => {
      throw new Error(token);
    };
    await rejected(createAsaasHttpClient(clock.options).getBalance());
    const invalid = fixture();
    invalid.options.now = () => new Date("invalid");
    await rejected(createAsaasHttpClient(invalid.options).getBalance());
  });

  it("times out a fetch that ignores abort without retrying or returning later success", async () => {
    vi.useFakeTimers();
    const { options, fetch } = fixture();
    let resolve!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((done) => {
          resolve = done;
        }),
    );
    const result = rejected(createAsaasHttpClient(options).getBalance());
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    resolve(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "content-type": "application/json" },
      }),
    );
    await Promise.resolve();
    await result;
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("times out stalled stream consumption and cancels the body", async () => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const { options } = fixture(
      new Response(new ReadableStream({ cancel: cancelled }), {
        headers: { "content-type": "application/json" },
      }),
    );
    const result = rejected(createAsaasHttpClient(options).getBalance());
    await vi.advanceTimersByTimeAsync(100);
    await result;
    expect(cancelled).toHaveBeenCalled();
  });

  it("bounds actual streamed bytes despite a false Content-Length", async () => {
    const cancelled = vi.fn();
    const { options } = fixture(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"balance":123.45}'));
          },
          cancel: cancelled,
        }),
        {
          headers: {
            "content-type": "application/json",
            "content-length": "1",
          },
        },
      ),
    );
    options.maxResponseBytes = 8;
    await rejected(createAsaasHttpClient(options).getBalance());
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each(["32769", "NaN", "-1", "1.5", "9007199254740992"])(
    "rejects invalid or oversized declared Content-Length %s and cancels unread body",
    async (length) => {
      const cancelled = vi.fn();
      const { options } = fixture(
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: {
            "content-type": "application/json",
            "content-length": length,
          },
        }),
      );
      await rejected(createAsaasHttpClient(options).getBalance());
      expect(cancelled).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds an endless stream of zero-byte chunks", async () => {
    let pulls = 0;
    const cancelled = vi.fn();
    const { options } = fixture(
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++;
            controller.enqueue(new Uint8Array());
          },
          cancel: cancelled,
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await rejected(createAsaasHttpClient(options).getBalance());
    expect(pulls).toBeLessThanOrEqual(4097);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it("decodes fragmented UTF-8 strictly and drops unrelated private values", async () => {
    const bytes = new TextEncoder().encode('{"balance":1,"private":"é"}');
    const chunks = [
      bytes.slice(0, bytes.length - 3),
      bytes.slice(bytes.length - 3),
    ];
    const { options } = fixture(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
        { headers: { "content-type": 'application/json; charset="UTF-8"' } },
      ),
    );
    expect(
      (await createAsaasHttpClient(options).getBalance()).balanceCents,
    ).toBe(100);
  });

  it.each([0xff, 0xc3])(
    "rejects invalid or incomplete UTF-8 byte %j",
    async (suffix) => {
      const prefix = new TextEncoder().encode('{"balance":1,"private":"');
      const bytes = new Uint8Array([...prefix, suffix]);
      const { options } = fixture(
        new Response(bytes, {
          headers: { "content-type": "application/json" },
        }),
      );
      await rejected(createAsaasHttpClient(options).getBalance());
    },
  );

  it("fetches one bound payment and emits only fields used by reconciliation", async () => {
    const raw = payment({
      customer: "payer-private",
      creditCard: { creditCardToken: "card-private" },
      invoiceUrl: "https://private.example",
      access_token: token,
    });
    Object.assign((raw.split as Record<string, unknown>[])[0], {
      description: "private",
      externalReference: "private",
    });
    const { options, fetch } = fixture(json(raw));
    const result = await createAsaasHttpClient(options).getPayment("pay_1");
    expect(result).toEqual({
      source: "provider",
      provider: "ASAAS",
      siteId: "site-1",
      accountReference: "remote-account-1",
      environment: "sandbox",
      currency: "BRL",
      observedAt: now,
      payment: {
        id: "pay_1",
        checkoutSession: "checkout-1",
        externalReference: "attempt-1",
        status: "RECEIVED",
        billingType: "PIX",
        value: "103.55",
        netValue: "102.00",
        split: [
          {
            id: "split-1",
            walletId: "platform-wallet",
            fixedValue: "2.00",
            percentualValue: null,
            totalValue: "2.00",
            status: "DONE",
          },
        ],
      },
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/payments/pay_1",
    );
    expect(JSON.stringify(result)).not.toMatch(
      /payer-private|card-private|private\.example|access_token|description/,
    );
  });

  it.each([
    "",
    "../pay_1",
    "pay_1?token=secret",
    "https://evil.example",
    "pay/1",
    "pay%2f1",
    "pay\n1",
    "pay_1\n",
    "x".repeat(129),
  ])("rejects an untrusted payment path before fetch: %s", async (ref) => {
    const { options, fetch } = fixture(json(payment()));
    await rejected(createAsaasHttpClient(options).getPayment(ref));
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    { id: "pay_other" },
    { id: null },
    { checkoutSession: null },
    { status: null },
    { status: "PRIVATE_UNKNOWN" },
    { billingType: null },
    { billingType: "PRIVATE_UNKNOWN" },
    { currency: "USD" },
    { value: 0 },
    { value: 1.001 },
    { value: -1 },
    { netValue: "Infinity" },
    { netValue: 200 },
    { externalReference: "attempt/secret" },
    { deleted: "false" },
    { split: {} },
    {
      split: [
        { walletId: "wallet", id: "split", status: "DONE", fixedValue: -1 },
      ],
    },
    {
      split: [
        {
          walletId: "wallet",
          id: "split",
          status: "DONE",
          totalValue: "1.111",
        },
      ],
    },
    {
      split: [
        {
          walletId: "wallet",
          id: "split",
          status: "DONE",
          percentualValue: "2%",
        },
      ],
    },
    { refunds: {} },
    { chargeback: "false" },
  ])(
    "rejects malformed required identity or observed values: %j",
    async (overrides) => {
      const { options } = fixture(json(payment(overrides)));
      await rejected(createAsaasHttpClient(options).getPayment("pay_1"));
    },
  );

  it("preserves absent and null net/split evidence instead of inventing approval", async () => {
    const missing: Record<string, unknown> = payment();
    delete missing.netValue;
    delete missing.split;
    const absent = fixture(json(missing));
    const absentPayment = (
      await createAsaasHttpClient(absent.options).getPayment("pay_1")
    ).payment;
    expect(absentPayment).not.toHaveProperty("netValue");
    expect(absentPayment).not.toHaveProperty("split");
    const nullable = fixture(json(payment({ netValue: null, split: null })));
    expect(
      (await createAsaasHttpClient(nullable.options).getPayment("pay_1"))
        .payment,
    ).toMatchObject({ netValue: null, split: null });
    const explicit = fixture(json(payment({ split: [] })));
    expect(
      (await createAsaasHttpClient(explicit.options).getPayment("pay_1"))
        .payment,
    ).toMatchObject({ split: [] });
  });

  it("preserves actual totalValue even when it contradicts fixedValue; it does not synthesize totalValue", async () => {
    const raw = payment({
      split: [
        {
          id: "split",
          walletId: "wallet",
          fixedValue: 2,
          totalValue: 3,
          status: "DONE",
        },
      ],
    });
    const actual = fixture(json(raw));
    expect(
      (await createAsaasHttpClient(actual.options).getPayment("pay_1")).payment,
    ).toMatchObject({ split: [{ fixedValue: "2.00", totalValue: "3.00" }] });
    delete (raw.split as Record<string, unknown>[])[0].totalValue;
    const absent = fixture(json(raw));
    const normalized = (
      await createAsaasHttpClient(absent.options).getPayment("pay_1")
    ).payment as { split: unknown[] };
    expect(normalized.split[0]).not.toHaveProperty("totalValue");
  });

  it("retains pending, refund, chargeback and custody risk without leaking their private payloads", async () => {
    const raw = payment({
      status: "CONFIRMED",
      billingType: "CREDIT_CARD",
      deleted: false,
      chargeback: {
        status: "IN_DISPUTE",
        customerAccount: { card: "private" },
      },
      refunds: [
        {
          status: "DONE",
          value: 1,
          transactionReceiptUrl: "https://private.example",
          description: "private",
        },
      ],
      custody: { private: "private" },
    });
    const { options } = fixture(json(raw));
    const result = await createAsaasHttpClient(options).getPayment("pay_1");
    expect(result.payment).toMatchObject({
      status: "CONFIRMED",
      billingType: "CREDIT_CARD",
      deleted: false,
      chargeback: { status: "IN_DISPUTE" },
      refunds: [{ status: "DONE", value: "1.00" }],
      custody: {},
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|customerAccount|transactionReceiptUrl/,
    );
  });
});

describe("Asaas GET actual completion ownership", () => {
  const methods = ["balance", "payment"] as const;
  type Method = (typeof methods)[number];

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  function observe(options: AsaasHttpClientOptions, method: Method) {
    let settled = false;
    const client = createAsaasHttpClient(options);
    const action: Promise<unknown> =
      method === "balance" ? client.getBalance() : client.getPayment("pay_1");
    const completion = action.then(
      (value) => {
        settled = true;
        return { value, error: undefined };
      },
      (error: unknown) => {
        settled = true;
        return { value: undefined, error };
      },
    );
    return { completion, settled: () => settled };
  }

  async function flush() {
    await vi.advanceTimersByTimeAsync(0);
  }

  async function unavailableResult(owner: ReturnType<typeof observe>) {
    const result = await owner.completion;
    expect(result.value).toBeUndefined();
    await rejected(Promise.reject(result.error));
  }

  // These synthetic readers let read and cancellation finish independently.
  // They never open a transport or claim that failed cleanup has completed.
  function responseWithReader(
    read: () => Promise<ReadableStreamReadResult<Uint8Array>>,
    cancel: () => Promise<void>,
    init: { status?: number; headers?: Record<string, string> } = {},
  ) {
    const reader = {
      read: vi.fn(read),
      cancel: vi.fn(cancel),
      releaseLock: vi.fn(),
    };
    const body = { getReader: vi.fn(() => reader), cancel: vi.fn(cancel) };
    const response = {
      status: init.status ?? 200,
      redirected: false,
      url: "",
      headers: new Headers({
        "content-type": "application/json",
        ...init.headers,
      }),
      body,
    } as unknown as Response;
    return { response, reader, body };
  }

  for (const method of methods) {
    it.each(["fulfill", "reject"] as const)(
      `${method} waits for an ignored-abort fetch to %s and rejects late results`,
      async (outcome) => {
        vi.useFakeTimers();
        const transport = deferred<Response>();
        const cleanup = deferred<void>();
        const cancelled = vi.fn(() => cleanup.promise);
        const { options, fetch } = fixture();
        fetch.mockReturnValueOnce(transport.promise);
        const owner = observe(options, method);
        try {
          await vi.advanceTimersByTimeAsync(100);
          expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
          expect(owner.settled()).toBe(false);
        } finally {
          if (outcome === "reject") transport.reject(new Error("private"));
          else
            transport.resolve(
              new Response(new ReadableStream({ cancel: cancelled }), {
                headers: { "content-type": "application/json" },
              }),
            );
          await flush();
          cleanup.resolve();
          await owner.completion;
        }
        if (outcome === "fulfill") expect(cancelled).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        await unavailableResult(owner);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it(`${method} retains a late unread body until native cancellation finishes`, async () => {
      vi.useFakeTimers();
      const transport = deferred<Response>();
      const cleanup = deferred<void>();
      const cancelled = vi.fn(() => cleanup.promise);
      const { options, fetch } = fixture();
      fetch.mockReturnValueOnce(transport.promise);
      const owner = observe(options, method);
      try {
        await vi.advanceTimersByTimeAsync(100);
        transport.resolve(
          new Response(new ReadableStream({ cancel: cancelled }), {
            headers: { "content-type": "application/json" },
          }),
        );
        await flush();
        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(owner.settled()).toBe(false);
      } finally {
        cleanup.resolve();
        await owner.completion;
      }
      await unavailableResult(owner);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it(`${method} waits for native cancellation after it releases a stalled read`, async () => {
      vi.useFakeTimers();
      const cleanup = deferred<void>();
      const cancelled = vi.fn(() => cleanup.promise);
      const { options } = fixture(
        new Response(new ReadableStream({ cancel: cancelled }), {
          headers: { "content-type": "application/json" },
        }),
      );
      const owner = observe(options, method);
      try {
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        expect(cancelled).toHaveBeenCalledTimes(1);
        expect(owner.settled()).toBe(false);
      } finally {
        cleanup.resolve();
        await owner.completion;
      }
      await unavailableResult(owner);
    });

    it.each([
      { first: "read", readRejects: false },
      { first: "cancel", readRejects: false },
      { first: "read", readRejects: true },
      { first: "cancel", readRejects: true },
    ] as const)(
      `${method} awaits independent read and cancellation: $first first, read rejection $readRejects`,
      async ({ first, readRejects }) => {
        vi.useFakeTimers();
        const read = deferred<ReadableStreamReadResult<Uint8Array>>();
        const cleanup = deferred<void>();
        const { response, reader } = responseWithReader(
          () => read.promise,
          () => cleanup.promise,
        );
        const { options, fetch } = fixture(response);
        const owner = observe(options, method);
        const finishRead = () => {
          if (readRejects) read.reject(new Error("private"));
          else
            read.resolve({
              done: false,
              value: new TextEncoder().encode("{}"),
            });
        };
        try {
          await flush();
          await vi.advanceTimersByTimeAsync(100);
          expect(reader.cancel).toHaveBeenCalledTimes(1);
          expect(owner.settled()).toBe(false);
          expect(reader.releaseLock).not.toHaveBeenCalled();
          if (first === "read") finishRead();
          else cleanup.resolve();
          await flush();
          expect(owner.settled()).toBe(false);
          expect(reader.releaseLock).not.toHaveBeenCalled();
        } finally {
          finishRead();
          cleanup.resolve();
          await owner.completion;
        }
        await unavailableResult(owner);
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.each(["status", "mime", "length", "bytes", "utf8", "read"] as const)(
      `${method} waits for actual cleanup after a %s error`,
      async (failure) => {
        vi.useFakeTimers();
        const cleanup = deferred<void>();
        const { response, reader, body } = responseWithReader(
          async () => {
            if (failure === "read") throw new Error("private");
            return {
              done: false,
              value:
                failure === "utf8"
                  ? new Uint8Array([255])
                  : new Uint8Array(32_769),
            };
          },
          () => cleanup.promise,
          {
            status: failure === "status" ? 500 : 200,
            headers:
              failure === "mime"
                ? { "content-type": "text/html" }
                : failure === "length"
                  ? { "content-length": "32769" }
                  : {},
          },
        );
        const { options } = fixture(response);
        const owner = observe(options, method);
        const cancellation = ["status", "mime", "length"].includes(failure)
          ? body.cancel
          : reader.cancel;
        try {
          await flush();
          expect(cancellation).toHaveBeenCalledTimes(1);
          expect(owner.settled()).toBe(false);
          expect(reader.releaseLock).not.toHaveBeenCalled();
          expect(vi.getTimerCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(100);
          expect(cancellation).toHaveBeenCalledTimes(1);
        } finally {
          cleanup.resolve();
          await owner.completion;
        }
        await unavailableResult(owner);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.each(["invalid JSON", "invalid record"] as const)(
      `${method} treats EOF independently from %s parsing`,
      async (failure) => {
        vi.useFakeTimers();
        let chunk = 0;
        const { response, reader } = responseWithReader(
          async () =>
            chunk++ === 0
              ? {
                  done: false,
                  value: new TextEncoder().encode(
                    failure === "invalid JSON" ? "{" : "[]",
                  ),
                }
              : { done: true, value: undefined },
          async () => {},
        );
        const { options } = fixture(response);
        const owner = observe(options, method);
        await unavailableResult(owner);
        expect(reader.cancel).not.toHaveBeenCalled();
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it.each(["body", "reader"] as const)(
      `${method} retains an invalid %s cancellation thenable without invoking it`,
      async (stage) => {
        vi.useFakeTimers();
        const read = deferred<ReadableStreamReadResult<Uint8Array>>();
        const then = vi.fn((fulfilled: () => void) => fulfilled());
        const { response, body, reader } = responseWithReader(
          () => read.promise,
          () => ({ then }) as unknown as Promise<void>,
          { status: stage === "body" ? 500 : 200 },
        );
        const { options } = fixture(response);
        const owner = observe(options, method);
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        read.reject(new Error("private read"));
        // Only the reader branch started this deferred read. Explicitly
        // observe the unused synthetic promise in the body branch as well.
        await read.promise.catch(() => undefined);
        await flush();
        expect(owner.settled()).toBe(false);
        expect(then).not.toHaveBeenCalled();
        expect(
          stage === "body" ? body.cancel : reader.cancel,
        ).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).not.toHaveBeenCalled();
        vi.clearAllTimers();
      },
    );

    it.each(["throws", "rejects", "invalid"] as const)(
      `${method} keeps failed cancellation owned after its independent read rejects: %s`,
      async (failure) => {
        vi.useFakeTimers();
        const read = deferred<ReadableStreamReadResult<Uint8Array>>();
        const { response, reader } = responseWithReader(
          () => read.promise,
          () => {
            if (failure === "throws") throw new Error("private");
            if (failure === "rejects")
              return Promise.reject(new Error("private"));
            return undefined as unknown as Promise<void>;
          },
        );
        const { options } = fixture(response);
        const owner = observe(options, method);
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        read.reject(new Error("private read"));
        await flush();
        expect(owner.settled()).toBe(false);
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).not.toHaveBeenCalled();
        // Neither a rejected read nor an invalid cancellation method proves
        // disposal. This retained synthetic owner has no live I/O.
        vi.clearAllTimers();
      },
    );

    it.each(["throws", "rejects", "pending"] as const)(
      `${method} retains synthetic uncertain cancellation that %s`,
      async (failure) => {
        vi.useFakeTimers();
        const { response, body, reader } = responseWithReader(
          async () => ({ done: true, value: undefined }),
          () => {
            if (failure === "throws") throw new Error("private");
            if (failure === "rejects")
              return Promise.reject(new Error("private"));
            return new Promise<void>(() => {});
          },
          { status: 500 },
        );
        const { options, fetch } = fixture(response);
        const owner = observe(options, method);
        await flush();
        await vi.advanceTimersByTimeAsync(100);
        expect(owner.settled()).toBe(false);
        expect(body.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
        // Held uncertainty is intentionally not reported as drained. Only the
        // isolated fake timer is discarded; this fixture owns no live I/O.
        vi.clearAllTimers();
      },
    );
  }
});

describe("exact account fee observations", () => {
  function fees(text: string, init: ResponseInit = {}) {
    return fixture(
      new Response(text, {
        ...init,
        headers: { "content-type": "application/json", ...init.headers },
      }),
    );
  }

  it("reads the fixed bodyless account endpoint and preserves only selected original decimal fields", async () => {
    const { options, fetch } = fees(
      '{"payment":{"creditCard":{"operationValue":0.49,"oneInstallmentPercentage":2.99},"pix":{"fixedFeeValue":0,"percentageFee":null}},"transfer":{"monthlyTransfersWithoutFee":30,"ted":{"feeValue":5,"consideredInMonthlyTransfersWithoutFee":false}},"apiKey":"private"}',
    );
    expect(await createAsaasHttpClient(options).getAccountFees()).toEqual({
      source: "provider",
      ...options.binding,
      currency: "BRL",
      observedAt: now,
      completedAt: now,
      fees: {
        payment: {
          creditCard: {
            operationValue: "0.49",
            oneInstallmentPercentage: "2.99",
          },
          pix: { fixedFeeValue: "0.00", percentageFee: null },
        },
        transfer: {
          monthlyTransfersWithoutFee: 30,
          ted: {
            feeValue: "5.00",
            consideredInMonthlyTransfersWithoutFee: false,
          },
        },
      },
    });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/myAccount/fees/",
    );
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: "GET",
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
    });
    expect(fetch.mock.calls[0][1]).not.toHaveProperty("body");
  });

  it("retains the observed fixed Pix tariff type and card promotion flag without inventing either", async () => {
    const { options } = fees(
      '{"payment":{"pix":{"type":"FIXED","fixedFeeValue":1.99,"monthlyCreditsWithoutFee":100,"creditsReceivedOfCurrentMonth":0},"creditCard":{"operationValue":0.49,"oneInstallmentPercentage":2.99,"discountOneInstallmentPercentage":1.99,"hasValidDiscount":true,"discountExpiration":"2027-01-16 00:00:00"}}}',
    );
    expect(
      (await createAsaasHttpClient(options).getAccountFees()).fees.payment,
    ).toMatchObject({
      pix: {
        type: "FIXED",
        fixedFeeValue: "1.99",
        monthlyCreditsWithoutFee: 100,
        creditsReceivedOfCurrentMonth: 0,
      },
      creditCard: {
        hasValidDiscount: true,
        discountOneInstallmentPercentage: "1.99",
      },
    });
  });

  it.each([
    "0.49000000000000001",
    "2.9900000000000001",
    "-0",
    "1e-2",
    "1e100000",
    "0.001",
    "99.999",
    "21474836.48",
    '"0.49"',
    '{"lexeme":"0.49"}',
    "1111111111111111111111111111111111111111111111111111111111111111111",
  ])(
    "rejects an unsupported original numeric token %s before rounded normalization",
    async (lexeme) => {
      const { options } = fees(
        `{"payment":{"creditCard":{"operationValue":${lexeme}}}}`,
      );
      await rejected(createAsaasHttpClient(options).getAccountFees());
    },
  );

  it.each(["100", "-1", "0.001"])(
    "rejects an unrepresentable percentage %s",
    async (lexeme) => {
      const { options } = fees(
        `{"payment":{"pix":{"percentageFee":${lexeme}}}}`,
      );
      await rejected(createAsaasHttpClient(options).getAccountFees());
    },
  );

  it("distinguishes absent, null and explicit zero without interpreting fee authority", async () => {
    for (const [text, expected] of [
      ["{}", {}],
      ['{"payment":null}', { payment: null }],
      [
        '{"payment":{"pix":{"fixedFeeValue":null}}}',
        { payment: { pix: { fixedFeeValue: null } } },
      ],
      [
        '{"payment":{"pix":{"fixedFeeValue":0}}}',
        { payment: { pix: { fixedFeeValue: "0.00" } } },
      ],
    ] as const) {
      const { options } = fees(text);
      const result = await createAsaasHttpClient(options).getAccountFees();
      expect(result.fees).toEqual(expected);
      expect(result).not.toHaveProperty("verification");
      expect(result).not.toHaveProperty("expiresAt");
    }
  });

  it("fails closed when JSON reviver numeric-source capability is absent", async () => {
    const parse = JSON.parse;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) =>
      parse(
        text,
        reviver
          ? function (key, value) {
              return reviver.call(this, key, value);
            }
          : undefined,
      ),
    );
    try {
      const { options } = fees('{"payment":{"pix":{"fixedFeeValue":0}}}');
      await rejected(createAsaasHttpClient(options).getAccountFees());
    } finally {
      spy.mockRestore();
    }
  });

  it("uses the original native Response body and captured acquisition/read methods", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"transfer":{"ted":{"feeValue":5}}}'),
        );
        controller.close();
      },
    });
    const response = new Response(body, {
      headers: { "content-type": "application/json" },
    });
    const shadowedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
        controller.close();
      },
    });
    const fakeAcquisition = vi.fn(() => shadowedBody.getReader());
    Object.defineProperty(response, "body", { value: shadowedBody });
    Object.defineProperty(body, "getReader", { value: fakeAcquisition });
    const readSpy = vi
      .spyOn(ReadableStreamDefaultReader.prototype, "read")
      .mockImplementation(async () => ({ done: true, value: undefined }));
    try {
      const { options } = fixture(response);
      expect(
        (await createAsaasHttpClient(options).getAccountFees()).fees,
      ).toEqual({ transfer: { ted: { feeValue: "5.00" } } });
      expect(fakeAcquisition).not.toHaveBeenCalled();
      expect(readSpy).not.toHaveBeenCalled();
      expect(body.locked).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  it("does not accept a synthetic stream or an unrelated native body as original response provenance", async () => {
    const { options } = fixture({
      status: 200,
      redirected: false,
      url: "",
      headers: new Headers({ "content-type": "application/json" }),
      body: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    } as Response);
    await rejected(createAsaasHttpClient(options).getAccountFees());
  });

  it("keeps the pre-dispatch observation and refuses backward completion clocks", async () => {
    const { options, fetch } = fees("{}");
    let time = now.getTime();
    options.now = () => new Date(time);
    fetch.mockImplementationOnce(async () => {
      time += 50;
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    });
    expect(await createAsaasHttpClient(options).getAccountFees()).toMatchObject(
      { observedAt: now, completedAt: new Date(now.getTime() + 50) },
    );
    fetch.mockImplementationOnce(async () => {
      time -= 100;
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    });
    await rejected(createAsaasHttpClient(options).getAccountFees());
  });

  it("waits for an ignored-abort fetch and genuine native cancellation despite a forged body.cancel", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: Response) => void;
    let resolveCancel!: () => void;
    const cleanup = new Promise<void>((done) => {
      resolveCancel = done;
    });
    const cancel = vi.fn(() => cleanup);
    const body = new ReadableStream<Uint8Array>({ cancel });
    const forgedCancel = vi.fn(() => Promise.resolve());
    Object.defineProperty(body, "cancel", { value: forgedCancel });
    const { options, fetch } = fees("{}");
    fetch.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolveFetch = done;
      }),
    );
    let settled = false;
    const action = createAsaasHttpClient(options)
      .getAccountFees()
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      resolveFetch(
        new Response(body, { headers: { "content-type": "application/json" } }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(forgedCancel).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      resolveCancel();
      await action;
    }
    await rejected(Promise.reject(await action));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("waits for native reader cancellation while a genuine stalled read is released", async () => {
    vi.useFakeTimers();
    let resolveCancel!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolveCancel = done;
        }),
    );
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { options } = fixture(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    let settled = false;
    const action = createAsaasHttpClient(options)
      .getAccountFees()
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(body.locked).toBe(true);
      expect(settled).toBe(false);
    } finally {
      resolveCancel();
      await action;
    }
    expect(body.locked).toBe(false);
    await rejected(Promise.reject(await action));
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["rejects", "pending"] as const)(
    "retains genuine native cancellation uncertainty that %s",
    async (failure) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() =>
        failure === "rejects"
          ? Promise.reject(new Error("private cleanup"))
          : new Promise<void>(() => {}),
      );
      const body = new ReadableStream<Uint8Array>({ cancel });
      const { options } = fixture(
        new Response(body, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
      let settled = false;
      createAsaasHttpClient(options)
        .getAccountFees()
        .then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);
      // This offline stream has no I/O; its uncertain owner intentionally stays pending.
      vi.clearAllTimers();
    },
  );

  it.each(["status", "mime", "length", "bytes", "utf8", "json"] as const)(
    "rejects %s with real EOF or genuine cancellation",
    async (failure) => {
      const cancel = vi.fn(async () => {});
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (["bytes", "utf8", "json"].includes(failure)) {
            controller.enqueue(
              failure === "bytes"
                ? new Uint8Array(32_769)
                : failure === "utf8"
                  ? new Uint8Array([255])
                  : new TextEncoder().encode("{"),
            );
            if (failure === "json") controller.close();
          }
        },
        cancel,
      });
      const { options } = fixture(
        new Response(body, {
          status: failure === "status" ? 500 : 200,
          headers: {
            "content-type":
              failure === "mime" ? "text/html" : "application/json",
            ...(failure === "length" ? { "content-length": "32769" } : {}),
          },
        }),
      );
      await rejected(createAsaasHttpClient(options).getAccountFees());
      expect(cancel).toHaveBeenCalledTimes(failure === "json" ? 0 : 1);
      expect(body.locked).toBe(false);
    },
  );

  it("bounds unsupported token precision and length before any BigInt conversion", async () => {
    const conversion = vi.spyOn(globalThis, "BigInt");
    try {
      for (const lexeme of [
        "0.49000000000000001",
        "111111111111111111111111111111111",
      ]) {
        const { options } = fees(
          `{"payment":{"creditCard":{"operationValue":${lexeme}}}}`,
        );
        await rejected(createAsaasHttpClient(options).getAccountFees());
      }
      expect(conversion).not.toHaveBeenCalled();
    } finally {
      conversion.mockRestore();
    }
  });

  it("counts actual native chunk bytes even when its byteLength property is shadowed", async () => {
    const chunk = new TextEncoder().encode("{}");
    let accesses = 0;
    Object.defineProperty(chunk, "byteLength", {
      get: () => (accesses++ === 0 ? 0 : 2),
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const { options } = fixture(
      new Response(body, {
        headers: { "content-type": "application/json" },
      }),
    );
    options.maxResponseBytes = 1;
    await rejected(createAsaasHttpClient(options).getAccountFees());
    expect(body.locked).toBe(false);
  });

  it("keeps the original maximum cents and basis-point representation exact", async () => {
    const { options } = fees(
      '{"payment":{"creditCard":{"operationValue":21474836.47,"oneInstallmentPercentage":99.99}}}',
    );
    expect(
      (await createAsaasHttpClient(options).getAccountFees()).fees,
    ).toEqual({
      payment: {
        creditCard: {
          operationValue: "21474836.47",
          oneInstallmentPercentage: "99.99",
        },
      },
    });
  });

  it.each([
    '{"transfer":{"monthlyTransfersWithoutFee":1.1}}',
    '{"transfer":{"monthlyTransfersWithoutFee":2147483648}}',
    '{"transfer":{"ted":{"consideredInMonthlyTransfersWithoutFee":"false"}}}',
    '{"payment":{"pix":{"discountExpiration":1}}}',
    '{"payment":[]}',
  ])("refuses a malformed selected fee condition %s", async (text) => {
    const { options } = fees(text);
    await rejected(createAsaasHttpClient(options).getAccountFees());
  });

  it("rejects late fee parsing before a starved timer callback and preserves natural EOF", async () => {
    const { options } = fees('{"payment":{"pix":{"fixedFeeValue":0}}}');
    let elapsed = 0;
    const monotonic = vi
      .spyOn(performance, "now")
      .mockImplementation(() => elapsed);
    const parse = JSON.parse;
    const parser = vi
      .spyOn(JSON, "parse")
      .mockImplementation((text, reviver) => {
        if (text !== "0") elapsed = options.timeoutMs;
        return parse(text, reviver);
      });
    try {
      await rejected(createAsaasHttpClient(options).getAccountFees());
    } finally {
      parser.mockRestore();
      monotonic.mockRestore();
    }
  });

  it("uses captured native reader cancellation rather than a decorated replacement", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const cancel = vi.fn(
      () =>
        new Promise<void>((done) => {
          release = done;
        }),
    );
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { options } = fixture(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );
    const forged = vi
      .spyOn(ReadableStreamDefaultReader.prototype, "cancel")
      .mockImplementation(async () => {});
    let settled = false;
    const action = createAsaasHttpClient(options)
      .getAccountFees()
      .catch((error) => error)
      .finally(() => {
        settled = true;
      });
    try {
      await vi.advanceTimersByTimeAsync(100);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(forged).not.toHaveBeenCalled();
      expect(settled).toBe(false);
    } finally {
      release();
      await action;
      forged.mockRestore();
    }
    await rejected(Promise.reject(await action));
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("native Asaas Pix transfer transport", () => {
  const transfer = () => ({
    id: "transfer-1",
    status: "DONE",
    type: "PIX",
    operationType: "PIX",
    value: 95,
    netValue: 95,
    transferFee: 0,
    externalReference: "operation-1",
    transactionReceiptUrl: "https://sandbox.asaas.com/receipt/1",
    endToEndIdentifier: "E123",
    effectiveDate: "2026-10-12",
  });
  it.each(["get", "list"] as const)(
    "preserves a completed native datetime exactly through %s",
    async (method) => {
      const effectiveDate = "2026-10-20 21:22:33";
      const native = { ...transfer(), effectiveDate };
      const f = fixture(
        json(
          method === "get"
            ? native
            : { hasMore: false, totalCount: 1, offset: 0, data: [native] },
        ),
      );
      const client = createAsaasHttpClient(f.options);
      const observed =
        method === "get"
          ? (await client.getTransfer("transfer-1")).transfer
          : (await client.listTransfers(0)).transfers[0];
      expect(observed).toEqual({
        ...native,
        value: "95.00",
        netValue: "95.00",
        transferFee: "0.00",
      });
      expect(f.fetch).toHaveBeenCalledOnce();
      expect(f.fetch.mock.calls[0][1]?.method).toBe("GET");
    },
  );
  it.each([
    "2026-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-10-00",
    "2026-02-29 21:22:33",
    "2026-10-20 24:00:00",
    "2026-10-20 21:60:00",
    "2026-10-20 21:22:60",
    "2026-10-20 21:22",
    "2026-10-20T21:22:33Z",
    "2026-10-20 21:22:33.000",
    "2026-10-20 21:22:33Z",
    "2026-10-20 21:22:33 garbage",
    "2026-10-20\n21:22:33",
    "2026-10-20 21:22:33\n",
    " 2026-10-20",
    "",
    1792531353,
  ])("rejects an invalid native effective date %j", async (effectiveDate) => {
    const f = fixture(json({ ...transfer(), effectiveDate }));
    await rejected(createAsaasHttpClient(f.options).getTransfer("transfer-1"));
  });
  it("preserves a leap-day date without adding a time or zone", async () => {
    const f = fixture(json({ ...transfer(), effectiveDate: "2024-02-29" }));
    expect(
      (await createAsaasHttpClient(f.options).getTransfer("transfer-1"))
        .transfer.effectiveDate,
    ).toBe("2024-02-29");
  });
  it.each(["externalReference", "transactionReceiptUrl", "endToEndIdentifier"])(
    "still rejects spaces in optional transfer field %s",
    async (field) => {
      const f = fixture(json({ ...transfer(), [field]: "invalid value" }));
      await rejected(
        createAsaasHttpClient(f.options).getTransfer("transfer-1"),
      );
    },
  );
  it("sends only native Pix fields, with the exact transferred amount", async () => {
    const f = fixture(json(transfer()));
    const result = await createAsaasHttpClient(f.options).createPixTransfer({
      valueCents: 9500,
      pixAddressKey: "cliente-a00001@pix.bcb.gov.br",
      pixAddressKeyType: "EMAIL",
      externalReference: "operation-1",
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/transfers",
    );
    const request = f.fetch.mock.calls[0][1] ?? {};
    expect(request.method).toBe("POST");
    expect(JSON.parse(String(request.body))).toEqual({
      value: 95,
      operationType: "PIX",
      pixAddressKey: "cliente-a00001@pix.bcb.gov.br",
      pixAddressKeyType: "EMAIL",
      externalReference: "operation-1",
    });
    expect(result.transfer).toMatchObject({
      value: "95.00",
      netValue: "95.00",
      transferFee: "0.00",
      status: "DONE",
    });
    expect(result).toMatchObject({
      source: "provider",
      siteId: "site-1",
      accountBindingId: "account-1",
      environment: "sandbox",
    });
  });
  it("reads by ID and verifies the response ID", async () => {
    const f = fixture(json(transfer()));
    await createAsaasHttpClient(f.options).getTransfer("transfer-1");
    expect(f.fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/transfers/transfer-1",
    );
    const wrong = fixture(json(transfer()));
    await rejected(createAsaasHttpClient(wrong.options).getTransfer("another"));
  });
  it("lists bounded native pages without an unsupported externalReference filter", async () => {
    const f = fixture(
      json({
        hasMore: true,
        totalCount: 101,
        limit: 100,
        offset: 0,
        data: [transfer()],
      }),
    );
    const result = await createAsaasHttpClient(f.options).listTransfers(0);
    expect(result.hasMore).toBe(true);
    expect(result.transfers).toHaveLength(1);
    expect(f.fetch.mock.calls[0][0]).toBe(
      "https://api-sandbox.asaas.com/v3/transfers?limit=100&offset=0",
    );
  });
  it("rejects precision loss in native financial fields", async () => {
    const f = fixture(
      new Response(
        JSON.stringify(transfer()).replace(
          '"value":95',
          '"value":95.000000000000001',
        ),
        { headers: { "content-type": "application/json" } },
      ),
    );
    await rejected(createAsaasHttpClient(f.options).getTransfer("transfer-1"));
  });
  it("never retries a lost POST response", async () => {
    const f = fixture();
    f.fetch.mockRejectedValue(new Error("lost response"));
    await rejected(
      createAsaasHttpClient(f.options).createPixTransfer({
        valueCents: 9500,
        pixAddressKey: "cliente-a00001@pix.bcb.gov.br",
        pixAddressKeyType: "EMAIL",
        externalReference: "operation-1",
      }),
    );
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
  it.each([-1, 1, 1001, Number.NaN])(
    "rejects invalid pagination offset %s before fetch",
    async (offset) => {
      const f = fixture();
      await rejected(createAsaasHttpClient(f.options).listTransfers(offset));
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("Sandbox-only native transfer dispatch", () => {
  it("rejects a live POST even with valid live-scoped credentials", async () => {
    const f = fixture();
    f.options.mode = "live";
    f.options.binding.environment = "live";
    f.options.credentials.context.environment = "live";
    f.options.credentials.accessToken = "$aact_prod_offline-test-token";
    await rejected(
      createAsaasHttpClient(f.options).createPixTransfer({
        valueCents: 100,
        pixAddressKey: "sandbox@example.test",
        pixAddressKeyType: "EMAIL",
        externalReference: "operation-1",
      }),
    );
    expect(f.fetch).not.toHaveBeenCalled();
  });
});
