import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  resolveSiteAccess: vi.fn(),
  AdminSessionRequiredError: class extends Error {},
}));
vi.mock("./authHttp", () => ({
  requireAdminSession: mocks.requireAdminSession,
  AdminSessionRequiredError: mocks.AdminSessionRequiredError,
}));
vi.mock("./siteAccess", () => ({ resolveSiteAccess: mocks.resolveSiteAccess }));

import { ReceivingProviderRejectedError } from "./receivingSetup";
import { createReceivingSetupHttpRouter } from "./receivingSetupHttp";
import { ReceivingSetupError } from "./receivingSetupRepository";

const origin = "http://localhost:3000";
const access = {
  siteId: "site-one",
  userId: "bride-one",
  membershipRole: "SITE_ADMIN",
  membershipId: "membership-one",
  capabilities: { configureReceiving: true, readFinance: true },
};
const kycLink = {
  url: "https://exemplo.com/kyc?token=eyWfwqrnqwrnfoqwntoqwntqw",
  base64QrCode: "PD94bWwgdmVyc2lvbj0iMS4wIj8+PHN2Zy8+",
  expiresAt: "2026-11-18T12:20:00.000Z",
};
function fixture() {
  const designate = vi.fn(async () => {}),
    read = vi.fn(),
    submit = vi.fn(async () => ({ state: "STORED" })),
    createKycLink = vi.fn(async () => kycLink),
    kycRateLimit = { consume: vi.fn(async (_siteId: string) => true) };
  const verifyIncoming = vi.fn(async () => ({
    siteId: "site-one",
    mode: "sandbox" as const,
    state: "READY" as const,
    reason: null,
    observedAt: "2026-10-19T12:00:00Z",
    destinationVersion: 2,
    catalogEligible: true,
  }));
  const router = createReceivingSetupHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin: origin,
    receivingSetup: { read, designate, submit, createKycLink } as never,
    receivingVerification: { verify: verifyIncoming },
    kycRateLimit,
  });
  return {
    router,
    verifyIncoming,
    designate,
    read,
    submit,
    createKycLink,
    kycRateLimit,
  };
}
function request(path = "setup", body?: unknown, suppliedOrigin = origin) {
  return new Request(
    `http://localhost:8080/v1/sites/site-one/receiving/${path}`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: suppliedOrigin, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireAdminSession.mockResolvedValue({
    user: { id: "bride-one", role: "SITE_ADMIN" },
    session: { id: "session-one" },
  });
  mocks.resolveSiteAccess.mockResolvedValue(access);
});
describe("receiving setup HTTP boundary", () => {
  it("uses the real holder session and explicit consent for initial incoming-bank verification", async () => {
    const v = fixture();
    const response = await v.router.fetch(
      request("incoming-verification", {
        confirmIncomingAccount: true,
      }),
    );
    expect(response.status).toBe(200);
    expect(v.verifyIncoming).toHaveBeenCalledWith({
      userId: "bride-one",
      siteId: "site-one",
      sessionId: "session-one",
    });
  });
  it.each([
    {},
    { confirmIncomingAccount: false, reauthenticationToken: "proof" },
    {
      confirmIncomingAccount: true,
      reauthenticationToken: "proof",
      bankReference: "browser-chosen",
    },
  ])(
    "rejects missing consent or browser-selected incoming bank %#",
    async (input) => {
      const v = fixture();
      expect(
        (await v.router.fetch(request("incoming-verification", input))).status,
      ).toBe(400);
      expect(v.verifyIncoming).not.toHaveBeenCalled();
    },
  );

  it("accepts initial holder setup without a password/token service and passes only real actor/access", async () => {
    const v = fixture();
    const input = {
      policyVersion: "policy-v1",
      consentVersion: "pagarme-receiving-v1",
      confirmHolder: true,
      consentToProvider: true,
      account: {
        name: "Maria da Silva",
        email: "maria@example.test",
        cpf: "12345678909",
        mobilePhone: "21994647568",
        birthDate: "1990-04-12",
        monthlyIncomeCents: 500000,
        professionalOccupation: "Professora",
        address: {
          street: "Av. General Justo",
          streetNumber: "375",
          neighborhood: "Centro",
          city: "Rio de Janeiro",
          state: "RJ",
          zipCode: "20021130",
          referencePoint: "Ao lado da banca",
        },
        bankAccount: {
          bank: "341",
          branchNumber: "1234",
          accountNumber: "12345",
          accountCheckDigit: "6",
          type: "checking",
        },
      },
    };
    const response = await v.router.request(request("setup", input));
    expect(response.status).toBe(200);
    expect(v.submit).toHaveBeenCalledExactlyOnceWith(input, {
      actor: {
        userId: "bride-one",
        siteId: "site-one",
        sessionId: "session-one",
      },
      access,
    });
    expect(
      (
        await v.router.request(
          request("setup", {
            ...input,
            reauthenticationToken: "obsolete-proof",
          }),
        )
      ).status,
    ).toBe(400);
  });
  it.each(["OWNER", "SITE_ASSISTANT"])(
    "does not let %s submit initial holder consent",
    async (role) => {
      const v = fixture();
      mocks.requireAdminSession.mockResolvedValue({
        user: { id: "bride-one", role },
        session: { id: "session-one" },
      });
      expect((await v.router.request(request("setup", {}))).status).toBe(403);
      expect(v.submit).not.toHaveBeenCalled();
    },
  );
  it("rejects a missing current session before setup submission", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    expect((await v.router.request(request("setup", {}))).status).toBe(401);
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("denies a foreign origin before reading authentication or performing actions", async () => {
    const v = fixture();
    expect(
      (
        await v.router.request(
          request(
            "holder",
            { holderUserId: "bride-one" },
            "https://foreign.test",
          ),
        )
      ).status,
    ).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.designate).not.toHaveBeenCalled();
  });
  it("restricts receiving-holder designation to the platform owner", async () => {
    const v = fixture();
    expect(
      (await v.router.request(request("holder", { holderUserId: "bride-one" })))
        .status,
    ).toBe(403);
    expect(v.designate).not.toHaveBeenCalled();
  });
  it("allows the owner to designate an explicit identity without consenting on her behalf", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-one", role: "OWNER" },
      session: { id: "owner-session" },
    });
    expect(
      (await v.router.request(request("holder", { holderUserId: "bride-one" })))
        .status,
    ).toBe(204);
    expect(v.designate).toHaveBeenCalledWith(
      { userId: "owner-one", sessionId: "owner-session", siteId: "site-one" },
      "bride-one",
    );
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("rejects unknown input fields before setup submission", async () => {
    const v = fixture();
    expect(
      (await v.router.request(request("setup", { apiKey: "private" }))).status,
    ).toBe(400);
    expect(v.submit).not.toHaveBeenCalled();
  });
  it("answers a definitive Pagar.me refusal with an owner-safe 422 problem", async () => {
    const v = fixture();
    v.submit.mockRejectedValueOnce(
      new ReceivingProviderRejectedError({
        message: "Recebedor inválido",
        fields: [
          {
            field: "register_information.birthdate",
            messages: ["must be dd/mm/yyyy"],
          },
        ],
      }),
    );
    const response = await v.router.request(
      request("setup", {
        policyVersion: "policy-v1",
        consentVersion: "pagarme-receiving-v1",
        confirmHolder: true,
        consentToProvider: true,
        account: {
          name: "Maria da Silva",
          email: "maria@example.test",
          cpf: "12345678909",
          mobilePhone: "21994647568",
          birthDate: "1990-04-12",
          monthlyIncomeCents: 500000,
          professionalOccupation: "Professora",
          address: {
            street: "Av. General Justo",
            streetNumber: "375",
            neighborhood: "Centro",
            city: "Rio de Janeiro",
            state: "RJ",
            zipCode: "20021130",
          },
          bankAccount: {
            bank: "341",
            branchNumber: "1234",
            accountNumber: "12345",
            accountCheckDigit: "6",
            type: "checking",
          },
        },
      }),
    );
    expect(response.status).toBe(422);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      type: "about:blank",
      title: "Receiving setup unavailable",
      status: 422,
      code: "RECEIVING_PROVIDER_REJECTED",
      provider: {
        message: "Recebedor inválido",
        fields: [
          {
            field: "register_information.birthdate",
            messages: ["must be dd/mm/yyyy"],
          },
        ],
      },
    });
  });
  it("sanitizes unexpected provider failures", async () => {
    const v = fixture();
    v.read.mockRejectedValue(new Error("private database password"));
    const response = await v.router.request(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private database password");
  });
  it("rejects query-string capabilities", async () => {
    const v = fixture();
    const request = new Request(
      "http://localhost:8080/v1/sites/site-one/receiving/setup?token=secret",
      { headers: { origin } },
    );
    expect((await v.router.request(request)).status).toBe(400);
    expect(v.read).not.toHaveBeenCalled();
  });
});

describe("receiving identity verification link", () => {
  function kycRequest(suppliedOrigin = origin, query = "") {
    return new Request(
      `http://localhost:8080/v1/owner/sites/site-one/receiving/kyc-link${query}`,
      { method: "POST", headers: { origin: suppliedOrigin } },
    );
  }
  it("returns a no-store link to the platform owner", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "owner-one", role: "OWNER" },
      session: { id: "owner-session" },
    });
    const response = await v.router.request(kycRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(kycLink);
    expect(v.createKycLink).toHaveBeenCalledExactlyOnceWith(
      { userId: "owner-one", sessionId: "owner-session", siteId: "site-one" },
      "OWNER",
    );
  });
  it("lets the site administrator ask for her own recipient link", async () => {
    const v = fixture();
    const response = await v.router.request(kycRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(kycLink);
    expect(v.createKycLink).toHaveBeenCalledExactlyOnceWith(
      { userId: "bride-one", sessionId: "session-one", siteId: "site-one" },
      "SITE_ADMIN",
    );
  });
  it("limits identity links per site and answers 429 without calling Pagar.me", async () => {
    const v = fixture();
    v.kycRateLimit.consume.mockResolvedValueOnce(false);
    const response = await v.router.request(kycRequest());
    expect(response.status).toBe(429);
    expect(v.createKycLink).not.toHaveBeenCalled();
    expect(v.kycRateLimit.consume).toHaveBeenCalledWith("site-one");
  });
  it("refuses another administrator of the site", async () => {
    const v = fixture();
    v.createKycLink.mockRejectedValue(
      new ReceivingSetupError(403, "MEMBERSHIP_DENIED"),
    );
    const response = await v.router.request(kycRequest());
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("kyc?token");
  });
  it.each([
    ["no site membership", null],
    [
      "an assistant membership",
      { ...access, membershipRole: "SITE_ASSISTANT" },
    ],
  ])("refuses a site user with %s", async (_label, membership) => {
    const v = fixture();
    mocks.resolveSiteAccess.mockResolvedValue(membership);
    expect((await v.router.request(kycRequest())).status).toBe(403);
    expect(v.createKycLink).not.toHaveBeenCalled();
  });
  it("requires a session", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    expect((await v.router.request(kycRequest())).status).toBe(401);
    expect(v.createKycLink).not.toHaveBeenCalled();
  });
  it("reports a missing recipient as a conflict", async () => {
    const v = fixture();
    v.createKycLink.mockRejectedValue(
      new ReceivingSetupError(409, "RECEIVING_ACCOUNT_REQUIRED"),
    );
    const response = await v.router.request(kycRequest());
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "RECEIVING_ACCOUNT_REQUIRED",
    });
  });
  it("denies a foreign origin or a query string before authentication", async () => {
    const v = fixture();
    expect(
      (await v.router.request(kycRequest("https://foreign.test"))).status,
    ).toBe(403);
    expect((await v.router.request(kycRequest(origin, "?x=1"))).status).toBe(
      400,
    );
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.createKycLink).not.toHaveBeenCalled();
  });
  it("no longer serves the Pix destination routes", async () => {
    const v = fixture();
    expect((await v.router.request(request("pix-destination"))).status).toBe(
      404,
    );
  });
});
