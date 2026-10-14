import type { ReceivingNominationContext } from "@entrelacos/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { loadReceivingNominationContext } from "./receivingNominationContextClient";

const available: ReceivingNominationContext = {
  siteId: "wedding-a",
  state: "AVAILABLE",
  mode: "sandbox",
  requestId: `nr1_${"A".repeat(43)}`,
  policyVersion: "server-policy-current",
};
const pending: ReceivingNominationContext = {
  ...available,
  state: "PENDING",
  requestId: "legacy.request:fixed",
  policyVersion: "server-policy-original",
  currentPolicyVersion: "server-policy-original",
  postAllowed: true,
  nomination: {
    siteId: available.siteId,
    requestId: "legacy.request:fixed",
    state: "AWAITING_PROVIDER_VERIFICATION",
    createdAt: "2026-10-12T20:00:00.000Z",
    mode: "sandbox",
  },
};
const changedPolicy: ReceivingNominationContext = {
  ...pending,
  currentPolicyVersion: "server-policy-current",
  postAllowed: false,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("receiving nomination context client", () => {
  it.each([available, pending, changedPolicy])(
    "returns unchanged server context for $state/$postAllowed",
    async (context) => {
      const request = vi.fn().mockResolvedValue({ context });
      await expect(
        loadReceivingNominationContext("wedding-a", request),
      ).resolves.toEqual(context);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "/v1/sites/wedding-a/receiving/nomination-context",
      );
    },
  );

  it.each(["sandbox", "live"] as const)(
    "preserves the server's %s mode for available and pending context",
    async (mode) => {
      for (const context of [
        { ...available, mode },
        { ...pending, mode, nomination: { ...pending.nomination, mode } },
      ]) {
        const request = vi.fn().mockResolvedValue({ context });
        await expect(
          loadReceivingNominationContext("wedding-a", request),
        ).resolves.toEqual(context);
      }
    },
  );

  it("uses the existing default GET with session credentials and no-store", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ context: available })));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadReceivingNominationContext("wedding-a")).resolves.toEqual(
      available,
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "/api/v1/sites/wedding-a/receiving/nomination-context",
      {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      },
    );
  });

  it.each([
    "",
    "../wedding-a",
    "wedding-a/receiving",
    "wedding-a?policy=x",
    " wedding-a",
    "wedding.a",
    "wedding:a",
    "-wedding-a",
    "A".repeat(129),
    null,
    undefined,
    123,
  ])("rejects invalid site %j before dispatch", async (siteId) => {
    const request = vi.fn().mockResolvedValue({ context: available });
    await expect(
      loadReceivingNominationContext(siteId as string, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("uses the exact valid site in the path and response binding", async () => {
    const siteId = "1_SITE-name";
    const context = { ...available, siteId };
    const request = vi.fn().mockResolvedValue({ context });
    await expect(
      loadReceivingNominationContext(siteId, request),
    ).resolves.toEqual(context);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/v1/sites/1_SITE-name/receiving/nomination-context",
    );
  });

  it.each([
    null,
    undefined,
    [[]],
    {},
    { context: null },
    { context: available, operatorUserId: "private-operator" },
    { context: { ...available, siteId: "wedding-b" } },
    { context: { ...available, state: "READY" } },
    { context: { ...available, mode: "disabled" } },
    { context: { ...available, requestId: "" } },
    { context: { ...available, policyVersion: undefined } },
    { context: { ...available, providerAccountId: "private-account" } },
    { context: { ...available, reauthenticationToken: "private-proof" } },
    { context: { ...available, configureReceiving: true } },
    { context: { ...pending, siteId: "wedding-b" } },
    {
      context: {
        ...pending,
        siteId: "wedding-b",
        nomination: { ...pending.nomination, siteId: "wedding-b" },
      },
    },
    { context: { ...pending, nomination: undefined } },
    { context: { ...pending, currentPolicyVersion: undefined } },
    { context: { ...pending, postAllowed: false } },
    { context: { ...changedPolicy, postAllowed: true } },
    {
      context: {
        ...pending,
        nomination: { ...pending.nomination, siteId: "wedding-b" },
      },
    },
    {
      context: {
        ...pending,
        nomination: { ...pending.nomination, requestId: "other-request" },
      },
    },
    {
      context: {
        ...pending,
        nomination: { ...pending.nomination, mode: "live" },
      },
    },
    {
      context: {
        ...pending,
        nomination: { ...pending.nomination, state: "READY" },
      },
    },
    {
      context: {
        ...pending,
        nomination: { ...pending.nomination, createdAt: "not-a-date" },
      },
    },
    {
      context: {
        ...pending,
        nomination: { ...pending.nomination, walletId: "private-wallet" },
      },
    },
  ])(
    "rejects malformed, foreign, private or contradictory context %j",
    async (response) => {
      const request = vi.fn().mockResolvedValue(response);
      await expect(
        loadReceivingNominationContext("wedding-a", request),
      ).rejects.toThrow();
      expect(request).toHaveBeenCalledExactlyOnceWith(
        "/v1/sites/wedding-a/receiving/nomination-context",
      );
    },
  );

  it.each([
    new ApiError(401, "UNAUTHORIZED"),
    new ApiError(403, "MEMBERSHIP_DENIED"),
    new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"),
    new ApiError(503, "SERVICE_UNAVAILABLE"),
    new Error("offline"),
  ])(
    "preserves transport/auth failures without constructing context: %j",
    async (failure) => {
      const request = vi.fn().mockRejectedValue(failure);
      await expect(
        loadReceivingNominationContext("wedding-a", request),
      ).rejects.toBe(failure);
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it("reads every response freshly without changing identity or retaining context", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ context: available })
      .mockResolvedValueOnce({ context: changedPolicy });
    await expect(
      loadReceivingNominationContext("wedding-a", request),
    ).resolves.toEqual(available);
    await expect(
      loadReceivingNominationContext("wedding-a", request),
    ).resolves.toEqual(changedPolicy);
    expect(request.mock.calls).toEqual([
      ["/v1/sites/wedding-a/receiving/nomination-context"],
      ["/v1/sites/wedding-a/receiving/nomination-context"],
    ]);
  });

  it("does not mutate payloads, access storage or generate operation identities", async () => {
    const storage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
    };
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("sessionStorage", storage);
    const randomUUID = vi.spyOn(globalThis.crypto, "randomUUID");
    const getRandomValues = vi.spyOn(globalThis.crypto, "getRandomValues");
    const context = Object.freeze({
      ...changedPolicy,
      nomination: Object.freeze({ ...changedPolicy.nomination }),
    });
    const response = Object.freeze({ context });
    const request = vi.fn().mockResolvedValue(response);
    await expect(
      loadReceivingNominationContext("wedding-a", request),
    ).resolves.toEqual(changedPolicy);
    expect(response).toEqual({ context: changedPolicy });
    for (const operation of Object.values(storage))
      expect(operation).not.toHaveBeenCalled();
    expect(randomUUID).not.toHaveBeenCalled();
    expect(getRandomValues).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith(
      "/v1/sites/wedding-a/receiving/nomination-context",
    );
  });
});
