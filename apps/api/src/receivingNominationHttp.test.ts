import { createHash } from "node:crypto";
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

import { FinancialReauthenticationError } from "./financialReauthentication";
import { deriveReceivingNominationRequestId } from "./receivingNomination";
import { createReceivingNominationHttpRouter } from "./receivingNominationHttp";

const origin = "https://admin.example.test";
const token = `fr1.${"a".repeat(80)}.${"b".repeat(43)}`;
const actor = {
  userId: "user-one",
  siteId: "site-one",
  sessionId: "session-one",
};
const access = {
  siteId: "site-one",
  userId: "user-one",
  membershipId: "membership-one",
  membershipRole: "SITE_ADMIN",
  capabilities: {
    manageInvitations: true,
    manageMessages: true,
    manageCatalog: true,
    manageTeam: true,
    readFinance: true,
    configureReceiving: true,
    requestWithdrawal: false,
  },
};
const input = {
  requestId: "request-one",
  confirmSelfAsRecipient: true,
  policyVersion: "intent-v1",
  reauthenticationToken: token,
};
function fixture(enabled = true) {
  const proof = {
    ...actor,
    proofKind: "PASSWORD_REAUTHENTICATION",
    verification: "verified",
    provenance: "backend",
    authenticatedAt: new Date("2026-10-12T18:19:30.000Z"),
    expiresAt: new Date("2026-10-12T18:24:30.000Z"),
  };
  const snapshot = {
    state: "AWAITING_PROVIDER_VERIFICATION",
    siteId: "site-one",
    requestId: "request-one",
    operatorUserId: "user-one",
    environment: "sandbox",
    policyVersion: "intent-v1",
    accountId: "account-one",
    operationId: "operation-one",
    createdAt: "2026-10-12T18:20:00.000Z",
    requestHash: createHash("sha256")
      .update(
        JSON.stringify([
          "receiving.self-nomination.v1",
          "site-one",
          "request-one",
          "user-one",
          "sandbox",
          "intent-v1",
          true,
        ]),
        "utf8",
      )
      .digest("hex"),
    authentication: {
      ...actor,
      proofKind: "PASSWORD_REAUTHENTICATION",
      authenticatedAt: "2026-10-12T18:19:30.000Z",
      expiresAt: "2026-10-12T18:24:30.000Z",
    },
  };
  const readProof = vi.fn().mockReturnValue(proof);
  const nominate = vi.fn().mockResolvedValue(snapshot);
  const configuration = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    policyVersion: "intent-v1",
    requestIdentityVersion: "nr1" as const,
  };
  const router = createReceivingNominationHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin: origin,
    financialReauthentication: enabled
      ? { readProof, authenticate: vi.fn() }
      : undefined,
    receivingNomination: enabled ? { nominate, configuration } : undefined,
  });
  return { router, proof, snapshot, readProof, nominate };
}
function request(
  body: unknown = input,
  options: { origin?: string; query?: string; mime?: string } = {},
) {
  return new Request(
    `https://api.example.test/v1/sites/site-one/receiving/nomination${options.query ?? ""}`,
    {
      method: "POST",
      headers: {
        Origin: options.origin ?? origin,
        "Content-Type": options.mime ?? "application/json",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdminSession.mockResolvedValue({
    user: { id: "user-one", role: "SITE_ADMIN" },
    session: { id: "session-one" },
  });
  mocks.resolveSiteAccess.mockResolvedValue(access);
});

describe("read-only receiving nomination context transport", () => {
  function contextFixture() {
    const configuration = {
      mode: "sandbox" as const,
      applicationEnvironment: "test" as const,
      policyVersion: "intent-v1",
      requestIdentityVersion: "nr1" as const,
    };
    const context = {
      siteId: "site-one",
      mode: "sandbox",
      state: "AVAILABLE",
      requestId: deriveReceivingNominationRequestId({
        siteId: "site-one",
        operatorUserId: "user-one",
        environment: "sandbox",
      }),
      policyVersion: "intent-v1",
    };
    const readContext = vi.fn().mockResolvedValue(context);
    const readAdministrativeSession = vi.fn().mockResolvedValue({
      user: { id: "user-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    });
    const nominate = vi.fn();
    const readProof = vi.fn();
    const options = {
      auth: {} as never,
      db: { update: vi.fn(), insert: vi.fn(), delete: vi.fn() } as never,
      adminOrigin: origin,
      receivingNominationContext: { configuration, readContext },
      receivingNomination: { configuration: { ...configuration }, nominate },
      financialReauthentication: { readProof, authenticate: vi.fn() },
      readAdministrativeSession,
    };
    return {
      options,
      context,
      readContext,
      readAdministrativeSession,
      nominate,
      readProof,
    };
  }
  const getRequest = (suffix = "", suppliedOrigin = origin) =>
    new Request(
      `https://api.example.test/v1/sites/site-one/receiving/nomination-context${suffix}`,
      { headers: { Origin: suppliedOrigin } },
    );
  it("uses only the explicit read-only authentication seam and projects no-store without actions or writes", async () => {
    const v = contextFixture();
    const response = await createReceivingNominationHttpRouter(
      v.options,
    ).request(getRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ context: v.context });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(v.readAdministrativeSession).toHaveBeenCalledTimes(1);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.readContext).toHaveBeenCalledExactlyOnceWith({ actor, access });
    expect(v.nominate).not.toHaveBeenCalled();
    expect(v.readProof).not.toHaveBeenCalled();
    for (const port of Object.values(v.options.db))
      expect(port).not.toHaveBeenCalled();
  });
  it("returns a changed-policy original pending request without upgrading it or invoking an action", async () => {
    const v = contextFixture();
    v.options.receivingNominationContext.configuration.policyVersion =
      "intent-v2";
    v.options.receivingNomination.configuration.policyVersion = "intent-v2";
    const pending = Object.assign(
      { ...v.context },
      {
        state: "PENDING",
        requestId: "legacy-request",
        policyVersion: "intent-v1",
        currentPolicyVersion: "intent-v2",
        postAllowed: false,
        nomination: {
          siteId: "site-one",
          requestId: "legacy-request",
          state: "AWAITING_PROVIDER_VERIFICATION",
          createdAt: "2026-10-12T12:00:00.000Z",
          mode: "sandbox",
        },
      },
    );
    v.readContext.mockResolvedValue(pending);
    const response = await createReceivingNominationHttpRouter(
      v.options,
    ).request(getRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ context: pending });
    expect(v.nominate).not.toHaveBeenCalled();
    expect(v.readProof).not.toHaveBeenCalled();
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    for (const port of Object.values(v.options.db))
      expect(port).not.toHaveBeenCalled();
  });
  it.each([
    "receivingNominationContext",
    "receivingNomination",
    "financialReauthentication",
    "readAdministrativeSession",
  ] as const)(
    "defaults to unavailable without %s, never falling back to the touching auth helper",
    async (port) => {
      const v = contextFixture();
      Object.assign(v.options, { [port]: undefined });
      const response = await createReceivingNominationHttpRouter(
        v.options,
      ).request(getRequest());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
      expect(v.readContext).not.toHaveBeenCalled();
    },
  );
  it("keeps an incomplete context service unavailable instead of crashing router creation", async () => {
    const v = contextFixture();
    Object.assign(v.options.receivingNominationContext, {
      readContext: undefined,
    });
    const response = await createReceivingNominationHttpRouter(
      v.options,
    ).request(getRequest());
    expect(response.status).toBe(503);
    expect(v.readAdministrativeSession).not.toHaveBeenCalled();
  });
  it.each([
    "mode",
    "applicationEnvironment",
    "policyVersion",
    "requestIdentityVersion",
  ] as const)(
    "denies incompatible context/action configuration %s",
    async (field) => {
      const v = contextFixture();
      Object.assign(v.options.receivingNomination.configuration, {
        [field]: "other",
      });
      expect(
        (
          await createReceivingNominationHttpRouter(v.options).request(
            getRequest(),
          )
        ).status,
      ).toBe(503);
      expect(v.readContext).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    { user: { id: "user-one", role: "OWNER" }, session: { id: "session-one" } },
  ])("denies absent or platform-owner authentication %j", async (current) => {
    const v = contextFixture();
    v.readAdministrativeSession.mockResolvedValue(current);
    expect(
      (
        await createReceivingNominationHttpRouter(v.options).request(
          getRequest(),
        )
      ).status,
    ).toBe(current === null ? 401 : 403);
    expect(v.readContext).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...access, membershipRole: "SITE_ASSISTANT" },
    { ...access, userId: "other" },
    {
      ...access,
      capabilities: { ...access.capabilities, configureReceiving: false },
    },
  ])("denies unsuitable selected membership %j", async (current) => {
    const v = contextFixture();
    mocks.resolveSiteAccess.mockResolvedValue(current);
    expect(
      (
        await createReceivingNominationHttpRouter(v.options).request(
          getRequest(),
        )
      ).status,
    ).toBe(403);
    expect(v.readContext).not.toHaveBeenCalled();
  });
  it("rejects origin/query/body capabilities before authentication", async () => {
    const v = contextFixture();
    const router = createReceivingNominationHttpRouter(v.options);
    expect(
      (await router.request(getRequest("", "https://evil.example"))).status,
    ).toBe(403);
    expect(
      (await router.request(getRequest("?requestId=private"))).status,
    ).toBe(400);
    const req = getRequest();
    Object.defineProperty(req, "body", { value: new ReadableStream() });
    expect((await router.request(req)).status).toBe(400);
    expect(v.readAdministrativeSession).not.toHaveBeenCalled();
    expect(v.readContext).not.toHaveBeenCalled();
  });
  it.each([
    { siteId: "other" },
    { policyVersion: "other" },
    { apiKey: "private" },
    { state: "PENDING", currentPolicyVersion: "intent-v2", postAllowed: true },
  ])("rejects malformed or foreign context projection %j", async (change) => {
    const v = contextFixture();
    v.readContext.mockResolvedValue({ ...v.context, ...change });
    const response = await createReceivingNominationHttpRouter(
      v.options,
    ).request(getRequest());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });
});
describe("receiving nomination protected transport", () => {
  it("verifies the purpose-specific capability before nominating the backend actor", async () => {
    const v = fixture();
    const response = await v.router.request(request());
    expect(response.status).toBe(200);
    expect(v.readProof).toHaveBeenCalledExactlyOnceWith(
      actor,
      "CONFIGURE_RECEIVING",
      token,
    );
    expect(v.nominate).toHaveBeenCalledExactlyOnceWith({
      actor,
      access,
      recentAuth: v.proof,
      input: {
        requestId: "request-one",
        confirmSelfAsRecipient: true,
        policyVersion: "intent-v1",
      },
    });
    expect(await response.json()).toEqual({
      nomination: {
        siteId: "site-one",
        requestId: "request-one",
        state: "AWAITING_PROVIDER_VERIFICATION",
        createdAt: v.snapshot.createdAt,
        mode: "sandbox",
      },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("defaults to unavailable without reading a token or creating an account", async () => {
    const v = fixture(false);
    expect((await v.router.request(request())).status).toBe(409);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.nominate).not.toHaveBeenCalled();
  });
  it("rejects foreign origins before session or proof", async () => {
    const v = fixture();
    expect(
      (
        await v.router.request(
          request(undefined, { origin: "https://attacker.test" }),
        )
      ).status,
    ).toBe(403);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.nominate).not.toHaveBeenCalled();
  });
  it("requires an active session before inspecting body capabilities", async () => {
    const v = fixture();
    mocks.requireAdminSession.mockRejectedValue(
      new mocks.AdminSessionRequiredError(),
    );
    const req = request("{private");
    expect((await v.router.request(req)).status).toBe(401);
    expect(req.bodyUsed).toBe(false);
    expect(v.readProof).not.toHaveBeenCalled();
  });
  it.each([
    null,
    { ...access, userId: "other" },
    { ...access, siteId: "other" },
    { ...access, membershipRole: "OWNER" },
    { ...access, membershipRole: "SITE_ASSISTANT" },
    { ...access, membershipId: null },
    {
      ...access,
      capabilities: { ...access.capabilities, configureReceiving: false },
    },
  ])("denies unsuitable current membership %j", async (value) => {
    const v = fixture();
    mocks.resolveSiteAccess.mockResolvedValue(value);
    const req = request("{private");
    expect((await v.router.request(req)).status).toBe(403);
    expect(req.bodyUsed).toBe(false);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.nominate).not.toHaveBeenCalled();
  });
  it.each([
    { ...input, operatorUserId: "other" },
    { ...input, accountReference: "private" },
    { ...input, approved: true },
    { ...input, confirmSelfAsRecipient: false },
    { ...input, reauthenticationToken: undefined },
    "{broken",
  ])("rejects browser authority or malformed input %j", async (value) => {
    const v = fixture();
    expect((await v.router.request(request(value))).status).toBe(400);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.nominate).not.toHaveBeenCalled();
  });
  it.each([
    "text/plain",
    "application/json-bad",
    "application/json; charset=latin1",
  ])("rejects invalid MIME %s", async (mime) => {
    const v = fixture();
    expect((await v.router.request(request(input, { mime }))).status).toBe(400);
    expect(v.nominate).not.toHaveBeenCalled();
  });
  it("rejects oversized bodies and query capabilities before verification", async () => {
    const v = fixture();
    expect((await v.router.request(request("x".repeat(4097)))).status).toBe(
      400,
    );
    expect(
      (
        await v.router.request(
          request(input, { query: "?reauthenticationToken=private" }),
        )
      ).status,
    ).toBe(400);
    expect(v.readProof).not.toHaveBeenCalled();
  });
  it("never invokes nomination after failed proof verification", async () => {
    const v = fixture();
    v.readProof.mockImplementation(() => {
      throw new FinancialReauthenticationError(403, "RECENT_AUTH_REQUIRED");
    });
    const response = await v.router.request(request());
    expect(response.status).toBe(403);
    expect(v.nominate).not.toHaveBeenCalled();
  });
  it.each(["site", "operator", "request", "policy", "private"])(
    "rejects contradictory or private service output %s",
    async (variant) => {
      const v = fixture();
      const output = { ...v.snapshot };
      if (variant === "site") output.siteId = "other";
      if (variant === "operator") output.operatorUserId = "other";
      if (variant === "request") output.requestId = "other";
      if (variant === "policy") output.policyVersion = "other";
      if (variant === "private") Object.assign(output, { apiKey: "private" });
      v.nominate.mockResolvedValue(output);
      const response = await v.router.request(request());
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private");
    },
  );
  it("sanitizes failed transactions and never returns a fabricated pending record", async () => {
    const v = fixture();
    v.nominate.mockRejectedValue(new Error("private SQL credential"));
    const response = await v.router.request(request());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private SQL");
  });
});
