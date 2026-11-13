import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAsaasWebhookReceiver, hashAsaasEventIdentity } from "./asaasWebhook";

const token = "a-realistic-local-test-token-of-48-characters-only";
const tokenHash = createHash("sha256").update(token).digest("hex");
const event = {
  id: "evt_reference&12345",
  event: "PAYMENT_RECEIVED",
  account: { id: "provider-account" },
  payment: {
    id: "pay_one",
    externalReference: "attempt-one",
    value: 103.5,
    creditCard: { creditCardToken: "never-store-card-token" },
    customer: "never-store-payer",
  },
  futureField: { secret: "never-store-unknown" },
};

function fixture() {
  const binding = {
    siteId: "site-one",
    accountId: "account-one",
    provider: "ASAAS" as const,
    providerAccountReference: "provider-account",
    environment: "sandbox" as const,
    webhookTokenHash: tokenHash,
    isDemo: false,
  };
  const append = vi.fn().mockResolvedValue("INSERTED");
  const dependencies = {
    mode: "sandbox" as "disabled" | "sandbox" | "live",
    applicationEnvironment: "test" as "test" | "production" | "development",
    resolveBinding: vi.fn().mockResolvedValue(binding),
    repository: { append },
    now: () => new Date("2026-10-12T12:00:00.000Z"),
    generateId: () => "inbox-one",
  };
  return {
    binding,
    dependencies,
    append,
    receiver: createAsaasWebhookReceiver(dependencies),
  };
}

it.each([undefined, "foreign-site", "site-one"])(
  "admits a live showcase webhook only for the designated site (%s)",
  async (liveDemoSiteId) => {
    const v = fixture();
    Object.assign(v.binding, { environment: "live", isDemo: true });
    const receiver = createAsaasWebhookReceiver({
      ...v.dependencies,
      mode: "live",
      applicationEnvironment: "production",
      liveDemoSiteId,
    });
    if (liveDemoSiteId === "site-one") {
      await expect(
        receiver.receive(token, JSON.stringify(event)),
      ).resolves.toEqual({ accepted: true });
      expect(v.append).toHaveBeenCalledWith(
        expect.objectContaining({ siteId: "site-one", environment: "live" }),
      );
    } else {
      await expect(
        receiver.receive(token, JSON.stringify(event)),
      ).rejects.toMatchObject({ code: "WEBHOOK_AUTH_DENIED" });
      expect(v.append).not.toHaveBeenCalled();
    }
  },
);
describe("Asaas webhook durable acceptance", () => {
  it.each([
    "PAYMENT_REFUNDED",
    "PAYMENT_PARTIALLY_REFUNDED",
    "PAYMENT_REFUND_IN_PROGRESS",
    "PAYMENT_CHARGEBACK_REQUESTED",
    "PAYMENT_CHARGEBACK_DISPUTE",
    "PAYMENT_AWAITING_CHARGEBACK_REVERSAL",
  ])(
    "retains only authenticated correlation references for %s",
    async (eventType) => {
      const values = fixture();
      await values.receiver.receive(
        token,
        JSON.stringify({
          ...event,
          event: eventType,
          payment: {
            ...event.payment,
            refunds: [
              { id: "refund_one", value: 10, privateData: "never-store" },
            ],
            chargeback: { privateData: "never-store" },
          },
        }),
      );
      expect(values.append).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType,
          accountId: "account-one",
          payload: { paymentId: "pay_one", externalReference: "attempt-one" },
        }),
      );
      expect(JSON.stringify(values.append.mock.calls)).not.toContain(
        "never-store",
      );
    },
  );
  it("accepts the documented payment event without an undocumented account field and uses its unique token binding", async () => {
    const values = fixture();
    const { account: _account, ...documentedEvent } = event;
    await expect(
      values.receiver.receive(token, JSON.stringify(documentedEvent)),
    ).resolves.toEqual({ accepted: true });
    expect(values.append).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: values.binding.siteId,
        accountId: values.binding.accountId,
        providerAccountReference: values.binding.providerAccountReference,
      }),
    );
  });

  it.each([null, "provider-account", {}, { id: "other-account" }])(
    "rejects a malformed or contradictory optional account field: %j",
    async (account) => {
      const values = fixture();
      await expect(
        values.receiver.receive(token, JSON.stringify({ ...event, account })),
      ).rejects.toMatchObject({ code: "WEBHOOK_INVALID" });
      expect(values.append).not.toHaveBeenCalled();
    },
  );

  it("deduplicates equivalent normalized references regardless of source object placement", async () => {
    const values = fixture();
    let savedHash: string | undefined;
    values.append.mockImplementation(async (record) => {
      if (!savedHash) {
        savedHash = record.payloadHash;
        return "INSERTED";
      }
      return savedHash === record.payloadHash ? "DUPLICATE" : "COLLISION";
    });
    await values.receiver.receive(
      token,
      JSON.stringify({ ...event, checkout: { id: "checkout-one" } }),
    );
    await expect(
      values.receiver.receive(
        token,
        JSON.stringify({
          ...event,
          payment: { id: "pay_one" },
          checkout: { id: "checkout-one", externalReference: "attempt-one" },
        }),
      ),
    ).resolves.toEqual({ accepted: true });
    expect(values.append).toHaveBeenCalledTimes(2);
  });
  it("derives account/site/environment from the authenticated binding and stores only safe correlation references", async () => {
    const values = fixture();
    await expect(
      values.receiver.receive(
        token,
        JSON.stringify({ ...event, siteId: "evil-site", environment: "live" }),
      ),
    ).resolves.toEqual({ accepted: true });
    expect(values.dependencies.resolveBinding).toHaveBeenCalledWith(tokenHash);
    expect(values.append).toHaveBeenCalledOnce();
    const record = values.append.mock.calls[0][0];
    expect(record).toMatchObject({
      id: "inbox-one",
      siteId: "site-one",
      accountId: "account-one",
      environment: "sandbox",
      provider: "ASAAS",
      providerEventId: event.id,
      eventType: event.event,
      providerAccountReference: "provider-account",
      receivedAt: "2026-10-12T12:00:00.000Z",
      payload: { paymentId: "pay_one", externalReference: "attempt-one" },
    });
    expect(JSON.stringify(record)).not.toMatch(
      /never-store|webhookToken|103\.5|evil-site/,
    );
    expect(record.payloadHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("waits for durable persistence before acknowledging and accepts verified duplicate delivery", async () => {
    const values = fixture();
    let save!: (value: string) => void;
    values.append.mockReturnValue(
      new Promise((resolve) => {
        save = resolve;
      }),
    );
    let acknowledged = false;
    const pending = values.receiver
      .receive(token, JSON.stringify(event))
      .then(() => {
        acknowledged = true;
      });
    await vi.waitFor(() => expect(values.append).toHaveBeenCalledOnce());
    expect(acknowledged).toBe(false);
    save("DUPLICATE");
    await pending;
    expect(acknowledged).toBe(true);
  });

  it.each(["COLLISION", "unknown", null])(
    "refuses unproven persistence result %s",
    async (result) => {
      const values = fixture();
      values.append.mockResolvedValue(result);
      await expect(
        values.receiver.receive(token, JSON.stringify(event)),
      ).rejects.toMatchObject({ code: "WEBHOOK_UNAVAILABLE", status: 503 });
    },
  );

  it("sanitizes storage failure and never reports acceptance", async () => {
    const values = fixture();
    values.append.mockRejectedValue(new Error("private-database-credential"));
    await expect(
      values.receiver.receive(token, JSON.stringify(event)),
    ).rejects.toMatchObject({
      code: "WEBHOOK_UNAVAILABLE",
      message: "Webhook unavailable",
    });
  });

  it.each([null, "short", `${token}\n`, "a".repeat(256)])(
    "rejects malformed header before lookup %s",
    async (header) => {
      const values = fixture();
      await expect(
        values.receiver.receive(header, JSON.stringify(event)),
      ).rejects.toMatchObject({ code: "WEBHOOK_AUTH_DENIED", status: 401 });
      expect(values.dependencies.resolveBinding).not.toHaveBeenCalled();
      expect(values.append).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    { environment: "live" },
    { webhookTokenHash: "0".repeat(64) },
    { provider: "OTHER" },
  ])(
    "rejects missing or mismatched authoritative account binding %j",
    async (change) => {
      const values = fixture();
      values.dependencies.resolveBinding.mockResolvedValue(
        change === null ? null : { ...values.binding, ...change },
      );
      await expect(
        values.receiver.receive(token, JSON.stringify(event)),
      ).rejects.toMatchObject({ code: "WEBHOOK_AUTH_DENIED" });
      expect(values.append).not.toHaveBeenCalled();
    },
  );

  it.each([
    "not-json",
    "[]",
    "null",
    JSON.stringify({ ...event, account: { id: "foreign" } }),
    JSON.stringify({ ...event, id: "" }),
    " ".repeat(65537),
    JSON.stringify({ ...event, id: "event\nsecret" }),
  ])("rejects invalid or unbound bounded payload", async (body) => {
    const values = fixture();
    await expect(values.receiver.receive(token, body)).rejects.toMatchObject({
      code: "WEBHOOK_INVALID",
      status: 400,
    });
    expect(values.append).not.toHaveBeenCalled();
  });

  it("retains unknown event types for later reconciliation without accepting unknown secret fields", async () => {
    const values = fixture();
    await values.receiver.receive(
      token,
      JSON.stringify({
        ...event,
        event: "PAYMENT_FUTURE_EVENT",
        newField: "private",
      }),
    );
    expect(values.append.mock.calls[0][0].eventType).toBe(
      "PAYMENT_FUTURE_EVENT",
    );
    expect(JSON.stringify(values.append.mock.calls[0][0])).not.toContain(
      "newField",
    );
  });

  it("defaults to disabled and denies forbidden production/sandbox mode combinations", async () => {
    for (const combination of [
      { mode: "disabled" as const },
      {
        mode: "sandbox" as const,
        applicationEnvironment: "production" as const,
      },
    ]) {
      const values = fixture();
      const receiver = createAsaasWebhookReceiver({
        ...values.dependencies,
        ...combination,
      });
      await expect(
        receiver.receive(token, JSON.stringify(event)),
      ).rejects.toMatchObject({ code: "WEBHOOK_UNAVAILABLE" });
      expect(values.append).not.toHaveBeenCalled();
    }
  });
});

it("keeps just the payment, attempt and plan identifiers for a direct installment deletion", async () => {
  const f = fixture();
  await f.receiver.receive(
    token,
    JSON.stringify({
      ...event,
      event: "PAYMENT_DELETED",
      payment: {
        ...event.payment,
        installment: "plan_one",
        installmentNumber: 2,
        deleted: true,
      },
    }),
  );
  expect(f.append).toHaveBeenCalledWith(
    expect.objectContaining({
      eventType: "PAYMENT_DELETED",
      payload: {
        paymentId: "pay_one",
        externalReference: "attempt-one",
        installmentId: "plan_one",
      },
    }),
  );
});

describe("Asaas platform-account (V2) webhook binding", () => {
  const platformToken = "platform-account-webhook-token-of-48-characters!";
  const platformTokenHash = createHash("sha256")
    .update(platformToken)
    .digest("hex");
  const route = {
    siteId: "site-v2",
    accountId: "account-v2",
    providerAccountReference: "couple-subaccount",
    environment: "sandbox" as const,
    attemptId: "attempt-v2",
    isDemo: false,
  };
  const splitDone = {
    id: "evt_platform_split_done",
    event: "PAYMENT_SPLIT_DONE",
    account: { id: "platform-account" },
    payment: {
      id: "pay_v2",
      installment: "plan_v2",
      externalReference: "attempt-v2",
      creditCard: { creditCardToken: "never-store-card-token" },
    },
  };

  function platformFixture(found: typeof route | null = route) {
    const v = fixture();
    const platform = {
      webhookTokenHash: platformTokenHash,
      accountReference: "platform-account",
      route: vi.fn().mockResolvedValue(found),
      recordUnroutable: vi.fn().mockResolvedValue(undefined),
    };
    return {
      ...v,
      platform,
      receiver: createAsaasWebhookReceiver({ ...v.dependencies, platform }),
    };
  }

  it("routes a platform notification into the couple scope with the couple hash", async () => {
    const v = platformFixture();
    await expect(
      v.receiver.receive(platformToken, JSON.stringify(splitDone)),
    ).resolves.toEqual({ accepted: true });
    expect(v.dependencies.resolveBinding).not.toHaveBeenCalled();
    expect(v.platform.route).toHaveBeenCalledWith({
      externalReference: "attempt-v2",
      paymentId: "pay_v2",
      providerReferences: ["plan_v2"],
    });
    const payload = { paymentId: "pay_v2", externalReference: "attempt-v2" };
    expect(v.append).toHaveBeenCalledWith({
      id: "inbox-one",
      siteId: "site-v2",
      accountId: "account-v2",
      provider: "ASAAS",
      environment: "sandbox",
      providerAccountReference: "couple-subaccount",
      providerEventId: "evt_platform_split_done",
      eventType: "PAYMENT_SPLIT_DONE",
      payload,
      payloadHash: hashAsaasEventIdentity(
        "evt_platform_split_done",
        "PAYMENT_SPLIT_DONE",
        "couple-subaccount",
        payload,
      ),
      receivedAt: "2026-10-12T12:00:00.000Z",
    });
    expect(JSON.stringify(v.append.mock.calls)).not.toContain(
      "never-store-card-token",
    );
    expect(v.platform.recordUnroutable).not.toHaveBeenCalled();
  });

  it.each([
    { id: "other-account" },
    undefined,
  ])("rejects the platform token for a foreign or missing account (%#)", async (account) => {
    const v = platformFixture();
    await expect(
      v.receiver.receive(
        platformToken,
        JSON.stringify({ ...splitDone, account }),
      ),
    ).rejects.toMatchObject({ status: 400, code: "WEBHOOK_INVALID" });
    expect(v.platform.route).not.toHaveBeenCalled();
    expect(v.append).not.toHaveBeenCalled();
  });

  it("keeps the subaccount (V1) flow for every other token", async () => {
    const v = platformFixture();
    await expect(
      v.receiver.receive(token, JSON.stringify(event)),
    ).resolves.toEqual({ accepted: true });
    expect(v.dependencies.resolveBinding).toHaveBeenCalledWith(tokenHash);
    expect(v.platform.route).not.toHaveBeenCalled();
    expect(v.append).toHaveBeenCalledWith(
      expect.objectContaining({
        siteId: "site-one",
        providerAccountReference: "provider-account",
        payload: { paymentId: "pay_one", externalReference: "attempt-one" },
      }),
    );
    v.dependencies.resolveBinding.mockResolvedValue(null);
    await expect(
      v.receiver.receive(
        "another-unknown-token-of-at-least-32-chars",
        JSON.stringify(splitDone),
      ),
    ).rejects.toMatchObject({ code: "WEBHOOK_AUTH_DENIED" });
  });

  it("answers 200 and alerts without enqueueing an unroutable event", async () => {
    const v = platformFixture(null);
    await expect(
      v.receiver.receive(platformToken, JSON.stringify(splitDone)),
    ).resolves.toEqual({ accepted: true });
    expect(v.append).not.toHaveBeenCalled();
    expect(v.platform.recordUnroutable).toHaveBeenCalledWith({
      environment: "sandbox",
      providerEventId: "evt_platform_split_done",
      eventType: "PAYMENT_SPLIT_DONE",
      paymentReference: "pay_v2",
    });
  });

  it("treats a route that contradicts the external reference as unroutable", async () => {
    const v = platformFixture({ ...route, attemptId: "attempt-other" });
    await expect(
      v.receiver.receive(platformToken, JSON.stringify(splitDone)),
    ).resolves.toEqual({ accepted: true });
    expect(v.append).not.toHaveBeenCalled();
    expect(v.platform.recordUnroutable).toHaveBeenCalledOnce();
  });

  it("routes an anticipation notification by its payment", async () => {
    const v = platformFixture();
    await v.receiver.receive(
      platformToken,
      JSON.stringify({
        id: "evt_anticipation",
        event: "RECEIVABLE_ANTICIPATION_DENIED",
        account: { id: "platform-account" },
        anticipation: {
          id: "ant_one",
          payment: "pay_v2",
          installment: null,
          status: "DENIED",
        },
      }),
    );
    expect(v.platform.route).toHaveBeenCalledWith({
      paymentId: "pay_v2",
      providerReferences: [],
    });
    expect(v.append).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "RECEIVABLE_ANTICIPATION_DENIED",
        payload: { paymentId: "pay_v2", externalReference: "attempt-v2" },
      }),
    );
  });
});
