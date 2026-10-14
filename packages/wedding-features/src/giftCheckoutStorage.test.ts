import {
  type CheckoutStatus,
  checkoutRecoveryTokenSchema,
} from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createGiftCheckoutState,
  giftCheckoutReducer,
} from "./giftCheckoutState";
import {
  clearPendingGiftCheckout,
  createGiftCheckoutRecoveryToken,
  giftPendingStorageKey,
  hasUnresolvedGiftCheckout,
  loadPendingGiftCheckout,
  readPendingGiftCheckout,
  retainPendingGiftCheckout,
  writePendingGiftCheckout,
} from "./giftCheckoutStorage";

const pending = {
  quoteId: "quote-a",
  requestId: "request-a",
  recoveryToken: "A".repeat(43),
  method: "PIX",
  mode: "sandbox",
} as const;
const terminalStatus: CheckoutStatus = {
  siteId: "wedding-a",
  quoteId: pending.quoteId,
  requestId: pending.requestId,
  orderId: "order-a",
  attemptId: "attempt-a",
  method: "PIX",
  mode: "sandbox",
  state: "RECEIVED",
  observedAt: "2026-10-12T12:00:00.000Z",
  closedReason: null,
  mayStartNewAttempt: false,
  checkout: null,
};
const withHistory = {
  ...pending,
  terminalStatus,
  lastStatus: {
    ...terminalStatus,
    state: "OUTCOME_UNKNOWN" as const,
    observedAt: "2026-10-12T12:01:00.000Z",
  },
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
  };
}
describe("pending checkout recovery storage", () => {
  it("retains status history only for the exact current marker", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", pending);
    retainPendingGiftCheckout(() => target, "wedding-a", pending, withHistory);
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(withHistory);
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("rejects a concurrent history update instead of overwriting a newer snapshot", () => {
    const target = storage();
    const current = {
      ...withHistory,
      lastStatus: {
        ...withHistory.lastStatus,
        observedAt: "2026-10-12T12:02:00.000Z",
      },
    };
    writePendingGiftCheckout(target, "wedding-a", current);
    expect(() =>
      retainPendingGiftCheckout(
        () => target,
        "wedding-a",
        withHistory,
        withHistory,
      ),
    ).toThrow("Checkout recovery could not be retained.");
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(current);
  });
  it.each([
    pending,
    { ...withHistory, recoveryToken: `${"B".repeat(42)}A` },
    {
      ...withHistory,
      lastStatus: {
        ...withHistory.lastStatus,
        observedAt: terminalStatus.observedAt,
      },
    },
    {
      ...withHistory,
      terminalStatus: {
        ...terminalStatus,
        observedAt: withHistory.lastStatus.observedAt,
      },
      lastStatus: {
        ...terminalStatus,
        observedAt: withHistory.lastStatus.observedAt,
      },
    },
  ])(
    "never drops the floor, changes identity, regresses time or overwrites tied uncertainty",
    (next) => {
      const target = storage();
      writePendingGiftCheckout(target, "wedding-a", withHistory);
      expect(() =>
        retainPendingGiftCheckout(() => target, "wedding-a", withHistory, next),
      ).toThrow();
      expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(withHistory);
    },
  );
  it("never weakens a historical refund to receipt", () => {
    const target = storage();
    const refund = {
      ...withHistory,
      terminalStatus: { ...terminalStatus, state: "REFUNDED" as const },
    };
    writePendingGiftCheckout(target, "wedding-a", refund);
    expect(() =>
      retainPendingGiftCheckout(() => target, "wedding-a", refund, withHistory),
    ).toThrow();
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(refund);
  });
  it("never treats different UTC precision as newer confirmation when retaining history", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", withHistory);
    const tied = { ...terminalStatus, observedAt: "2026-10-12T12:01:00Z" };
    expect(() =>
      retainPendingGiftCheckout(() => target, "wedding-a", withHistory, {
        ...pending,
        terminalStatus: tied,
        lastStatus: tied,
      }),
    ).toThrow();
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(withHistory);
  });
  it("persists a terminal floor and newer observation without restoring cached success", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", withHistory);
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(withHistory);
    const stored = loadPendingGiftCheckout(() => target, "wedding-a");
    if (!stored) throw new Error("Expected durable operation");
    const restored = giftCheckoutReducer(createGiftCheckoutState(), {
      type: "RESTORE_UNKNOWN",
      siteId: "wedding-a",
      pending: stored,
    });
    expect(restored.pending).toEqual(withHistory);
    expect(restored.checkoutStatus).toBeNull();
    expect(restored.phase).toBe("UNKNOWN");
    expect(hasUnresolvedGiftCheckout(() => target, "wedding-a")).toBe(true);
  });
  it("never clears a terminal floor using an older marker snapshot", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", withHistory);
    expect(() =>
      clearPendingGiftCheckout(() => target, "wedding-a", pending),
    ).toThrow();
    expect(target.removeItem).not.toHaveBeenCalled();
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(withHistory);
  });
  it("binds historical status to the marker's site on read and write", () => {
    const target = storage();
    expect(() =>
      writePendingGiftCheckout(target, "wedding-b", withHistory),
    ).toThrow();
    target.setItem(
      giftPendingStorageKey("wedding-b"),
      JSON.stringify(withHistory),
    );
    expect(() => loadPendingGiftCheckout(() => target, "wedding-b")).toThrow(
      "Checkout recovery could not be read.",
    );
    expect(hasUnresolvedGiftCheckout(() => target, "wedding-b")).toBe(true);
  });
  it.each([
    { terminalStatus: { ...terminalStatus, state: "OUTCOME_UNKNOWN" } },
    { terminalStatus: { ...terminalStatus, quoteId: "quote-b" } },
    { terminalStatus: { ...terminalStatus, requestId: "request-b" } },
    { terminalStatus: { ...terminalStatus, method: "CREDIT_CARD" } },
    { terminalStatus: { ...terminalStatus, mode: "live" } },
    { terminalStatus: { ...terminalStatus, providerSecret: "private" } },
    { lastStatus: undefined },
    { lastStatus: { ...withHistory.lastStatus, observedAt: "invalid" } },
    {
      lastStatus: {
        ...withHistory.lastStatus,
        observedAt: "2026-10-12T11:59:00.000Z",
      },
    },
    { terminalStatus: undefined },
    { lastStatus: { ...withHistory.lastStatus, orderId: "order-b" } },
    { lastStatus: { ...withHistory.lastStatus, attemptId: "attempt-b" } },
    { lastStatus: { ...withHistory.lastStatus, siteId: "wedding-b" } },
  ])(
    "keeps corrupt or contradictory historical metadata locked: %j",
    (extra) => {
      const target = storage();
      target.setItem(
        giftPendingStorageKey("wedding-a"),
        JSON.stringify({ ...withHistory, ...extra }),
      );
      expect(() => loadPendingGiftCheckout(() => target, "wedding-a")).toThrow(
        "Checkout recovery could not be read.",
      );
      expect(hasUnresolvedGiftCheckout(() => target, "wedding-a")).toBe(true);
      expect(target.removeItem).not.toHaveBeenCalled();
    },
  );
  it("clears only the exact operation and preserves other sites", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", pending);
    writePendingGiftCheckout(target, "wedding-b", pending);
    clearPendingGiftCheckout(() => target, "wedding-a", pending);
    expect(readPendingGiftCheckout(target, "wedding-a")).toBeNull();
    expect(readPendingGiftCheckout(target, "wedding-b")).toEqual(pending);
  });
  it.each([
    { ...pending, quoteId: "quote-b" },
    { ...pending, requestId: "request-b" },
    { ...pending, recoveryToken: `${"B".repeat(42)}A` },
    { ...pending, method: "CREDIT_CARD" },
    { ...pending, mode: "live" },
    null,
    "corrupt",
  ])("never removes a missing or replaced operation", (replacement) => {
    const target = storage();
    if (replacement !== null)
      target.setItem(
        giftPendingStorageKey("wedding-a"),
        JSON.stringify(replacement),
      );
    expect(() =>
      clearPendingGiftCheckout(() => target, "wedding-a", pending),
    ).toThrow();
    expect(target.removeItem).not.toHaveBeenCalled();
  });
  it("reports inaccessible removal without exposing storage errors", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", pending);
    target.removeItem.mockImplementation(() => {
      throw new Error("private details");
    });
    expect(() =>
      clearPendingGiftCheckout(() => target, "wedding-a", pending),
    ).toThrow("Checkout recovery could not be cleared.");
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(pending);
  });
  it("keeps corrupt or inaccessible recovery locked against selection and closing", () => {
    const target = storage();
    target.setItem(giftPendingStorageKey("wedding-a"), "broken");
    for (const getStorage of [
      () => target,
      () => {
        throw new Error("denied");
      },
    ]) {
      const unresolved = hasUnresolvedGiftCheckout(getStorage, "wedding-a");
      expect(unresolved).toBe(true);
      const restored = unresolved
        ? giftCheckoutReducer(createGiftCheckoutState(), {
            type: "RESTORE_UNKNOWN",
          })
        : createGiftCheckoutState();
      expect(giftCheckoutReducer(restored, { type: "CLOSE" }).phase).toBe(
        "UNKNOWN",
      );
      expect(
        giftCheckoutReducer(restored, {
          type: "SELECT_GIFT",
          gift: {
            id: "gift-a",
            siteId: "wedding-a",
            title: "Presente",
            description: "",
            nominalCents: 10000,
            currency: "BRL",
            image: null,
            sortOrder: 0,
          },
        }).phase,
      ).toBe("UNKNOWN");
    }
    expect(hasUnresolvedGiftCheckout(() => storage(), "wedding-a")).toBe(false);
  });
  it("retains the strict C1 recovery identity in site-scoped storage", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", pending);
    expect(readPendingGiftCheckout(target, "wedding-a")).toEqual(pending);
    expect(readPendingGiftCheckout(target, "wedding-b")).toBeNull();
    expect(target.getItem(giftPendingStorageKey("wedding-a"))).not.toMatch(
      /wallet|payer|amount|hostedUrl|paid/i,
    );
  });
  it("refuses corrupt/private recovery records rather than silently opening another attempt", () => {
    const target = storage();
    target.setItem(giftPendingStorageKey("wedding-a"), "broken");
    expect(() => readPendingGiftCheckout(target, "wedding-a")).toThrow();
    expect(() =>
      writePendingGiftCheckout(target, "wedding-a", {
        ...pending,
        walletId: "private",
      } as never),
    ).toThrow();
    expect(() =>
      writePendingGiftCheckout(target, "wedding-a", {
        ...pending,
        mode: "disabled",
      }),
    ).toThrow();
  });
  it("does not swallow a failed persistence step before a financial request", () => {
    const target = {
      setItem: () => {
        throw new Error("storage unavailable");
      },
    };
    expect(() =>
      writePendingGiftCheckout(target, "wedding-a", pending),
    ).toThrow("storage unavailable");
  });

  it("loads the exact current marker and preserves its site-bound identity", () => {
    const target = storage();
    writePendingGiftCheckout(target, "wedding-a", pending);
    const getItem = vi.fn(target.getItem);
    expect(loadPendingGiftCheckout(() => ({ getItem }), "wedding-a")).toEqual(
      pending,
    );
    expect(getItem).toHaveBeenCalledExactlyOnceWith(
      giftPendingStorageKey("wedding-a"),
    );
    expect(loadPendingGiftCheckout(() => target, "wedding-b")).toBeNull();
  });

  it.each([
    "broken private recovery data",
    JSON.stringify({ ...pending, recoveryToken: undefined }),
    JSON.stringify({ ...pending, recoveryToken: "_".repeat(43) }),
    JSON.stringify({ ...pending, recoveryToken: `${pending.recoveryToken}=` }),
    JSON.stringify({ ...pending, providerSecret: "private-value" }),
  ])(
    "throws a sanitized error for corrupt or legacy storage without removing it",
    (marker) => {
      const target = storage();
      target.setItem(giftPendingStorageKey("wedding-a"), marker);
      expect(() => loadPendingGiftCheckout(() => target, "wedding-a")).toThrow(
        "Checkout recovery could not be read.",
      );
      expect(hasUnresolvedGiftCheckout(() => target, "wedding-a")).toBe(true);
      expect(target.getItem(giftPendingStorageKey("wedding-a"))).toBe(marker);
    },
  );

  it("keeps denied storage locked without propagating private exception details", () => {
    for (const getStorage of [
      () => {
        throw new Error("private getter failure");
      },
      () => ({
        getItem: () => {
          throw new Error("private read failure");
        },
      }),
    ]) {
      expect(() => loadPendingGiftCheckout(getStorage, "wedding-a")).toThrow(
        "Checkout recovery could not be read.",
      );
      expect(hasUnresolvedGiftCheckout(getStorage, "wedding-a")).toBe(true);
    }
  });

  it("encodes exactly 32 injected cryptographic bytes as canonical unpadded base64url", () => {
    const observed = vi.fn();
    const getRandomValues: Crypto["getRandomValues"] = (bytes) => {
      observed(bytes);
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes?.byteLength).toBe(32);
      if (bytes instanceof Uint8Array)
        bytes.set(Array.from({ length: 32 }, (_, index) => index));
      return bytes;
    };
    const token = createGiftCheckoutRecoveryToken({ getRandomValues });
    expect(token).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
    expect(checkoutRecoveryTokenSchema.parse(token)).toBe(token);
    expect(observed).toHaveBeenCalledTimes(1);
  });

  it("uses URL-safe encoding for high-byte cryptographic input", () => {
    const getRandomValues: Crypto["getRandomValues"] = (bytes) => {
      if (bytes instanceof Uint8Array) bytes.fill(255);
      return bytes;
    };
    const token = createGiftCheckoutRecoveryToken({ getRandomValues });
    expect(token).toBe(`${"_".repeat(42)}8`);
    expect(checkoutRecoveryTokenSchema.safeParse(token).success).toBe(true);
  });

  it("refuses to fabricate a capability when secure randomness is unavailable", () => {
    const getRandomValues = vi.fn(() => {
      throw new Error("randomness unavailable");
    });
    expect(() =>
      createGiftCheckoutRecoveryToken({ getRandomValues }),
    ).toThrow();
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });
});
