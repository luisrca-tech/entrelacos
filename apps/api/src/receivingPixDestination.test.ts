import { describe, expect, it, vi } from "vitest";
import { createReceivingPixDestinationLookup } from "./receivingPixDestination";

const actor = {
  siteId: "site-one",
  userId: "holder-one",
  sessionId: "session-one",
};
function fixture(mode: "sandbox" | "live" = "sandbox") {
  const account = {
    accountId: "account-one",
    operatorUserId: actor.userId,
    state: "SUCCEEDED",
    result: {
      accountReference: "native-account",
      recipientReference: "native-wallet",
    },
  };
  const authorize = vi.fn(async () => account);
  const consume = vi.fn(async () => true);
  const response = {
    type: "PHONE",
    key: "+5547996515839",
    ispb: "19540550",
    ispbName: "Test Bank",
    owner: { name: "Fictional Holder", cpfCnpj: "***.456.789-**" },
  };
  const fetch = vi.fn(async (url: string | URL | Request) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/wallets/"))
      return Response.json({ data: [{ id: "native-wallet" }], hasMore: false });
    if (path.endsWith("/commercialInfo/"))
      return Response.json({
        name: "Fictional Holder",
        cpfCnpj: "12345678909",
      });
    return Response.json(response);
  });
  const lookup = createReceivingPixDestinationLookup({
    mode,
    authorize: authorize as never,
    consume,
    fetch,
    credential: () => "private-native-key",
    now: () => new Date("2026-10-16T18:00:00Z"),
    issueReview: vi.fn(async () => ({
      reviewToken: "opaque-review-token-for-testing",
      expiresAt: "2026-10-16T18:05:00Z",
    })),
  });
  return { lookup, authorize, consume, fetch, response, account };
}
describe("native Pix destination lookup without payout authorization", () => {
  it.each([
    new Response("not-json", {
      headers: { "content-type": "application/json" },
    }),
    new Response("x".repeat(65537), {
      headers: { "content-type": "application/json" },
    }),
    new Response("{}", { headers: { "content-type": "text/html" } }),
    new Response("{}", {
      status: 302,
      headers: { location: "https://foreign.test" },
    }),
  ])(
    "rejects malformed, oversized or redirected native responses",
    async (response) => {
      const v = fixture();
      v.fetch.mockResolvedValueOnce(response);
      await expect(
        v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
      ).rejects.toMatchObject({ code: "PIX_DESTINATION_UNAVAILABLE" });
      expect(v.fetch).toHaveBeenCalledTimes(1);
    },
  );
  it("aborts a stalled native lookup without retaining private provider errors", async () => {
    vi.useFakeTimers();
    try {
      const v = fixture();
      v.fetch.mockImplementationOnce(
        (_url, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(new Error("private-native-key")),
              { once: true },
            );
          }),
      );
      const work = expect(
        v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
      ).rejects.toMatchObject({ code: "PIX_DESTINATION_UNAVAILABLE" });
      await vi.advanceTimersByTimeAsync(15000);
      await work;
    } finally {
      vi.useRealTimers();
    }
  });
  it("uses scoped credentials and native identity and masks key/tax ID without enabling withdrawals", async () => {
    const v = fixture();
    const result = await v.lookup.lookup(actor, {
      type: "PHONE",
      key: "47996515839",
    });
    expect(result).toMatchObject({
      siteId: actor.siteId,
      mode: "sandbox",
      ownerName: "Fictional Holder",
      bankName: "Test Bank",
      identity: "INCOMPLETE",
      withdrawalEnabled: false,
      destinationSaved: false,
    });
    expect(JSON.stringify(result)).not.toContain("12345678909");
    expect(JSON.stringify(result)).not.toContain("47996515839");
    expect(v.authorize).toHaveBeenCalledTimes(2);
    expect(v.consume).toHaveBeenCalledExactlyOnceWith("account-one");
    for (const [url, init] of v.fetch.mock.calls as unknown as [
      string,
      RequestInit,
    ][]) {
      expect(url).toMatch(/^https:\/\/api-sandbox\.asaas\.com\/v3\//);
      expect(init).toMatchObject({
        method: "GET",
        redirect: "error",
        headers: { access_token: "private-native-key" },
      });
    }
  });
  it("never equates a complete identity match with permission to withdraw", async () => {
    const v = fixture("live");
    v.response.owner.cpfCnpj = "12345678909";
    expect(
      await v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).toMatchObject({
      identity: "MATCH",
      withdrawalEnabled: false,
      destinationSaved: false,
    });
  });
  it.each(["Different Person", "Fictional Holder Junior"])(
    "rejects a provider name mismatch: %s",
    async (name) => {
      const v = fixture("live");
      v.response.owner.name = name;
      v.response.owner.cpfCnpj = "12345678909";
      expect(
        await v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
      ).toMatchObject({ identity: "MISMATCH", withdrawalEnabled: false });
    },
  );
  it("reports a complete tax-ID mismatch even with an identical name", async () => {
    const v = fixture("live");
    v.response.owner.cpfCnpj = "98765432100";
    expect(
      await v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).toMatchObject({ identity: "MISMATCH" });
  });
  it("does not guess a personal key in Sandbox", async () => {
    const v = fixture();
    await expect(
      v.lookup.lookup(actor, { type: "CPF", key: "12345678909" }),
    ).rejects.toMatchObject({ code: "PIX_SANDBOX_KEY_UNSUPPORTED" });
    expect(v.fetch).not.toHaveBeenCalled();
  });
  it("checks server authority before rate limit or provider contact", async () => {
    const v = fixture();
    v.authorize.mockRejectedValue(new Error("revoked holder"));
    await expect(
      v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).rejects.toThrow();
    expect(v.consume).not.toHaveBeenCalled();
    expect(v.fetch).not.toHaveBeenCalled();
  });
  it("rejects a changed account binding after the provider responds", async () => {
    const v = fixture();
    v.authorize
      .mockResolvedValueOnce(v.account)
      .mockResolvedValueOnce({ ...v.account, accountId: "another-account" });
    await expect(
      v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).rejects.toMatchObject({ code: "PIX_DESTINATION_UNAVAILABLE" });
  });
  it("discards private provider data when authorization was revoked during lookup", async () => {
    const v = fixture();
    v.authorize
      .mockResolvedValueOnce(v.account)
      .mockRejectedValueOnce(new Error("expired session"));
    await expect(
      v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).rejects.toThrow();
  });
  it("limits each native account before contacting the provider", async () => {
    const v = fixture();
    v.consume.mockResolvedValue(false);
    await expect(
      v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).rejects.toMatchObject({ status: 429, code: "PIX_LOOKUP_RATE_LIMITED" });
    expect(v.fetch).not.toHaveBeenCalled();
  });
  it.each(["type", "key"])(
    "rejects a provider response with a foreign %s",
    async (field) => {
      const v = fixture();
      Object.assign(v.response, { [field]: "foreign" });
      await expect(
        v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
      ).rejects.toMatchObject({ code: "PIX_DESTINATION_UNAVAILABLE" });
    },
  );
  it("sanitizes native errors and makes no non-GET provider request", async () => {
    const v = fixture();
    v.fetch.mockRejectedValue(new Error("private key"));
    await expect(
      v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).rejects.toMatchObject({ code: "PIX_DESTINATION_UNAVAILABLE" });
  });
  it("rejects an account credential bound to another wallet", async () => {
    const v = fixture();
    v.fetch.mockResolvedValueOnce(
      Response.json({ data: [{ id: "foreign-wallet" }], hasMore: false }),
    );
    await expect(
      v.lookup.lookup(actor, { type: "PHONE", key: "47996515839" }),
    ).rejects.toMatchObject({ code: "PIX_DESTINATION_UNAVAILABLE" });
    expect(v.fetch).toHaveBeenCalledTimes(1);
  });
});

it("allows the documented successful Sandbox email key and returns only actual lookup facts", async () => {
  const f = fixture();
  f.response.type = "EMAIL";
  f.response.key = "cliente-a00001@pix.bcb.gov.br";
  const result = await f.lookup.lookup(actor, {
    type: "EMAIL",
    key: "cliente-a00001@pix.bcb.gov.br",
  });
  expect(result).toMatchObject({
    keyType: "EMAIL",
    ownerName: f.response.owner.name,
    maskedKey: "c***@p***",
  });
  expect(result.withdrawalEnabled).toBe(false);
});
