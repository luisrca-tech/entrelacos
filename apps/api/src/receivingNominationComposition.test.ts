import { createHash, createHmac } from "node:crypto";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import * as authModule from "./auth";
import { type AuthFactoryOptions, createAuth } from "./auth";
import type { ReceivingNominationSnapshot } from "./receivingNomination";
import {
  createReceivingNominationComposition,
  type ReceivingNominationCompositionOptions,
} from "./receivingNominationComposition";

const instant = new Date("2026-10-12T21:00:00.000Z");
const origin = "https://admin.example.test";
const authSecret = "synthetic-composition-auth-secret-32-only";
const sessionToken = "synthetic-composition-session-token";
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(policyVersion = "intent-v1") {
  const storedSession = {
    id: "session-one",
    userId: "user-one",
    token: sessionToken,
    createdAt: new Date(instant.getTime() - 60000),
    updatedAt: new Date(instant.getTime() - 60000),
    lastActiveAt: new Date(instant.getTime() - 60000),
    expiresAt: new Date(instant.getTime() + 3600000),
    ipAddress: null,
    userAgent: null,
  };
  const storedUser = {
    id: "user-one",
    name: "Synthetic Admin",
    email: "synthetic@example.test",
    emailVerified: true,
    image: null,
    role: "SITE_ADMIN",
    state: "ACTIVE",
    createdAt: new Date(instant.getTime() - 3600000),
    updatedAt: new Date(instant.getTime() - 3600000),
  };
  const membership = {
    user_id: "user-one",
    account_role: "SITE_ADMIN",
    account_state: "ACTIVE",
    site_id: "site-one",
    membership_id: "membership-one",
    membership_user_id: "user-one",
    membership_role: "SITE_ADMIN",
    revoked_at: null as Date | null,
  };
  const state = { missing: false, databaseSessionMissing: false };
  const dialect = new PgDialect();
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () =>
              state.databaseSessionMissing
                ? []
                : [
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
    execute: vi.fn(async (statement) => {
      const query = dialect.sqlToQuery(statement);
      expect(query.sql).toMatch(/SELECT/);
      expect(query.params).toContain("user-one");
      return { rows: [{ ...membership }] };
    }),
    insert: vi.fn(),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => []) })),
    })),
    delete: vi.fn(),
    transaction: vi.fn(),
  };
  const authConfiguration: AuthFactoryOptions = {
    db: db as never,
    secret: authSecret,
    baseURL: "https://api.example.test",
    adminOrigin: origin,
  };
  const auth = createAuth(authConfiguration);
  const actualBuilder = authModule.createSessionReadAuth;
  let readAuth!: ReturnType<typeof createAuth>;
  const builder = vi
    .spyOn(authModule, "createSessionReadAuth")
    .mockImplementation((options) => {
      readAuth = actualBuilder(options);
      return readAuth;
    });
  let pending: ReceivingNominationSnapshot | null = null;
  const repository = {
    readNominationScope: vi.fn(async () => pending),
    findByRequest: vi.fn(async () => pending),
    reserveNomination: vi.fn(),
  };
  const rateLimit = { consume: vi.fn(async () => true) };
  const password = { verifyPassword: vi.fn(async () => true) };
  const clock = vi.fn(() => new Date(instant));
  const options = {
    standardAuth: auth,
    authentication: authConfiguration,
    configuration: {
      mode: "sandbox" as const,
      applicationEnvironment: "test" as const,
      policyVersion,
      requestIdentityVersion: "nr1" as const,
    },
    nomination: {
      repository,
      loadSite: vi.fn(async () => ({ siteId: "site-one", isDemo: false })),
      generateId: vi.fn((kind: "account" | "operation") => `${kind}-one`),
    },
    reauthentication: {
      keyId: "proof-key-one",
      key: new Uint8Array(32).fill(7),
      maxAgeMs: 300000,
      rateLimit,
      password,
    },
    now: clock,
  };
  const ports = createReceivingNominationComposition(options);
  const native = await readAuth.$context;
  const standard = await auth.$context;
  const lookup = () =>
    state.missing
      ? null
      : {
          session: structuredClone(storedSession),
          user: structuredClone(storedUser),
        };
  const findSession = vi
    .spyOn(native.internalAdapter, "findSession")
    .mockImplementation(async () => lookup() as never);
  const standardFindSession = vi
    .spyOn(standard.internalAdapter, "findSession")
    .mockImplementation(async () => lookup() as never);
  const readDeleteSession = vi
    .spyOn(native.internalAdapter, "deleteSession")
    .mockResolvedValue(undefined);
  const standardDeleteSession = vi
    .spyOn(standard.internalAdapter, "deleteSession")
    .mockResolvedValue(undefined);
  const readGetSession = vi.spyOn(readAuth.api, "getSession");
  const standardGetSession = vi.spyOn(auth.api, "getSession");
  const signature = createHmac("sha256", authSecret)
    .update(sessionToken)
    .digest("base64");
  const headers = new Headers({
    Origin: origin,
    Cookie: `${native.authCookies.sessionToken.name}=${encodeURIComponent(`${sessionToken}.${signature}`)}`,
  });
  const app = createApp(
    { auth, db: db as never, adminOrigin: origin, ...ports },
    { sink: () => {} },
  );
  const get = (siteId = "site-one", suppliedHeaders = headers) =>
    app.request(`/v1/sites/${siteId}/receiving/nomination-context`, {
      headers: suppliedHeaders,
    });
  const setPending = (originalPolicy = "intent-v1") => {
    pending = {
      state: "AWAITING_PROVIDER_VERIFICATION",
      siteId: "site-one",
      requestId: "legacy-original-request",
      operatorUserId: "user-one",
      environment: "sandbox",
      policyVersion: originalPolicy,
      accountId: "private-account",
      operationId: "private-operation",
      createdAt: new Date(instant.getTime() - 30000).toISOString(),
      requestHash: createHash("sha256")
        .update(
          JSON.stringify([
            "receiving.self-nomination.v1",
            "site-one",
            "legacy-original-request",
            "user-one",
            "sandbox",
            originalPolicy,
            true,
          ]),
        )
        .digest("hex"),
      authentication: {
        userId: "user-one",
        siteId: "site-one",
        sessionId: "legacy-session",
        proofKind: "PASSWORD_REAUTHENTICATION",
        authenticatedAt: new Date(instant.getTime() - 45000).toISOString(),
        expiresAt: new Date(instant.getTime() + 255000).toISOString(),
      },
    };
    return pending;
  };
  const assertNoWrites = () => {
    for (const write of [
      db.insert,
      db.update,
      db.delete,
      db.transaction,
      readDeleteSession,
      repository.reserveNomination,
      repository.findByRequest,
      rateLimit.consume,
      password.verifyPassword,
    ])
      expect(write).not.toHaveBeenCalled();
  };
  return {
    options,
    ports,
    auth,
    readAuth,
    native,
    standard,
    builder,
    db,
    repository,
    rateLimit,
    password,
    clock,
    storedSession,
    storedUser,
    membership,
    state,
    get,
    headers,
    app,
    findSession,
    standardFindSession,
    readGetSession,
    standardGetSession,
    readDeleteSession,
    standardDeleteSession,
    setPending,
    assertNoWrites,
  };
}

describe("optional nomination composition with the installed native session SDK", () => {
  it("preserves explicit clock, site-reader and ID-generator receivers through context and first nomination", async () => {
    const v = await fixture();
    const options: ReceivingNominationCompositionOptions = {
      ...v.options,
      now() {
        expect(this === options).toBe(true);
        return new Date(instant);
      },
      nomination: {
        ...v.options.nomination,
        loadSite(siteId) {
          expect(this === options.nomination).toBe(true);
          return Promise.resolve({ siteId, isDemo: false });
        },
        generateId(kind) {
          expect(this === options.nomination).toBe(true);
          return `${kind}-receiver`;
        },
      },
    };
    const ports = createReceivingNominationComposition(options);
    expect(ports.now()).toEqual(instant);
    const actor = {
      siteId: "site-one",
      userId: "user-one",
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
    const result = await ports.receivingNominationContext.readContext({
      actor,
      access,
    });
    expect(result.state).toBe("AVAILABLE");
    v.assertNoWrites();
    v.repository.reserveNomination.mockImplementation(
      async (snapshot, authorize) => {
        await authorize({
          access,
          currentSession: actor,
          designatedOperatorUserId: null,
          hasProviderBinding: false,
        });
        return snapshot;
      },
    );
    const proof = await ports.financialReauthentication.authenticate(
      actor,
      "CONFIGURE_RECEIVING",
      "synthetic-password",
    );
    const nomination = await ports.receivingNomination.nominate({
      actor,
      access,
      recentAuth: ports.financialReauthentication.readProof(
        actor,
        "CONFIGURE_RECEIVING",
        proof.reauthenticationToken,
      ),
      input: {
        requestId: result.requestId,
        policyVersion: result.policyVersion,
        confirmSelfAsRecipient: true,
      },
    });
    expect(nomination).toMatchObject({
      requestId: result.requestId,
      accountId: "account-receiver",
      operationId: "operation-receiver",
    });
    expect(v.repository.reserveNomination).toHaveBeenCalledTimes(1);
  });
  it("constructs distinct private GET auth and composes AVAILABLE without persistent writes or outer cookies", async () => {
    const v = await fixture();
    const response = await v.get();
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.context).toMatchObject({
      siteId: "site-one",
      state: "AVAILABLE",
      mode: "sandbox",
      policyVersion: "intent-v1",
    });
    expect(body.context.requestId).toMatch(/^nr1_[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(body)).not.toMatch(
      /private|synthetic|session-one|proof-key|user-one|credential|READY/,
    );
    expect(v.builder).toHaveBeenCalledTimes(1);
    expect(v.readAuth).not.toBe(v.auth);
    expect(v.native).not.toBe(v.standard);
    expect(v.auth.options.session).not.toHaveProperty("deferSessionRefresh");
    expect(v.readAuth.options.session).toMatchObject({
      deferSessionRefresh: true,
    });
    expect(v.findSession).toHaveBeenCalledExactlyOnceWith(sessionToken);
    expect(v.standardGetSession).not.toHaveBeenCalled();
    expect(v.repository.readNominationScope).toHaveBeenCalledExactlyOnceWith({
      siteId: "site-one",
      operatorUserId: "user-one",
      environment: "sandbox",
    });
    expect(Object.keys(v.ports).sort()).toEqual([
      "financialReauthentication",
      "now",
      "readAdministrativeSession",
      "receivingNomination",
      "receivingNominationContext",
    ]);
    v.assertNoWrites();
  });
  it.each(["intent-v1", "intent-v2"])(
    "preserves legacy PENDING and original policy under configured %s",
    async (policyVersion) => {
      const v = await fixture(policyVersion);
      const original = v.setPending();
      const response = await v.get();
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.context).toMatchObject({
        state: "PENDING",
        requestId: original.requestId,
        policyVersion: "intent-v1",
        currentPolicyVersion: policyVersion,
        postAllowed: policyVersion === "intent-v1",
      });
      expect(body.context.nomination.requestId).toBe(original.requestId);
      expect(body.context.nomination.createdAt).toBe(original.createdAt);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(original.authentication.sessionId).toBe("legacy-session");
      v.assertNoWrites();
    },
  );
  it.each([
    "expired-native",
    "missing-native",
    "missing-stored",
    "idle",
    "absolute",
    "disabled-user",
    "forged",
    "absent-cookie",
  ])(
    "denies %s with no mutation or outer expiry-cookie forwarding",
    async (scenario) => {
      const v = await fixture();
      const headers = new Headers(v.headers);
      if (scenario === "expired-native")
        v.storedSession.expiresAt = new Date(instant.getTime() - 1);
      if (scenario === "missing-native") v.state.missing = true;
      if (scenario === "missing-stored") v.state.databaseSessionMissing = true;
      if (scenario === "idle") {
        v.storedSession.lastActiveAt = new Date(instant.getTime() - 86400000);
        v.storedSession.createdAt = new Date(v.storedSession.lastActiveAt);
      }
      if (scenario === "absolute")
        v.storedSession.createdAt = new Date(instant.getTime() - 7 * 86400000);
      if (scenario === "disabled-user") v.storedUser.state = "DISABLED";
      if (scenario === "forged")
        headers.set(
          "Cookie",
          `${v.native.authCookies.sessionToken.name}=${sessionToken}.invalid-signature`,
        );
      if (scenario === "absent-cookie") headers.delete("Cookie");
      const response = await v.get("site-one", headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(v.repository.readNominationScope).not.toHaveBeenCalled();
      v.assertNoWrites();
      if (["forged", "absent-cookie"].includes(scenario)) {
        expect(v.findSession).not.toHaveBeenCalled();
        expect(v.db.select).not.toHaveBeenCalled();
      }
    },
  );
  it.each(["revoked", "assistant", "foreign-site", "owner"])(
    "denies current %s membership without writes",
    async (scenario) => {
      const v = await fixture();
      if (scenario === "revoked") v.membership.revoked_at = new Date(instant);
      if (scenario === "assistant")
        v.membership.membership_role = "SITE_ASSISTANT";
      if (scenario === "owner") v.storedUser.role = "OWNER";
      const response = await v.get(
        scenario === "foreign-site" ? "other-site" : "site-one",
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(v.repository.readNominationScope).not.toHaveBeenCalled();
      v.assertNoWrites();
    },
  );
  it("requires a real compatible standard auth binding, shared password/rate-limit and explicit configuration", async () => {
    const v = await fixture();
    for (const change of [
      { standardAuth: v.readAuth },
      {
        authentication: {
          ...v.options.authentication,
          secret: "wrong-synthetic-secret",
        },
      },
      {
        reauthentication: {
          ...v.options.reauthentication,
          rateLimit: undefined,
        },
      },
      {
        reauthentication: {
          ...v.options.reauthentication,
          password: undefined,
        },
      },
      { configuration: { ...v.options.configuration, policyVersion: "" } },
    ]) {
      expect(() =>
        createReceivingNominationComposition({
          ...v.options,
          ...change,
        } as typeof v.options),
      ).toThrow();
    }
    v.assertNoWrites();
  });
  it("rejects a mismatched application db/auth/clock/origin instead of quietly authenticating another scope", async () => {
    const v = await fixture();
    const request = new Request(
      "https://api.example.test/v1/sites/site-one/receiving/nomination-context",
      { headers: v.headers },
    );
    for (const change of [
      { db: {} },
      { auth: v.readAuth },
      { now: () => new Date(instant) },
    ]) {
      await expect(
        v.ports.readAdministrativeSession(request, {
          auth: v.auth,
          db: v.options.authentication.db,
          now: v.ports.now,
          ...change,
        } as never),
      ).rejects.toMatchObject({ status: 503 });
    }
    const foreign = new Request(request.url, {
      headers: {
        ...Object.fromEntries(v.headers),
        Origin: "https://evil.example",
      },
    });
    await expect(
      v.ports.readAdministrativeSession(foreign, {
        auth: v.auth,
        db: v.options.authentication.db,
        now: v.ports.now,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(v.findSession).not.toHaveBeenCalled();
    v.assertNoWrites();
  });
  it("preserves standard /me activity and password POST authentication after a non-mutating context GET", async () => {
    const v = await fixture();
    expect((await v.get()).status).toBe(200);
    v.assertNoWrites();
    const me = await v.app.request("/v1/me", { headers: v.headers });
    expect(me.status).toBe(200);
    expect(v.db.update).toHaveBeenCalledTimes(1);
    expect(v.standardGetSession).toHaveBeenCalledTimes(1);
    const proof = await v.app.request(
      "/v1/sites/site-one/financial-reauthentication",
      {
        method: "POST",
        headers: {
          ...Object.fromEntries(v.headers),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action: "CONFIGURE_RECEIVING",
          password: "synthetic-password",
        }),
      },
    );
    expect(proof.status).toBe(200);
    expect((await proof.json()).reauthenticationToken).toMatch(/^fr1\./);
    expect(v.standardGetSession).toHaveBeenCalledTimes(2);
    expect(v.readGetSession).toHaveBeenCalledTimes(1);
    expect(v.db.update).toHaveBeenCalledTimes(2);
    expect(v.rateLimit.consume).toHaveBeenCalledExactlyOnceWith("user-one");
    expect(v.password.verifyPassword).toHaveBeenCalledExactlyOnceWith({
      userId: "user-one",
      password: "synthetic-password",
    });
  });
  it("keeps native expired-session cleanup on the standard instance while GET emits no cookie or writes", async () => {
    const v = await fixture();
    v.storedSession.expiresAt = new Date(instant.getTime() - 1);
    const context = await v.get();
    expect(context.status).toBe(401);
    expect(context.headers.get("set-cookie")).toBeNull();
    v.assertNoWrites();
    const me = await v.app.request("/v1/me", { headers: v.headers });
    expect(me.status).toBe(401);
    expect(v.standardDeleteSession).toHaveBeenCalledTimes(1);
    expect(v.readDeleteSession).not.toHaveBeenCalled();
    expect(v.auth.options.session).not.toHaveProperty("deferSessionRefresh");
  });
  it("replays an original legacy nomination through standard POST auth and the configured same-session proof", async () => {
    const v = await fixture();
    const original = v.setPending();
    expect((await v.get()).status).toBe(200);
    v.assertNoWrites();
    v.repository.reserveNomination.mockImplementation(
      async (snapshot, authorize, authorization) => {
        await authorize({
          access: {
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
          },
          currentSession: authorization.actor,
          designatedOperatorUserId: "user-one",
          hasProviderBinding: false,
        });
        expect(snapshot).toEqual(original);
        return snapshot;
      },
    );
    const proof = await v.ports.financialReauthentication.authenticate(
      { siteId: "site-one", userId: "user-one", sessionId: "session-one" },
      "CONFIGURE_RECEIVING",
      "synthetic-password",
    );
    const response = await v.app.request(
      "/v1/sites/site-one/receiving/nomination",
      {
        method: "POST",
        headers: {
          ...Object.fromEntries(v.headers),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          requestId: original.requestId,
          policyVersion: original.policyVersion,
          confirmSelfAsRecipient: true,
          reauthenticationToken: proof.reauthenticationToken,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.nomination.requestId).toBe(original.requestId);
    expect(body.nomination.createdAt).toBe(original.createdAt);
    expect(original.authentication.sessionId).toBe("legacy-session");
    expect(v.options.nomination.generateId).not.toHaveBeenCalled();
    expect(v.standardGetSession).toHaveBeenCalledTimes(1);
    expect(v.readGetSession).toHaveBeenCalledTimes(1);
    expect(v.db.update).toHaveBeenCalledTimes(1);
    expect(v.repository.reserveNomination).toHaveBeenCalledTimes(1);
  });
});
