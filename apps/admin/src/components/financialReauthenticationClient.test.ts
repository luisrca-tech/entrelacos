import type { SiteAccess } from "@entrelacos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  createFinancialReauthenticationController,
  type FinancialReauthenticationScope,
  financialReauthenticationScopeKey,
  requestFinancialReauthentication,
} from "./financialReauthenticationClient";

const access: SiteAccess = {
  siteId: "wedding-a",
  userId: "admin-a",
  membershipId: "member-a",
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
const scope: FinancialReauthenticationScope = {
  siteId: "wedding-a",
  access,
  action: "CONFIGURE_RECEIVING",
  sessionEpoch: 1,
};
const start = Date.parse("2026-10-12T18:00:00.000Z");
const proof = {
  reauthenticationToken: `fr1.cHVycG9zZS1ib3VuZC1wcm9vZg.${"A".repeat(43)}`,
  expiresAt: "2026-10-12T18:03:00.000Z",
};
const password = "dummy-current-password";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("purpose-bound financial reauthentication client", () => {
  it("does not dispatch password after a loading subscriber disposes its controller", async () => {
    const request = vi.fn().mockResolvedValue(proof);
    let controller!: ReturnType<
      typeof createFinancialReauthenticationController
    >;
    controller = createFinancialReauthenticationController(
      scope,
      (next) => {
        if (next.status === "loading") controller.dispose();
      },
      { request, now: () => start },
    );
    await controller.submit(password);
    expect(request).not.toHaveBeenCalled();
  });
  it("quarantines the response until an explicit fresh context comparison completes", async () => {
    let resolve!: (value: boolean) => void;
    const validate = vi.fn(
      () =>
        new Promise<boolean>((yes) => {
          resolve = yes;
        }),
    );
    const guard = {
      isCurrent: () => true,
      validate,
      subscribeInvalidation: vi.fn(() => vi.fn()),
    };
    const states = vi.fn();
    const controller = createFinancialReauthenticationController(
      scope,
      states,
      { request: vi.fn().mockResolvedValue(proof), now: () => start, guard },
    );
    const work = controller.submit(password);
    await Promise.resolve();
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(controller.getState().status).toBe("loading");
    expect(controller.consumeProof()).toBeNull();
    expect(JSON.stringify(states.mock.calls)).not.toContain(
      proof.reauthenticationToken,
    );
    resolve(true);
    await work;
    expect(controller.getState().status).toBe("verified");
    expect(controller.consumeProof()).toBe(proof.reauthenticationToken);
    controller.dispose();
  });
  it("does not accept proof when fresh server context is denied", async () => {
    const guard = {
      isCurrent: () => true,
      validate: vi.fn().mockResolvedValue(false),
      subscribeInvalidation: vi.fn(() => vi.fn()),
    };
    const controller = createFinancialReauthenticationController(
      scope,
      vi.fn(),
      { request: vi.fn().mockResolvedValue(proof), now: () => start, guard },
    );
    await controller.submit(password);
    expect(controller.getState().status).not.toBe("verified");
    expect(controller.consumeProof()).toBeNull();
    controller.dispose();
  });
  it("discards quarantine immediately on ownership loss, even if former scope returns", async () => {
    let resolve!: (value: boolean) => void;
    let invalidate!: () => void;
    let valid = true;
    const guard = {
      isCurrent: () => valid,
      validate: () =>
        new Promise<boolean>((yes) => {
          resolve = yes;
        }),
      subscribeInvalidation: (listener: () => void) => {
        invalidate = listener;
        return vi.fn();
      },
    };
    const controller = createFinancialReauthenticationController(
      scope,
      vi.fn(),
      { request: vi.fn().mockResolvedValue(proof), now: () => start, guard },
    );
    const work = controller.submit(password);
    await Promise.resolve();
    await Promise.resolve();
    valid = false;
    invalidate();
    valid = true;
    resolve(true);
    await work;
    expect(controller.consumeProof()).toBeNull();
    expect(controller.getState().status).toBe("denied");
    controller.dispose();
  });
  it("clears an installed proof synchronously when its validated context becomes uncertain", async () => {
    let invalidate!: () => void;
    const cleanup = vi.fn();
    const guard = {
      isCurrent: () => true,
      validate: vi.fn().mockResolvedValue(true),
      subscribeInvalidation: (listener: () => void) => {
        invalidate = listener;
        return cleanup;
      },
    };
    const controller = createFinancialReauthenticationController(
      scope,
      vi.fn(),
      { request: vi.fn().mockResolvedValue(proof), now: () => start, guard },
    );
    await controller.submit(password);
    invalidate();
    expect(controller.consumeProof()).toBeNull();
    controller.dispose();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
  it.each(["CONFIGURE_RECEIVING", "REQUEST_WITHDRAWAL"] as const)(
    "posts only %s/password with session no-store transport",
    async (action) => {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(JSON.stringify(proof)));
      await expect(
        requestFinancialReauthentication(
          { ...scope, action },
          password,
          (path, options) => apiRequest(path, options, fetcher),
          () => start,
        ),
      ).resolves.toEqual(proof);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(
        "/api/v1/sites/wedding-a/financial-reauthentication",
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, password }),
        },
      );
    },
  );
  it.each([
    { access: null },
    { siteId: "wedding-b" },
    { access: { ...access, membershipRole: "OWNER" } },
    { access: { ...access, membershipRole: "SITE_ASSISTANT" } },
    { access: { ...access, membershipId: null } },
    {
      access: {
        ...access,
        capabilities: { ...access.capabilities, configureReceiving: false },
      },
    },
    { sessionEpoch: null },
    { sessionEpoch: -1 },
    { sessionEpoch: 1.5 },
    { action: "OTHER" },
  ])(
    "rejects missing or mismatched authority/session/purpose before requesting: %j",
    async (extra) => {
      const candidate = {
        ...scope,
        ...extra,
      } as FinancialReauthenticationScope;
      const request = vi.fn();
      expect(financialReauthenticationScopeKey(candidate)).toBeNull();
      await expect(
        requestFinancialReauthentication(
          candidate,
          password,
          request,
          () => start,
        ),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("uses readFinance for password proof of withdrawal and never infers withdrawal permission", async () => {
    const candidate = {
      ...scope,
      action: "REQUEST_WITHDRAWAL" as const,
      access: {
        ...access,
        capabilities: {
          ...access.capabilities,
          requestWithdrawal: true,
          readFinance: false,
        },
      },
    };
    const request = vi.fn();
    await expect(
      requestFinancialReauthentication(
        candidate,
        password,
        request,
        () => start,
      ),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["", "x".repeat(201)])(
    "rejects an invalid password before the protected POST",
    async (value) => {
      const request = vi.fn();
      await expect(
        requestFinancialReauthentication(scope, value, request, () => start),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    { ...proof, password },
    { ...proof, walletId: "private" },
    { ...proof, reauthenticationToken: "invalid" },
    { reauthenticationToken: proof.reauthenticationToken },
    { ...proof, expiresAt: "invalid" },
    { ...proof, expiresAt: "2026-10-12T18:00:00.000Z" },
    { ...proof, expiresAt: "2026-10-12T18:06:00.000Z" },
  ])(
    "rejects private, incomplete, expired or implausibly long proof responses",
    async (value) => {
      await expect(
        requestFinancialReauthentication(
          scope,
          password,
          vi.fn().mockResolvedValue(value),
          () => start,
        ),
      ).rejects.toThrow();
    },
  );
});

describe("transient financial password proof lifecycle", () => {
  function setup(
    request = vi.fn().mockResolvedValue(proof),
    candidate = scope,
  ) {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const listener = vi.fn();
    return {
      request,
      listener,
      controller: createFinancialReauthenticationController(
        candidate,
        listener,
        { request },
      ),
    };
  }
  it("keeps password/token out of observable state and consumes a proof only once", async () => {
    const { controller, listener } = setup();
    await controller.submit(password);
    expect(controller.getState()).toEqual({
      status: "verified",
      expiresAt: proof.expiresAt,
    });
    expect(JSON.stringify(listener.mock.calls)).not.toMatch(
      /dummy-current-password|fr1\./,
    );
    expect(controller.consumeProof()).toBe(proof.reauthenticationToken);
    expect(controller.getState()).toEqual({ status: "consumed" });
    expect(controller.consumeProof()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("ignores duplicate submission while the first confirmation is pending", async () => {
    let resolve!: (value: typeof proof) => void;
    const request = vi.fn(
      () =>
        new Promise<typeof proof>((yes) => {
          resolve = yes;
        }),
    );
    const { controller } = setup(request);
    const first = controller.submit(password);
    expect(controller.getState()).toEqual({ status: "loading" });
    await controller.submit("another-dummy-password");
    expect(request).toHaveBeenCalledTimes(1);
    resolve(proof);
    await first;
    expect(controller.getState().status).toBe("verified");
  });
  it("clears proof automatically at expiry and cannot consume expired proof", async () => {
    const { controller } = setup();
    await controller.submit(password);
    vi.advanceTimersByTime(180000);
    expect(controller.getState()).toEqual({ status: "expired" });
    expect(controller.consumeProof()).toBeNull();
  });
  it("checks the actual deadline before timer delivery", async () => {
    const { controller } = setup();
    await controller.submit(password);
    vi.setSystemTime(start + 180000);
    expect(controller.consumeProof()).toBeNull();
    expect(controller.getState()).toEqual({ status: "expired" });
  });
  it("does not extend proof validity when the browser clock moves backwards", async () => {
    const { controller } = setup();
    await controller.submit(password);
    vi.setSystemTime(start - 1);
    expect(controller.consumeProof()).toBeNull();
    expect(controller.getState()).toEqual({ status: "expired" });
  });
  it.each([start - 3600000, Number.NaN, Number.POSITIVE_INFINITY, -1])(
    "rejects rollback or invalid clock values between response validation and proof installation",
    async (secondClock) => {
      vi.useFakeTimers();
      vi.setSystemTime(start);
      const now = vi
        .fn()
        .mockReturnValueOnce(start)
        .mockReturnValue(secondClock);
      const controller = createFinancialReauthenticationController(
        scope,
        vi.fn(),
        { request: vi.fn().mockResolvedValue(proof), now },
      );
      await controller.submit(password);
      expect(controller.getState()).toEqual({ status: "error" });
      expect(controller.consumeProof()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("clears an existing proof before reconfirming", async () => {
    const { controller, request } = setup();
    await controller.submit(password);
    request.mockImplementation(() => new Promise(() => {}));
    void controller.submit(password);
    expect(controller.consumeProof()).toBeNull();
    expect(controller.getState()).toEqual({ status: "loading" });
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });
  it("disposes proof/timers and ignores a late successful response", async () => {
    let resolve!: (value: typeof proof) => void;
    const { controller, listener } = setup(
      vi.fn(
        () =>
          new Promise<typeof proof>((yes) => {
            resolve = yes;
          }),
      ),
    );
    const pending = controller.submit(password);
    controller.dispose();
    resolve(proof);
    await pending;
    expect(listener.mock.calls).toEqual([[{ status: "loading" }]]);
    expect(controller.consumeProof()).toBeNull();
    expect(controller.getState()).toEqual({ status: "idle" });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("disposes an installed proof without emitting into an unmounted form", async () => {
    const { controller, listener } = setup();
    await controller.submit(password);
    listener.mockClear();
    controller.dispose();
    expect(controller.consumeProof()).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["siteId", "action", "sessionEpoch", "access"] as const)(
    "clears an installed proof on %s change before consumption",
    async (field) => {
      const candidate = { ...scope };
      const { controller } = setup(vi.fn().mockResolvedValue(proof), candidate);
      await controller.submit(password);
      if (field === "siteId") candidate.siteId = "wedding-b";
      if (field === "action") candidate.action = "REQUEST_WITHDRAWAL";
      if (field === "sessionEpoch") candidate.sessionEpoch = 2;
      if (field === "access")
        candidate.access = { ...access, membershipId: "member-b" };
      expect(controller.consumeProof()).toBeNull();
      expect(controller.getState()).toEqual({ status: "denied" });
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("does not emit a late failure into an unmounted form", async () => {
    let reject!: (error: unknown) => void;
    const { controller, listener } = setup(
      vi.fn(
        () =>
          new Promise((_yes, no) => {
            reject = no;
          }),
      ),
    );
    const pending = controller.submit(password);
    controller.dispose();
    reject(new Error("private password confirmation error"));
    await pending;
    expect(listener.mock.calls).toEqual([[{ status: "loading" }]]);
    expect(controller.consumeProof()).toBeNull();
  });
  it("never sends a password without a current authenticated scope", async () => {
    const { controller, request } = setup(vi.fn(), {
      ...scope,
      sessionEpoch: null,
    });
    await controller.submit(password);
    expect(request).not.toHaveBeenCalled();
    expect(controller.getState()).toEqual({ status: "denied" });
  });
  it.each(["siteId", "action", "sessionEpoch", "access"] as const)(
    "rejects a successful response after %s replacement",
    async (field) => {
      const candidate = { ...scope };
      let resolve!: (value: typeof proof) => void;
      const { controller } = setup(
        vi.fn(
          () =>
            new Promise<typeof proof>((yes) => {
              resolve = yes;
            }),
        ),
        candidate,
      );
      const pending = controller.submit(password);
      if (field === "siteId") candidate.siteId = "wedding-b";
      if (field === "action") candidate.action = "REQUEST_WITHDRAWAL";
      if (field === "sessionEpoch") candidate.sessionEpoch = 2;
      if (field === "access")
        candidate.access = { ...access, userId: "admin-b" };
      resolve(proof);
      await pending;
      expect(controller.consumeProof()).toBeNull();
      expect(controller.getState()).toEqual({ status: "denied" });
    },
  );
  it.each([
    [new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"), "unavailable"],
    [new ApiError(503, "REAUTHENTICATION_UNAVAILABLE"), "unavailable"],
    [new ApiError(403, "RECENT_AUTH_REQUIRED"), "error"],
    [new ApiError(403, "MEMBERSHIP_DENIED"), "denied"],
    [new ApiError(401, "UNAUTHORIZED"), "session_expired"],
    [new ApiError(429, "REAUTHENTICATION_RATE_LIMITED"), "rate_limited"],
    [new Error(`private ${password} ${proof.reauthenticationToken}`), "error"],
  ])("keeps failures honest and sanitized", async (failure, status) => {
    const { controller } = setup(vi.fn().mockRejectedValue(failure));
    await controller.submit(password);
    expect(controller.getState()).toEqual({ status });
    expect(controller.consumeProof()).toBeNull();
    expect(JSON.stringify(controller.getState())).not.toMatch(
      /dummy-current-password|fr1\./,
    );
  });
  it("does not install a proof that expired while the request was pending", async () => {
    const { controller } = setup(
      vi.fn(async () => {
        vi.setSystemTime(start + 180000);
        return proof;
      }),
    );
    await controller.submit(password);
    expect(controller.getState()).toEqual({ status: "expired" });
    expect(controller.consumeProof()).toBeNull();
  });
});
