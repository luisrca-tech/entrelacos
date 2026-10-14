import { createHmac } from "node:crypto";
import type {
  GiftPurchaseHistoryDetailResponse,
  GiftPurchaseHistoryPageResponse,
} from "@entrelacos/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { createAuth, createSessionReadAuth } from "./auth";
import type { AuthHttpOptions } from "./authHttp";
import * as authHttp from "./authHttp";
import { createFinancialReauthentication } from "./financialReauthentication";
import * as giftMedia from "./giftMedia";
import { createGiftMediaComposition } from "./giftMediaComposition";
import {
  createGiftPaymentHistory,
  type GiftPaymentHistoryRepository,
} from "./giftPaymentHistory";
import { deriveReceivingNominationRequestId } from "./receivingNomination";
import { createReceivingNominationComposition } from "./receivingNominationComposition";
import * as receivingRepository from "./receivingRepository";
import * as siteAccess from "./siteAccess";

describe("API composition", () => {
  it("forwards singleton media ports and separate read auth only to media routes", async () => {
    const standardAuth = { standard: true } as never;
    const readAuth = { readOnly: true } as never;
    const actor = {
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    };
    const session = vi
      .spyOn(authHttp, "requireAdminSession")
      .mockResolvedValue(actor as never);
    const recheck = vi
      .spyOn(authHttp, "readAdministrativeSession")
      .mockResolvedValue(actor as never);
    const storage = {
      storageNamespace: "existing-development-bucket",
      getDerivativeUrl: vi.fn(),
      headDerivative: vi.fn(),
      readDerivative: vi.fn(),
      publishDerivative: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const decode = vi.fn() as never;
    const composition = await createGiftMediaComposition(
      {
        mode: "r2",
        accountId: "a".repeat(32),
        accessKeyId: "synthetic-key",
        secretAccessKey: "synthetic-secret",
        bucketName: storage.storageNamespace,
        publicOrigin: "https://images.example.test",
      },
      {
        createReadAuth: () => readAuth,
        createStorage: () => storage,
        decode,
      },
    );
    const db = {} as never;
    const input = {
      contentType: "image/png",
      byteLength: 20,
      contentSha256: "a".repeat(64),
    };
    const issue = vi
      .spyOn(giftMedia, "issueGiftMediaUpload")
      .mockImplementation(async (_db, _actor, _site, _input, options) => {
        await options?.authorize?.(db);
        expect(await options?.readReadiness?.("site-one")).toMatchObject({
          catalogEligible: false,
          state: "NOT_CONFIGURED",
        });
        return {
          upload: { id: "asset-one", expiresAt: "2026-10-13T08:00:00.000Z" },
        };
      });
    const status = {
      status: {
        siteId: "site-one",
        assetId: "asset-one",
        state: "UNKNOWN" as const,
        expiresAt: "2026-10-13T08:00:00.000Z",
        canRetrySameBytes: false,
        media: null,
      },
    };
    const consult = vi
      .spyOn(giftMedia, "consultGiftMediaUpload")
      .mockResolvedValue(status);
    const recover = vi
      .spyOn(giftMedia, "recoverGiftMediaUpload")
      .mockResolvedValue(status);
    const finalize = vi
      .spyOn(giftMedia, "finalizeGiftMediaUpload")
      .mockResolvedValue({
        media: {
          id: "asset-one",
          siteId: "site-one",
          url: "https://images.example.test/gifts/site-one/asset-one/result.webp",
          contentType: "image/webp",
          byteLength: 20,
          width: 2,
          height: 2,
        },
      });
    const ignoredReadiness = vi.fn(() => {
      throw new Error("untrusted readiness injection");
    });
    const options = {
      auth: standardAuth,
      db,
      adminOrigin: "https://panel.example.test",
      ...composition.ports,
      readReadiness: ignoredReadiness,
    };
    try {
      const api = createApp(options, { sink: () => {} });
      const path = "/v1/sites/site-one/gift-media/asset-one/finalize";
      for (const [target, contentType, body] of [
        [
          "/v1/sites/site-one/gift-media/uploads",
          "application/json",
          JSON.stringify(input),
        ],
        [path, "application/json", "{}"],
        [path, "application/json", '{"action":"RECOVER"}'],
        [path, "image/png", new Uint8Array([1, 2, 3])],
      ] as const) {
        const response = await api.request(target, {
          method: "POST",
          headers: { Origin: options.adminOrigin, "Content-Type": contentType },
          body,
        });
        expect(response.status).toBe(target.endsWith("uploads") ? 201 : 200);
      }
      for (const forwarded of [
        issue.mock.calls[0][4],
        consult.mock.calls[0][4],
        recover.mock.calls[0][4],
        finalize.mock.calls[0][5],
      ]) {
        expect(forwarded).toMatchObject({
          storage,
          storageNamespace: storage.storageNamespace,
          processing: composition.ports.processing,
          decode,
        });
      }
      expect(recheck).toHaveBeenCalledWith(
        expect.any(Request),
        expect.objectContaining({ auth: readAuth, db }),
      );
      expect(
        session.mock.calls.every((call) => call[1].auth === readAuth),
      ).toBe(true);
      expect(ignoredReadiness).not.toHaveBeenCalled();
      await api.request("/v1/sites/site-one/gifts", {
        headers: { Origin: options.adminOrigin },
      });
      expect(session.mock.lastCall?.[1].auth).toBe(standardAuth);
      expect((await api.request("/v1/health")).status).toBe(200);
      expect(storage.publishDerivative).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
    } finally {
      await composition.close();
      vi.restoreAllMocks();
    }
  });

  it("keeps the actual media service denied by authoritative default readiness", async () => {
    const actor = {
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    };
    vi.spyOn(authHttp, "requireAdminSession").mockResolvedValue(actor as never);
    vi.spyOn(authHttp, "readAdministrativeSession").mockResolvedValue(
      actor as never,
    );
    vi.spyOn(siteAccess, "requireSiteCapability").mockResolvedValue(
      undefined as never,
    );
    const storage = {
      storageNamespace: "existing-development-bucket",
      getDerivativeUrl: vi.fn(),
      headDerivative: vi.fn(),
      readDerivative: vi.fn(),
      publishDerivative: vi.fn(),
      close: vi.fn(async () => {}),
    };
    const decode = vi.fn() as never;
    const composition = await createGiftMediaComposition(
      {
        mode: "r2",
        accountId: "a".repeat(32),
        accessKeyId: "synthetic-key",
        secretAccessKey: "synthetic-secret",
        bucketName: storage.storageNamespace,
        publicOrigin: "https://images.example.test",
      },
      {
        createReadAuth: () => ({}) as never,
        createStorage: () => storage,
        decode,
      },
    );
    const transaction = vi.fn();
    try {
      const api = createApp(
        {
          auth: {} as never,
          db: { transaction } as never,
          adminOrigin: "https://panel.example.test",
          ...composition.ports,
        },
        { sink: () => {} },
      );
      const response = await api.request(
        "/v1/sites/site-one/gift-media/uploads",
        {
          method: "POST",
          headers: {
            Origin: "https://panel.example.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            contentType: "image/png",
            byteLength: 20,
            contentSha256: "a".repeat(64),
          }),
        },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "RECEIVING_NOT_READY",
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(storage.publishDerivative).not.toHaveBeenCalled();
      expect(decode).not.toHaveBeenCalled();
    } finally {
      await composition.close();
      vi.restoreAllMocks();
    }
  });
  it("forwards durable discovery through the explicit read-only session port without standard session writes", async () => {
    const now = () => new Date("2026-10-12T21:00:00.000Z");
    const actor = {
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    };
    const standard = vi
      .spyOn(authHttp, "requireAdminSession")
      .mockImplementation(async () => {
        throw new Error("Unexpected standard session activity");
      });
    vi.spyOn(siteAccess, "resolveSiteAccess").mockResolvedValue({
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
    });
    const context = {
      siteId: "site-one",
      mode: "sandbox",
      scopeRevision: "0",
      observedAt: now().toISOString(),
      observationOrder: {
        scopeRevision: "0",
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      newRequestAllowed: false,
      reason: "NOT_CONFIGURED",
      openRequest: null,
      recoverableRequests: [],
      nextCursor: null,
    };
    const readContext = vi.fn(async () => context);
    const requestStatus = {
      siteId: "site-one",
      requestId: "context",
      mode: "sandbox",
      scopeRevision: "0",
      requestRevision: null,
      observedAt: context.observedAt,
      observationOrder: context.observationOrder,
      state: "UNRESOLVED",
      command: null,
    };
    const readRequest = vi.fn(async () => requestStatus);
    const readSession = vi.fn(async () => actor);
    const update = vi.fn(() => {
      throw new Error("Unexpected persistent write");
    });
    const options = {
      auth: {} as never,
      db: { update } as never,
      adminOrigin: "https://panel.example.test",
      now,
      readAdministrativeSession: readSession as never,
      withdrawalReservation: { readContext, readRequest } as never,
    };
    try {
      const result = await createApp(options, { sink: () => {} }).request(
        new Request(
          "https://api.example.test/v1/sites/site-one/withdrawals/context",
          { headers: { Origin: options.adminOrigin } },
        ),
      );
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({ context });
      expect(readSession).toHaveBeenCalledExactlyOnceWith(
        expect.any(Request),
        options,
      );
      expect(readContext).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actor: {
            userId: "admin-one",
            siteId: "site-one",
            sessionId: "session-one",
          },
        }),
      );
      expect(standard).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(result.headers.get("set-cookie")).toBeNull();
      expect(result.headers.get("cache-control")).toBe("no-store");
      const api = createApp(options, { sink: () => {} });
      for (const method of ["GET", "HEAD"]) {
        const exact = await api.request(
          new Request(
            "https://api.example.test/v1/sites/site-one/withdrawals/requests/context",
            { method, headers: { Origin: options.adminOrigin } },
          ),
        );
        expect(exact.status).toBe(200);
        if (method === "GET")
          expect(await exact.json()).toEqual({ request: requestStatus });
        else expect(await exact.text()).toBe("");
        expect(exact.headers.get("set-cookie")).toBeNull();
        expect(exact.headers.get("cache-control")).toBe("no-store");
      }
      expect(readRequest).toHaveBeenCalledTimes(2);
      expect(standard).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      const absent = await createApp(
        { ...options, readAdministrativeSession: undefined },
        { sink: () => {} },
      ).request(
        new Request(
          "https://api.example.test/v1/sites/site-one/withdrawals/context",
          { headers: { Origin: options.adminOrigin } },
        ),
      );
      expect(absent.status).toBe(409);
      expect(readContext).toHaveBeenCalledTimes(1);
      expect(standard).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("forwards explicit withdrawal and proof ports while default startup stays unavailable", async () => {
    const instant = new Date("2026-10-12T21:00:00.000Z");
    const actor = {
      userId: "admin-one",
      siteId: "site-one",
      sessionId: "session-one",
    };
    const session = vi
      .spyOn(authHttp, "requireAdminSession")
      .mockResolvedValue({
        user: { id: actor.userId, role: "SITE_ADMIN" },
        session: { id: actor.sessionId },
      } as never);
    vi.spyOn(siteAccess, "resolveSiteAccess").mockResolvedValue({
      siteId: actor.siteId,
      userId: actor.userId,
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
    });
    const proof = createFinancialReauthentication({
      keyId: "synthetic-app-key",
      key: new Uint8Array(32).fill(5),
      maxAgeMs: 300000,
      now: () => new Date(instant),
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
    const intent = {
      id: "withdrawal-one",
      siteId: "site-one",
      amountCents: 10000,
      feeCents: 500,
      netCents: 9500,
      currency: "BRL" as const,
      destinationVersion: 1,
      state: "REQUESTED" as const,
      createdAt: instant.toISOString(),
      updatedAt: instant.toISOString(),
      mode: "sandbox" as const,
    };
    const confirmNew = vi.fn(async () => intent);
    const createWithdrawal = vi.fn();
    const options = {
      auth: {} as never,
      db: {} as never,
      adminOrigin: "https://panel.example.test",
      now: () => new Date(instant),
    };
    const input = {
      requestId: "request-one",
      action: "CONFIRM_NEW",
      reauthenticationToken: token,
    };
    const request = () =>
      new Request("https://api.example.test/v1/sites/site-one/withdrawals", {
        method: "POST",
        headers: {
          Origin: options.adminOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });
    try {
      const api = createApp(
        {
          ...options,
          financialReauthentication: proof,
          withdrawalReservation: { createWithdrawal, confirmNew } as never,
        },
        { sink: () => {} },
      );
      const result = await api.request(request());
      expect(result.status).toBe(200);
      expect(await result.json()).toEqual({
        requestId: input.requestId,
        withdrawal: intent,
      });
      expect(session).toHaveBeenCalledTimes(1);
      expect(confirmNew).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          actor,
          requestId: input.requestId,
          recentAuth: expect.objectContaining({
            ...actor,
            verification: "verified",
            provenance: "backend",
          }),
        }),
      );
      const disabled = await createApp(options, { sink: () => {} }).request(
        request(),
      );
      expect(disabled.status).toBe(409);
      expect(await disabled.json()).toMatchObject({
        code: "PROVIDER_MODE_UNAVAILABLE",
      });
      expect(disabled.headers.get("cache-control")).toBe("no-store");
      expect(confirmNew).toHaveBeenCalledTimes(1);
      expect(createWithdrawal).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("accepts explicit reviewed nomination composition ports without substituting the app auth handler", async () => {
    const db = {
      select: vi.fn(),
      execute: vi.fn(),
      update: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      transaction: vi.fn(),
    };
    const authentication = {
      db: db as never,
      secret: "synthetic-app-composition-secret-32-only",
      baseURL: "https://api.example.test",
      adminOrigin: "https://panel.example.test",
    };
    const auth = createAuth(authentication);
    const ports = createReceivingNominationComposition({
      standardAuth: auth,
      authentication,
      configuration: {
        mode: "sandbox",
        applicationEnvironment: "test",
        policyVersion: "synthetic-intent-v1",
        requestIdentityVersion: "nr1",
      },
      nomination: {
        repository: {
          readNominationScope: vi.fn(),
          findByRequest: vi.fn(),
          reserveNomination: vi.fn(),
        },
        loadSite: vi.fn(),
        generateId: vi.fn(),
      },
      reauthentication: {
        keyId: "synthetic-proof-key",
        key: new Uint8Array(32).fill(9),
        maxAgeMs: 60000,
        password: { verifyPassword: vi.fn() },
        rateLimit: { consume: vi.fn() },
      },
      now: () => new Date(),
    });
    const api = createApp(
      {
        auth,
        db: db as never,
        adminOrigin: authentication.adminOrigin,
        ...ports,
      },
      { sink: () => {} },
    );
    const response = await api.request(
      "/v1/sites/site-one/receiving/nomination-context",
      { headers: { Origin: authentication.adminOrigin } },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(auth.options.session).not.toHaveProperty("deferSessionRefresh");
    expect(ports).not.toHaveProperty("auth");
    expect(ports).not.toHaveProperty("handler");
    for (const port of Object.values(db)) expect(port).not.toHaveBeenCalled();
    expect((await api.request("/v1/health")).status).toBe(200);
  });
  it("registers read-only nomination context as unavailable by default without touching auth or storage", async () => {
    const touch = vi.spyOn(authHttp, "requireAdminSession");
    try {
      const api = createApp(
        {
          auth: {} as never,
          db: {} as never,
          adminOrigin: "https://panel.example.test",
        },
        { sink: () => {} },
      );
      const response = await api.request(
        "/v1/sites/site-one/receiving/nomination-context",
        { headers: { Origin: "https://panel.example.test" } },
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(touch).not.toHaveBeenCalled();
      expect((await api.request("/v1/health")).status).toBe(200);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("passes only explicitly injected read-only context/session services without enabling nomination POST", async () => {
    const configuration = {
      mode: "sandbox" as const,
      applicationEnvironment: "test" as const,
      policyVersion: "intent-v1",
      requestIdentityVersion: "nr1" as const,
    };
    const current = {
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    } as Awaited<ReturnType<typeof authHttp.requireAdminSession>>;
    const access = {
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
    vi.spyOn(siteAccess, "resolveSiteAccess").mockResolvedValue(
      access as never,
    );
    const touch = vi.spyOn(authHttp, "requireAdminSession");
    const readSession = vi.fn().mockResolvedValue(current);
    const readContext = vi.fn().mockResolvedValue({
      siteId: "site-one",
      mode: "sandbox",
      state: "AVAILABLE",
      requestId: deriveReceivingNominationRequestId({
        siteId: "site-one",
        operatorUserId: "admin-one",
        environment: "sandbox",
      }),
      policyVersion: "intent-v1",
    });
    const nominate = vi.fn();
    const readProof = vi.fn();
    try {
      const api = createApp(
        {
          auth: {} as never,
          db: {} as never,
          adminOrigin: "https://panel.example.test",
          readAdministrativeSession: readSession,
          receivingNominationContext: { configuration, readContext },
          receivingNomination: { configuration, nominate },
          financialReauthentication: { readProof, authenticate: vi.fn() },
        },
        { sink: () => {} },
      );
      const response = await api.request(
        "/v1/sites/site-one/receiving/nomination-context",
        { headers: { Origin: "https://panel.example.test" } },
      );
      expect(response.status).toBe(200);
      expect(readSession).toHaveBeenCalledTimes(1);
      expect(readContext).toHaveBeenCalledExactlyOnceWith({
        actor: {
          siteId: "site-one",
          userId: "admin-one",
          sessionId: "session-one",
        },
        access,
      });
      expect(touch).not.toHaveBeenCalled();
      expect(nominate).not.toHaveBeenCalled();
      expect(readProof).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("registers initial receiving nomination and leaves it unavailable without explicit services", async () => {
    vi.spyOn(authHttp, "requireAdminSession").mockResolvedValue({
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    } as Awaited<ReturnType<typeof authHttp.requireAdminSession>>);
    vi.spyOn(siteAccess, "resolveSiteAccess").mockResolvedValue({
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
    } as never);
    try {
      const api = createApp(
        {
          auth: {} as never,
          db: {} as never,
          adminOrigin: "https://panel.example.test",
        },
        { sink: () => {} },
      );
      const response = await api.request(
        "/v1/sites/site-one/receiving/nomination",
        {
          method: "POST",
          headers: {
            Origin: "https://panel.example.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            requestId: "request-one",
            confirmSelfAsRecipient: true,
            policyVersion: "intent-v1",
            reauthenticationToken: `fr1.${"a".repeat(80)}.${"b".repeat(43)}`,
          }),
        },
      );
      expect(response.status).toBe(409);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("registers financial reauthentication with the default disabled boundary", async () => {
    vi.spyOn(authHttp, "requireAdminSession").mockResolvedValue({
      user: { id: "admin-one", role: "SITE_ADMIN" },
      session: { id: "session-one" },
    } as Awaited<ReturnType<typeof authHttp.requireAdminSession>>);
    vi.spyOn(siteAccess, "resolveSiteAccess").mockResolvedValue({
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
    } as never);
    try {
      const api = createApp(
        {
          auth: {} as never,
          db: {} as never,
          adminOrigin: "https://panel.example.test",
        },
        { sink: () => {} },
      );
      const response = await api.request(
        "/v1/sites/site-one/financial-reauthentication",
        {
          method: "POST",
          headers: {
            Origin: "https://panel.example.test",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action: "CONFIGURE_RECEIVING",
            password: "test-only-password",
          }),
        },
      );
      expect(response.status).toBe(409);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("composes server-only financial reads after current site authorization", async () => {
    const access = {
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
    vi.spyOn(authHttp, "requireAdminSession").mockResolvedValue({
      user: { id: "admin-one", role: "SITE_ADMIN" },
    } as Awaited<ReturnType<typeof authHttp.requireAdminSession>>);
    const resolve = vi
      .spyOn(siteAccess, "resolveSiteAccess")
      .mockResolvedValue(access as never);
    const overview = {
      siteId: "site-one",
      currency: "BRL",
      nominalReceivedCents: 10000,
      netReceivedCents: 9500,
      processingCents: 300,
      commissionCents: 200,
      awaitingReleaseCents: 0,
      availableCents: null,
      pendingCommitmentsCents: 0,
      withdrawnCents: 0,
      refundedCents: 0,
      synchronizedAt: null,
      availability: "UNKNOWN",
      mode: "sandbox",
    };
    const readOverview = vi.fn().mockResolvedValue(overview);
    const listWithdrawals = vi.fn().mockResolvedValue([]);
    try {
      const api = createApp(
        {
          auth: {} as never,
          db: {} as never,
          adminOrigin: "https://panel.example.test",
          finance: { readOverview, listWithdrawals },
        },
        { sink: () => {} },
      );
      const response = await api.request("/v1/sites/site-one/finance", {
        headers: { Origin: "https://panel.example.test" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ overview });
      expect(readOverview).toHaveBeenCalledExactlyOnceWith("site-one");
      const history = await api.request("/v1/sites/site-one/withdrawals", {
        headers: { Origin: "https://panel.example.test" },
      });
      expect(await history.json()).toEqual({ withdrawals: [] });
      resolve.mockResolvedValueOnce(null);
      expect(
        (
          await api.request("/v1/sites/site-one/finance", {
            headers: { Origin: "https://panel.example.test" },
          })
        ).status,
      ).toBe(403);
      expect(readOverview).toHaveBeenCalledTimes(1);
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("registers the provider webhook independently of sessions and defaults to unavailable", async () => {
    const getSession = vi.fn();
    const options = {
      auth: { api: { getSession } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    const response = await api.request("/v1/webhooks/asaas", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "asaas-access-token": "local-test-webhook-token-for-disabled-runtime",
      },
      body: "{}",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      code: "WEBHOOK_UNAVAILABLE",
    });
    expect(getSession).not.toHaveBeenCalled();
  });
  it("composes the stored readiness reader into the authorized receiving endpoint", async () => {
    const readiness = {
      siteId: "site-one",
      state: "READY" as const,
      reason: null,
      observedAt: "2026-10-12T12:00:00.000Z",
      destinationVersion: 1,
      catalogEligible: true,
      mode: "sandbox" as const,
    };
    const requireSession = vi
      .spyOn(authHttp, "requireAdminSession")
      .mockResolvedValue({
        user: { id: "admin-one", role: "SITE_ADMIN" },
      } as Awaited<ReturnType<typeof authHttp.requireAdminSession>>);
    vi.spyOn(siteAccess, "resolveSiteAccess").mockResolvedValue({
      siteId: "site-one",
    } as never);
    const read = vi
      .spyOn(receivingRepository, "readReceivingReadiness")
      .mockResolvedValue(readiness);
    const options = {
      auth: {},
      db: {},
      adminOrigin: "https://panel.example.test",
      receiving: {
        mode: "sandbox" as const,
        applicationEnvironment: "test" as const,
        freshnessMs: 60000,
      },
    } as unknown as AuthHttpOptions & {
      receiving: receivingRepository.ReceivingRepositoryOptions;
    };
    try {
      const api = createApp(options, { sink: () => {} });
      const response = await api.request(
        "/v1/sites/site-one/receiving/readiness",
        { headers: { Origin: options.adminOrigin } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ readiness });
      expect(requireSession).toHaveBeenCalledOnce();
      expect(read).toHaveBeenCalledWith(
        options.db,
        "site-one",
        options.receiving,
      );
    } finally {
      vi.restoreAllMocks();
    }
  });
  it("mounts protected authentication routes without requiring a session for liveness", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const options = {
      auth: { api: { getSession } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    expect((await api.request("/v1/health")).status).toBe(200);
    expect(getSession).not.toHaveBeenCalled();
    const me = await api.request("/v1/me", {
      headers: { Origin: options.adminOrigin },
    });
    expect(me.status).toBe(401);
    expect(await me.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(getSession).toHaveBeenCalledOnce();
    for (const path of [
      "/v1/owner/sites",
      "/v1/owner/sites/one/admins",
      "/v1/sites/one",
      "/v1/sites/one/receiving/readiness",
      "/v1/sites/one/access",
      "/v1/sites/one/team",
      "/v1/sites/one/finance",
      "/v1/sites/one/withdrawals",
      "/v1/sites/one/gifts",
    ]) {
      const response = await api.request(path, {
        headers: { Origin: options.adminOrigin },
      });
      expect(response.status).toBe(401);
    }
    const handoff = await api.request("/v1/handoff", {
      method: "POST",
      headers: { Origin: options.adminOrigin },
    });
    expect(handoff.status).toBe(401);
  });

  it("enforces the team router's origin and anonymous write boundaries in composition", async () => {
    const options = {
      auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    expect(
      (
        await api.request("/v1/sites/one/team", {
          headers: { Origin: "https://untrusted.example.test" },
        })
      ).status,
    ).toBe(403);
    for (const path of [
      "/v1/sites/one/team/invitations",
      "/v1/sites/one/team/members/helper/revoke",
    ]) {
      const response = await api.request(path, {
        method: "POST",
        headers: {
          Origin: options.adminOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    }
    const accept = await api.request("/v1/team-invitations/accept", {
      method: "POST",
      headers: {
        Origin: options.adminOrigin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ role: "SITE_ADMIN", siteId: "another-site" }),
    });
    expect(accept.status).toBe(400);
    expect(await accept.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("keeps team middleware inside its own routes when another public handler is composed", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const options = {
      auth: { api: { getSession } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    api.get("/v1/public/probe", (context) => context.json({ reachable: true }));
    const response = await api.request("/v1/public/probe", {
      headers: { Origin: "https://wedding.example.test" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ reachable: true });
    expect(getSession).not.toHaveBeenCalled();
  });

  it("dispatches public catalog preflight without private session middleware", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const options = {
      auth: { api: { getSession } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    const response = await api.request(
      "http://localhost/v1/public/sites/one/gifts",
      { method: "OPTIONS", headers: { Origin: "http://localhost:4322" } },
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:4322",
    );
    expect(getSession).not.toHaveBeenCalled();
  });

  it("registers default-disabled public quote/checkout/recovery without private middleware", async () => {
    const getSession = vi.fn().mockResolvedValue(null);
    const options = {
      auth: { api: { getSession } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    for (const endpoint of [
      "gift-quotes",
      "gift-checkouts",
      "gift-checkouts/status",
    ]) {
      const path = `http://localhost/v1/public/sites/site-one/${endpoint}`;
      const headers = {
        Origin: "http://localhost:4325",
        "Content-Type": "application/json",
      };
      const response = await api.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify(
          endpoint === "gift-quotes"
            ? { giftId: "gift-one", method: "PIX" }
            : {
                quoteId: "quote-one",
                requestId: "request-one",
                recoveryToken: "A".repeat(43),
              },
        ),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "PROVIDER_MODE_UNAVAILABLE",
      });
      expect(
        (await api.request(path, { method: "OPTIONS", headers })).status,
      ).toBe(204);
    }
    expect(getSession).not.toHaveBeenCalled();
  });

  it("registers protected media upload and finalization without invoking storage", async () => {
    const options = {
      auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
      db: {},
      adminOrigin: "https://panel.example.test",
    } as unknown as AuthHttpOptions;
    const api = createApp(options, { sink: () => {} });
    for (const [path, body] of [
      [
        "/v1/sites/site-one/gift-media/uploads",
        { contentType: "image/png", byteLength: 1000 },
      ],
      ["/v1/sites/site-one/gift-media/asset-one/finalize", {}],
    ] as const) {
      const response = await api.request(path, {
        method: "POST",
        headers: {
          Origin: options.adminOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
      const foreign = await api.request(path, {
        method: "POST",
        headers: {
          Origin: "https://evil.example.test",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      expect(foreign.status).toBe(403);
    }
  });
});

const historyOrigin = "https://admin.example.test";
const historyIndex = "/v1/sites/site-one/finance/purchases";
const historyDetail = `${historyIndex}/order-one/history`;
const historyInstant = new Date("2026-10-13T14:00:00.000Z");
function historyGate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
async function nativeHistoryApp() {
  const storedSession = {
    id: "session-one",
    userId: "viewer-one",
    token: "fictional-app-history-token",
    createdAt: new Date(historyInstant.getTime() - 60000),
    updatedAt: new Date(historyInstant.getTime() - 60000),
    lastActiveAt: new Date(historyInstant.getTime() - 60000),
    expiresAt: new Date(historyInstant.getTime() + 3600000),
    ipAddress: null,
    userAgent: null,
  };
  const storedUser = {
    id: "viewer-one",
    name: "Fictional Viewer",
    email: "fictional@example.test",
    role: "SITE_ADMIN",
    state: "ACTIVE",
    emailVerified: true,
    image: null,
    createdAt: storedSession.createdAt,
    updatedAt: storedSession.updatedAt,
  };
  const membership = {
    user_id: "viewer-one",
    account_role: "SITE_ADMIN",
    account_state: "ACTIVE",
    site_id: "site-one",
    membership_id: "membership-one",
    membership_user_id: "viewer-one",
    membership_role: "SITE_ADMIN",
    revoked_at: null,
  };
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                sessionId: storedSession.id,
                userId: storedSession.userId,
                sessionCreatedAt: storedSession.createdAt,
                sessionExpiresAt: storedSession.expiresAt,
                lastActiveAt: storedSession.lastActiveAt,
                userName: storedUser.name,
                userEmail: storedUser.email,
                userRole: storedUser.role,
                userState: storedUser.state,
              },
            ],
          }),
        }),
      }),
    })),
    execute: vi.fn(async (value) => {
      expect(new PgDialect().sqlToQuery(value).sql).toMatch(/SELECT/);
      return { rows: [{ ...membership }] };
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    close: vi.fn(),
  };
  const secret = "fictional-app-history-cookie-secret-32";
  const readAuth = createSessionReadAuth({
    db: db as never,
    secret,
    baseURL: "https://api.example.test",
    adminOrigin: historyOrigin,
  });
  const nativeContext = await readAuth.$context;
  const native = vi
    .spyOn(nativeContext.internalAdapter, "findSession")
    .mockImplementation(
      async () =>
        ({
          session: structuredClone(storedSession),
          user: structuredClone(storedUser),
        }) as never,
    );
  const deletion = vi
    .spyOn(nativeContext.internalAdapter, "deleteSession")
    .mockResolvedValue(undefined);
  const cookie = encodeURIComponent(
    storedSession.token +
      "." +
      createHmac("sha256", secret).update(storedSession.token).digest("base64"),
  );
  const response: GiftPurchaseHistoryPageResponse = {
    history: {
      scope: { siteId: "site-one", mode: "sandbox", policy: "SITE_HISTORY" },
      consistency: "PER_READ",
      readObservedAtMicros: "1791900000000000",
      currentKnowledge: "UNKNOWN",
      sourceOrdering: "UNAVAILABLE",
      items: [],
      nextCursor: null,
    },
  };
  const { items: _items, ...detailEnvelope } = response.history;
  const detail: GiftPurchaseHistoryDetailResponse = {
    history: {
      ...detailEnvelope,
      currentKnowledge: "UNAVAILABLE",
      originalPurchase: {
        siteId: "site-one",
        mode: "sandbox",
        orderId: "order-one",
        quoteId: "quote-one",
        giftId: "gift-one",
        titleSnapshot: "Original archived gift",
        method: "PIX",
        currency: "BRL",
        purchasedAtMicros: "1791824110000123",
        destinationVersion: 1,
        policyVersion: "original-policy",
        binding: "UNBOUND",
        quoted: {
          nominalCents: 10000,
          commissionCents: 200,
          processingCents: 39,
          totalCents: 10239,
        },
      },
      coverage: {
        payments: "UNAVAILABLE",
        receipts: "UNAVAILABLE",
        reversals: "UNAVAILABLE",
        bankSettlement: "UNAVAILABLE",
      },
      retainedPayments: [],
      validatedHistoricalReceipts: [],
    },
  };
  const repository = {
    database: db as never,
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    policy: "SITE_HISTORY" as const,
    readPurchasePage: vi.fn<GiftPaymentHistoryRepository["readPurchasePage"]>(
      async () => response,
    ),
    readPurchaseDetailPage: vi.fn<
      GiftPaymentHistoryRepository["readPurchaseDetailPage"]
    >(async () => detail),
    close: vi.fn(async () => {}),
  };
  const service = createGiftPaymentHistory({
    mode: "sandbox",
    applicationEnvironment: "test",
    policy: "SITE_HISTORY",
    adminOrigin: historyOrigin,
    now: () => new Date(historyInstant),
    authentication: { auth: readAuth, db: db as never },
    repository,
  });
  const standardSession = vi.fn(async () => null);
  const actions = {
    authenticate: vi.fn(),
    readProof: vi.fn(),
    nominate: vi.fn(),
  };
  const events: unknown[] = [];
  const api = createApp(
    {
      auth: { api: { getSession: standardSession } } as never,
      db: db as never,
      adminOrigin: historyOrigin,
      giftPaymentHistory: service,
      financialReauthentication: actions as never,
      receivingNomination: actions as never,
    },
    { sink: (event) => events.push(event) },
  );
  const request = (path = historyIndex, init: RequestInit = {}) => {
    const headers = new Headers({
      origin: historyOrigin,
      cookie: `${nativeContext.authCookies.sessionToken.name}=${cookie}`,
    });
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    return new Request(`https://api.example.test${path}`, { ...init, headers });
  };
  return {
    api,
    service,
    repository,
    response,
    detail,
    native,
    deletion,
    db,
    membership,
    standardSession,
    actions,
    events,
    request,
  };
}
describe("owned history composition", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(historyInstant);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("keeps both exact history resources unavailable by default without private work", async () => {
    const standardSession = vi.fn(async () => null);
    const db = {
      select: vi.fn(),
      execute: vi.fn(),
      update: vi.fn(),
      close: vi.fn(),
    };
    const apps = [
      createApp(undefined, { sink: () => {} }),
      createApp(
        {
          auth: { api: { getSession: standardSession } } as never,
          db: db as never,
          adminOrigin: historyOrigin,
        },
        { sink: () => {} },
      ),
    ];
    for (const api of apps) {
      for (const path of [historyIndex, historyDetail]) {
        const result = await api.request(path, {
          headers: { origin: historyOrigin },
        });
        expect(result.status).toBe(503);
        expect(result.headers.get("cache-control")).toBe("no-store");
        expect(await result.json()).toMatchObject({
          code: "GIFT_PAYMENT_HISTORY_UNAVAILABLE",
        });
      }
      await api.close();
      expect((await api.request("/v1/health")).status).toBe(200);
    }
    expect(standardSession).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
    expect(db.execute).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
    expect(db.close).not.toHaveBeenCalled();
  });
  it("dispatches real signed native reads independently of ordinary administrative activity and actions", async () => {
    const v = await nativeHistoryApp();
    const ordinary = vi
      .spyOn(authHttp, "requireAdminSession")
      .mockRejectedValue(new Error("private-standard-activity"));
    const activity = vi
      .spyOn(authHttp, "getAdministrativeSession")
      .mockRejectedValue(new Error("private-standard-activity"));
    const readiness = vi
      .spyOn(receivingRepository, "readReceivingReadiness")
      .mockRejectedValue(new Error("private-current-readiness"));
    try {
      const index = await v.api.fetch(
        v.request(`${historyIndex}?cursor=navigation-only`),
      );
      expect(index.status).toBe(200);
      expect(await index.json()).toEqual(v.response);
      const detail = await v.api.fetch(v.request(historyDetail));
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual(v.detail);
      const head = await v.api.fetch(
        v.request(historyDetail, { method: "HEAD" }),
      );
      expect(head.status).toBe(200);
      expect(await head.text()).toBe("");
      expect(v.native).toHaveBeenCalledTimes(6);
      expect(v.repository.readPurchasePage.mock.calls[0]?.[1]).toBe(
        "navigation-only",
      );
      expect(ordinary).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
      expect(readiness).not.toHaveBeenCalled();
      expect(v.standardSession).not.toHaveBeenCalled();
      for (const action of Object.values(v.actions))
        expect(action).not.toHaveBeenCalled();
      for (const write of [v.db.insert, v.db.update, v.db.delete, v.deletion])
        expect(write).not.toHaveBeenCalled();
      expect(index.headers.get("x-request-id")).toBeTruthy();
      expect(JSON.stringify(v.events)).not.toMatch(
        /navigation-only|fictional-app-history-token|cookie|Original archived gift/,
      );
      expect(v.events).toHaveLength(3);
    } finally {
      await v.api.close();
    }
    expect(v.repository.close).toHaveBeenCalledTimes(1);
    expect(v.db.close).not.toHaveBeenCalled();
  });
  it("denies actual membership replacement at native settlement through app dispatch", async () => {
    const v = await nativeHistoryApp();
    const pending = historyGate<GiftPurchaseHistoryPageResponse>();
    v.repository.readPurchasePage.mockImplementation(() => pending.promise);
    const response = v.api.fetch(v.request());
    try {
      await vi.waitFor(() =>
        expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1),
      );
      v.membership.membership_id = "replacement-membership";
      pending.resolve(v.response);
      const result = await response;
      expect(result.status).toBe(503);
      expect(await result.json()).toEqual({
        type: "about:blank",
        status: 503,
        code: "GIFT_PAYMENT_HISTORY_UNAVAILABLE",
        title: "Purchase history unavailable",
      });
      expect(v.standardSession).not.toHaveBeenCalled();
      expect(v.db.update).not.toHaveBeenCalled();
    } finally {
      pending.resolve(v.response);
      await v.api.close();
    }
  });
  it("memoized app close drains actual pending native confirmation while preserving shared dependencies", async () => {
    const v = await nativeHistoryApp();
    const gate = historyGate<void>();
    const original = v.native.getMockImplementation();
    let calls = 0;
    v.native.mockImplementation(async (token) => {
      if (++calls === 2) await gate.promise;
      return original ? original(token) : null;
    });
    let finished = false;
    const response = Promise.resolve(v.api.fetch(v.request())).then((value) => {
      finished = true;
      return value;
    });
    try {
      await vi.waitFor(() => expect(v.native).toHaveBeenCalledTimes(2));
      const close = v.api.close();
      expect(v.api.close()).toBe(close);
      const callerClose = v.service.close();
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(v.repository.close).not.toHaveBeenCalled();
      const unavailable = await v.api.fetch(v.request());
      expect(unavailable.status).toBe(503);
      gate.resolve();
      expect((await response).status).toBe(503);
      await Promise.all([close, callerClose]);
      expect(v.repository.close).toHaveBeenCalledTimes(1);
      expect(v.db.close).not.toHaveBeenCalled();
      expect(v.db.update).not.toHaveBeenCalled();
      expect(v.deletion).not.toHaveBeenCalled();
      expect((await v.api.request("/v1/health")).status).toBe(200);
    } finally {
      gate.resolve();
      await v.api.close();
    }
  });
  it("preserves neighboring routes and their original standard authentication", async () => {
    const v = await nativeHistoryApp();
    v.api.get("/v1/public/history-neighbor", (context) =>
      context.json({ reachable: true }),
    );
    try {
      expect((await v.api.fetch(v.request())).status).toBe(200);
      expect(v.standardSession).not.toHaveBeenCalled();
      for (const path of [
        "/v1/sites/site-one/finance",
        "/v1/sites/site-one/gifts",
        "/v1/sites/site-one/team",
      ]) {
        const response = await v.api.fetch(v.request(path));
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
      }
      expect(v.standardSession).toHaveBeenCalledTimes(3);
      expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1);
      expect((await v.api.request("/v1/health")).status).toBe(200);
      expect((await v.api.request("/v1/public/history-neighbor")).status).toBe(
        200,
      );
      expect(v.standardSession).toHaveBeenCalledTimes(3);
    } finally {
      await v.api.close();
    }
  });
});
