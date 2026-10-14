import { createHmac } from "node:crypto";
import { isPromise } from "node:util/types";
import { runInNewContext } from "node:vm";
import {
  type GiftPurchaseHistoryDetailResponse,
  type GiftPurchaseHistoryPageResponse,
  giftPurchaseHistoryDetailResponseSchema,
  giftPurchaseHistoryPageResponseSchema,
} from "@entrelacos/contracts";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionReadAuth } from "./auth";
import * as authHttp from "./authHttp";
import type {
  GiftPaymentHistoryReadOwner,
  GiftPaymentHistoryRepository,
  GiftPaymentHistoryService,
} from "./giftPaymentHistory";

const instant = new Date("2026-10-13T14:00:00.000Z");
const origin = "https://admin.example.test";
const indexPath = "/v1/sites/site-one/finance/purchases";
const detailPath = `${indexPath}/order-one/history`;
const releases: Array<() => void> = [];
const closers: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instant);
});
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.allSettled(closers.splice(0).map((close) => close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  releases.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}
function otherRealm<T>() {
  const context: {
    resolve?: (value: T) => void;
    reject?: (reason: unknown) => void;
  } = {};
  const promise: Promise<T> = runInNewContext(
    "new Promise((resolve, reject) => { globalThis.resolve = resolve; globalThis.reject = reject; })",
    context,
  );
  expect(isPromise(promise)).toBe(true);
  expect(promise).not.toBeInstanceOf(Promise);
  const resolve = (value: T) => context.resolve?.(value);
  const reject = (reason: unknown) => context.reject?.(reason);
  releases.push(() => resolve(undefined as T));
  return { promise, resolve, reject };
}
function purchase() {
  return {
    siteId: "site-one",
    mode: "sandbox" as const,
    orderId: "order-one",
    quoteId: "quote-one",
    giftId: "gift-one",
    titleSnapshot: "Original archived gift",
    method: "PIX" as const,
    currency: "BRL" as const,
    purchasedAtMicros: "1791824110000123",
    destinationVersion: 1,
    policyVersion: "original-policy",
    binding: "AVAILABLE" as const,
    quoted: {
      nominalCents: 10000,
      commissionCents: 200,
      processingCents: 39,
      totalCents: 10239,
    },
  };
}
function page(): GiftPurchaseHistoryPageResponse {
  return {
    history: {
      scope: { siteId: "site-one", mode: "sandbox", policy: "SITE_HISTORY" },
      consistency: "PER_READ",
      readObservedAtMicros: "1791900000000000",
      currentKnowledge: "UNKNOWN",
      sourceOrdering: "UNAVAILABLE",
      items: [purchase()],
      nextCursor: null,
    },
  };
}
function detail(): GiftPurchaseHistoryDetailResponse {
  const base = page().history;
  const { items: _items, ...envelope } = base;
  return {
    history: {
      ...envelope,
      originalPurchase: purchase(),
      coverage: {
        payments: "AVAILABLE",
        receipts: "AVAILABLE",
        reversals: "UNAVAILABLE",
        bankSettlement: "UNAVAILABLE",
      },
      retainedPayments: [
        {
          paymentId: "payment-one",
          attemptId: "attempt-one",
          orderId: "order-one",
          currency: "BRL",
          recordedState: "RECEIVED",
          createdAtMicros: "1791824670000123",
          observedAtMicros: "1791824670000124",
          grossCents: 10239,
          processingCents: 39,
          commissionCents: 200,
          recipientNetCents: 10000,
        },
      ],
      validatedHistoricalReceipts: [
        {
          effectId: "effect-one",
          paymentId: "payment-one",
          orderId: "order-one",
          currency: "BRL",
          recipientCreditCents: 10000,
          postedAtMicros: "1791824700000123",
          sourceObservedAtMicros: "1791824670000124",
          source: "CORRELATED_STORED_POSTING",
        },
      ],
    },
  };
}
async function problem(
  response: Response,
  status = 503,
  code = "GIFT_PAYMENT_HISTORY_UNAVAILABLE",
) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-type")).toContain(
    "application/problem+json",
  );
  expect(response.headers.get("set-cookie")).toBeNull();
  const body = await response.json();
  expect(Object.keys(body).sort()).toEqual(["code", "status", "title", "type"]);
  expect(body).toMatchObject({ type: "about:blank", status, code });
  expect(JSON.stringify(body)).not.toMatch(
    /private|secret|fictional-history-session|provider-account|stack|cause/i,
  );
}
async function synthetic(
  owner: GiftPaymentHistoryReadOwner<GiftPurchaseHistoryPageResponse>,
) {
  const module = await import("./giftPaymentHistoryHttp");
  const read = vi.fn<GiftPaymentHistoryService["readPurchasePage"]>(
    () => owner,
  );
  const close = vi.fn(async () => {});
  const service: GiftPaymentHistoryService = {
    available: true,
    readPurchasePage: read,
    readPurchaseDetailPage: vi.fn(() => {
      throw new Error("private-unused-detail");
    }),
    close,
  };
  const router = module.createGiftPaymentHistoryHttpRouter({
    adminOrigin: origin,
    giftPaymentHistory: service,
  });
  closers.push(() => router.close());
  const request = (signal?: AbortSignal) =>
    new Request(`https://api.example.test${indexPath}`, {
      headers: { origin },
      signal,
    });
  return { router, read, close, service, request };
}
async function fixture() {
  const session = {
    id: "session-one",
    userId: "viewer-one",
    token: "fictional-history-session",
    createdAt: new Date(instant.getTime() - 60000),
    updatedAt: new Date(instant.getTime() - 60000),
    lastActiveAt: new Date(instant.getTime() - 60000),
    expiresAt: new Date(instant.getTime() + 3600000),
    ipAddress: null,
    userAgent: null,
  };
  const user = {
    id: "viewer-one",
    name: "Fictional Admin",
    email: "fictional@example.test",
    role: "SITE_ADMIN",
    state: "ACTIVE",
    emailVerified: true,
    image: null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  };
  const membership = {
    user_id: "viewer-one",
    account_role: "SITE_ADMIN",
    account_state: "ACTIVE",
    site_id: "site-one",
    membership_id: "membership-one",
    membership_user_id: "viewer-one",
    membership_role: "SITE_ADMIN",
    revoked_at: null as string | null,
  };
  const state = { missing: false };
  const db = {
    select: vi.fn(() => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => [
              {
                sessionId: session.id,
                userId: session.userId,
                sessionCreatedAt: session.createdAt,
                sessionExpiresAt: session.expiresAt,
                lastActiveAt: session.lastActiveAt,
                userName: user.name,
                userEmail: user.email,
                userRole: user.role,
                userState: user.state,
              },
            ],
          }),
        }),
      }),
    })),
    execute: vi.fn(async (value) => {
      expect(new PgDialect().sqlToQuery(value).sql).toMatch(/SELECT/);
      return {
        rows:
          membership.revoked_at === null
            ? [
                {
                  ...membership,
                  account_role: user.role,
                  account_state: user.state,
                },
              ]
            : [],
      };
    }),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const secret = "fictional-history-cookie-secret-32-only";
  const auth = createSessionReadAuth({
    db: db as never,
    secret,
    baseURL: "https://api.example.test",
    adminOrigin: origin,
  });
  const context = await auth.$context;
  const native = vi
    .spyOn(context.internalAdapter, "findSession")
    .mockImplementation(async () =>
      state.missing
        ? null
        : ({
            session: structuredClone(session),
            user: structuredClone(user),
          } as never),
    );
  const deletes = vi
    .spyOn(context.internalAdapter, "deleteSession")
    .mockResolvedValue(undefined);
  const signature = createHmac("sha256", secret)
    .update(session.token)
    .digest("base64");
  const request = (path = indexPath, init: RequestInit = {}) => {
    const headers = new Headers({
      origin,
      cookie: `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`,
    });
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });
    return new Request(`https://api.example.test${path}`, { ...init, headers });
  };
  const scope = {
    siteId: "site-one",
    mode: "sandbox" as const,
    policy: "SITE_HISTORY" as const,
  };
  const page = {
    history: {
      scope,
      consistency: "PER_READ" as const,
      readObservedAtMicros: "1791900000000000",
      currentKnowledge: "UNKNOWN" as const,
      sourceOrdering: "UNAVAILABLE" as const,
      items: [purchase()],
      nextCursor: null,
    },
  };
  const repository = {
    database: db,
    mode: "sandbox",
    applicationEnvironment: "test",
    policy: "SITE_HISTORY",
    readPurchasePage: vi.fn<GiftPaymentHistoryRepository["readPurchasePage"]>(
      async () => page,
    ),
    readPurchaseDetailPage: vi.fn<
      GiftPaymentHistoryRepository["readPurchaseDetailPage"]
    >(async () => detail()),
    close: vi.fn(async () => {}),
  };
  const options = {
    mode: "sandbox" as const,
    applicationEnvironment: "test" as const,
    policy: "SITE_HISTORY" as const,
    adminOrigin: origin,
    now: () => new Date(instant),
    authentication: { auth, db },
    repository,
  };
  const module = await import("./giftPaymentHistory");
  const service = module.createGiftPaymentHistory(options as never);
  const http = await import("./giftPaymentHistoryHttp");
  const router = http.createGiftPaymentHistoryHttpRouter({
    adminOrigin: origin,
    giftPaymentHistory: service,
  });
  closers.push(
    () => router.close(),
    () => service.close(),
  );
  return {
    http,
    router,
    module,
    service,
    options,
    db,
    native,
    deletes,
    request,
    membership,
    session,
    user,
    state,
    repository,
    page,
  };
}

describe("owned private purchase history HTTP", () => {
  it("returns a genuine signed native index and detail without touching administrative activity", async () => {
    const v = await fixture();
    const touch = vi
      .spyOn(authHttp, "requireAdminSession")
      .mockRejectedValue(new Error("private-activity-touch"));
    const activity = vi
      .spyOn(authHttp, "getAdministrativeSession")
      .mockRejectedValue(new Error("private-activity-touch"));
    const index = await v.router.fetch(
      v.request(`${indexPath}?cursor=opaque-position`),
    );
    expect(index.status).toBe(200);
    expect(index.headers.get("cache-control")).toBe("no-store");
    expect(
      giftPurchaseHistoryPageResponseSchema.parse(await index.json()),
    ).toEqual(v.page);
    expect(v.repository.readPurchasePage.mock.calls[0]?.[1]).toBe(
      "opaque-position",
    );
    const response = await v.router.fetch(v.request(detailPath));
    expect(response.status).toBe(200);
    const body = giftPurchaseHistoryDetailResponseSchema.parse(
      await response.json(),
    );
    expect(body).toEqual(detail());
    expect(body.history.retainedPayments[0].observedAtMicros).toBe(
      "1791824670000124",
    );
    expect(body.history.coverage.bankSettlement).toBe("UNAVAILABLE");
    expect(v.native).toHaveBeenCalledTimes(4);
    expect(touch).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
    for (const write of [v.db.insert, v.db.update, v.db.delete, v.deletes])
      expect(write).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(
      new TextEncoder().encode(JSON.stringify(body)).byteLength,
    ).toBeLessThanOrEqual(131072);
  });
  it("keeps HEAD authorized and non-mutating while suppressing its body", async () => {
    const v = await fixture();
    const response = await v.router.fetch(
      v.request(detailPath, { method: "HEAD" }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(v.native).toHaveBeenCalledTimes(2);
    expect(v.db.update).not.toHaveBeenCalled();
    expect(v.deletes).not.toHaveBeenCalled();
  });
  it.each(["missing", "disabled", "incompatible"] as const)(
    "keeps %s configuration unavailable before private dependency access",
    async (kind) => {
      const v = await fixture();
      const read = vi.fn(() => {
        throw new Error("private-read");
      });
      const configured =
        kind === "missing"
          ? undefined
          : kind === "disabled"
            ? {
                available: false,
                get readPurchasePage() {
                  throw new Error("private-disabled-getter");
                },
              }
            : { available: true, readPurchasePage: read };
      const router = v.http.createGiftPaymentHistoryHttpRouter({
        adminOrigin: origin,
        giftPaymentHistory: configured as never,
      });
      closers.push(() => router.close());
      await problem(await router.fetch(v.request()));
      expect(read).not.toHaveBeenCalled();
      expect(v.native).not.toHaveBeenCalled();
      expect(v.db.select).not.toHaveBeenCalled();
    },
  );
  it("rejects a foreign Origin before native admission", async () => {
    const v = await fixture();
    await problem(
      await v.router.fetch(
        v.request(indexPath, {
          headers: { origin: "https://foreign.example.test" },
        }),
      ),
      403,
      "FORBIDDEN",
    );
    expect(v.native).not.toHaveBeenCalled();
  });
  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "rejects unsupported methods %s with no private work",
    async (method) => {
      const v = await fixture();
      const response = await v.router.fetch(v.request(detailPath, { method }));
      await problem(response, 405, "METHOD_NOT_ALLOWED");
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(v.native).not.toHaveBeenCalled();
    },
  );
  it.each([
    "?mode=live",
    "?policy=SITE_HISTORY",
    "?accountId=other",
    "?siteId=other",
    "?userId=other",
    "?cursor=a&cursor=b",
    "?cursor=",
    "?cursor=%20",
    `?cursor=${"x".repeat(257)}`,
    "?cursor=a&revision=1",
    "?cursor=a&membershipId=other",
    `?cursor=a${"&".repeat(1017)}`,
  ])("rejects strict query %s before private work", async (query) => {
    const v = await fixture();
    await problem(
      await v.router.fetch(v.request(indexPath + query)),
      400,
      "VALIDATION_ERROR",
    );
    expect(v.native).not.toHaveBeenCalled();
    expect(v.repository.readPurchasePage).not.toHaveBeenCalled();
  });
  it("admits the1024-byte single-cursor query boundary", async () => {
    const v = await fixture();
    const query = `?cursor=a${"&".repeat(1015)}`;
    expect(new TextEncoder().encode(query).byteLength).toBe(1024);
    expect((await v.router.fetch(v.request(indexPath + query))).status).toBe(
      200,
    );
    expect(v.repository.readPurchasePage.mock.calls[0]?.[1]).toBe("a");
  });
  it.each([
    "/v1/sites/site.one/finance/purchases",
    "/v1/sites/site-one/finance/purchases/%20/history",
  ])("rejects invalid canonical path %s before private work", async (path) => {
    const v = await fixture();
    await problem(
      await v.router.fetch(v.request(path)),
      400,
      "VALIDATION_ERROR",
    );
    expect(v.native).not.toHaveBeenCalled();
  });
  it.each(["nonzero", "noncanonical", "transfer", "body"] as const)(
    "rejects body/framing %s without consuming it",
    async (kind) => {
      const v = await fixture();
      const headers = new Headers();
      if (kind === "nonzero") headers.set("content-length", "1");
      if (kind === "noncanonical") headers.set("content-length", "00");
      if (kind === "transfer") headers.set("transfer-encoding", "chunked");
      const request = v.request(indexPath, { headers });
      const body = new ReadableStream<Uint8Array>();
      const reader = vi.spyOn(body, "getReader");
      const cancel = vi.spyOn(body, "cancel");
      if (kind === "body")
        Object.defineProperty(request, "body", { value: body });
      await problem(await v.router.fetch(request), 400, "VALIDATION_ERROR");
      expect(reader).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(v.native).not.toHaveBeenCalled();
    },
  );
  it.each([
    "unsigned",
    "absent",
    "expired",
    "idle",
    "absolute",
    "inactive",
    "OWNER",
    "SITE_ASSISTANT",
    "membership",
    "foreign",
  ] as const)(
    "denies actual native %s through the uniform private boundary",
    async (kind) => {
      const v = await fixture();
      const request = v.request();
      if (kind === "unsigned")
        request.headers.set("cookie", "better-auth.session_token=unsigned");
      if (kind === "absent") request.headers.delete("cookie");
      if (kind === "expired") v.session.expiresAt = new Date(instant);
      if (kind === "idle")
        v.session.lastActiveAt = new Date(instant.getTime() - 86400000);
      if (kind === "absolute")
        v.session.createdAt = new Date(instant.getTime() - 7 * 86400000);
      if (kind === "inactive") v.user.state = "DISABLED";
      if (kind === "OWNER" || kind === "SITE_ASSISTANT") v.user.role = kind;
      if (kind === "membership")
        v.membership.revoked_at = "2026-10-13T13:59:00Z";
      if (kind === "foreign") v.membership.site_id = "foreign-site";
      await problem(await v.router.fetch(request));
      expect(v.repository.readPurchasePage).not.toHaveBeenCalled();
      expect(v.db.update).not.toHaveBeenCalled();
      expect(v.deletes).not.toHaveBeenCalled();
    },
  );
  it.each(["membership", "session"] as const)(
    "suppresses a late read after genuine current %s replacement",
    async (kind) => {
      const v = await fixture();
      const stored = deferred<typeof v.page>();
      v.repository.readPurchasePage.mockImplementation(() => stored.promise);
      const response = v.router.fetch(v.request());
      await vi.waitFor(() =>
        expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1),
      );
      if (kind === "membership")
        v.membership.membership_id = "replacement-membership";
      else v.session.id = "replacement-session";
      stored.resolve(v.page);
      await problem(await response);
      expect(v.db.update).not.toHaveBeenCalled();
    },
  );
  it("pre-abort invokes no native or stored port", async () => {
    const v = await fixture();
    const controller = new AbortController();
    controller.abort();
    await problem(
      await v.router.fetch(v.request(indexPath, { signal: controller.signal })),
    );
    expect(v.native).not.toHaveBeenCalled();
    expect(v.repository.readPurchasePage).not.toHaveBeenCalled();
  });
  it.each(["admission", "stored", "confirmation"] as const)(
    "abort retains actual pending native/read %s ownership",
    async (phase) => {
      const v = await fixture();
      const gate = deferred<void>();
      const original = v.native.getMockImplementation();
      let calls = 0;
      if (phase === "stored")
        v.repository.readPurchasePage.mockImplementation(async () => {
          await gate.promise;
          return v.page;
        });
      else
        v.native.mockImplementation(async (token) => {
          if (++calls === (phase === "admission" ? 1 : 2)) await gate.promise;
          return original ? original(token) : null;
        });
      const controller = new AbortController();
      let finished = false;
      const response = Promise.resolve(
        v.router.fetch(v.request(indexPath, { signal: controller.signal })),
      ).then((value) => {
        finished = true;
        return value;
      });
      await vi.waitFor(() =>
        phase === "stored"
          ? expect(v.repository.readPurchasePage).toHaveBeenCalledTimes(1)
          : expect(v.native).toHaveBeenCalledTimes(
              phase === "admission" ? 1 : 2,
            ),
      );
      controller.abort();
      const close = v.router.close();
      await Promise.resolve();
      expect(finished).toBe(false);
      expect(v.repository.close).not.toHaveBeenCalled();
      gate.resolve();
      await problem(await response);
      await close;
      expect(v.repository.close).toHaveBeenCalledTimes(1);
      expect(v.db.update).not.toHaveBeenCalled();
    },
  );
  it.each([
    "result-first",
    "completion-first",
    "result-error",
    "completion-error",
  ] as const)(
    "owns both real synthetic promises for %s, including one-sided rejection",
    async (order) => {
      const result = deferred<GiftPurchaseHistoryPageResponse>();
      const completion = deferred<void>();
      const cancel = vi.fn();
      const v = await synthetic({
        result: result.promise,
        completion: completion.promise,
        cancel,
      });
      let finished = false;
      const response = Promise.resolve(v.router.fetch(v.request())).then(
        (value) => {
          finished = true;
          return value;
        },
      );
      await vi.waitFor(() => expect(v.read).toHaveBeenCalledTimes(1));
      if (order === "result-first") result.resolve(page());
      if (order === "completion-first") completion.resolve();
      if (order === "result-error")
        result.reject(new Error("private-result-secret"));
      if (order === "completion-error")
        completion.reject(new Error("private-completion-secret"));
      await Promise.resolve();
      await Promise.resolve();
      expect(finished).toBe(false);
      if (order === "result-first" || order === "result-error")
        completion.resolve();
      else result.resolve(page());
      const reply = await response;
      if (order.endsWith("error")) await problem(reply);
      else expect(reply.status).toBe(200);
    },
  );
  it.each([
    ["result", "fulfilled"],
    ["result", "rejected"],
    ["completion", "fulfilled"],
    ["completion", "rejected"],
  ] as const)(
    "owns actual other-realm %s through %s settlement",
    async (which, outcome) => {
      const foreign = otherRealm<GiftPurchaseHistoryPageResponse | undefined>();
      const result =
        which === "result"
          ? (foreign.promise as Promise<GiftPurchaseHistoryPageResponse>)
          : Promise.resolve(page());
      const completion =
        which === "completion"
          ? (foreign.promise as Promise<void>)
          : Promise.resolve();
      const v = await synthetic({ result, completion, cancel: vi.fn() });
      let finished = false;
      const response = Promise.resolve(v.router.fetch(v.request())).then(
        (value) => {
          finished = true;
          return value;
        },
      );
      await vi.waitFor(() => expect(v.read).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      let closed = false;
      const close = v.router.close();
      void close.then(() => {
        closed = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      if (outcome === "rejected")
        foreign.reject(new Error("private-other-realm-secret"));
      else foreign.resolve(which === "result" ? page() : undefined);
      await problem(await response);
      await close;
      expect(closed).toBe(true);
      expect(v.close).toHaveBeenCalledTimes(1);
    },
  );
  it.each(["result", "completion"] as const)(
    "returns a valid actual other-realm %s after genuine settlement",
    async (which) => {
      const foreign = otherRealm<GiftPurchaseHistoryPageResponse | undefined>();
      const v = await synthetic({
        result:
          which === "result"
            ? (foreign.promise as Promise<GiftPurchaseHistoryPageResponse>)
            : Promise.resolve(page()),
        completion:
          which === "completion"
            ? (foreign.promise as Promise<void>)
            : Promise.resolve(),
        cancel: vi.fn(),
      });
      let finished = false;
      const response = Promise.resolve(v.router.fetch(v.request())).then(
        (value) => {
          finished = true;
          return value;
        },
      );
      await vi.waitFor(() => expect(v.read).toHaveBeenCalledTimes(1));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(finished).toBe(false);
      foreign.resolve(which === "result" ? page() : undefined);
      const reply = await response;
      expect(reply.status).toBe(200);
      expect(await reply.json()).toEqual(page());
      expect(v.close).not.toHaveBeenCalled();
    },
  );
  it("captures the original normalized synthetic result before pending completion", async () => {
    const result = deferred<GiftPurchaseHistoryPageResponse>();
    const completion = deferred<void>();
    const v = await synthetic({
      result: result.promise,
      completion: completion.promise,
      cancel: vi.fn(),
    });
    const response = v.router.fetch(v.request());
    await vi.waitFor(() => expect(v.read).toHaveBeenCalledTimes(1));
    const original = page();
    result.resolve(original);
    await Promise.resolve();
    await Promise.resolve();
    original.history.readObservedAtMicros = "1791900000000001";
    completion.resolve();
    const reply = await response;
    expect(reply.status).toBe(200);
    expect((await reply.json()).history.readObservedAtMicros).toBe(
      "1791900000000000",
    );
  });
  it("memoized close stops admission and drains HTTP promises even after service close returns", async () => {
    const result = deferred<GiftPurchaseHistoryPageResponse>();
    const completion = deferred<void>();
    const cancel = vi.fn();
    const v = await synthetic({
      result: result.promise,
      completion: completion.promise,
      cancel,
    });
    const request = v.request();
    const response = v.router.fetch(request);
    await vi.waitFor(() => expect(v.read).toHaveBeenCalledTimes(1));
    let closed = false;
    const close = v.router.close();
    expect(v.router.close()).toBe(close);
    void close.then(() => {
      closed = true;
    });
    expect(cancel).toHaveBeenCalledTimes(1);
    await problem(await v.router.fetch(v.request()));
    result.reject(new Error("private-read-secret"));
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    completion.resolve();
    await problem(await response);
    await close;
    expect(v.close).toHaveBeenCalledTimes(1);
    expect(v.read).toHaveBeenCalledTimes(1);
    expect(v.read.mock.calls[0]?.[0].request).toBe(request);
  });
  it("captures original bound synthetic methods instead of following a later replacement", async () => {
    const v = await synthetic({
      result: Promise.resolve(page()),
      completion: Promise.resolve(),
      cancel: vi.fn(),
    });
    const substitute = vi.fn(() => {
      throw new Error("private-substitute");
    });
    v.service.readPurchasePage = substitute;
    expect((await v.router.fetch(v.request())).status).toBe(200);
    expect(v.read).toHaveBeenCalledTimes(1);
    expect(substitute).not.toHaveBeenCalled();
  });
  it("a service close rejection cannot skip pending actual HTTP result and completion", async () => {
    const result = deferred<GiftPurchaseHistoryPageResponse>();
    const completion = deferred<void>();
    const closeGate = deferred<void>();
    const module = await import("./giftPaymentHistoryHttp");
    const read = vi.fn(() => ({
      result: result.promise,
      completion: completion.promise,
      cancel: vi.fn(),
    }));
    const close = vi.fn(() => closeGate.promise);
    const router = module.createGiftPaymentHistoryHttpRouter({
      adminOrigin: origin,
      giftPaymentHistory: {
        available: true,
        readPurchasePage: read,
        readPurchaseDetailPage: vi.fn(() => {
          throw new Error("private-unused");
        }),
        close,
      },
    });
    closers.push(() => router.close());
    const response = router.fetch(
      new Request(`https://api.example.test${indexPath}`, {
        headers: { origin },
      }),
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    let closed = false;
    const shutdown = router.close();
    const observed = shutdown.then(
      () => {
        closed = true;
        return null;
      },
      (error) => {
        closed = true;
        return error;
      },
    );
    closeGate.reject(new Error("private-close-secret"));
    result.resolve(page());
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    completion.resolve();
    await problem(await response);
    const error = await observed;
    expect(error).toMatchObject({
      message: "Purchase history unavailable",
      status: 503,
      code: "GIFT_PAYMENT_HISTORY_UNAVAILABLE",
    });
    expect(error).not.toHaveProperty("cause");
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("captures original native cookie and Origin before a pending SDK lookup", async () => {
    const v = await fixture();
    const gate = deferred<void>();
    const original = v.native.getMockImplementation();
    let calls = 0;
    v.native.mockImplementation(async (token) => {
      if (++calls === 1) await gate.promise;
      return original ? original(token) : null;
    });
    const request = v.request();
    const response = v.router.fetch(request);
    await vi.waitFor(() => expect(v.native).toHaveBeenCalledTimes(1));
    request.headers.set("cookie", "private-substitute-cookie");
    request.headers.set("origin", "https://foreign.example.test");
    gate.resolve();
    expect((await response).status).toBe(200);
    expect(v.native).toHaveBeenCalledTimes(2);
  });
  it.each([
    "foreign-site",
    "private-field",
    "certainty",
    "index26",
    "detail51",
    "foreign-order",
  ] as const)(
    "revalidates synthetic %s response instead of exposing private or unsupported JSON",
    async (kind) => {
      const value: unknown =
        kind === "detail51" || kind === "foreign-order" ? detail() : page();
      const history = (value as { history: Record<string, unknown> }).history;
      if (kind === "foreign-site")
        (history.scope as { siteId: string }).siteId = "foreign-site";
      if (kind === "private-field")
        history.privateProviderProof = "private-bank-secret".repeat(10000);
      if (kind === "certainty") history.currentKnowledge = "KNOWN";
      if (kind === "index26")
        history.items = Array.from({ length: 26 }, (_, i) => ({
          ...purchase(),
          orderId: `order-${i}`,
          quoteId: `quote-${i}`,
          purchasedAtMicros: "1791824110000123",
        }));
      if (kind === "detail51") {
        const sample = detail().history.retainedPayments[0];
        history.retainedPayments = Array.from({ length: 50 }, (_, i) => ({
          ...sample,
          paymentId: `payment-${i}`,
        }));
      }
      if (kind === "foreign-order")
        (history.originalPurchase as { orderId: string }).orderId =
          "foreign-order";
      const owner = {
        result: Promise.resolve(value),
        completion: Promise.resolve(),
        cancel: vi.fn(),
      };
      const module = await import("./giftPaymentHistoryHttp");
      const read = vi.fn(() => owner);
      const service = {
        available: true,
        readPurchasePage: read,
        readPurchaseDetailPage: read,
        close: vi.fn(async () => {}),
      };
      const router = module.createGiftPaymentHistoryHttpRouter({
        adminOrigin: origin,
        giftPaymentHistory: service as never,
      });
      closers.push(() => router.close());
      await problem(
        await router.fetch(
          new Request(
            "https://api.example.test" +
              (kind === "detail51" || kind === "foreign-order"
                ? detailPath
                : indexPath),
            { headers: { origin } },
          ),
        ),
      );
      expect(read).toHaveBeenCalledTimes(1);
    },
  );
});
