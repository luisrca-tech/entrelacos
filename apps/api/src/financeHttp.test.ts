import {
  type FinancialOverview,
  type SiteAccess,
  type WithdrawalRequestStatus,
  withdrawalRequestContextSchema,
  withdrawalRequestStatusSchema,
} from "@entrelacos/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  resolveSiteAccess: vi.fn(),
  AdminSessionRequiredError: class AdminSessionRequiredError extends Error {},
}));
vi.mock("./authHttp", () => ({
  requireAdminSession: mocks.requireAdminSession,
  AdminSessionRequiredError: mocks.AdminSessionRequiredError,
}));
vi.mock("./siteAccess", () => ({ resolveSiteAccess: mocks.resolveSiteAccess }));

import { createFinanceHttpRouter } from "./financeHttp";
import { FinancialAuthorizationError } from "./financialAuthorization";
import { createFinancialReauthentication } from "./financialReauthentication";
import {
  createWithdrawalReservationService,
  hashWithdrawalConsentSnapshot,
  readWithdrawalConsentSnapshot,
  type WithdrawalConsentRecord,
  type WithdrawalConsentSnapshot,
  type WithdrawalReservationContext,
  type WithdrawalReservationLockedState,
  type WithdrawalReservationRecord,
  WithdrawalReservationServiceError,
} from "./withdrawalReservations";

const adminOrigin = "https://admin.example.test";
const financePath = "/v1/sites/site-one/finance";
const withdrawalsPath = "/v1/sites/site-one/withdrawals";
const routes = [
  ["GET", financePath],
  ["GET", withdrawalsPath],
  ["POST", withdrawalsPath],
] as const;
const withdrawal = {
  requestId: "request-one",
  action: "CONFIRM_NEW",
  reauthenticationToken: `fr1.synthetic.${"A".repeat(43)}`,
};

function access(): SiteAccess {
  return {
    siteId: "site-one",
    userId: "admin-one",
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
}

function router(finance?: {
  readOverview?(siteId: string): Promise<unknown>;
  listWithdrawals?(siteId: string): Promise<unknown>;
}) {
  return createFinanceHttpRouter({
    auth: {} as never,
    db: {} as never,
    adminOrigin,
    finance,
  });
}

function request(
  path: string,
  init: RequestInit = {},
  origin: string | null = adminOrigin,
): Request {
  const headers = new Headers(init.headers);
  if (origin !== null) headers.set("Origin", origin);
  return new Request(`https://api.example.test${path}`, { ...init, headers });
}

function routeRequest(method: string, path: string): Request {
  return request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: method === "POST" ? JSON.stringify(withdrawal) : undefined,
  });
}

describe("finance HTTP disabled boundary", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
      siteId: "site-one",
      memberships: [access()],
    });
    mocks.resolveSiteAccess.mockResolvedValue(access());
  });
  afterEach(() => vi.restoreAllMocks());

  function discoveryFixture() {
    const observedAt = "2026-10-12T21:00:00.000Z";
    const actor = {
      userId: "admin-one",
      siteId: "site-one",
      sessionId: "session-one",
    };
    const open = {
      siteId: actor.siteId,
      requestId: "request-one",
      mode: "sandbox",
      scopeRevision: "1",
      requestRevision: "1",
      observedAt,
      observationOrder: {
        scopeRevision: "1",
        requestRevision: "1",
        recordUpdatedAtMicroseconds: "1791838800000001",
      },
      state: "OPEN",
      preview: {
        siteId: actor.siteId,
        requestId: "request-one",
        mode: "sandbox",
        currency: "BRL",
        amountCents: 10000,
        feeCents: 500,
        netCents: 9500,
        destinationVersion: 1,
        maskedDestination: "**** 1234",
        operatorDisplayName: "Operator",
        policyVersion: "fee-v1",
        issuedAt: observedAt,
        expiresAt: "2026-10-12T21:01:00.000Z",
      },
    };
    const context = {
      siteId: actor.siteId,
      mode: "sandbox",
      scopeRevision: "1",
      observedAt,
      observationOrder: {
        scopeRevision: "1",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: false,
      reason: "OPEN_REQUEST",
      openRequest: open,
      recoverableRequests: [],
      nextCursor: null,
    };
    const service = {
      createWithdrawal: vi.fn(),
      readContext: vi.fn(async () => context),
      readRequest: vi.fn(async () => open),
      createPreview: vi.fn(async () => open),
      confirmNew: vi.fn(),
      recoverExisting: vi.fn(),
      sealUncreatedRequest: vi.fn(async () => ({
        ...(() => {
          const { preview: _preview, ...envelope } = open;
          return envelope;
        })(),
        state: "SEALED_NOT_CREATED",
        requestRevision: "2",
        scopeRevision: "2",
        observationOrder: {
          ...open.observationOrder,
          requestRevision: "2",
          scopeRevision: "2",
        },
        command: {
          requestId: "request-one",
          amountCents: 10000,
          destinationVersion: 1,
        },
        sealedAt: observedAt,
      })),
    };
    const readSession = vi.fn(async () => ({
      user: { id: actor.userId, role: "SITE_ADMIN" },
      session: { id: actor.sessionId },
    }));
    const readProof = vi.fn(() => ({
      ...actor,
      verification: "verified",
      provenance: "backend",
    }));
    const options = {
      auth: {} as never,
      db: {} as never,
      adminOrigin,
      withdrawalReservation: service as never,
      readAdministrativeSession: readSession as never,
      financialReauthentication: { readProof } as never,
    };
    return { actor, open, context, service, readSession, readProof, options };
  }
  it.each(["context", "request-one"])(
    "reads durable %s with the explicitly supplied non-mutating reader only",
    async (suffix) => {
      const v = discoveryFixture();
      const response = await createFinanceHttpRouter(v.options).request(
        request(
          `${withdrawalsPath}/${suffix === "context" ? "context" : `requests/${suffix}`}`,
        ),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(
        suffix === "context" ? { context: v.context } : { request: v.open },
      );
      expect(v.readSession).toHaveBeenCalledTimes(1);
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
      expect(v.readProof).not.toHaveBeenCalled();
      expect(v.service.createPreview).not.toHaveBeenCalled();
      expect(v.service.sealUncreatedRequest).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
  it("keeps missing read-only ports unavailable without falling back to standard auth", async () => {
    const v = discoveryFixture();
    const response = await createFinanceHttpRouter({
      ...v.options,
      readAdministrativeSession: undefined,
    }).request(request(`${withdrawalsPath}/context`));
    expect(response.status).toBe(409);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(v.service.readContext).not.toHaveBeenCalled();
  });
  it.each([
    ["OWNER", 403],
    ["SITE_ADMIN", 409],
    ["SIGNED_OUT", 401],
  ] as const)(
    "authorizes %s before reporting missing withdrawal discovery service",
    async (role, expectedStatus) => {
      const v = discoveryFixture();
      if (role === "SIGNED_OUT") v.readSession.mockResolvedValue(null as never);
      else
        v.readSession.mockResolvedValue({
          user: { id: v.actor.userId, role },
          session: { id: v.actor.sessionId },
        });
      if (role === "OWNER") {
        mocks.resolveSiteAccess.mockResolvedValue({
          ...access(),
          membershipId: null,
          membershipRole: "OWNER",
          capabilities: {
            ...access().capabilities,
            configureReceiving: false,
            requestWithdrawal: false,
          },
        });
      }
      const api = createFinanceHttpRouter({
        ...v.options,
        withdrawalReservation: undefined,
      });
      for (const method of ["GET", "HEAD"]) {
        const response = await api.request(
          request(`${withdrawalsPath}/context`, { method }),
        );
        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get("set-cookie")).toBeNull();
      }
      expect(v.readSession).toHaveBeenCalledTimes(2);
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
      expect(v.service.readContext).not.toHaveBeenCalled();
      expect(v.readProof).not.toHaveBeenCalled();
      if (role === "SIGNED_OUT")
        expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
    },
  );
  it("registers an explicit preview through standard auth without a proof or hold action", async () => {
    const v = discoveryFixture();
    const input = {
      requestId: "request-one",
      amountCents: 10000,
      scopeRevision: "9007199254740993",
    };
    const response = await createFinanceHttpRouter(v.options).request(
      request(`${withdrawalsPath}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ request: v.open });
    expect(v.service.createPreview).toHaveBeenCalledExactlyOnceWith({
      actor: v.actor,
      access: access(),
      input,
    });
    expect(mocks.requireAdminSession).toHaveBeenCalledTimes(1);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.service.confirmNew).not.toHaveBeenCalled();
  });
  it.each(["CONFIRM_NEW", "RECOVER_EXISTING"])(
    "dispatches %s exclusively by immutable reference and strips its proof",
    async (action) => {
      const v = discoveryFixture();
      const intent = {
        id: "withdrawal-one",
        siteId: "site-one",
        mode: "sandbox",
        amountCents: 10000,
        feeCents: 500,
        netCents: 9500,
        currency: "BRL",
        destinationVersion: 1,
        state: "REQUESTED",
        createdAt: v.open.observedAt,
        updatedAt: v.open.observedAt,
      };
      v.service.confirmNew.mockResolvedValue(intent as never);
      v.service.recoverExisting.mockResolvedValue(intent as never);
      const response = await createFinanceHttpRouter(v.options).request(
        request(withdrawalsPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            requestId: "request-one",
            reauthenticationToken: withdrawal.reauthenticationToken,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const method =
        action === "CONFIRM_NEW"
          ? v.service.confirmNew
          : v.service.recoverExisting;
      expect(method).toHaveBeenCalledExactlyOnceWith({
        actor: v.actor,
        access: access(),
        requestId: "request-one",
        recentAuth: expect.objectContaining({ userId: v.actor.userId }),
      });
      expect(v.service.createWithdrawal).not.toHaveBeenCalled();
      expect(v.readProof).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(method.mock.calls)).not.toContain("fr1");
    },
  );
  it("rejects the old four-field first-create bypass before proof or service", async () => {
    const v = discoveryFixture();
    const response = await createFinanceHttpRouter(v.options).request(
      request(withdrawalsPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "request-one",
          amountCents: 10000,
          destinationVersion: 1,
          reauthenticationToken: withdrawal.reauthenticationToken,
        }),
      }),
    );
    expect(response.status).toBe(400);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.service.createWithdrawal).not.toHaveBeenCalled();
  });
  it("seals the exact path reference with purpose-bound proof and no first-create call", async () => {
    const v = discoveryFixture();
    const response = await createFinanceHttpRouter(v.options).request(
      request(`${withdrawalsPath}/request-one/seal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reauthenticationToken: withdrawal.reauthenticationToken,
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).request.state).toBe("SEALED_NOT_CREATED");
    expect(v.readProof).toHaveBeenCalledExactlyOnceWith(
      v.actor,
      "REQUEST_WITHDRAWAL",
      withdrawal.reauthenticationToken,
    );
    expect(v.service.sealUncreatedRequest).toHaveBeenCalledExactlyOnceWith({
      actor: v.actor,
      access: access(),
      requestId: "request-one",
      recentAuth: expect.any(Object),
    });
    expect(v.service.createWithdrawal).not.toHaveBeenCalled();
    expect(v.service.confirmNew).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("keeps HEAD discovery on the same non-mutating reader", async () => {
    const v = discoveryFixture();
    const response = await createFinanceHttpRouter(v.options).request(
      request(`${withdrawalsPath}/context`, { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(v.readSession).toHaveBeenCalledTimes(1);
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
  });
  it.each([
    "?account=private",
    "?cursor=",
    "?cursor=a&cursor=b",
    "?cursor=%2Fprivate",
  ])(
    "rejects unsafe discovery query %s without provider or mutation",
    async (query) => {
      const v = discoveryFixture();
      const response = await createFinanceHttpRouter(v.options).request(
        request(`${withdrawalsPath}/context${query}`),
      );
      expect(response.status).toBe(400);
      expect(v.service.readContext).not.toHaveBeenCalled();
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    },
  );
  it("passes a bounded non-secret cursor without filtering backend eligibility in HTTP", async () => {
    const v = discoveryFixture();
    const response = await createFinanceHttpRouter(v.options).request(
      request(`${withdrawalsPath}/context?cursor=request.previous`),
    );
    expect(response.status).toBe(200);
    expect(v.service.readContext).toHaveBeenCalledExactlyOnceWith({
      actor: v.actor,
      access: access(),
      cursor: "request.previous",
    });
    expect((await response.json()).context.newRequestAllowed).toBe(false);
  });
  it.each(["site", "request", "private"])(
    "rejects contradictory exact discovery %s",
    async (change) => {
      const v = discoveryFixture();
      v.service.readRequest.mockResolvedValue({
        ...v.open,
        ...(change === "site"
          ? { siteId: "foreign" }
          : change === "request"
            ? { requestId: "foreign" }
            : { providerReference: "private" }),
      } as never);
      const response = await createFinanceHttpRouter(v.options).request(
        request(`${withdrawalsPath}/requests/request-one`),
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain("private");
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    },
  );
  it("retains an explicit sealed result on preview replay instead of manufacturing a new OPEN", async () => {
    const v = discoveryFixture();
    const sealed = await v.service.sealUncreatedRequest();
    v.service.createPreview.mockResolvedValue(sealed as never);
    const response = await createFinanceHttpRouter(v.options).request(
      request(`${withdrawalsPath}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "request-one",
          amountCents: 10000,
          scopeRevision: "0",
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).request.state).toBe("SEALED_NOT_CREATED");
    expect(v.service.confirmNew).not.toHaveBeenCalled();
  });
  it.each(["GET", "HEAD"])(
    "resolves the retained request named context through canonical %s without session activity",
    async (method) => {
      const v = discoveryFixture();
      const original = {
        ...v.open,
        requestId: "context",
        preview: { ...v.open.preview, requestId: "context" },
      };
      v.service.readRequest.mockResolvedValue(original);
      const response = await createFinanceHttpRouter(v.options).request(
        request(`${withdrawalsPath}/requests/context`, { method }),
      );
      expect(response.status).toBe(200);
      if (method === "GET")
        expect(await response.json()).toEqual({ request: original });
      else expect(await response.text()).toBe("");
      expect(v.service.readRequest).toHaveBeenCalledExactlyOnceWith({
        actor: v.actor,
        access: access(),
        requestId: "context",
      });
      expect(v.service.readContext).not.toHaveBeenCalled();
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
      expect(v.readSession).toHaveBeenCalledTimes(1);
      expect(response.headers.get("cache-control")).toBe("no-store");
    },
  );
  it.each(["GET", "HEAD"])(
    "rejects context cursor queries on the exact request named context with %s",
    async (method) => {
      const v = discoveryFixture();
      const response = await createFinanceHttpRouter(v.options).request(
        request(`${withdrawalsPath}/requests/context?cursor=x`, { method }),
      );
      expect(response.status).toBe(400);
      expect(v.service.readRequest).not.toHaveBeenCalled();
      expect(v.service.readContext).not.toHaveBeenCalled();
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    },
  );
  it("does not register an undeployed generic exact-request alias", async () => {
    const v = discoveryFixture();
    const response = await createFinanceHttpRouter(v.options).request(
      request(`${withdrawalsPath}/request-one`),
    );
    expect(response.status).toBe(404);
    expect(v.service.readRequest).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it.each(["absent", "origin"])(
    "denies canonical lookup with %s reader authority before any request disclosure",
    async (failure) => {
      const v = discoveryFixture();
      const options = {
        ...v.options,
        ...(failure === "absent"
          ? { readAdministrativeSession: undefined }
          : {}),
      };
      const response = await createFinanceHttpRouter(options).request(
        request(
          `${withdrawalsPath}/requests/context`,
          {},
          failure === "origin" ? "https://foreign.example.test" : adminOrigin,
        ),
      );
      expect(response.status).toBe(failure === "absent" ? 409 : 403);
      expect(v.service.readRequest).not.toHaveBeenCalled();
      expect(v.readSession).not.toHaveBeenCalled();
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    },
  );
  it.each(["GET", "HEAD"])(
    "authenticates the valid request named withdrawals with canonical %s",
    async (method) => {
      const v = discoveryFixture();
      const original = {
        ...v.open,
        requestId: "withdrawals",
        preview: { ...v.open.preview, requestId: "withdrawals" },
      };
      v.service.readRequest.mockResolvedValue(original);
      const response = await createFinanceHttpRouter(v.options).request(
        request(`${withdrawalsPath}/requests/withdrawals`, { method }),
      );
      expect(response.status).toBe(200);
      expect(v.readSession).toHaveBeenCalledTimes(1);
      expect(mocks.resolveSiteAccess).toHaveBeenCalledTimes(1);
      expect(v.service.readRequest).toHaveBeenCalledExactlyOnceWith({
        actor: v.actor,
        access: access(),
        requestId: "withdrawals",
      });
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    },
  );
  it.each(["GET", "HEAD"])(
    "denies foreign Origin for request withdrawals before any %s disclosure or session",
    async (method) => {
      const v = discoveryFixture();
      const response = await createFinanceHttpRouter(v.options).request(
        request(
          `${withdrawalsPath}/requests/withdrawals`,
          { method },
          "https://foreign.example.test",
        ),
      );
      expect(response.status).toBe(403);
      expect(v.service.readRequest).not.toHaveBeenCalled();
      expect(v.readSession).not.toHaveBeenCalled();
      expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
      const absent = await createFinanceHttpRouter({
        ...v.options,
        readAdministrativeSession: undefined,
      }).request(
        request(`${withdrawalsPath}/requests/withdrawals`, { method }),
      );
      expect(absent.status).toBe(409);
      expect(v.service.readRequest).not.toHaveBeenCalled();
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    },
  );

  function overview(): FinancialOverview {
    return {
      siteId: "site-one",
      currency: "BRL",
      nominalReceivedCents: 10000,
      netReceivedCents: 9500,
      processingCents: 300,
      commissionCents: 200,
      awaitingReleaseCents: 0,
      availableCents: null,
      pendingCommitmentsCents: 1000,
      withdrawnCents: 0,
      refundedCents: 0,
      synchronizedAt: null,
      availability: "UNKNOWN",
      mode: "sandbox",
    };
  }

  it("reads authoritative overview only after current authorization", async () => {
    const readOverview = vi.fn().mockResolvedValue(overview());
    const response = await router({ readOverview }).request(
      request(financePath),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ overview: overview() });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(readOverview).toHaveBeenCalledExactlyOnceWith("site-one");
    mocks.resolveSiteAccess.mockResolvedValueOnce(null);
    expect(
      (await router({ readOverview }).request(request(financePath))).status,
    ).toBe(403);
    expect(readOverview).toHaveBeenCalledTimes(1);
  });

  it("allows native OWNER consultation without granting withdrawal mutations", async () => {
    const ownerAccess = {
      ...access(),
      membershipId: null,
      membershipRole: "OWNER",
      capabilities: {
        ...access().capabilities,
        configureReceiving: false,
        requestWithdrawal: false,
      },
    };
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: "admin-one", role: "OWNER" },
      session: { id: "session-one" },
      memberships: [],
    });
    mocks.resolveSiteAccess.mockResolvedValue(ownerAccess);
    const readOverview = vi.fn().mockResolvedValue(overview());
    const listWithdrawals = vi.fn().mockResolvedValue([]);
    const api = router({ readOverview, listWithdrawals });
    expect((await api.request(request(financePath))).status).toBe(200);
    expect((await api.request(request(withdrawalsPath))).status).toBe(200);
    expect(
      (await api.request(routeRequest("POST", withdrawalsPath))).status,
    ).toBe(403);
    expect(readOverview).toHaveBeenCalledOnce();
    expect(listWithdrawals).toHaveBeenCalledOnce();
  });

  it.each([
    { ...overview(), siteId: "another-site" },
    { ...overview(), availableCents: 0 },
    { ...overview(), credential: "private" },
    { ...overview(), nominalReceivedCents: undefined },
    null,
  ])("fails closed on corrupt or private overview %j", async (value) => {
    const readOverview = vi.fn().mockResolvedValue(value);
    const response = await router({ readOverview }).request(
      request(financePath),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });

  it("sanitizes failed finance reads without leaking their cause", async () => {
    const readOverview = vi
      .fn()
      .mockRejectedValue(new Error("private-provider-token"));
    const response = await router({ readOverview }).request(
      request(financePath),
    );
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private-provider-token");
  });

  it("reads actual withdrawal history independently of overview", async () => {
    const listWithdrawals = vi.fn().mockResolvedValue([]);
    const app = router({ listWithdrawals });
    const response = await app.request(request(withdrawalsPath));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ withdrawals: [] });
    expect(listWithdrawals).toHaveBeenCalledExactlyOnceWith("site-one");
    expect((await app.request(request(financePath))).status).toBe(409);
    expect(
      (await app.request(routeRequest("POST", withdrawalsPath))).status,
    ).toBe(409);
  });

  it.each([
    {
      value: [
        {
          id: "withdrawal-one",
          siteId: "another-site",
          amountCents: 1000,
          feeCents: 100,
          netCents: 900,
          currency: "BRL",
          destinationVersion: 1,
          state: "UNKNOWN",
          createdAt: "2026-10-12T12:00:00.000Z",
          updatedAt: "2026-10-12T12:00:00.000Z",
          mode: "sandbox",
        },
      ],
    },
    { value: [{ accountReference: "private" }] },
    { value: null },
  ])("rejects cross-site or malformed history %j", async ({ value }) => {
    const response = await router({
      listWithdrawals: vi.fn().mockResolvedValue(value),
    }).request(request(withdrawalsPath));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private");
  });

  it("rejects query-supplied financial authority before invoking readers", async () => {
    const readOverview = vi.fn();
    const response = await router({ readOverview }).request(
      request(`${financePath}?account=other`),
    );
    expect(response.status).toBe(400);
    expect(readOverview).not.toHaveBeenCalled();
  });

  it.each([financePath, withdrawalsPath])(
    "reports an unavailable provider instead of fabricating financial data at %s",
    async (path) => {
      const response = await router().request(request(path));
      expect(response.status).toBe(409);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-type")).toBe(
        "application/problem+json",
      );
      expect(await response.json()).toEqual({
        type: "about:blank",
        status: 409,
        code: "PROVIDER_MODE_UNAVAILABLE",
        title: "Financial provider is unavailable",
      });
      expect(mocks.resolveSiteAccess).toHaveBeenCalledWith(expect.anything(), {
        userId: "admin-one",
        platformRole: "SITE_ADMIN",
        siteId: "site-one",
      });
    },
  );

  it("requires exact origin before session or financial membership lookup", async () => {
    const response = await router().request(
      request(financePath, {}, "https://attacker.example.test"),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).code).toBe("FORBIDDEN");
    expect(mocks.requireAdminSession).not.toHaveBeenCalled();
    expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
  });

  it("denies anonymous callers before financial membership lookup", async () => {
    mocks.requireAdminSession.mockRejectedValueOnce(
      new mocks.AdminSessionRequiredError(),
    );
    const response = await router().request(request(financePath));
    expect(response.status).toBe(401);
    expect((await response.json()).code).toBe("UNAUTHORIZED");
    expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
  });

  it.each(routes)(
    "protects %s %s with exact origin and authentication",
    async (method, path) => {
      for (const origin of [
        null,
        "null",
        `${adminOrigin}/`,
        `${adminOrigin}.attacker.test`,
      ]) {
        const response = await router().request(
          request(path, { method }, origin),
        );
        expect(response.status).toBe(403);
      }
      expect(mocks.requireAdminSession).not.toHaveBeenCalled();
      expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
      mocks.requireAdminSession.mockRejectedValueOnce(
        new mocks.AdminSessionRequiredError(),
      );
      const anonymous = await router().request(routeRequest(method, path));
      expect(anonymous.status).toBe(401);
      expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "validates the selected site before querying membership for %s %s",
    async (method, path) => {
      const response = await router().request(
        routeRequest(method, path.replace("site-one", "bad.identifier")),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("VALIDATION_ERROR");
      expect(mocks.resolveSiteAccess).not.toHaveBeenCalled();
    },
  );

  it.each(routes)(
    "denies unsupported financial membership for %s %s",
    async (method, path) => {
      for (const candidate of [
        null,
        { ...access(), membershipRole: "SITE_ASSISTANT" },
        { ...access(), membershipRole: "OWNER" },
        { ...access(), membershipId: null },
        { ...access(), siteId: "another-site" },
        { ...access(), userId: "another-user" },
        {
          ...access(),
          capabilities: { ...access().capabilities, readFinance: false },
        },
        { siteId: "site-one", userId: "admin-one", readFinance: true },
      ]) {
        mocks.resolveSiteAccess.mockResolvedValueOnce(candidate);
        const response = await router().request(routeRequest(method, path));
        expect(response.status).toBe(403);
        expect((await response.json()).code).toBe("MEMBERSHIP_DENIED");
      }
    },
  );

  it("uses current selected-site resolution rather than cached session membership", async () => {
    const app = router();
    mocks.resolveSiteAccess
      .mockResolvedValueOnce(access())
      .mockResolvedValueOnce(null);
    expect((await app.request(request(financePath))).status).toBe(409);
    const revoked = await app.request(request(financePath));
    expect(revoked.status).toBe(403);
    expect(mocks.resolveSiteAccess).toHaveBeenCalledTimes(2);

    mocks.resolveSiteAccess.mockResolvedValueOnce(null);
    const another = await app.request(
      request(financePath.replace("site-one", "another-site")),
    );
    expect(another.status).toBe(403);
    expect(mocks.resolveSiteAccess).toHaveBeenLastCalledWith(
      expect.anything(),
      {
        userId: "admin-one",
        platformRole: "SITE_ADMIN",
        siteId: "another-site",
      },
    );
  });

  it("accepts a strict withdrawal payload but never invokes a provider while disabled", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Unexpected provider call"));
    const response = await router().request(
      request(withdrawalsPath, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify(withdrawal),
      }),
    );
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
    expect(await response.json()).toEqual({
      type: "about:blank",
      status: 409,
      code: "PROVIDER_MODE_UNAVAILABLE",
      title: "Financial provider is unavailable",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  async function actionFixture() {
    let instant = new Date("2026-10-12T21:00:00.000Z");
    const now = () => new Date(instant);
    const actor = {
      userId: "admin-one",
      siteId: "site-one",
      sessionId: "session-one",
    };
    const context: WithdrawalReservationContext = {
      siteId: actor.siteId,
      isDemo: true,
      mode: "sandbox" as const,
      verification: "verified" as const,
      accountId: "private-account",
      bankReference: "private-bank",
      recipientBinding: {
        siteId: actor.siteId,
        operatorUserId: actor.userId,
        environment: "sandbox" as const,
        accountReference: "private-asaas-account",
        recipientReference: "private-recipient",
        destinationVersion: 1,
      },
      readiness: {
        siteId: actor.siteId,
        state: "READY" as const,
        reason: null,
        observedAt: now().toISOString(),
        destinationVersion: 1,
        catalogEligible: true,
        mode: "sandbox" as const,
      },
    };
    const locked: WithdrawalReservationLockedState = {
      access: access(),
      currentSession: actor,
      context,
      existingReservation: null,
      heldCents: 0n,
      unresolvedFinancialEventCount: 0,
      balanceEffectsAfterObservationCount: 0,
    };
    let stored: WithdrawalReservationRecord | null = null;
    let consent: WithdrawalConsentRecord | null = null;
    const status = (): WithdrawalRequestStatus => {
      const scopeRevision = consent?.requestRevision ?? "0";
      const requestRevision = consent?.requestRevision ?? null;
      const updatedAt =
        stored?.intent.updatedAt ?? consent?.snapshot.preview.issuedAt;
      const envelope = {
        siteId: actor.siteId,
        requestId: withdrawal.requestId,
        mode: "sandbox",
        scopeRevision,
        requestRevision,
        observedAt: now().toISOString(),
        observationOrder: {
          scopeRevision,
          requestRevision,
          recordUpdatedAtMicroseconds: updatedAt
            ? String(BigInt(Date.parse(updatedAt)) * 1000n)
            : null,
        },
      };
      if (stored)
        return withdrawalRequestStatusSchema.parse({
          ...envelope,
          state: "EXISTING",
          command: {
            requestId: withdrawal.requestId,
            amountCents: stored.intent.amountCents,
            destinationVersion: stored.intent.destinationVersion,
          },
          withdrawal: stored.intent,
          preview: consent?.snapshot.preview ?? null,
        });
      if (consent?.state === "OPEN")
        return withdrawalRequestStatusSchema.parse({
          ...envelope,
          state: "OPEN",
          preview: consent.snapshot.preview,
        });
      return withdrawalRequestStatusSchema.parse({
        ...envelope,
        state: "UNRESOLVED",
        command: null,
      });
    };
    const repository = {
      findByRequest: vi.fn(async () => stored),
      findConsent: vi.fn(async () => consent),
      readRequest: vi.fn(async () => status()),
      readContext: vi.fn(async () =>
        withdrawalRequestContextSchema.parse({
          siteId: actor.siteId,
          mode: "sandbox",
          scopeRevision: consent?.requestRevision ?? "0",
          observedAt: now().toISOString(),
          observationOrder: {
            scopeRevision: consent?.requestRevision ?? "0",
            requestRevision: null,
            recordUpdatedAtMicroseconds: null,
          },
          newRequestAllowed:
            consent?.state !== "OPEN" && stored?.intent.state !== "UNKNOWN",
          reason:
            consent?.state === "OPEN"
              ? "OPEN_REQUEST"
              : stored?.intent.state === "UNKNOWN"
                ? "UNRESOLVED_OPERATION"
                : null,
          openRequest: consent?.state === "OPEN" ? status() : null,
          recoverableRequests: stored ? [status()] : [],
          nextCursor: null,
        }),
      ),
      issuePreview: vi.fn(async (value: WithdrawalConsentSnapshot) => {
        const snapshot = readWithdrawalConsentSnapshot(value);
        consent = {
          snapshot,
          previewHash: hashWithdrawalConsentSnapshot(snapshot),
          state: "OPEN",
          requestRevision: "1",
        };
        return status();
      }),
      recoverWithdrawal: vi.fn(async () => stored),
      reserveWithdrawal: vi.fn(
        async (snapshot, authorize, _authorization, confirmation) => {
          if (
            !stored &&
            (consent?.state !== "OPEN" ||
              confirmation?.previewHash !== consent.previewHash)
          )
            throw new WithdrawalReservationServiceError(
              409,
              "REQUEST_CONFLICT",
            );
          locked.existingReservation = stored;
          await authorize(locked);
          stored ??= { snapshot, intent: snapshot.intent };
          if (consent)
            consent = { ...consent, state: "COMMITTED", requestRevision: "2" };
          return stored;
        },
      ),
    };
    const fee = vi.fn(async (scope) => ({
      ...scope,
      feeCents: 500,
      policyVersion: "synthetic-fee-v1",
      provenance: "provider" as const,
      verification: "verified" as const,
      observedAt: now(),
      expiresAt: new Date(instant.getTime() + 60000),
    }));
    const balance = vi.fn(async (scope) => ({
      source: "provider" as const,
      provider: "ASAAS" as const,
      siteId: scope.siteId,
      accountBindingId: scope.accountId,
      accountReference: scope.accountReference,
      environment: scope.environment,
      currency: "BRL" as const,
      observedAt: now(),
      balanceCents: 15000,
    }));
    const loadContext = vi.fn(async () => context);
    const generateId = vi.fn((kind) => `${kind}-synthetic`);
    const service = createWithdrawalReservationService({
      mode: "sandbox",
      applicationEnvironment: "test",
      maxAuthAgeMs: 300000,
      freshnessMs: 60000,
      now,
      generateId,
      loadContext,
      loadVerifiedPresentation: async (scope) => ({
        ...scope,
        source: "stored",
        verification: "verified",
        provenance: "provider",
        operatorUserId: actor.userId,
        recipientReference: "private-recipient",
        destinationId: "private-destination",
        evidenceId: "private-evidence",
        verificationReference: "private-verification",
        evidenceObservedAt: now(),
        bankObservedAt: now(),
        operatorProfileUpdatedAt: now(),
        maskedDestination: "**** 1234",
        operatorDisplayName: "Operator",
      }),
      feeQuotes: { quoteWithdrawal: fee },
      balance: { getBalance: balance },
      repository,
    });
    const create = vi.spyOn(service, "confirmNew");
    const proof = createFinancialReauthentication({
      keyId: "synthetic-key",
      key: new Uint8Array(32).fill(9),
      maxAgeMs: 300000,
      now,
      password: { verifyPassword: vi.fn(async () => true) },
      rateLimit: { consume: vi.fn(async () => true) },
    });
    const token = (
      await proof.authenticate(
        actor,
        "REQUEST_WITHDRAWAL",
        "synthetic-password",
      )
    ).reauthenticationToken;
    const readProof = vi.spyOn(proof, "readProof");
    await service.createPreview({
      actor,
      access: access(),
      input: {
        requestId: withdrawal.requestId,
        amountCents: 10000,
        scopeRevision: "0",
      },
    });
    fee.mockClear();
    loadContext.mockClear();
    repository.findByRequest.mockClear();
    const options = {
      auth: {} as never,
      db: {} as never,
      adminOrigin,
      now,
      financialReauthentication: proof,
      withdrawalReservation: service,
    };
    const send = (
      body: unknown = { ...withdrawal, reauthenticationToken: token },
      path = withdrawalsPath,
    ) =>
      createFinanceHttpRouter(options).request(
        request(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    return {
      actor,
      locked,
      context,
      options,
      service,
      create,
      proof,
      readProof,
      token,
      send,
      repository,
      fee,
      balance,
      generateId,
      loadContext,
      setTime: (value: Date) => {
        instant = value;
      },
      getStored: () => stored,
      setUnknown: () => {
        if (stored)
          stored = {
            ...stored,
            intent: { ...stored.intent, state: "UNKNOWN" },
          };
      },
    };
  }

  it("reserves through real proof and reservation factories with one standard auth and a private-free correlated response", async () => {
    const v = await actionFixture();
    const response = await v.send();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("set-cookie")).toBeNull();
    const body = await response.json();
    expect(body).toEqual({
      requestId: withdrawal.requestId,
      withdrawal: {
        id: "withdrawal-synthetic",
        siteId: "site-one",
        amountCents: 10000,
        feeCents: 500,
        netCents: 9500,
        currency: "BRL",
        destinationVersion: 1,
        state: "REQUESTED",
        createdAt: "2026-10-12T21:00:00.000Z",
        updatedAt: "2026-10-12T21:00:00.000Z",
        mode: "sandbox",
      },
    });
    expect(mocks.requireAdminSession).toHaveBeenCalledTimes(1);
    expect(mocks.resolveSiteAccess).toHaveBeenCalledTimes(1);
    expect(v.readProof).toHaveBeenCalledExactlyOnceWith(
      v.actor,
      "REQUEST_WITHDRAWAL",
      v.token,
    );
    expect(v.create.mock.calls[0]?.[0].requestId).toBe(withdrawal.requestId);
    expect(v.repository.reserveWithdrawal).toHaveBeenCalledTimes(1);
    expect(v.fee).toHaveBeenCalledExactlyOnceWith({
      siteId: "site-one",
      accountId: "private-account",
      accountReference: "private-asaas-account",
      environment: "sandbox",
      bankReference: "private-bank",
      destinationVersion: 1,
      amountCents: 10000,
      currency: "BRL",
    });
    expect(JSON.stringify(v.getStored())).not.toContain(v.token);
    expect(JSON.stringify(body)).not.toMatch(
      /private|session-one|synthetic-password|authenticationAuditHash|reauthenticationToken/,
    );
  });

  it.each(["forged", "expired", "purpose", "site", "user", "session"])(
    "rejects %s signed proof before action or provider reads",
    async (change) => {
      const v = await actionFixture();
      let token = v.token;
      if (change === "forged")
        token = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
      else if (change === "expired")
        v.setTime(new Date("2026-10-12T21:05:00.000Z"));
      else
        token = (
          await v.proof.authenticate(
            {
              ...v.actor,
              ...(change === "site"
                ? { siteId: "other" }
                : change === "user"
                  ? { userId: "other" }
                  : change === "session"
                    ? { sessionId: "other" }
                    : {}),
            },
            change === "purpose" ? "CONFIGURE_RECEIVING" : "REQUEST_WITHDRAWAL",
            "synthetic-password",
          )
        ).reauthenticationToken;
      const response = await v.send({
        ...withdrawal,
        reauthenticationToken: token,
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: "RECENT_AUTH_REQUIRED",
      });
      expect(v.create).not.toHaveBeenCalled();
      expect(v.fee).not.toHaveBeenCalled();
      expect(v.balance).not.toHaveBeenCalled();
      expect(v.repository.reserveWithdrawal).not.toHaveBeenCalled();
    },
  );

  it.each(["action", "proof"])(
    "keeps missing %s port unavailable without work",
    async (missing) => {
      const v = await actionFixture();
      const options = {
        ...v.options,
        ...(missing === "action"
          ? { withdrawalReservation: undefined }
          : { financialReauthentication: undefined }),
      };
      const response = await createFinanceHttpRouter(options).request(
        request(withdrawalsPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...withdrawal,
            reauthenticationToken: v.token,
          }),
        }),
      );
      expect(response.status).toBe(409);
      expect(v.readProof).not.toHaveBeenCalled();
      expect(v.create).not.toHaveBeenCalled();
    },
  );

  it("rejects proof-free legacy wire bodies before proof or reservation", async () => {
    const v = await actionFixture();
    const { reauthenticationToken: _token, ...body } = withdrawal;
    const response = await v.send(body);
    expect(response.status).toBe(400);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.create).not.toHaveBeenCalled();
  });

  it.each([
    "origin",
    "query",
    "anonymous",
    "OWNER",
    "assistant",
    "foreign",
    "revoked",
  ])(
    "denies configured %s requests before proof and reservation",
    async (failure) => {
      const v = await actionFixture();
      if (failure === "anonymous")
        mocks.requireAdminSession.mockRejectedValueOnce(
          new mocks.AdminSessionRequiredError(),
        );
      else if (failure === "OWNER")
        mocks.resolveSiteAccess.mockResolvedValueOnce({
          ...access(),
          membershipRole: "OWNER",
          membershipId: null,
        });
      else if (failure === "assistant")
        mocks.resolveSiteAccess.mockResolvedValueOnce({
          ...access(),
          membershipRole: "SITE_ASSISTANT",
        });
      else if (failure === "foreign")
        mocks.resolveSiteAccess.mockResolvedValueOnce({
          ...access(),
          siteId: "other",
        });
      else if (failure === "revoked")
        mocks.resolveSiteAccess.mockResolvedValueOnce({
          ...access(),
          membershipId: null,
        });
      const response = await createFinanceHttpRouter(v.options).request(
        request(
          failure === "query"
            ? `${withdrawalsPath}?account=private`
            : withdrawalsPath,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...withdrawal,
              reauthenticationToken: v.token,
            }),
          },
          failure === "origin" ? "https://foreign.example.test" : adminOrigin,
        ),
      );
      expect(response.status).toBe(
        failure === "anonymous" ? 401 : failure === "query" ? 400 : 403,
      );
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(v.readProof).not.toHaveBeenCalled();
      expect(v.create).not.toHaveBeenCalled();
      expect(v.repository.reserveWithdrawal).not.toHaveBeenCalled();
    },
  );

  it("denies a changed designated recipient through the real service before fee or balance", async () => {
    const v = await actionFixture();
    if (!v.context.recipientBinding)
      throw new Error("Missing synthetic recipient");
    v.context.recipientBinding.operatorUserId = "other";
    const response = await v.send();
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "RECIPIENT_REQUIRED" });
    expect(v.fee).not.toHaveBeenCalled();
    expect(v.balance).not.toHaveBeenCalled();
    expect(v.repository.reserveWithdrawal).not.toHaveBeenCalled();
  });

  it("preserves the receiver of injected proof and action methods", async () => {
    const v = await actionFixture();
    const create = v.service.confirmNew,
      read = v.proof.readProof;
    v.service.confirmNew = function (attempt) {
      expect(this === v.service).toBe(true);
      return create.call(v.service, attempt);
    };
    v.proof.readProof = function (...args) {
      expect(this === v.proof).toBe(true);
      return read.call(v.proof, ...args);
    };
    expect((await v.send()).status).toBe(200);
    expect(v.create).toHaveBeenCalledTimes(1);
    expect(v.readProof).toHaveBeenCalledTimes(1);
  });

  it.each(["code", "status"])(
    "suppresses corrupted typed error %s",
    async (field) => {
      const v = await actionFixture();
      const error = new WithdrawalReservationServiceError(
        409,
        "INSUFFICIENT_FUNDS",
      );
      Object.assign(
        error,
        field === "code" ? { code: "PRIVATE_SECRET" } : { status: 200 },
      );
      v.create.mockRejectedValueOnce(error);
      const response = await v.send();
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(
        /PRIVATE_SECRET|fr1|private-bank/,
      );
    },
  );

  it.each([
    "charset=iso-8859-1",
    "charset=utf-8; extra=value",
    "application/json-malicious",
  ])("rejects unsupported MIME %s before action", async (suffix) => {
    const v = await actionFixture();
    const response = await createFinanceHttpRouter(v.options).request(
      request(withdrawalsPath, {
        method: "POST",
        headers: {
          "Content-Type": suffix.startsWith("application/")
            ? suffix
            : `application/json; ${suffix}`,
        },
        body: JSON.stringify({ ...withdrawal, reauthenticationToken: v.token }),
      }),
    );
    expect(response.status).toBe(400);
    expect(v.create).not.toHaveBeenCalled();
    expect(v.readProof).not.toHaveBeenCalled();
  });

  it("cancels an oversized streamed body and rejects invalid UTF-8 before proof", async () => {
    const v = await actionFixture();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8193).fill(32));
      },
      cancel,
    });
    const raw = new Request(`https://api.example.test${withdrawalsPath}`, {
      method: "POST",
      headers: { Origin: adminOrigin, "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await createFinanceHttpRouter(v.options).request(raw)).status).toBe(
      400,
    );
    expect(cancel).toHaveBeenCalledTimes(1);
    const invalid = await createFinanceHttpRouter(v.options).request(
      request(withdrawalsPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: new Uint8Array([123, 255, 125]),
      }),
    );
    expect(invalid.status).toBe(400);
    expect(v.readProof).not.toHaveBeenCalled();
    expect(v.create).not.toHaveBeenCalled();
  });

  it("recovers original UNKNOWN despite changed current readiness without new fee, balance, IDs or hold", async () => {
    const v = await actionFixture();
    expect((await v.send()).status).toBe(200);
    const original = v.getStored();
    if (!original) throw new Error("Missing synthetic reservation");
    v.setUnknown();
    v.context.readiness = {
      ...v.context.readiness,
      state: "NOT_CONFIGURED",
      reason: "NOT_CONFIGURED",
      catalogEligible: false,
    } as WithdrawalReservationContext["readiness"];
    v.context.recipientBinding = {
      ...v.context.recipientBinding,
      operatorUserId: "new-recipient",
      destinationVersion: 2,
    } as WithdrawalReservationContext["recipientBinding"];
    v.fee.mockClear();
    v.balance.mockClear();
    v.generateId.mockClear();
    const currentActor = { ...v.actor, sessionId: "session-after-relogin" };
    const fresh = await v.proof.authenticate(
      currentActor,
      "REQUEST_WITHDRAWAL",
      "synthetic-password",
    );
    mocks.requireAdminSession.mockResolvedValueOnce({
      user: { id: currentActor.userId, role: "SITE_ADMIN" },
      session: { id: currentActor.sessionId },
    });
    v.locked.currentSession = currentActor;
    const response = await v.send({
      ...withdrawal,
      reauthenticationToken: fresh.reauthenticationToken,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      requestId: withdrawal.requestId,
      withdrawal: {
        id: original.intent.id,
        state: "UNKNOWN",
        destinationVersion: 1,
      },
    });
    expect(v.getStored()?.snapshot).toEqual(original.snapshot);
    expect(v.fee).not.toHaveBeenCalled();
    expect(v.balance).not.toHaveBeenCalled();
    expect(v.generateId).not.toHaveBeenCalled();
  });

  it.each(["amountCents", "destinationVersion"] as const)(
    "conflicts on changed %s without replacing original commitment",
    async (field) => {
      const v = await actionFixture();
      expect((await v.send()).status).toBe(200);
      const original = v.getStored();
      v.repository.reserveWithdrawal.mockClear();
      const response = await v.send({
        ...withdrawal,
        reauthenticationToken: v.token,
        [field]: field === "amountCents" ? 10001 : 2,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
      expect(v.getStored()).toBe(original);
      expect(v.repository.reserveWithdrawal).not.toHaveBeenCalled();
    },
  );

  it.each([
    "siteId",
    "amountCents",
    "destinationVersion",
    "mode",
    "private",
    "conservation",
  ])("rejects contradictory service projection %s", async (field) => {
    const v = await actionFixture();
    const change: Record<string, unknown> =
      field === "siteId"
        ? { siteId: "foreign" }
        : field === "amountCents"
          ? { amountCents: 0, netCents: 0 }
          : field === "destinationVersion"
            ? { destinationVersion: 0 }
            : field === "mode"
              ? { mode: "disabled" }
              : field === "private"
                ? { bankReference: "private-bank" }
                : { netCents: 1 };
    const intent = {
      id: "withdrawal-one",
      siteId: "site-one",
      amountCents: 10000,
      feeCents: 500,
      netCents: 9500,
      currency: "BRL",
      destinationVersion: 1,
      state: "REQUESTED",
      createdAt: "2026-10-12T21:00:00.000Z",
      updatedAt: "2026-10-12T21:00:00.000Z",
      mode: "sandbox",
      ...change,
    };
    v.create.mockResolvedValueOnce(intent as never);
    const response = await v.send();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toMatch(/private-bank|fr1|synthetic-key/);
  });

  it("sanitizes typed reservation errors while retaining precise status and code", async () => {
    const v = await actionFixture();
    const error = new WithdrawalReservationServiceError(
      409,
      "INSUFFICIENT_FUNDS",
    );
    error.message = "private-password-and-bank";
    v.create.mockRejectedValueOnce(error);
    const response = await v.send();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "INSUFFICIENT_FUNDS" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("preserves existing financial read authorization error projection", async () => {
    mocks.resolveSiteAccess.mockRejectedValueOnce(
      new FinancialAuthorizationError(
        403,
        "RECIPIENT_REQUIRED",
        "private-bank",
      ),
    );
    const response = await router().request(request(financePath));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "MEMBERSHIP_DENIED",
      title: "Financial access denied",
    });
  });

  it("retains original UNKNOWN after a lost commit ACK and recovers without new provider reads", async () => {
    const v = await actionFixture();
    const reserve = v.repository.reserveWithdrawal.getMockImplementation();
    if (!reserve) throw new Error("Missing synthetic reservation writer");
    v.repository.reserveWithdrawal.mockImplementationOnce(async (...args) => {
      await reserve(...args);
      v.setUnknown();
      throw new Error("private-commit-ack");
    });
    const first = await v.send();
    expect(first.status).toBe(503);
    const original = v.getStored();
    if (!original) throw new Error("Missing committed synthetic reservation");
    expect(original.intent.state).toBe("UNKNOWN");
    v.fee.mockClear();
    v.balance.mockClear();
    v.generateId.mockClear();
    const replay = await v.send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({
      requestId: withdrawal.requestId,
      withdrawal: original.intent,
    });
    expect(v.getStored()).toBe(original);
    expect(v.fee).not.toHaveBeenCalled();
    expect(v.balance).not.toHaveBeenCalled();
    expect(v.generateId).not.toHaveBeenCalled();
  });

  it("accepts the exact 8192-byte JSON boundary with a valid signed proof", async () => {
    const v = await actionFixture();
    const json = JSON.stringify({
      ...withdrawal,
      reauthenticationToken: v.token,
    });
    const body =
      json + " ".repeat(8192 - new TextEncoder().encode(json).length);
    const response = await createFinanceHttpRouter(v.options).request(
      request(withdrawalsPath, {
        method: "POST",
        headers: { "Content-Type": 'Application/JSON; charset="UTF-8"' },
        body,
      }),
    );
    expect(response.status).toBe(200);
    expect(v.create).toHaveBeenCalledTimes(1);
  });

  it("requires authorization before inspecting a withdrawal payload", async () => {
    mocks.resolveSiteAccess.mockResolvedValueOnce({
      ...access(),
      membershipRole: "SITE_ASSISTANT",
    });
    const attempted = request(withdrawalsPath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{malformed-private-claim",
    });
    const response = await router().request(attempted);
    expect(response.status).toBe(403);
    expect(attempted.bodyUsed).toBe(false);
  });

  it("rejects missing or misleading JSON media types", async () => {
    for (const contentType of [
      undefined,
      "text/plain",
      "application/json-malicious",
      "application/json-patch+json",
    ]) {
      const response = await router().request(
        request(withdrawalsPath, {
          method: "POST",
          headers: contentType ? { "Content-Type": contentType } : {},
          body: JSON.stringify(withdrawal),
        }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects malformed JSON and invalid withdrawal amounts or versions", async () => {
    for (const body of [
      "{",
      JSON.stringify(null),
      JSON.stringify([]),
      JSON.stringify({}),
      JSON.stringify({ ...withdrawal, amountCents: 0 }),
      JSON.stringify({ ...withdrawal, amountCents: -1 }),
      JSON.stringify({ ...withdrawal, amountCents: 0.5 }),
      JSON.stringify({ ...withdrawal, amountCents: 2_147_483_648 }),
      JSON.stringify({ ...withdrawal, destinationVersion: 0 }),
      JSON.stringify({ ...withdrawal, destinationVersion: 0.5 }),
    ]) {
      const response = await router().request(
        request(withdrawalsPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect((await response.json()).code).toBe("VALIDATION_ERROR");
    }
  });

  it("rejects client role, account, approval and proof claims rather than forwarding them", async () => {
    for (const claim of [
      { role: "OWNER" },
      { accountReference: "attacker-account" },
      { approved: true },
      { recentAuth: { verified: true } },
      { readiness: { state: "READY" } },
    ]) {
      const response = await router().request(
        request(withdrawalsPath, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...withdrawal, ...claim }),
        }),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe("VALIDATION_ERROR");
    }
  });

  it.each(["authentication", "membership"] as const)(
    "sanitizes %s storage outages without logging private errors",
    async (source) => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const error = new Error(
        "postgresql://private:credential@database.example.test/provider-wallet",
      );
      if (source === "authentication")
        mocks.requireAdminSession.mockRejectedValueOnce(error);
      else mocks.resolveSiteAccess.mockRejectedValueOnce(error);
      const response = await router().request(request(financePath));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toEqual({
        type: "about:blank",
        status: 503,
        code: "SERVICE_UNAVAILABLE",
        title: "Financial service unavailable",
      });
      expect(consoleSpy).not.toHaveBeenCalled();
    },
  );
});
