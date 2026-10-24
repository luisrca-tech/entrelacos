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

import { createReceivingSetupHttpRouter } from "./receivingSetupHttp";

const origin = "http://localhost:3000";
const access = {
  siteId: "site-one",
  userId: "bride-one",
  membershipRole: "SITE_ADMIN",
  membershipId: "membership-one",
  capabilities: { configureReceiving: true, readFinance: true },
};
function fixture(snapshot?: unknown) {
  const designate = vi.fn(async () => {}),
    read = vi.fn(),
    lookupPixDestination = vi.fn(async () => ({
      siteId: "site-one",
      mode: "sandbox",
      keyType: "PHONE",
      maskedKey: "***5839",
      ownerName: "Fictional Holder",
      maskedCpfCnpj: "***.456.789-**",
      bankName: "Test Bank",
      identity: "INCOMPLETE",
      observedAt: "2026-10-16T18:00:00Z",
      destinationSaved: false,
      withdrawalEnabled: false,
      reviewToken: "opaque-review-token-for-testing",
      expiresAt: "2026-10-16T18:05:00Z",
    })),
    confirmPixDestination = vi.fn(async () => ({
      siteId: "site-one",
      mode: "sandbox",
      destinationId: "destination-one",
      version: 1,
      keyType: "PHONE",
      maskedKey: "***5839",
      ownerName: "Fictional Holder",
      maskedCpfCnpj: "***.456.789-**",
      bankName: "Test Bank",
      identity: "INCOMPLETE",
      state: "PENDING",
      withdrawalEnabled: false,
    })),
    readPixDestination = vi.fn(async () => null),
    readPixDestinationSnapshot = vi.fn(async () => snapshot),
    readProof = vi.fn(() => ({ proofKind: "PASSWORD_REAUTHENTICATION" })),
    submit = vi.fn(async () => ({ state: "STORED" }));
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
    receivingSetup: {
      read,
      designate,
      submit,
      lookupPixDestination,
      confirmPixDestination,
      readPixDestination,
      ...(snapshot === undefined ? {} : { readPixDestinationSnapshot }),
    } as never,
    financialReauthentication: { readProof } as never,
    receivingVerification: { verify: verifyIncoming },
  });
  return {
    router,
    verifyIncoming,
    designate,
    read,
    submit,
    lookupPixDestination,
    confirmPixDestination,
    readPixDestination,
    readPixDestinationSnapshot,
    readProof,
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
    expect(v.readProof).not.toHaveBeenCalled();
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

  it("requires real receiving-purpose password authentication before confirming a recipient without accepting a replacement key", async () => {
    const v = fixture();
    const payload = {
      reviewToken: "opaque-review-token-for-testing",
      confirmRecipient: true,
      acceptThirdParty: true,
      reauthenticationToken: "real-password-proof",
    };
    const response = await v.router.request(
      request("pix-destination/confirm", payload),
    );
    expect(response.status).toBe(200);
    expect(v.readProof).toHaveBeenCalledExactlyOnceWith(
      { userId: "bride-one", siteId: "site-one", sessionId: "session-one" },
      "CONFIGURE_RECEIVING",
      "real-password-proof",
    );
    expect(v.confirmPixDestination).toHaveBeenCalledExactlyOnceWith(
      { userId: "bride-one", siteId: "site-one", sessionId: "session-one" },
      {
        reviewToken: payload.reviewToken,
        confirmRecipient: true,
        acceptThirdParty: true,
      },
      { proofKind: "PASSWORD_REAUTHENTICATION" },
    );
    expect(
      (
        await v.router.request(
          request("pix-destination/confirm", { ...payload, key: "other-key" }),
        )
      ).status,
    ).toBe(400);
    expect(v.confirmPixDestination).toHaveBeenCalledTimes(1);
  });
  it("returns an explicitly empty saved-destination read without exposing a key", async () => {
    const v = fixture();
    const response = await v.router.request(request("pix-destination"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      destination: null,
      recentDestinations: [],
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(v.readPixDestination).toHaveBeenCalledExactlyOnceWith({
      userId: "bride-one",
      siteId: "site-one",
      sessionId: "session-one",
    });
  });
  it("returns recent masked destinations with the current destination unchanged", async () => {
    const recent = {
      siteId: "site-one",
      mode: "sandbox",
      keyType: "PHONE",
      maskedKey: "***5839",
      ownerName: "Fictional Holder",
      maskedCpfCnpj: "***.456.789-**",
      bankName: "Test Bank",
      identity: "INCOMPLETE",
      destinationId: "destination-one",
      version: 1,
      savedAt: "2026-10-16T18:00:00Z",
    };
    const destination = {
      ...recent,
      savedAt: undefined,
      state: "PENDING",
      withdrawalEnabled: false,
    };
    delete destination.savedAt;
    const snapshot = { destination, recentDestinations: [recent] };
    const v = fixture(snapshot);
    const response = await v.router.request(request("pix-destination"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(snapshot);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(v.readPixDestinationSnapshot).toHaveBeenCalledExactlyOnceWith({
      userId: "bride-one",
      siteId: "site-one",
      sessionId: "session-one",
    });
    expect(v.readPixDestination).not.toHaveBeenCalled();
  });
  it.each(["wrong-site", "secret"])(
    "rejects a recent destination %s projection",
    async (change) => {
      const recent = {
        siteId: change === "wrong-site" ? "other-site" : "site-one",
        mode: "sandbox",
        keyType: "PHONE",
        maskedKey: "***5839",
        ownerName: "Fictional Holder",
        maskedCpfCnpj: "***.456.789-**",
        bankName: "Test Bank",
        identity: "INCOMPLETE",
        destinationId: "destination-one",
        version: 1,
        savedAt: "2026-10-16T18:00:00Z",
        ...(change === "secret" ? { key: "secret-native-key" } : {}),
      };
      const v = fixture({ destination: null, recentDestinations: [recent] });
      const response = await v.router.request(request("pix-destination"));
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("secret-native-key");
    },
  );
  it("permits read-only platform owner access without requesting password proof", async () => {
    const v = fixture({ destination: null, recentDestinations: [] });
    mocks.requireAdminSession.mockResolvedValueOnce({
      user: { id: "bride-one", role: "OWNER" },
      session: { id: "session-one" },
    });
    mocks.resolveSiteAccess.mockResolvedValueOnce({
      ...access,
      membershipRole: "OWNER",
      membershipId: null,
      capabilities: { configureReceiving: false, readFinance: true },
    });
    expect((await v.router.request(request("pix-destination"))).status).toBe(
      200,
    );
    expect(v.readPixDestinationSnapshot).toHaveBeenCalledTimes(1);
    expect(v.readProof).not.toHaveBeenCalled();
  });
  it.each(["site", "user", "role"])(
    "denies recent-destination reads with wrong %s access",
    async (change) => {
      const v = fixture({ destination: null, recentDestinations: [] });
      if (change === "role")
        mocks.requireAdminSession.mockResolvedValueOnce({
          user: { id: "bride-one", role: "SITE_ASSISTANT" },
          session: { id: "session-one" },
        });
      else
        mocks.resolveSiteAccess.mockResolvedValueOnce({
          ...access,
          ...(change === "site"
            ? { siteId: "other-site" }
            : { userId: "other-user" }),
        });
      expect((await v.router.request(request("pix-destination"))).status).toBe(
        403,
      );
      expect(v.readPixDestinationSnapshot).not.toHaveBeenCalled();
    },
  );
  it.each(["OWNER", "SITE_ASSISTANT"])(
    "never lets %s save a Pix destination",
    async (role) => {
      const v = fixture();
      mocks.requireAdminSession.mockResolvedValue({
        user: { id: "bride-one", role },
        session: { id: "session-one" },
      });
      expect(
        (
          await v.router.request(
            request("pix-destination/confirm", {
              reviewToken: "opaque-review-token-for-testing",
              confirmRecipient: true,
              reauthenticationToken: "real-password-proof",
            }),
          )
        ).status,
      ).toBe(403);
      expect(v.confirmPixDestination).not.toHaveBeenCalled();
      expect(v.readProof).not.toHaveBeenCalled();
    },
  );
  it("exposes a holder-scoped no-store Pix review without trusting client identity", async () => {
    const v = fixture();
    const response = await v.router.request(
      request("pix-destination/preview", { type: "PHONE", key: "47996515839" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(v.lookupPixDestination).toHaveBeenCalledExactlyOnceWith(
      { userId: "bride-one", siteId: "site-one", sessionId: "session-one" },
      { type: "PHONE", key: "47996515839" },
    );
    expect((await response.json()).withdrawalEnabled).toBe(false);
    expect(v.submit).not.toHaveBeenCalled();
  });
  it.each(["OWNER", "SITE_ASSISTANT"])(
    "denies a Pix lookup by %s",
    async (role) => {
      const v = fixture();
      mocks.requireAdminSession.mockResolvedValue({
        user: { id: "bride-one", role },
        session: { id: "session-one" },
      });
      expect(
        (
          await v.router.request(
            request("pix-destination/preview", {
              type: "PHONE",
              key: "47996515839",
            }),
          )
        ).status,
      ).toBe(403);
      expect(v.lookupPixDestination).not.toHaveBeenCalled();
    },
  );
  it("denies invalid identity fields, expired sessions and foreign origins before Pix lookup", async () => {
    const v = fixture();
    expect(
      (
        await v.router.request(
          request("pix-destination/preview", {
            type: "PHONE",
            key: "47996515839",
            ownerName: "Forged Person",
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await v.router.request(
          request(
            "pix-destination/preview",
            { type: "PHONE", key: "47996515839" },
            "https://foreign.test",
          ),
        )
      ).status,
    ).toBe(403);
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    expect(
      (
        await v.router.request(
          request("pix-destination/preview", {
            type: "PHONE",
            key: "47996515839",
          }),
        )
      ).status,
    ).toBe(401);
    expect(v.lookupPixDestination).not.toHaveBeenCalled();
  });
  it("accepts initial holder setup without a password/token service and passes only real actor/access", async () => {
    const v = fixture();
    const input = {
      policyVersion: "policy-v1",
      consentVersion: "asaas-receiving-v1",
      confirmHolder: true,
      consentToAsaas: true,
      account: {
        name: "Fictional Person",
        email: "person@example.test",
        cpfCnpj: "12345678909",
        mobilePhone: "11999999999",
        incomeValue: 1000,
        address: "Fictional Road",
        addressNumber: "1",
        province: "District",
        postalCode: "12345678",
        birthDate: "1990-01-01",
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
