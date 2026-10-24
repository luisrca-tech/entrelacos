import { describe, expect, it, vi } from "vitest";
import {
  createReceivingSetupAsaasObserver,
  normalizeReceivingSetupAsaasAccount,
} from "./receivingSetupAsaas";

const parent = {
  environment: "sandbox" as const,
  parentAccountReference: "parent-account",
};
const binding = {
  provider: "ASAAS" as const,
  siteId: "site-one",
  accountBindingId: "binding-one",
  environment: "sandbox" as const,
  accountReference: "child-account",
  recipientReference: "child-wallet",
};
const approved = {
  id: "status-one",
  commercialInfo: "APPROVED",
  bankAccountInfo: "APPROVED",
  documentation: "APPROVED",
  general: "APPROVED",
};
function fixture(overrides: Record<string, unknown> = {}) {
  const responses: unknown[] = [
    { data: [{ id: "child-wallet" }], hasMore: false },
    approved,
    {
      commercialInfoExpiration: { isExpired: false },
      cpfCnpj: "12345678909",
      email: "private@example.test",
    },
  ];
  const fetch = vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify(responses.shift()), { status: 200 }),
  );
  const observer = createReceivingSetupAsaasObserver({
    binding,
    accessToken: "child-private-key",
    fetch: fetch as typeof globalThis.fetch,
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    ...overrides,
  });
  return { observer, fetch, responses };
}
describe("native Asaas receiving setup", () => {
  it("normalizes the documented original response without retaining profile data", async () => {
    const normalized = await normalizeReceivingSetupAsaasAccount(
      {
        id: "child-account",
        walletId: "child-wallet",
        apiKey: "child-private-key",
        name: "Private Person",
      },
      parent,
    );
    expect(normalized).toEqual({
      accountReference: "child-account",
      recipientReference: "child-wallet",
      credential: "child-private-key",
    });
  });
  it.each([
    { id: "parent-account", walletId: "child-wallet", apiKey: "key" },
    { id: "child-account", walletId: null, apiKey: "key" },
    { id: "child-account", walletId: "child-wallet", apiKey: "key\nsecret" },
    { child: "child-account", wallet: "child-wallet", key: "key" },
  ])("rejects incomplete or incompatible creation responses", async (body) => {
    await expect(
      normalizeReceivingSetupAsaasAccount(body, parent),
    ).rejects.toThrow("Receiving setup provider unavailable");
  });
  it("observes a wallet-bound account and returns statuses without granting financial authority", async () => {
    const values = fixture();
    const result = await values.observer.readStatus();
    expect(result).toEqual({
      siteId: "site-one",
      accountBindingId: "binding-one",
      environment: "sandbox",
      accountReference: "child-account",
      recipientReference: "child-wallet",
      observedAt: "2026-10-16T12:00:00.000Z",
      status: approved,
      commercialInfoExpired: false,
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|12345678909|READY|receivingCapability|commercialEnabled/,
    );
    expect(values.fetch.mock.calls.map((call) => call[0])).toEqual([
      "https://api-sandbox.asaas.com/v3/wallets/",
      "https://api-sandbox.asaas.com/v3/myAccount/status/",
      "https://api-sandbox.asaas.com/v3/myAccount/commercialInfo/",
    ]);
    for (const call of values.fetch.mock.calls) {
      const request = call[1] as RequestInit;
      expect(request.method).toBe("GET");
      expect(request.redirect).toBe("error");
      expect(request.body).toBeUndefined();
      expect(new Headers(request.headers).get("User-Agent")).toBe(
        "Entrelacos/1.0",
      );
      expect(new Headers(request.headers).get("access_token")).toBe(
        "child-private-key",
      );
    }
    await values.observer.close();
    await expect(values.observer.readStatus()).rejects.toThrow(
      "Receiving setup provider unavailable",
    );
  });
  it.each(["sandbox", "live"] as const)(
    "reads %s own bank and active Pix identity only for internal verification",
    async (environment) => {
      const values = fixture({
        includeVerificationFacts: true,
        binding: { ...binding, environment },
      });
      values.responses.push(
        { agency: "0001", account: "123456", accountDigit: "7" },
        {
          hasMore: false,
          data: [
            {
              id: "key-one",
              status: "ACTIVE",
              type: "EVP",
              key: "private-key-value",
            },
          ],
        },
      );
      const result = await values.observer.readStatus();
      expect(result.environment).toBe(environment);
      expect(
        values.fetch.mock.calls.every(([url]) =>
          String(url).startsWith(
            environment === "live"
              ? "https://api.asaas.com/"
              : "https://api-sandbox.asaas.com/",
          ),
        ),
      ).toBe(true);
      expect(result.verificationFacts).toMatchObject({
        accountNumber: { agency: "0001", account: "123456", accountDigit: "7" },
        activePixKey: { id: "key-one", status: "ACTIVE" },
      });
      expect(JSON.stringify(result.verificationFacts)).not.toContain(
        "private-key-value",
      );
      await values.observer.close();
    },
  );
  it("cannot observe statuses using a credential for a different wallet", async () => {
    const values = fixture();
    values.responses[0] = { data: [{ id: "other-wallet" }], hasMore: false };
    await expect(values.observer.readStatus()).rejects.toThrow(
      "Receiving setup provider unavailable",
    );
    expect(values.fetch).toHaveBeenCalledTimes(1);
    await values.observer.close();
  });
  it.each(["SOMETHING_NEW", null, undefined])(
    "fails closed on an unknown native status %s",
    async (general) => {
      const values = fixture();
      values.responses[1] = { ...approved, general };
      await expect(values.observer.readStatus()).rejects.toThrow(
        "Receiving setup provider unavailable",
      );
      await values.observer.close();
    },
  );
  it("preserves expired commercial data independently from general approval", async () => {
    const values = fixture();
    values.responses[2] = { commercialInfoExpiration: { isExpired: true } };
    expect(await values.observer.readStatus()).toMatchObject({
      status: { general: "APPROVED" },
      commercialInfoExpired: true,
    });
    await values.observer.close();
  });
  it("keeps unavailable commercial expiration unknown", async () => {
    const values = fixture();
    values.responses[2] = {};
    expect(await values.observer.readStatus()).toMatchObject({
      commercialInfoExpired: null,
    });
    await values.observer.close();
  });
  it("sanitizes transport failures and performs no retry", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("private-key in transport error");
    });
    const values = fixture({ fetch });
    await expect(values.observer.readStatus()).rejects.toThrow(
      "Receiving setup provider unavailable",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    await values.observer.close();
  });
  it("refuses oversized provider bodies", async () => {
    const fetch = vi.fn(async () => new Response("x".repeat(65537)));
    const values = fixture({ fetch });
    await expect(values.observer.readStatus()).rejects.toThrow(
      "Receiving setup provider unavailable",
    );
    await values.observer.close();
  });
});
