import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

import {
  createPagarmeWebhookReceiver,
  PagarmeWebhookError,
  type PagarmeWebhookRepository,
  parsePagarmeWebhookEvent,
  verifyPagarmeWebhookAuthorization,
} from "./pagarmeWebhook";

const user = "entrelacos-webhook";
const password = "p".repeat(40);
const credentialsHash = createHash("sha256")
  .update(`${user}:${password}`)
  .digest("hex");
const basic = (u: string, p: string) =>
  `Basic ${Buffer.from(`${u}:${p}`).toString("base64")}`;

function fixture(name: string): string {
  return readFileSync(
    new URL(`./__fixtures__/pagarme/${name}.json`, import.meta.url),
    "utf8",
  );
}

function receiver(
  append = vi.fn<PagarmeWebhookRepository["append"]>(async () => "INSERTED"),
) {
  const inserted = vi.fn();
  return {
    append,
    inserted,
    receiver: createPagarmeWebhookReceiver({
      webhookCredentialsHash: credentialsHash,
      repository: { append },
      now: () => new Date("2026-11-18T12:03:02.000Z"),
      onInserted: inserted,
    }),
  };
}

describe("Pagar.me webhook authorization", () => {
  it("accepts only the configured Basic credentials", () => {
    expect(
      verifyPagarmeWebhookAuthorization(basic(user, password), credentialsHash),
    ).toBe(true);
    for (const header of [
      undefined,
      "",
      "Bearer token",
      basic(user, `${password}x`),
      basic("other", password),
      basic(user, ""),
      `Basic ${"!".repeat(10)}`,
      `basic ${Buffer.from(`${user}:${password}`).toString("base64")}x`,
    ])
      expect(verifyPagarmeWebhookAuthorization(header, credentialsHash)).toBe(
        false,
      );
  });

  it("compares digests with timingSafeEqual (constant time)", async () => {
    const spy = vi.mocked(timingSafeEqual);
    spy.mockClear();
    verifyPagarmeWebhookAuthorization(basic(user, "wrong"), credentialsHash);
    verifyPagarmeWebhookAuthorization(undefined, credentialsHash);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("Pagar.me webhook events", () => {
  it("normalizes an order event into its correlation references", () => {
    expect(parsePagarmeWebhookEvent(fixture("webhook-order-paid"))).toEqual({
      eventId: "hook_fixtureHook0001",
      providerType: "order.paid",
      eventType: "ORDER_PAID",
      orderId: "or_fixtureOrder0001",
      orderCode: "checkout-fixture-1",
      chargeId: "ch_fixtureCharge001",
      recipientId: null,
    });
  });

  it("reads charge refunds and both chargeback spellings", () => {
    expect(
      parsePagarmeWebhookEvent(fixture("webhook-charge-refunded")),
    ).toMatchObject({
      eventType: "CHARGE_REFUNDED",
      orderId: "or_fixtureOrder0002",
      chargeId: "ch_fixtureCharge002",
    });
    const chargedback = fixture("webhook-charge-chargedback");
    expect(parsePagarmeWebhookEvent(chargedback)).toMatchObject({
      providerType: "charge.chargedback",
      eventType: "CHARGE_CHARGEDBACK",
    });
    expect(
      parsePagarmeWebhookEvent(
        chargedback.replace('"charge.chargedback"', '"charge.chargeback"'),
      ),
    ).toMatchObject({
      providerType: "charge.chargeback",
      eventType: "CHARGE_CHARGEDBACK",
    });
  });

  it("reads chargeback.received (dispute shape, no order reference)", () => {
    expect(
      parsePagarmeWebhookEvent(fixture("webhook-chargeback-received")),
    ).toEqual({
      eventId: "hook_fixtureHook0005",
      providerType: "chargeback.received",
      eventType: "CHARGE_CHARGEDBACK",
      orderId: null,
      orderCode: null,
      chargeId: "ch_fixtureCharge002",
      recipientId: null,
    });
    for (const data of [
      { charge_id: "ch_fixtureCharge002", order_id: "or_fixtureOrder0002" },
      {
        charge: {
          id: "ch_fixtureCharge002",
          order: { id: "or_fixtureOrder0002" },
        },
      },
      { id: "ch_fixtureCharge002", order: { id: "or_fixtureOrder0002" } },
    ])
      expect(
        parsePagarmeWebhookEvent(
          JSON.stringify({ id: "hook_cb1", type: "chargeback.received", data }),
        ),
      ).toMatchObject({
        eventType: "CHARGE_CHARGEDBACK",
        chargeId: "ch_fixtureCharge002",
        orderId: "or_fixtureOrder0002",
      });
    expect(() =>
      parsePagarmeWebhookEvent(
        JSON.stringify({
          id: "hook_cb2",
          type: "chargeback.received",
          data: { disputeId: "1" },
        }),
      ),
    ).toThrow(PagarmeWebhookError);
  });

  it("reads partial cancellations as refund events (re-read decides)", () => {
    expect(
      parsePagarmeWebhookEvent(
        fixture("webhook-charge-refunded").replace(
          '"charge.refunded"',
          '"charge.partial_canceled"',
        ),
      ),
    ).toMatchObject({ eventType: "CHARGE_REFUNDED" });
  });

  it("reads recipient updates", () => {
    expect(
      parsePagarmeWebhookEvent(fixture("webhook-recipient-updated")),
    ).toMatchObject({
      eventType: "RECIPIENT_UPDATED",
      recipientId: "rp_fixtureRecipient01",
      orderId: null,
    });
  });

  it("reads recipient updates for re_ and pp_ recipient ids", () => {
    for (const id of ["re_fixtureRecipient01", "pp_fixtureProfile01"])
      expect(
        parsePagarmeWebhookEvent(
          fixture("webhook-recipient-updated").replace(
            '"rp_fixtureRecipient01"',
            JSON.stringify(id),
          ),
        ),
      ).toMatchObject({ eventType: "RECIPIENT_UPDATED", recipientId: id });
  });

  it("ignores event types we do not handle", () => {
    expect(
      parsePagarmeWebhookEvent(
        JSON.stringify({ id: "hook_x1", type: "order.created", data: {} }),
      ),
    ).toBeNull();
  });

  it("rejects malformed bodies", () => {
    for (const body of [
      "not json",
      "[]",
      JSON.stringify({ type: "order.paid", data: {} }),
      JSON.stringify({ id: "hook_1", type: "order.paid", data: { id: "x" } }),
      JSON.stringify({ id: "hook 1", type: "order.paid", data: {} }),
    ])
      expect(() => parsePagarmeWebhookEvent(body)).toThrow(PagarmeWebhookError);
  });
});

describe("Pagar.me webhook receiver", () => {
  it("returns 401 without auth or with a wrong password and stores nothing", async () => {
    const { receiver: hook, append } = receiver();
    for (const header of [undefined, basic(user, "wrong-password")]) {
      const error = await hook
        .receive(header, fixture("webhook-order-paid"))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PagarmeWebhookError);
      expect((error as PagarmeWebhookError).status).toBe(401);
    }
    expect(append).not.toHaveBeenCalled();
  });

  it("appends an authenticated event once and wakes the worker", async () => {
    const { receiver: hook, append, inserted } = receiver();
    await expect(
      hook.receive(basic(user, password), fixture("webhook-order-paid")),
    ).resolves.toEqual({ accepted: true });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].eventId).toBe("hook_fixtureHook0001");
    expect(inserted).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a duplicate delivery with 200 without waking the worker", async () => {
    const { receiver: hook, inserted } = receiver(
      vi.fn<PagarmeWebhookRepository["append"]>(async () => "DUPLICATE"),
    );
    await expect(
      hook.receive(basic(user, password), fixture("webhook-order-paid")),
    ).resolves.toEqual({ accepted: true });
    expect(inserted).not.toHaveBeenCalled();
  });

  it("acknowledges ignored and unroutable events", async () => {
    const { receiver: hook, append } = receiver(
      vi.fn<PagarmeWebhookRepository["append"]>(async () => "UNROUTABLE"),
    );
    await expect(
      hook.receive(
        basic(user, password),
        JSON.stringify({ id: "hook_x1", type: "order.created", data: {} }),
      ),
    ).resolves.toEqual({ accepted: true });
    expect(append).not.toHaveBeenCalled();
    await expect(
      hook.receive(basic(user, password), fixture("webhook-order-paid")),
    ).resolves.toEqual({ accepted: true });
  });

  it("reports storage failures as 503 so Pagar.me retries", async () => {
    const { receiver: hook } = receiver(
      vi.fn<PagarmeWebhookRepository["append"]>(async () => {
        throw new Error("db down");
      }),
    );
    const error = await hook
      .receive(basic(user, password), fixture("webhook-order-paid"))
      .catch((caught: unknown) => caught);
    expect((error as PagarmeWebhookError).status).toBe(503);
  });
});
