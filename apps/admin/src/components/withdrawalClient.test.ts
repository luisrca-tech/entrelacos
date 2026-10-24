import {
  type WithdrawalIntent,
  type WithdrawalRequestContext,
  type WithdrawalRequestStatus,
  withdrawalRequestContextSchema,
} from "@entrelacos/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compareWithdrawalContexts,
  compareWithdrawalObservations,
  loadWithdrawalContext,
  loadWithdrawalRequest,
  postWithdrawalAction,
  previewWithdrawal,
  readWithdrawalMarker,
  removeWithdrawalMarker,
  sealWithdrawalRequest,
  type WithdrawalMarker,
  type WithdrawalStorage,
  withdrawalMarkerKey,
  writeWithdrawalMarker,
} from "./withdrawalClient";

const siteId = "wedding-a";
const requestId = "context";
const token = `fr1.opaque.${"A".repeat(43)}`;
const observedAt = "2026-10-12T22:00:00.000Z";
const micros = String(BigInt(Date.parse(observedAt)) * 1000n);
const preview = {
  siteId,
  requestId,
  mode: "sandbox" as const,
  currency: "BRL" as const,
  amountCents: 10000,
  feeCents: 200,
  netCents: 9800,
  destinationVersion: 3,
  maskedDestination: "Banco **** 1234",
  operatorDisplayName: "Operator profile",
  policyVersion: "policy-original",
  issuedAt: observedAt,
  expiresAt: "2026-10-12T22:05:00.000Z",
};
const open: WithdrawalRequestStatus = {
  siteId,
  requestId,
  mode: "sandbox",
  state: "OPEN",
  requestRevision: "1",
  scopeRevision: "90071992547409930",
  observedAt,
  observationOrder: {
    scopeRevision: "90071992547409930",
    requestRevision: "1",
    recordUpdatedAtMicroseconds: micros,
  },
  preview,
};
const withdrawal: WithdrawalIntent = {
  id: "intent-original",
  siteId,
  mode: "sandbox",
  currency: "BRL",
  amountCents: 10000,
  feeCents: 200,
  netCents: 9800,
  destinationVersion: 3,
  state: "REQUESTED",
  createdAt: observedAt,
  updatedAt: observedAt,
};
const existing: WithdrawalRequestStatus = {
  ...open,
  state: "EXISTING",
  requestRevision: "2",
  scopeRevision: "90071992547409931",
  observationOrder: {
    scopeRevision: "90071992547409931",
    requestRevision: "2",
    recordUpdatedAtMicroseconds: String(BigInt(micros) + 1n),
  },
  preview,
  command: { requestId, amountCents: 10000, destinationVersion: 3 },
  withdrawal,
};
const context: WithdrawalRequestContext = {
  siteId,
  mode: "sandbox",
  scopeRevision: open.scopeRevision,
  observedAt,
  observationOrder: {
    scopeRevision: open.scopeRevision,
    requestRevision: null,
    recordUpdatedAtMicroseconds: null,
  },
  newRequestAllowed: false,
  reason: "OPEN_REQUEST",
  openRequest: open,
  recoverableRequests: [],
  nextCursor: "page:next",
};
const marker: WithdrawalMarker = {
  version: 1,
  siteId,
  operatorUserId: "operator:1",
  mode: "sandbox",
  requestId,
};

function memoryStorage(): WithdrawalStorage {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => void values.set(key, value)),
    removeItem: vi.fn((key: string) => void values.delete(key)),
  };
}

let realFetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  realFetch = vi.fn(() => Promise.reject(new Error("Real fetch forbidden")));
  vi.stubGlobal("fetch", realFetch);
});
afterEach(() => {
  expect(realFetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("withdrawal strict transport", () => {
  it("rejects correlated preview settlement with a different original amount", async () => {
    const response = {
      ...open,
      preview: { ...preview, amountCents: 20000, netCents: 19800 },
    };
    await expect(
      previewWithdrawal(
        siteId,
        { requestId, amountCents: 10000, scopeRevision: open.scopeRevision },
        vi.fn().mockResolvedValue({ request: response }),
      ),
    ).rejects.toThrow();
  });
  it("loads discovery unchanged without a mutation or inferring page absence", async () => {
    const request = vi.fn().mockResolvedValue({ context });
    await expect(loadWithdrawalContext(siteId, request)).resolves.toEqual(
      context,
    );
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/sites/${siteId}/withdrawals/context`,
    );
  });
  it.each([open, existing])(
    "uses canonical exact lookup for reserved request $state",
    async (value) => {
      const request = vi.fn().mockResolvedValue({ request: value });
      await expect(
        loadWithdrawalRequest(siteId, requestId, request),
      ).resolves.toEqual(value);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        `/v1/sites/${siteId}/withdrawals/requests/context`,
      );
    },
  );
  it.each([open, existing])(
    "preserves state-correlated preview replay $state",
    async (value) => {
      const request = vi.fn().mockResolvedValue({ request: value });
      const input = {
        requestId,
        amountCents: 10000,
        scopeRevision: open.scopeRevision,
      };
      await expect(previewWithdrawal(siteId, input, request)).resolves.toEqual(
        value,
      );
      expect(request).toHaveBeenCalledExactlyOnceWith(
        `/v1/sites/${siteId}/withdrawals/preview`,
        { method: "POST", body: input },
      );
    },
  );
  it.each(["CONFIRM_NEW", "RECOVER_EXISTING"] as const)(
    "dispatches only explicit %s proof wire",
    async (action) => {
      const request = vi.fn().mockResolvedValue({ requestId, withdrawal });
      const input = { action, requestId, reauthenticationToken: token };
      await expect(
        postWithdrawalAction(siteId, input, request),
      ).resolves.toEqual(withdrawal);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        `/v1/sites/${siteId}/withdrawals`,
        { method: "POST", body: input },
      );
    },
  );
  it("seals route identity without a financial reauthentication proof", async () => {
    const sealed = {
      ...open,
      state: "SEALED_NOT_CREATED",
      requestRevision: "2",
      observationOrder: { ...open.observationOrder, requestRevision: "2" },
      command: existing.command,
      sealedAt: observedAt,
    };
    const { preview: _preview, ...value } = sealed;
    const request = vi.fn().mockResolvedValue({ request: value });
    await expect(
      sealWithdrawalRequest(siteId, requestId, request),
    ).resolves.toEqual(value);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/sites/${siteId}/withdrawals/context/seal`,
      { method: "POST", body: {} },
    );
  });
  it.each([
    "",
    "../other",
    "site?query",
    "site/path",
    "site.name",
    " site",
    "x".repeat(129),
  ])("rejects invalid site %j before any transport", async (bad) => {
    const request = vi.fn();
    await expect(loadWithdrawalContext(bad, request)).rejects.toThrow();
    await expect(
      loadWithdrawalRequest(bad, requestId, request),
    ).rejects.toThrow();
    await expect(
      previewWithdrawal(
        bad,
        { requestId, amountCents: 10000, scopeRevision: "1" },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      postWithdrawalAction(
        bad,
        { action: "CONFIRM_NEW", requestId, reauthenticationToken: token },
        request,
      ),
    ).rejects.toThrow();
    await expect(
      sealWithdrawalRequest(bad, requestId, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each(["", "../other", "id?query", "id/path", " id", "x".repeat(129)])(
    "rejects invalid retained ID %j before lookup/seal",
    async (bad) => {
      const request = vi.fn();
      await expect(
        loadWithdrawalRequest(siteId, bad, request),
      ).rejects.toThrow();
      await expect(
        sealWithdrawalRequest(siteId, bad, request),
      ).rejects.toThrow();
      expect(request).not.toHaveBeenCalled();
    },
  );
  it.each([
    { requestId, amountCents: 10000, scopeRevision: "01" },
    { requestId, amountCents: 10000, scopeRevision: 1 },
    { requestId, amountCents: 10000, scopeRevision: "1", quoteId: "private" },
    { requestId, amountCents: 0, scopeRevision: "1" },
  ])("rejects malformed/private preview input %j", async (input) => {
    const request = vi.fn();
    await expect(
      previewWithdrawal(siteId, input as never, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    {
      requestId,
      amountCents: 10000,
      destinationVersion: 3,
      reauthenticationToken: token,
    },
    {
      action: "CONFIRM_NEW",
      requestId,
      reauthenticationToken: token,
      operatorUserId: "operator",
    },
    { action: "RECOVER_EXISTING", requestId, reauthenticationToken: "invalid" },
    { action: "CONFIRM_NEW", requestId },
  ])("rejects legacy/private/invalid action input %j", async (input) => {
    const request = vi.fn();
    await expect(
      postWithdrawalAction(siteId, input as never, request),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {
      request: {
        ...open,
        requestId: "another",
        preview: { ...preview, requestId: "another" },
      },
    },
    {
      request: {
        ...open,
        siteId: "other",
        preview: { ...preview, siteId: "other" },
      },
    },
    { request: open, providerId: "private" },
    { request: { ...open, preview: { ...preview, bankAccount: "private" } } },
  ])(
    "rejects malformed/private/foreign request settlement %j",
    async (value) => {
      const request = vi.fn().mockResolvedValue(value);
      await expect(
        loadWithdrawalRequest(siteId, requestId, request),
      ).rejects.toThrow();
      await expect(
        previewWithdrawal(
          siteId,
          { requestId, amountCents: 10000, scopeRevision: "1" },
          request,
        ),
      ).rejects.toThrow();
      await expect(
        sealWithdrawalRequest(siteId, requestId, request),
      ).rejects.toThrow();
    },
  );
  it.each([
    { requestId: "other", withdrawal },
    { requestId, withdrawal: { ...withdrawal, siteId: "other" } },
    { requestId, withdrawal, reauthenticationToken: token },
    { requestId, withdrawal: { ...withdrawal, providerId: "private" } },
  ])("rejects uncorrelated/private action settlement %j", async (value) => {
    await expect(
      postWithdrawalAction(
        siteId,
        { action: "RECOVER_EXISTING", requestId, reauthenticationToken: token },
        vi.fn().mockResolvedValue(value),
      ),
    ).rejects.toThrow();
  });
  it.each([
    null,
    { context, privateAccount: "private" },
    {
      context: {
        ...context,
        siteId: "foreign",
        openRequest: null,
        reason: "CONTEXT_UNAVAILABLE",
      },
    },
    { context: { ...context, reauthenticationToken: token } },
  ])("rejects malformed/private/foreign discovery %j", async (value) => {
    await expect(
      loadWithdrawalContext(siteId, vi.fn().mockResolvedValue(value)),
    ).rejects.toThrow();
  });
  it("propagates possibly dispatched errors without automatic retries", async () => {
    const error = new Error("Unknown settlement");
    const request = vi.fn().mockRejectedValue(error);
    await expect(
      postWithdrawalAction(
        siteId,
        { action: "CONFIRM_NEW", requestId, reauthenticationToken: token },
        request,
      ),
    ).rejects.toBe(error);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("withdrawal authoritative ordering", () => {
  const unknown: WithdrawalRequestStatus = {
    siteId,
    requestId,
    mode: "sandbox",
    state: "UNRESOLVED",
    requestRevision: null,
    scopeRevision: String(BigInt(open.scopeRevision) - 1n),
    observedAt,
    observationOrder: {
      scopeRevision: String(BigInt(open.scopeRevision) - 1n),
      requestRevision: null,
      recordUpdatedAtMicroseconds: null,
    },
    command: null,
  };
  const sealed: WithdrawalRequestStatus = {
    siteId,
    requestId,
    mode: "sandbox",
    state: "SEALED_NOT_CREATED",
    requestRevision: "2",
    scopeRevision: existing.scopeRevision,
    observedAt,
    observationOrder: existing.observationOrder,
    command: existing.command,
    sealedAt: observedAt,
  };
  it("recovers an exact tombstone sealed by another device after delayed preview registration", () => {
    expect(compareWithdrawalObservations(unknown, sealed)).toBe("newer");
    expect(compareWithdrawalObservations(sealed, unknown)).toBe("older");
    expect(
      compareWithdrawalObservations(
        { ...unknown, command: existing.command },
        sealed,
      ),
    ).toBe("newer");
  });
  it.each([
    {
      ...unknown,
      scopeRevision: sealed.scopeRevision,
      observationOrder: {
        ...unknown.observationOrder,
        scopeRevision: sealed.scopeRevision,
      },
    },
    { ...unknown, observedAt: "2026-10-12T22:00:01.000Z" },
    { ...unknown, command: { ...existing.command, amountCents: 20000 } },
    { ...unknown, command: { ...existing.command, destinationVersion: 4 } },
    { ...unknown, siteId: "other" },
    { ...unknown, requestId: "other" },
    { ...unknown, mode: "live" },
    {
      ...unknown,
      observationOrder: {
        ...unknown.observationOrder,
        recordUpdatedAtMicroseconds: String(BigInt(micros) + 2n),
      },
    },
    { ...unknown, reauthenticationToken: token },
  ])("rejects unbound or regressive tombstone recovery %j", (before) => {
    expect(
      compareWithdrawalObservations(before as WithdrawalRequestStatus, sealed),
    ).toBe("incomparable");
  });
  it.each([open, existing])(
    "recovers delayed unknown correlation into authoritative $state only at a greater scope revision",
    (known) => {
      expect(compareWithdrawalObservations(unknown, known)).toBe("newer");
      expect(compareWithdrawalObservations(known, unknown)).toBe("older");
      const original = { ...unknown, command: existing.command };
      expect(compareWithdrawalObservations(original, known)).toBe("newer");
    },
  );
  it("allows discovery to resolve the retained unknown request rather than creating an unrelated operation", () => {
    const before: WithdrawalRequestContext = {
      ...context,
      scopeRevision: unknown.scopeRevision,
      observationOrder: {
        ...context.observationOrder,
        scopeRevision: unknown.scopeRevision,
      },
      reason: "UNRESOLVED_OPERATION",
      openRequest: null,
      recoverableRequests: [unknown],
    };
    expect(compareWithdrawalContexts(before, context)).toBe("newer");
    expect(compareWithdrawalContexts(context, before)).toBe("older");
  });
  it.each([
    {
      ...unknown,
      scopeRevision: open.scopeRevision,
      observationOrder: {
        ...unknown.observationOrder,
        scopeRevision: open.scopeRevision,
      },
    },
    {
      ...unknown,
      scopeRevision: String(BigInt(open.scopeRevision) + 1n),
      observationOrder: {
        ...unknown.observationOrder,
        scopeRevision: String(BigInt(open.scopeRevision) + 1n),
      },
    },
    { ...unknown, observedAt: "2026-10-12T22:00:01.000Z" },
    { ...unknown, command: { ...existing.command, amountCents: 20000 } },
    { ...unknown, command: { ...existing.command, destinationVersion: 4 } },
    { ...unknown, requestId: "other" },
    { ...unknown, siteId: "other" },
    { ...unknown, mode: "live" },
    {
      ...unknown,
      observationOrder: {
        ...unknown.observationOrder,
        recordUpdatedAtMicroseconds: String(BigInt(micros) + 1n),
      },
    },
  ])(
    "does not resolve unknown correlation across contradictory evidence %j",
    (before) => {
      expect(
        compareWithdrawalObservations(before as WithdrawalRequestStatus, open),
      ).toBe("incomparable");
    },
  );
  it("preserves the known record floor while resolving a previously unknown request revision", () => {
    const retainedFloor: WithdrawalRequestStatus = {
      ...unknown,
      command: existing.command,
      observationOrder: {
        ...unknown.observationOrder,
        recordUpdatedAtMicroseconds: micros,
      },
    };
    expect(compareWithdrawalObservations(retainedFloor, existing)).toBe(
      "newer",
    );
  });
  it("does not replace a known immutable preview with missing historical terms", () => {
    expect(
      compareWithdrawalObservations(open, { ...existing, preview: null }),
    ).toBe("incomparable");
  });
  it("rejects a stale nested request carried by a later context observation", () => {
    const before = {
      ...context,
      observedAt: "2026-10-12T22:00:02.000Z",
      openRequest: { ...open, observedAt: "2026-10-12T22:00:02.000Z" },
    };
    const after = {
      ...context,
      observedAt: "2026-10-12T22:00:03.000Z",
      openRequest: { ...open, observedAt: "2026-10-12T22:00:01.000Z" },
    };
    expect(compareWithdrawalContexts(before, after)).toBe("incomparable");
  });
  it("rejects older observation time even when the authoritative tuple is unchanged", () => {
    const newer = { ...existing, observedAt: "2026-10-12T22:00:02.000Z" };
    const older = { ...existing, observedAt: "2026-10-12T22:00:01.000Z" };
    expect(compareWithdrawalObservations(newer, older)).toBe("older");
    expect(
      compareWithdrawalContexts(
        { ...context, observedAt: newer.observedAt },
        { ...context, observedAt: older.observedAt },
      ),
    ).toBe("older");
  });
  it("accepts unchanged discovery observed later without changing nested request terms", () => {
    const next = {
      ...context,
      observedAt: "2026-10-12T22:00:01.000Z",
      openRequest: { ...open, observedAt: "2026-10-12T22:00:01.000Z" },
    };
    expect(compareWithdrawalContexts(context, next)).toBe("same");
  });
  it.each(["DESTINATION_UNAVAILABLE", "UNRESOLVED_OPERATION"] as const)(
    "orders newer derived %s admission without a withdrawal revision change",
    (reason) => {
      const blocked: WithdrawalRequestContext = {
        ...context,
        scopeRevision: "0",
        observationOrder: { ...context.observationOrder, scopeRevision: "0" },
        newRequestAllowed: false,
        reason,
        openRequest: null,
        recoverableRequests: [],
        nextCursor: null,
      };
      const ready = {
        ...blocked,
        observedAt: "2026-10-12T22:00:01.000Z",
        newRequestAllowed: true,
        reason: null,
      };
      const blockedAgain = {
        ...blocked,
        observedAt: "2026-10-12T22:00:02.000Z",
      };
      expect(compareWithdrawalContexts(blocked, ready)).toBe("newer");
      expect(compareWithdrawalContexts(ready, blocked)).toBe("older");
      expect(compareWithdrawalContexts(ready, blockedAgain)).toBe("newer");
      expect(compareWithdrawalContexts(blockedAgain, ready)).toBe("older");
      const conflicting = { ...ready, observedAt };
      const changedCursor = { ...ready, nextCursor: "wc1:changed" };
      expect(
        withdrawalRequestContextSchema.safeParse(conflicting).success,
      ).toBe(true);
      expect(
        withdrawalRequestContextSchema.safeParse(changedCursor).success,
      ).toBe(true);
      expect(compareWithdrawalContexts(blocked, conflicting)).toBe(
        "incomparable",
      );
      expect(compareWithdrawalContexts(blocked, changedCursor)).toBe(
        "incomparable",
      );
    },
  );
  it.each(["REQUESTED", "UNKNOWN"] as const)(
    "orders provider completion from %s without a withdrawal scope revision change",
    (state) => {
      const before: WithdrawalRequestContext = {
        ...context,
        scopeRevision: existing.scopeRevision,
        observationOrder: {
          ...context.observationOrder,
          scopeRevision: existing.scopeRevision,
        },
        newRequestAllowed: state !== "UNKNOWN",
        reason: state === "UNKNOWN" ? "UNRESOLVED_OPERATION" : null,
        openRequest: null,
        recoverableRequests: [
          { ...existing, withdrawal: { ...withdrawal, state } },
        ],
      };
      const completedAt = "2026-10-12T22:00:01.000Z";
      const completed: WithdrawalRequestStatus = {
        ...existing,
        observedAt: completedAt,
        observationOrder: {
          ...existing.observationOrder,
          recordUpdatedAtMicroseconds: String(BigInt(micros) + 1000000n),
        },
        withdrawal: {
          ...withdrawal,
          state: "COMPLETED",
          updatedAt: completedAt,
        },
      };
      const after: WithdrawalRequestContext = {
        ...before,
        observedAt: completedAt,
        newRequestAllowed: true,
        reason: null,
        recoverableRequests: [completed],
      };
      expect(withdrawalRequestContextSchema.safeParse(before).success).toBe(
        true,
      );
      expect(withdrawalRequestContextSchema.safeParse(after).success).toBe(
        true,
      );
      expect(compareWithdrawalContexts(before, after)).toBe("newer");
      expect(compareWithdrawalContexts(after, before)).toBe("older");
      expect(
        compareWithdrawalContexts(before, {
          ...after,
          nextCursor: "wc1:changed",
        }),
      ).toBe("incomparable");
      expect(
        compareWithdrawalContexts(after, {
          ...before,
          observedAt: "2026-10-12T22:00:02.000Z",
        }),
      ).toBe("incomparable");
    },
  );
  it("rejects immutable term replacement across newer contexts", () => {
    const next = {
      ...context,
      scopeRevision: "90071992547409931",
      observationOrder: {
        ...context.observationOrder,
        scopeRevision: "90071992547409931",
      },
      openRequest: {
        ...open,
        scopeRevision: "90071992547409931",
        observationOrder: {
          ...open.observationOrder,
          scopeRevision: "90071992547409931",
        },
        preview: { ...preview, maskedDestination: "Banco **** 9876" },
      },
    };
    expect(compareWithdrawalContexts(context, next)).toBe("incomparable");
  });
  it("compares huge exact revisions and within-millisecond record time", () => {
    expect(compareWithdrawalObservations(open, existing)).toBe("newer");
    expect(compareWithdrawalObservations(existing, open)).toBe("older");
    expect(
      compareWithdrawalObservations(existing, structuredClone(existing)),
    ).toBe("same");
    const next = {
      ...existing,
      observationOrder: {
        ...existing.observationOrder,
        recordUpdatedAtMicroseconds: String(BigInt(micros) + 2n),
      },
    };
    expect(compareWithdrawalObservations(existing, next)).toBe("newer");
  });
  it.each([
    {
      ...existing,
      scopeRevision: open.scopeRevision,
      observationOrder: {
        ...existing.observationOrder,
        scopeRevision: open.scopeRevision,
      },
    },
    { ...existing, observedAt: "2026-10-12T21:59:59.999Z" },
    {
      ...existing,
      requestId: "other",
      command: { ...existing.command, requestId: "other" },
      preview: { ...preview, requestId: "other" },
    },
    {
      ...existing,
      preview: { ...preview, maskedDestination: "Banco **** 9876" },
    },
    {
      ...existing,
      preview: null,
      command: { ...existing.command, destinationVersion: 4 },
      withdrawal: { ...withdrawal, destinationVersion: 4 },
    },
    {
      ...existing,
      observationOrder: { ...existing.observationOrder, scopeRevision: "01" },
    },
  ])("does not accept contradictory/mixed/changed bindings %j", (next) => {
    expect(
      compareWithdrawalObservations(open, next as WithdrawalRequestStatus),
    ).toBe("incomparable");
  });
  it("rejects equal authoritative tuple with changed state/terms even if observation is later", () => {
    const next = {
      ...existing,
      observedAt: "2026-10-12T22:00:01.000Z",
      withdrawal: { ...withdrawal, state: "UNKNOWN" as const },
    };
    expect(compareWithdrawalObservations(existing, next)).toBe("incomparable");
  });
  it("rejects missing or contradictory settlement at the same authoritative record time", () => {
    const settled: WithdrawalRequestStatus = {
      ...existing,
      preview: { ...preview, feeSemantics: "MAXIMUM" },
      withdrawal: {
        ...withdrawal,
        state: "COMPLETED",
        feeSemantics: "MAXIMUM",
        settlement: {
          totalDebitCents: 9800,
          feeCents: 0,
          netCents: 9800,
          releasedCents: 200,
        },
      },
    };
    const { settlement: _settlement, ...withoutSettlement } =
      settled.withdrawal;
    const missing = { ...settled, withdrawal: withoutSettlement };
    const contradictory = {
      ...settled,
      withdrawal: {
        ...settled.withdrawal,
        settlement: {
          totalDebitCents: 9900,
          feeCents: 100,
          netCents: 9800,
          releasedCents: 100,
        },
      },
    };
    expect(compareWithdrawalObservations(settled, missing)).toBe(
      "incomparable",
    );
    expect(compareWithdrawalObservations(missing, settled)).toBe(
      "incomparable",
    );
    expect(compareWithdrawalObservations(settled, contradictory)).toBe(
      "incomparable",
    );
  });
  it.each(["rewrite", "remove", "regress"] as const)(
    "rejects completed settlement %s even with a later authoritative record",
    (change) => {
      const settled: WithdrawalRequestStatus & { state: "EXISTING" } = {
        ...existing,
        preview: { ...preview, feeSemantics: "MAXIMUM" },
        withdrawal: {
          ...withdrawal,
          state: "COMPLETED",
          feeSemantics: "MAXIMUM",
          settlement: {
            totalDebitCents: 9800,
            feeCents: 0,
            netCents: 9800,
            releasedCents: 200,
          },
        },
      };
      const { settlement: _settlement, ...withoutSettlement } =
        settled.withdrawal;
      const later: WithdrawalRequestStatus = {
        ...settled,
        observedAt: "2026-10-12T22:00:01.000Z",
        observationOrder: {
          ...settled.observationOrder,
          recordUpdatedAtMicroseconds: String(BigInt(micros) + 1000000n),
        },
        withdrawal:
          change === "rewrite"
            ? {
                ...settled.withdrawal,
                settlement: {
                  totalDebitCents: 9900,
                  feeCents: 100,
                  netCents: 9800,
                  releasedCents: 100,
                },
              }
            : {
                ...withoutSettlement,
                state: change === "regress" ? "REQUESTED" : "COMPLETED",
              },
      };
      const discovery = (
        request: WithdrawalRequestStatus,
      ): WithdrawalRequestContext => ({
        ...context,
        scopeRevision: request.scopeRevision,
        observedAt: request.observedAt,
        observationOrder: {
          ...context.observationOrder,
          scopeRevision: request.scopeRevision,
        },
        newRequestAllowed: true,
        reason: null,
        openRequest: null,
        recoverableRequests: [request],
      });
      expect(
        withdrawalRequestContextSchema.safeParse(discovery(later)).success,
      ).toBe(true);
      expect(compareWithdrawalObservations(settled, later)).toBe(
        "incomparable",
      );
      expect(compareWithdrawalObservations(later, settled)).toBe(
        "incomparable",
      );
      expect(
        compareWithdrawalContexts(discovery(settled), discovery(later)),
      ).toBe("incomparable");
      expect(
        compareWithdrawalContexts(discovery(later), discovery(settled)),
      ).toBe("incomparable");
    },
  );
  it("rejects completed terminal regression without requiring settlement evidence", () => {
    const terminal: WithdrawalRequestStatus = {
      ...existing,
      withdrawal: { ...withdrawal, state: "COMPLETED" },
    };
    const later: WithdrawalRequestStatus = {
      ...existing,
      observedAt: "2026-10-12T22:00:01.000Z",
      observationOrder: {
        ...existing.observationOrder,
        recordUpdatedAtMicroseconds: String(BigInt(micros) + 1000000n),
      },
    };
    expect(compareWithdrawalObservations(terminal, later)).toBe("incomparable");
    expect(compareWithdrawalObservations(later, terminal)).toBe("incomparable");
  });
  it("retains unknown legacy dimensions without treating null as zero", () => {
    const unresolved: WithdrawalRequestStatus = {
      siteId,
      requestId,
      mode: "sandbox",
      state: "UNRESOLVED",
      requestRevision: null,
      scopeRevision: open.scopeRevision,
      observedAt,
      observationOrder: {
        scopeRevision: open.scopeRevision,
        requestRevision: null,
        recordUpdatedAtMicroseconds: null,
      },
      command: null,
    };
    expect(compareWithdrawalObservations(unresolved, open)).toBe(
      "incomparable",
    );
    expect(
      compareWithdrawalObservations(unresolved, structuredClone(unresolved)),
    ).toBe("same");
  });
  it("compares scope discovery without treating same-revision changed payload as fresh", () => {
    expect(compareWithdrawalContexts(context, structuredClone(context))).toBe(
      "same",
    );
    const next = {
      ...context,
      scopeRevision: "90071992547409931",
      openRequest: null,
      newRequestAllowed: true,
      reason: null,
      observationOrder: {
        ...context.observationOrder,
        scopeRevision: "90071992547409931",
      },
    };
    expect(compareWithdrawalContexts(context, next)).toBe("newer");
    expect(compareWithdrawalContexts(next, context)).toBe("older");
    expect(
      compareWithdrawalContexts(context, { ...context, nextCursor: null }),
    ).toBe("incomparable");
    expect(
      compareWithdrawalContexts(context, {
        ...context,
        observedAt: "2026-10-12T22:00:01.000Z",
      }),
    ).toBe("same");
  });
});

describe("minimal withdrawal correlation marker", () => {
  it("retains a strict original preview body without upgrading or downgrading markers", () => {
    const storage = memoryStorage();
    const resumable = {
      ...marker,
      version: 2 as const,
      previewInput: { requestId, amountCents: 10000, scopeRevision: "0" },
    };
    writeWithdrawalMarker(storage, resumable);
    expect(
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toEqual(resumable);
    expect(() => writeWithdrawalMarker(storage, marker)).toThrow();
    expect(() =>
      writeWithdrawalMarker(storage, {
        ...resumable,
        previewInput: { ...resumable.previewInput, amountCents: 20000 },
      }),
    ).toThrow();
    expect(removeWithdrawalMarker(storage, resumable)).toBe(true);
    writeWithdrawalMarker(storage, marker);
    expect(() => writeWithdrawalMarker(storage, resumable)).toThrow();
  });
  it.each([
    { requestId: "other", amountCents: 10000, scopeRevision: "0" },
    { requestId, amountCents: 0, scopeRevision: "0" },
    { requestId, amountCents: 10000, scopeRevision: "-1" },
    {
      requestId,
      amountCents: 10000,
      scopeRevision: "0",
      reauthenticationToken: token,
    },
  ])("rejects invalid original preview bodies %j", (previewInput) => {
    const storage = memoryStorage();
    storage.setItem(
      withdrawalMarkerKey(siteId, marker.operatorUserId),
      JSON.stringify({
        ...marker,
        version: 2,
        previewInput,
      }),
    );
    expect(() =>
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toThrow();
  });
  it("propagates write/remove denial while preserving the retained correlation", () => {
    const storage = memoryStorage();
    vi.mocked(storage.setItem).mockImplementation(() => {
      throw new Error("Write denied");
    });
    expect(() => writeWithdrawalMarker(storage, marker)).toThrow(
      "Write denied",
    );
    const retained = memoryStorage();
    writeWithdrawalMarker(retained, marker);
    vi.mocked(retained.removeItem).mockImplementation(() => {
      throw new Error("Remove denied");
    });
    expect(() => removeWithdrawalMarker(retained, marker)).toThrow(
      "Remove denied",
    );
    expect(
      readWithdrawalMarker(retained, siteId, marker.operatorUserId),
    ).toEqual(marker);
  });
  it("persists only correlation and reads it back in the exact scoped key", () => {
    const storage = memoryStorage();
    expect(
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toBeNull();
    writeWithdrawalMarker(storage, marker);
    expect(
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toEqual(marker);
    expect(storage.setItem).toHaveBeenCalledExactlyOnceWith(
      withdrawalMarkerKey(siteId, marker.operatorUserId),
      JSON.stringify(marker),
    );
    expect(withdrawalMarkerKey("other", marker.operatorUserId)).not.toBe(
      withdrawalMarkerKey(siteId, marker.operatorUserId),
    );
    expect(withdrawalMarkerKey(siteId, "other")).not.toBe(
      withdrawalMarkerKey(siteId, marker.operatorUserId),
    );
  });
  it("allows same marker roundtrip but refuses a different retained operation", () => {
    const storage = memoryStorage();
    writeWithdrawalMarker(storage, marker);
    writeWithdrawalMarker(storage, { ...marker });
    expect(() =>
      writeWithdrawalMarker(storage, { ...marker, requestId: "later" }),
    ).toThrow();
    expect(() =>
      writeWithdrawalMarker(storage, { ...marker, mode: "live" }),
    ).toThrow();
    expect(
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toEqual(marker);
  });
  it.each([
    null,
    [],
    {},
    { ...marker, version: 2 },
    { ...marker, siteId: "other" },
    { ...marker, operatorUserId: "other" },
    { ...marker, mode: "disabled" },
    { ...marker, requestId: "../bad" },
    { ...marker, amountCents: 10000 },
    { ...marker, reauthenticationToken: token },
    { ...marker, sessionEpoch: 1 },
  ])("rejects corrupt/private/foreign marker %j", (value) => {
    const storage = memoryStorage();
    storage.setItem(
      withdrawalMarkerKey(siteId, marker.operatorUserId),
      JSON.stringify(value),
    );
    expect(() =>
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toThrow();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it("rejects invalid JSON, inaccessible storage, and mismatched write readback", () => {
    const storage = memoryStorage();
    storage.setItem(withdrawalMarkerKey(siteId, marker.operatorUserId), "{");
    expect(() =>
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toThrow();
    vi.mocked(storage.getItem).mockImplementation(() => {
      throw new Error("Storage denied");
    });
    expect(() =>
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toThrow();
    expect(() => writeWithdrawalMarker(storage, marker)).toThrow();
    const mismatch = memoryStorage();
    vi.mocked(mismatch.setItem).mockImplementation(() => {});
    expect(() => writeWithdrawalMarker(mismatch, marker)).toThrow();
  });
  it("compare-removes only the exact retained operation and checks missing readback", () => {
    const storage = memoryStorage();
    writeWithdrawalMarker(storage, marker);
    writeWithdrawalMarker(storage, {
      ...marker,
      operatorUserId: "other-operator",
    });
    expect(
      removeWithdrawalMarker(storage, {
        ...marker,
        requestId: "other-request",
      }),
    ).toBe(false);
    expect(removeWithdrawalMarker(storage, marker)).toBe(true);
    expect(
      readWithdrawalMarker(storage, siteId, marker.operatorUserId),
    ).toBeNull();
    expect(
      readWithdrawalMarker(storage, siteId, "other-operator"),
    ).not.toBeNull();
    expect(removeWithdrawalMarker(storage, marker)).toBe(false);
    writeWithdrawalMarker(storage, marker);
    vi.mocked(storage.removeItem).mockImplementation(() => {});
    expect(() => removeWithdrawalMarker(storage, marker)).toThrow();
  });
  it("does not remove a different-tab marker observed before removal", () => {
    const storage = memoryStorage();
    vi.mocked(storage.getItem)
      .mockReturnValueOnce(JSON.stringify(marker))
      .mockReturnValue(JSON.stringify({ ...marker, requestId: "other-tab" }));
    expect(removeWithdrawalMarker(storage, marker)).toBe(false);
    expect(storage.removeItem).not.toHaveBeenCalled();
  });
  it.each([
    { ...marker, siteId: "../site" },
    { ...marker, operatorUserId: "operator/other" },
    { ...marker, mode: "disabled" },
    { ...marker, reauthenticationToken: token },
  ])(
    "rejects invalid/private marker writes %j without storage mutation",
    (value) => {
      const storage = memoryStorage();
      expect(() =>
        writeWithdrawalMarker(storage, value as WithdrawalMarker),
      ).toThrow();
      expect(storage.setItem).not.toHaveBeenCalled();
    },
  );
});

describe("opaque withdrawal discovery cursor reads", () => {
  it("consults a valid discovered dotted ID through the default native transport", async () => {
    const id = "request..b";
    const result = {
      ...existing,
      requestId: id,
      command: { requestId: id, amountCents: 10000, destinationVersion: 3 },
      preview: { ...preview, requestId: id },
    };
    const native = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ request: result }), { status: 200 }),
    );
    vi.stubGlobal("fetch", native);
    await expect(loadWithdrawalRequest(siteId, id)).resolves.toEqual(result);
    expect(native).toHaveBeenCalledOnce();
    expect(native.mock.calls[0]?.[0]).toBe(
      `/api/v1/sites/${siteId}/withdrawals/requests/request%2E%2Eb`,
    );
  });
  it.each([
    ["opaque:next_page-2", "opaque%3Anext_page-2"],
    ["opaque:part..two", "opaque%3Apart%2E%2Etwo"],
  ])(
    "sends issued %s as one safely encoded GET query",
    async (cursor, encoded) => {
      const request = vi.fn().mockResolvedValue({ context });
      await expect(
        loadWithdrawalContext(siteId, request, cursor),
      ).resolves.toEqual(context);
      expect(request).toHaveBeenCalledExactlyOnceWith(
        `/v1/sites/${siteId}/withdrawals/context?cursor=${encoded}`,
      );
    },
  );
  it.each([
    "",
    "x".repeat(257),
    "cursor?extra=x",
    "cursor&other=x",
    "cursor#fragment",
    "cursor/slash",
    "cursor%3Aencoded",
    " cursor",
    null,
    1,
  ])("rejects invalid cursor %j before transport dispatch", async (cursor) => {
    const request = vi.fn().mockResolvedValue({ context });
    await expect(
      loadWithdrawalContext(siteId, request, cursor as string),
    ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it("forwards the bounded child signal through the existing transport seam without a mutation body", async () => {
    const request = vi.fn().mockResolvedValue({ context });
    const child = new AbortController();
    await loadWithdrawalContext(siteId, request, "issued:cursor", child.signal);
    expect(request).toHaveBeenCalledExactlyOnceWith(
      `/v1/sites/${siteId}/withdrawals/context?cursor=issued%3Acursor`,
      { signal: child.signal },
    );
  });
  it("retains strict site and full-context comparator semantics on a cursor response", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ context: { ...context, siteId: "wedding-b" } });
    await expect(
      loadWithdrawalContext(siteId, request, "issued:cursor"),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledOnce();
    expect(
      compareWithdrawalContexts(context, {
        ...context,
        nextCursor: "another:page",
      }),
    ).toBe("incomparable");
  });
});
