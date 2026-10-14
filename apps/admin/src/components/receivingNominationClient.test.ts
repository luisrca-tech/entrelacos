import type { SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError, apiRequest } from "../lib/apiClient";
import { createFinancialReauthenticationController } from "./financialReauthenticationClient";
import {
  createReceivingNominationController,
  type ReceivingNominationScope,
  type ReceivingNominationState,
  receivingNominationScopeKey,
  requestReceivingNomination,
} from "./receivingNominationClient";

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
const scope: ReceivingNominationScope = {
  siteId: "wedding-a",
  access,
  sessionEpoch: 1,
  requestId: "nomination-request-a",
  policyVersion: "server-policy-a",
};
const token = `fr1.cHVycG9zZS1ib3VuZA.${"A".repeat(43)}`;
const response = {
  nomination: {
    siteId: scope.siteId,
    requestId: scope.requestId,
    state: "AWAITING_PROVIDER_VERIFICATION",
    createdAt: "2026-10-12T18:00:00.000Z",
    mode: "sandbox",
  },
};
function proof(candidate = scope) {
  return {
    scope: {
      siteId: candidate.siteId,
      access: candidate.access,
      sessionEpoch: candidate.sessionEpoch,
      action: "CONFIGURE_RECEIVING" as const,
    },
    consumeProof: vi.fn(() => token),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("unmounted receiving nomination client", () => {
  it.each(["dispose", "invalidate"])(
    "never consumes or dispatches after controller %s while validation is pending",
    async (loss) => {
      const pending = deferred<boolean>();
      let invalidate!: () => void;
      const guard = {
        isCurrent: () => true,
        validate: () => pending.promise,
        subscribeInvalidation: (listener: () => void) => {
          invalidate = listener;
          return vi.fn();
        },
      };
      const source = proof();
      const request = vi.fn().mockResolvedValue(response);
      const controller = createReceivingNominationController(scope, vi.fn(), {
        request,
        guard,
      });
      const work = controller.submit(true, source);
      if (loss === "dispose") controller.dispose();
      else invalidate();
      pending.resolve(true);
      await work;
      expect(source.consumeProof).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      controller.dispose();
    },
  );
  it("revalidates the retained context before consuming proof or dispatching", async () => {
    const pending = deferred<boolean>();
    const source = proof();
    const request = vi.fn().mockResolvedValue(response);
    const guard = {
      isCurrent: () => true,
      validate: vi.fn(() => pending.promise),
      subscribeInvalidation: vi.fn(() => vi.fn()),
    };
    const work = requestReceivingNomination(
      scope,
      true,
      source,
      request,
      guard,
    );
    expect(source.consumeProof).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    pending.resolve(true);
    await work;
    expect(source.consumeProof).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("blocks consumption and POST when retained context rejects the attempt", async () => {
    const source = proof();
    const request = vi.fn();
    const guard = {
      isCurrent: () => true,
      validate: vi.fn().mockResolvedValue(false),
      subscribeInvalidation: vi.fn(() => vi.fn()),
    };
    await expect(
      requestReceivingNomination(scope, true, source, request, guard),
    ).rejects.toThrow();
    expect(source.consumeProof).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it("cannot accept old settlement after immediate guard invalidation and restoration", async () => {
    const pending = deferred<unknown>();
    let invalidate!: () => void;
    const guard = {
      isCurrent: () => true,
      validate: vi.fn().mockResolvedValue(true),
      subscribeInvalidation: (listener: () => void) => {
        invalidate = listener;
        return vi.fn();
      },
    };
    const controller = createReceivingNominationController(scope, vi.fn(), {
      request: vi.fn(() => pending.promise),
      guard,
    });
    const work = controller.submit(true, proof());
    await Promise.resolve();
    await Promise.resolve();
    invalidate();
    pending.resolve(response);
    await work;
    expect(controller.getState().status).toBe("denied");
    controller.dispose();
  });
  it("uses only strict nomination C1 in the protected session/no-store POST", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify(response)));
    await expect(
      requestReceivingNomination(scope, true, proof(), (path, options) =>
        apiRequest(path, options, fetcher),
      ),
    ).resolves.toEqual(response);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/sites/wedding-a/receiving/nomination",
      {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: scope.requestId,
          confirmSelfAsRecipient: true,
          policyVersion: scope.policyVersion,
          reauthenticationToken: token,
        }),
      },
    );
  });
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
    { requestId: null },
    { requestId: "" },
    { policyVersion: null },
    { policyVersion: "" },
  ])(
    "denies invalid authority/session/operation/policy before consuming proof: %j",
    async (extra) => {
      const candidate = { ...scope, ...extra } as ReceivingNominationScope;
      const source = proof();
      const request = vi.fn();
      expect(receivingNominationScopeKey(candidate)).toBeNull();
      await expect(
        requestReceivingNomination(candidate, true, source, request),
      ).rejects.toThrow();
      expect(source.consumeProof).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("requires explicit self-confirmation before consuming a password proof", async () => {
    const source = proof();
    const request = vi.fn();
    await expect(
      requestReceivingNomination(scope, false, source, request),
    ).rejects.toThrow();
    expect(source.consumeProof).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { siteId: "wedding-b" },
    { sessionEpoch: 2 },
    { action: "REQUEST_WITHDRAWAL" },
    { access: { ...access, userId: "another-admin" } },
  ])("rejects stale or wrong-purpose proof ownership: %j", async (extra) => {
    const source = proof();
    Object.assign(source.scope, extra);
    const request = vi.fn();
    await expect(
      requestReceivingNomination(scope, true, source, request),
    ).rejects.toThrow();
    expect(source.consumeProof).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([null, "", "private-provider-token"])(
    "does not dispatch missing or malformed proof %s",
    async (value) => {
      const source = { ...proof(), consumeProof: vi.fn(() => value) };
      const request = vi.fn();
      await expect(
        requestReceivingNomination(scope, true, source, request),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it("rechecks current scope after proof consumption before dispatch", async () => {
    const candidate = { ...scope };
    const request = vi.fn();
    const source = {
      ...proof(),
      consumeProof: () => {
        candidate.sessionEpoch = 2;
        return token;
      },
    };
    await expect(
      requestReceivingNomination(candidate, true, source, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...response, account: { id: "private" } },
    { nomination: { ...response.nomination, siteId: "wedding-b" } },
    { nomination: { ...response.nomination, requestId: "other-request" } },
    { nomination: { ...response.nomination, state: "READY" } },
    { nomination: { ...response.nomination, providerAccountId: "private" } },
  ])("rejects mismatched or private response %j", async (value) => {
    await expect(
      requestReceivingNomination(
        scope,
        true,
        proof(),
        vi.fn().mockResolvedValue(value),
      ),
    ).rejects.toThrow();
  });
  it("ignores response for a scope changed during await", async () => {
    const candidate = { ...scope };
    const pending = deferred<unknown>();
    const promise = requestReceivingNomination(
      candidate,
      true,
      proof(),
      () => pending.promise,
    );
    candidate.sessionEpoch = 2;
    pending.resolve(response);
    await expect(promise).rejects.toThrow();
  });
});

describe("receiving nomination operation controller", () => {
  it("cannot nominate with an expired proof from the real password controller", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-10-12T18:00:00.000Z");
      const source = proof();
      const auth = createFinancialReauthenticationController(
        source.scope,
        vi.fn(),
        {
          now: () => now,
          request: vi.fn().mockResolvedValue({
            reauthenticationToken: token,
            expiresAt: "2026-10-12T18:03:00.000Z",
          }),
        },
      );
      await auth.submit("dummy-password");
      now += 180_000;
      const request = vi.fn();
      const controller = createReceivingNominationController(scope, vi.fn(), {
        request,
      });
      await controller.submit(true, {
        scope: source.scope,
        consumeProof: () => auth.consumeProof(),
      });
      expect(controller.getState()).toEqual({
        status: "reauthentication_required",
        uncertain: false,
      });
      expect(request).not.toHaveBeenCalled();
      auth.dispose();
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("never restores an in-flight response after detecting and then restoring the old scope", async () => {
    const candidate = { ...scope, access: structuredClone(access) };
    const pending = deferred<unknown>();
    const onState = vi.fn();
    const controller = createReceivingNominationController(candidate, onState, {
      request: () => pending.promise,
    });
    const work = controller.submit(true, proof(candidate));
    if (!candidate.access) throw new Error("Expected current access");
    candidate.access.capabilities.configureReceiving = false;
    expect(controller.getState().status).toBe("denied");
    candidate.access.capabilities.configureReceiving = true;
    onState.mockClear();
    pending.resolve(response);
    await work;
    expect(controller.getState().status).toBe("denied");
    expect(onState).not.toHaveBeenCalled();
  });
  it("cannot reuse an instance whose session ownership was detected lost and restored", async () => {
    const candidate = { ...scope };
    const request = vi.fn().mockResolvedValue(response);
    const controller = createReceivingNominationController(candidate, vi.fn(), {
      request,
    });
    candidate.sessionEpoch = 2;
    expect(controller.getState().status).toBe("denied");
    candidate.sessionEpoch = 1;
    const source = proof();
    await controller.submit(true, source);
    expect(controller.getState().status).toBe("denied");
    expect(request).not.toHaveBeenCalled();
    expect(source.consumeProof).not.toHaveBeenCalled();
  });
  it("denies a wrong-purpose proof before dispatch without inventing uncertainty", async () => {
    const source = {
      ...proof(),
      scope: { ...proof().scope, action: "REQUEST_WITHDRAWAL" as const },
    };
    const request = vi.fn();
    const controller = createReceivingNominationController(scope, vi.fn(), {
      request,
    });
    await controller.submit(true, source);
    expect(controller.getState()).toEqual({
      status: "denied",
      uncertain: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(source.consumeProof).not.toHaveBeenCalled();
  });
  it("requires a fresh consumed proof without dispatching when the proof holder is empty", async () => {
    const request = vi.fn();
    const controller = createReceivingNominationController(scope, vi.fn(), {
      request,
    });
    await controller.submit(true, { ...proof(), consumeProof: () => null });
    expect(controller.getState()).toEqual({
      status: "reauthentication_required",
      uncertain: false,
    });
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    { ...response, providerAccountId: "private" },
    { nomination: { ...response.nomination, siteId: "wedding-b" } },
  ])(
    "keeps malformed or foreign success uncertain after dispatch",
    async (value) => {
      const request = vi.fn().mockResolvedValue(value);
      const controller = createReceivingNominationController(scope, vi.fn(), {
        request,
      });
      await controller.submit(true, proof());
      expect(controller.getState()).toEqual({
        status: "unknown",
        uncertain: true,
      });
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
  it("never exposes mutable ownership of a confirmed pending response", async () => {
    const onState = vi.fn();
    const request = vi.fn().mockResolvedValue(response);
    const controller = createReceivingNominationController(scope, onState, {
      request,
    });
    await controller.submit(true, proof());
    const snapshot = controller.getState();
    if (!snapshot.nomination) throw new Error("Expected pending response");
    snapshot.nomination.siteId = "foreign";
    const observed = onState.mock.calls.at(-1)?.[0] as ReceivingNominationState;
    if (observed.nomination) observed.nomination.requestId = "replacement";
    expect(controller.getState().nomination).toEqual(response.nomination);
  });
  it("consumes a real current CONFIGURE_RECEIVING proof once and presents only pending", async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse("2026-10-12T18:00:00.000Z");
      const source = proof();
      const auth = createFinancialReauthenticationController(
        source.scope,
        vi.fn(),
        {
          now: () => now,
          request: vi.fn().mockResolvedValue({
            reauthenticationToken: token,
            expiresAt: "2026-10-12T18:03:00.000Z",
          }),
        },
      );
      await auth.submit("dummy-password");
      const request = vi.fn().mockResolvedValue(response);
      const states: ReceivingNominationState[] = [];
      const controller = createReceivingNominationController(
        scope,
        (state) => states.push(state),
        { request },
      );
      await controller.submit(true, {
        scope: source.scope,
        consumeProof: () => auth.consumeProof(),
      });
      expect(controller.getState()).toEqual({
        status: "pending",
        uncertain: false,
        nomination: response.nomination,
      });
      expect(auth.consumeProof()).toBeNull();
      await controller.submit(true, proof());
      expect(request).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(states)).not.toContain(token);
      auth.dispose();
      controller.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("ignores double submit while in flight", async () => {
    const pending = deferred<unknown>();
    const request = vi.fn(() => pending.promise);
    const source = proof();
    const controller = createReceivingNominationController(scope, vi.fn(), {
      request,
    });
    const first = controller.submit(true, source);
    await controller.submit(true, source);
    expect(request).toHaveBeenCalledTimes(1);
    expect(source.consumeProof).toHaveBeenCalledTimes(1);
    pending.resolve(response);
    await first;
  });
  it("replays the same request/policy after uncertainty using a fresh proof", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error(`private ${token}`))
      .mockResolvedValueOnce(response);
    const states: ReceivingNominationState[] = [];
    const controller = createReceivingNominationController(
      scope,
      (state) => states.push(state),
      { request },
    );
    await controller.submit(true, proof());
    expect(controller.getState()).toMatchObject({
      status: "unknown",
      uncertain: true,
    });
    const renewed = {
      ...proof(),
      consumeProof: vi.fn(() => `fr1.cmVuZXdlZA.${"B".repeat(43)}`),
    };
    await controller.submit(true, renewed);
    expect(controller.getState().status).toBe("pending");
    const bodies = request.mock.calls.map(
      (call) =>
        (call as unknown as [string, { body: Record<string, unknown> }])[1]
          .body,
    );
    expect(bodies.map((body) => body.requestId)).toEqual([
      scope.requestId,
      scope.requestId,
    ]);
    expect(bodies.map((body) => body.policyVersion)).toEqual([
      scope.policyVersion,
      scope.policyVersion,
    ]);
    expect(JSON.stringify(states)).not.toContain(token);
    expect(JSON.stringify(states)).not.toContain("private");
  });
  it.each([
    [new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"), "unavailable"],
    [new ApiError(403, "RECENT_AUTH_REQUIRED"), "reauthentication_required"],
    [new ApiError(403, "MEMBERSHIP_DENIED"), "denied"],
    [new ApiError(401, "UNAUTHORIZED"), "session_expired"],
  ] as const)(
    "sanitizes known early rejection to %s",
    async (error, status) => {
      const controller = createReceivingNominationController(scope, vi.fn(), {
        request: vi.fn().mockRejectedValue(error),
      });
      await controller.submit(true, proof());
      expect(controller.getState()).toEqual({ status, uncertain: false });
    },
  );
  it.each([
    new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"),
    new ApiError(403, "RECENT_AUTH_REQUIRED"),
    new ApiError(401, "UNAUTHORIZED"),
  ])(
    "does not erase prior uncertainty after a rejected replay",
    async (error) => {
      const request = vi
        .fn()
        .mockRejectedValueOnce(new Error("lost acknowledgement"))
        .mockRejectedValueOnce(error);
      const controller = createReceivingNominationController(scope, vi.fn(), {
        request,
      });
      await controller.submit(true, proof());
      await controller.submit(true, proof());
      expect(controller.getState().uncertain).toBe(true);
      expect(request.mock.calls).toHaveLength(2);
    },
  );
  it("retains the caller operation identity across a new session/controller after fresh authentication", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error("lost acknowledgement"))
      .mockResolvedValueOnce(response);
    const first = createReceivingNominationController(scope, vi.fn(), {
      request,
    });
    await first.submit(true, proof());
    first.dispose();
    const fresh = { ...scope, sessionEpoch: 2 };
    const second = createReceivingNominationController(fresh, vi.fn(), {
      request,
    });
    await second.submit(true, proof(fresh));
    expect(
      request.mock.calls.map(
        (call) =>
          (call as unknown as [string, { body: { requestId: string } }])[1].body
            .requestId,
      ),
    ).toEqual([scope.requestId, scope.requestId]);
    expect(second.getState().status).toBe("pending");
  });
  it("never settles into a disposed controller", async () => {
    const pending = deferred<unknown>();
    const onState = vi.fn();
    const controller = createReceivingNominationController(scope, onState, {
      request: () => pending.promise,
    });
    const work = controller.submit(true, proof());
    controller.dispose();
    onState.mockClear();
    pending.resolve(response);
    await work;
    expect(onState).not.toHaveBeenCalled();
  });
  it("denies a changed request identity instead of dispatching a replacement operation", async () => {
    const candidate = { ...scope };
    const request = vi
      .fn()
      .mockRejectedValue(new Error("lost acknowledgement"));
    const controller = createReceivingNominationController(candidate, vi.fn(), {
      request,
    });
    await controller.submit(true, proof());
    candidate.requestId = "replacement";
    await controller.submit(true, proof());
    expect(controller.getState().status).toBe("denied");
    expect(request).toHaveBeenCalledTimes(1);
  });
});
