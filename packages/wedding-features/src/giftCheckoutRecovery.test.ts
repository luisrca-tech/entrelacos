import { describe, expect, it, vi } from "vitest";
import { recoverGiftCheckout } from "./giftCheckoutRecovery";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";
import {
  giftPendingStorageKey,
  loadPendingGiftCheckout,
  writePendingGiftCheckout,
} from "./giftCheckoutStorage";

const pending = {
  quoteId: "quote-a",
  requestId: "request-a",
  recoveryToken: "A".repeat(43),
  method: "PIX",
  mode: "sandbox",
} as const;
const state = () =>
  giftCheckoutReducer(createGiftCheckoutState(), {
    type: "RESTORE_UNKNOWN",
    siteId: "wedding-a",
    pending,
  });
const status = {
  siteId: "wedding-a",
  quoteId: "quote-a",
  requestId: "request-a",
  orderId: "order-a",
  attemptId: "attempt-a",
  method: "PIX",
  mode: "sandbox",
  state: "OUTCOME_UNKNOWN",
  observedAt: null,
  closedReason: null,
  mayStartNewAttempt: false,
  checkout: null,
} as const;
const closed = {
  ...status,
  state: "CLOSED_UNPAID",
  closedReason: "EXPIRED",
  observedAt: "2026-10-12T12:00:00.000Z",
  mayStartNewAttempt: true,
} as const;
function storage(value: unknown = pending) {
  return {
    getItem: vi.fn().mockReturnValue(JSON.stringify(value)),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  };
}
function durableStorage() {
  let marker: string | null = JSON.stringify(pending);
  return {
    getItem: vi.fn(() => marker),
    setItem: vi.fn((_key: string, value: string) => {
      marker = value;
    }),
    removeItem: vi.fn(() => {
      marker = null;
    }),
  };
}
describe("checkout recovery coordinator", () => {
  it.each(["RECEIVED", "REFUNDED"] as const)(
    "persists %s history before publishing the result and keeps newer uncertainty through remount",
    async (paymentState) => {
      const target = durableStorage();
      const terminal = {
        ...status,
        state: paymentState,
        observedAt: "2026-10-12T12:00:00.000Z",
      };
      const api = { getCheckoutStatus: vi.fn().mockResolvedValue(terminal) };
      const event = await recoverGiftCheckout(api, state(), () => target);
      expect(target.setItem).toHaveBeenCalledTimes(1);
      expect(loadPendingGiftCheckout(() => target, "wedding-a")).toMatchObject({
        terminalStatus: terminal,
        lastStatus: terminal,
      });
      if (!event) throw new Error("Expected terminal event");
      const received = giftCheckoutReducer(state(), event);
      const uncertain = { ...status, observedAt: "2026-10-12T12:01:00.000Z" };
      api.getCheckoutStatus.mockResolvedValue(uncertain);
      const nextEvent = await recoverGiftCheckout(api, received, () => target);
      expect(nextEvent).toEqual({ type: "STATUS_RESOLVED", status: uncertain });
      const marker = loadPendingGiftCheckout(() => target, "wedding-a");
      expect(marker).toMatchObject({
        ...pending,
        terminalStatus: terminal,
        lastStatus: uncertain,
      });
      if (!marker) throw new Error("Expected durable operation");
      const restored = giftCheckoutReducer(createGiftCheckoutState(), {
        type: "RESTORE_UNKNOWN",
        siteId: "wedding-a",
        pending: marker,
      });
      expect(restored.checkoutStatus).toBeNull();
      api.getCheckoutStatus.mockResolvedValue({
        ...closed,
        observedAt: "2026-10-12T12:02:00.000Z",
      });
      expect(await recoverGiftCheckout(api, restored, () => target)).toBeNull();
      expect(api.getCheckoutStatus).toHaveBeenLastCalledWith(
        {
          quoteId: pending.quoteId,
          requestId: pending.requestId,
          recoveryToken: pending.recoveryToken,
        },
        {
          method: pending.method,
          mode: pending.mode,
          orderId: terminal.orderId,
          attemptId: terminal.attemptId,
        },
      );
      expect(target.removeItem).not.toHaveBeenCalled();
      expect(loadPendingGiftCheckout(() => target, "wedding-a")).toEqual(
        marker,
      );
    },
  );
  it("refuses terminal acknowledgement when history cannot be retained", async () => {
    const target = durableStorage();
    target.setItem.mockImplementation(() => {
      throw new Error("private storage detail");
    });
    await expect(
      recoverGiftCheckout(
        {
          getCheckoutStatus: vi.fn().mockResolvedValue({
            ...status,
            state: "RECEIVED",
            observedAt: closed.observedAt,
          }),
        },
        state(),
        () => target,
      ),
    ).rejects.toThrow("Checkout recovery could not be retained.");
    expect(loadPendingGiftCheckout(() => target, "wedding-a")).toEqual(pending);
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("never clears a newly persisted receipt from an older unpaid consultation", async () => {
    const target = durableStorage();
    let resolve!: (value: typeof closed) => void;
    const promise = new Promise<typeof closed>((yes) => {
      resolve = yes;
    });
    const result = recoverGiftCheckout(
      { getCheckoutStatus: vi.fn(() => promise) },
      state(),
      () => target,
    );
    const terminal = {
      ...status,
      state: "RECEIVED" as const,
      observedAt: closed.observedAt,
    };
    writePendingGiftCheckout(target, "wedding-a", {
      ...pending,
      terminalStatus: terminal,
      lastStatus: terminal,
    });
    resolve(closed);
    await expect(result).rejects.toThrow(
      "Checkout recovery could not be cleared.",
    );
    expect(target.removeItem).not.toHaveBeenCalled();
    expect(
      loadPendingGiftCheckout(() => target, "wedding-a")?.terminalStatus,
    ).toEqual(terminal);
  });
  it("does not overwrite a concurrent stronger history with an old consultation snapshot", async () => {
    const target = durableStorage();
    const terminal = {
      ...status,
      state: "RECEIVED" as const,
      observedAt: closed.observedAt,
    };
    const initial = giftCheckoutReducer(state(), {
      type: "STATUS_RESOLVED",
      status: terminal,
    });
    if (!initial.pending) throw new Error("Expected retained operation");
    const current = {
      ...initial.pending,
      lastStatus: { ...status, observedAt: "2026-10-12T12:02:00.000Z" },
    };
    writePendingGiftCheckout(target, "wedding-a", current);
    await expect(
      recoverGiftCheckout(
        {
          getCheckoutStatus: vi.fn().mockResolvedValue({
            ...status,
            observedAt: "2026-10-12T12:01:00.000Z",
          }),
        },
        initial,
        () => target,
      ),
    ).rejects.toThrow("Checkout recovery could not be retained.");
    expect(loadPendingGiftCheckout(() => target, "wedding-a")).toEqual(current);
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("ignores a terminal reply after scope disposal before retaining its history", async () => {
    const target = durableStorage();
    let active = true;
    const api = {
      getCheckoutStatus: vi.fn(async () => {
        active = false;
        return {
          ...status,
          state: "RECEIVED" as const,
          observedAt: closed.observedAt,
        };
      }),
    };
    expect(
      await recoverGiftCheckout(
        api,
        state(),
        () => target,
        () => active,
      ),
    ).toBeNull();
    expect(target.setItem).not.toHaveBeenCalled();
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("queries the bound identity and keeps uncertain results durably locked", async () => {
    const api = { getCheckoutStatus: vi.fn().mockResolvedValue(status) };
    const target = storage();
    const event = await recoverGiftCheckout(api, state(), () => target);
    expect(api.getCheckoutStatus).toHaveBeenCalledWith(
      {
        quoteId: pending.quoteId,
        requestId: pending.requestId,
        recoveryToken: pending.recoveryToken,
      },
      { method: "PIX", mode: "sandbox" },
    );
    expect(event).toEqual({ type: "STATUS_RESOLVED", status });
    if (!event) throw new Error("Expected recovery event");
    expect(giftCheckoutReducer(state(), event).phase).toBe("UNKNOWN");
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("removes only the identical marker before releasing confirmed unpaid state", async () => {
    const api = { getCheckoutStatus: vi.fn().mockResolvedValue(closed) };
    const target = storage();
    const event = await recoverGiftCheckout(api, state(), () => target);
    expect(target.getItem).toHaveBeenCalledWith(
      giftPendingStorageKey("wedding-a"),
    );
    expect(target.removeItem).toHaveBeenCalledWith(
      giftPendingStorageKey("wedding-a"),
    );
    if (!event) throw new Error("Expected terminal event");
    expect(giftCheckoutReducer(state(), event).phase).toBe("IDLE");
  });
  it("never releases on missing, changed, corrupt or inaccessible storage", async () => {
    for (const target of [
      storage({ ...pending, requestId: "request-b" }),
      storage({ ...pending, recoveryToken: `${"B".repeat(42)}A` }),
      {
        getItem: vi.fn().mockReturnValue("broken"),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
      {
        getItem: vi.fn().mockReturnValue(null),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
      {
        getItem: vi.fn().mockImplementation(() => {
          throw new Error("denied");
        }),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    ]) {
      await expect(
        recoverGiftCheckout(
          { getCheckoutStatus: vi.fn().mockResolvedValue(closed) },
          state(),
          () => target,
        ),
      ).rejects.toThrow();
      expect(target.removeItem).not.toHaveBeenCalled();
    }
  });
  it("never releases when marker removal fails", async () => {
    const target = storage();
    target.removeItem.mockImplementation(() => {
      throw new Error("unavailable");
    });
    await expect(
      recoverGiftCheckout(
        { getCheckoutStatus: vi.fn().mockResolvedValue(closed) },
        state(),
        () => target,
      ),
    ).rejects.toThrow();
  });
  it("ignores stale scope and mismatched status before clearing or dispatching", async () => {
    const target = storage();
    expect(
      await recoverGiftCheckout(
        { getCheckoutStatus: vi.fn().mockResolvedValue(closed) },
        state(),
        () => target,
        () => false,
      ),
    ).toBeNull();
    expect(
      await recoverGiftCheckout(
        {
          getCheckoutStatus: vi
            .fn()
            .mockResolvedValue({ ...closed, siteId: "wedding-b" }),
        },
        state(),
        () => target,
      ),
    ).toBeNull();
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("does not request status without a valid recoverable operation", async () => {
    const api = { getCheckoutStatus: vi.fn() };
    await expect(
      recoverGiftCheckout(api, createGiftCheckoutState(), () => storage()),
    ).resolves.toBeNull();
    await expect(
      recoverGiftCheckout(
        api,
        giftCheckoutReducer(createGiftCheckoutState(), {
          type: "RESTORE_UNKNOWN",
        }),
        () => storage(),
      ),
    ).resolves.toBeNull();
    expect(api.getCheckoutStatus).not.toHaveBeenCalled();
  });
  it("preserves provider unavailability without manufacturing a terminal event", async () => {
    const failure = new Error("unavailable");
    const target = storage();
    await expect(
      recoverGiftCheckout(
        { getCheckoutStatus: vi.fn().mockRejectedValue(failure) },
        state(),
        () => target,
      ),
    ).rejects.toBe(failure);
    expect(target.removeItem).not.toHaveBeenCalled();
  });
});
