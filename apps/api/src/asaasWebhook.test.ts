import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAsaasWebhookReceiver } from "./asaasWebhook";

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
