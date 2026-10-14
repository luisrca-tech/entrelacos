import { describe, expect, it, vi } from "vitest";
import type { AuthHttpOptions } from "./authHttp";
import { createGiftPaymentsHttpRouter } from "./giftPaymentsHttp";

const origin = "https://wedding.example.test";
const recovery = {
  quoteId: "quote-one",
  requestId: "request-one",
  recoveryToken: "A".repeat(43),
};
const quote = {
  id: "quote-one",
  giftId: "gift-one",
  siteId: "site-one",
  title: "Symbolic gift",
  method: "PIX",
  currency: "BRL",
  nominalCents: 10000,
  commissionBasisPoints: 200,
  commissionCents: 200,
  processingCents: 0,
  totalCents: 10200,
  policyVersion: "policy-one",
  expiresAt: "2026-10-12T12:05:00.000Z",
  mode: "sandbox",
};
const checkout = {
  orderId: "order-one",
  attemptId: "attempt-one",
  quoteId: "quote-one",
  method: "PIX",
  hostedUrl: "https://checkout.example.test/one",
  mode: "sandbox",
};
const status = {
  siteId: "site-one",
  quoteId: "quote-one",
  requestId: "request-one",
  orderId: "order-one",
  attemptId: "attempt-one",
  method: "PIX",
  mode: "sandbox",
  state: "OUTCOME_UNKNOWN",
  observedAt: null,
  closedReason: null,
  mayStartNewAttempt: false,
  checkout: null,
};

function fixture() {
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        where: () => ({ limit: async () => [{ id: "origin-one" }] }),
      }),
    })),
  };
  const options = {
    db,
    auth: { api: { getSession: vi.fn() } },
    adminOrigin: "https://panel.example.test",
  } as unknown as AuthHttpOptions;
  const giftPayments = {
    createQuote: vi.fn().mockResolvedValue(quote),
    createCheckout: vi.fn().mockResolvedValue(checkout),
    getStatus: vi.fn().mockResolvedValue(status),
  };
  const router = createGiftPaymentsHttpRouter({ ...options, giftPayments });
  function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return router.request(`/v1/public/sites/site-one/${path}`, {
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }
  return { options, db, giftPayments, router, post };
}

describe("public gift payment transport", () => {
  it("validates a stored registered origin and dispatches only strict server inputs without guest session", async () => {
    const values = fixture();
    const response = await values.post("gift-quotes", {
      giftId: "gift-one",
      method: "PIX",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ quote });
    expect(values.giftPayments.createQuote).toHaveBeenCalledWith("site-one", {
      giftId: "gift-one",
      method: "PIX",
    });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(values.options.auth.api.getSession).not.toHaveBeenCalled();
  });

  it("posts the recovery capability only in the body and returns sanitized same-identity checkout/status", async () => {
    const values = fixture();
    expect(
      await (await values.post("gift-checkouts", recovery)).json(),
    ).toEqual({ checkout });
    expect(
      await (await values.post("gift-checkouts/status", recovery)).json(),
    ).toEqual({ status });
    expect(values.giftPayments.getStatus).toHaveBeenCalledWith(
      "site-one",
      recovery,
    );
  });

  it("keeps all routes unavailable without durable/provider services rather than reporting fake state", async () => {
    const values = fixture();
    const router = createGiftPaymentsHttpRouter(values.options);
    for (const path of [
      "gift-quotes",
      "gift-checkouts",
      "gift-checkouts/status",
    ]) {
      const response = await router.request(
        `/v1/public/sites/site-one/${path}`,
        {
          method: "POST",
          headers: { Origin: origin, "Content-Type": "application/json" },
          body: JSON.stringify(
            path === "gift-quotes"
              ? { giftId: "gift-one", method: "PIX" }
              : recovery,
          ),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "PROVIDER_MODE_UNAVAILABLE",
      });
    }
  });

  it.each(["gift-quotes", "gift-checkouts", "gift-checkouts/status"])(
    "handles body-only POST CORS preflight for %s",
    async (path) => {
      const values = fixture();
      const response = await values.router.request(
        `/v1/public/sites/site-one/${path}`,
        { method: "OPTIONS", headers: { Origin: origin } },
      );
      expect(response.status).toBe(204);
      expect(response.headers.get("Access-Control-Allow-Methods")).toBe("POST");
      expect(response.headers.get("Access-Control-Allow-Headers")).toBe(
        "Content-Type",
      );
      expect(values.giftPayments.getStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects missing/unregistered origins and does not reflect foreign origins", async () => {
    const values = fixture();
    const missing = await values.router.request(
      "/v1/public/sites/site-one/gift-checkouts/status",
      { method: "POST" },
    );
    expect(missing.status).toBe(403);
    values.db.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }));
    const foreign = await values.post("gift-checkouts/status", recovery, {
      Origin: "https://evil.example.test",
    });
    expect(foreign.status).toBe(403);
    expect(foreign.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(values.giftPayments.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    { ...recovery, recoveryToken: undefined },
    { ...recovery, walletId: "private" },
    { ...recovery, received: true },
  ])("rejects invalid recovery body without calling service", async (body) => {
    const values = fixture();
    const response = await values.post("gift-checkouts/status", body);
    expect(response.status).toBe(400);
    expect(values.giftPayments.getStatus).not.toHaveBeenCalled();
    expect(JSON.stringify(await response.json())).not.toContain(
      recovery.recoveryToken,
    );
  });

  it("rejects credential-bearing query parameters and oversized body before service dispatch", async () => {
    const values = fixture();
    const query = await values.post(
      `gift-checkouts/status?recoveryToken=${recovery.recoveryToken}`,
      recovery,
    );
    expect(query.status).toBe(400);
    const large = await values.post("gift-checkouts/status", {
      ...recovery,
      unexpected: "x".repeat(16384),
    });
    expect(large.status).toBe(400);
    expect(values.giftPayments.getStatus).not.toHaveBeenCalled();
  });

  it.each([
    { ...status, siteId: "other" },
    { ...status, quoteId: "other" },
    { ...status, requestId: "other" },
    { ...status, mayStartNewAttempt: true },
    { ...status, recoveryToken: recovery.recoveryToken },
  ])("rejects unsafe service status projection %j", async (projection) => {
    const values = fixture();
    values.giftPayments.getStatus.mockResolvedValue(projection);
    const response = await values.post("gift-checkouts/status", recovery);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("rejects cross-site quote and different checkout quote without leaking the result", async () => {
    const values = fixture();
    values.giftPayments.createQuote.mockResolvedValue({
      ...quote,
      siteId: "other",
    });
    expect(
      (await values.post("gift-quotes", { giftId: "gift-one", method: "PIX" }))
        .status,
    ).toBe(503);
    values.giftPayments.createCheckout.mockResolvedValue({
      ...checkout,
      quoteId: "other",
    });
    expect((await values.post("gift-checkouts", recovery)).status).toBe(503);
  });

  it("sanitizes storage/service errors without logging or exposing token/cause", async () => {
    const values = fixture();
    values.giftPayments.getStatus.mockRejectedValue(
      new Error(recovery.recoveryToken),
    );
    const response = await values.post("gift-checkouts/status", recovery);
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(
      recovery.recoveryToken,
    );
  });

  it("rejects a capability-bearing hosted URL from creation and status services", async () => {
    const values = fixture();
    const unsafe = {
      ...checkout,
      hostedUrl: `https://checkout.example.test/?private=${recovery.recoveryToken}`,
    };
    values.giftPayments.createCheckout.mockResolvedValue(unsafe);
    expect((await values.post("gift-checkouts", recovery)).status).toBe(503);
    values.giftPayments.getStatus.mockResolvedValue({
      ...status,
      state: "AWAITING_PAYMENT",
      observedAt: "2026-10-12T12:00:00.000Z",
      checkout: unsafe,
    });
    expect((await values.post("gift-checkouts/status", recovery)).status).toBe(
      503,
    );
  });

  it("accepts exact JSON with charset while rejecting prefix lookalikes", async () => {
    const values = fixture();
    expect(
      (
        await values.post("gift-checkouts/status", recovery, {
          "Content-Type": "application/json-malicious",
        })
      ).status,
    ).toBe(400);
    expect(values.giftPayments.getStatus).not.toHaveBeenCalled();
    expect(
      (
        await values.post("gift-checkouts/status", recovery, {
          "Content-Type": "application/json; charset=utf-8",
        })
      ).status,
    ).toBe(200);
  });
});
