import type { SiteAccess } from "@entrelacos/contracts";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../lib/apiClient";
import { currentFinancialRead, observeFinancialRead } from "./financialRead";

const access = { siteId: "wedding-a" } as SiteAccess;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("scoped financial reads", () => {
  it("starts loading then returns only the successful value", async () => {
    const read = deferred<number>();
    const listener = vi.fn();
    observeFinancialRead(() => read.promise, listener);
    expect(listener.mock.calls).toEqual([[{ status: "loading" }]]);
    read.resolve(23);
    await settle();
    expect(listener.mock.calls).toEqual([
      [{ status: "loading" }],
      [{ status: "ready", value: 23 }],
    ]);
  });
  it.each([
    [new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"), "unavailable"],
    [new ApiError(503, "SERVICE_UNAVAILABLE"), "error"],
    [new ApiError(403, "MEMBERSHIP_DENIED"), "error"],
    [new Error("private provider payload"), "error"],
  ])(
    "classifies failures without retaining private error details",
    async (error, status) => {
      const listener = vi.fn();
      observeFinancialRead(() => Promise.reject(error), listener);
      await settle();
      expect(listener).toHaveBeenLastCalledWith({ status });
    },
  );
  it("handles a synchronous read failure with the same sanitized state", () => {
    const listener = vi.fn();
    observeFinancialRead(() => {
      throw new Error("private");
    }, listener);
    expect(listener).toHaveBeenLastCalledWith({ status: "error" });
  });
  it.each(["success", "error"])(
    "ignores obsolete %s replies after scope disposal",
    async (outcome) => {
      const old = deferred<number>();
      const current = deferred<number>();
      const listener = vi.fn();
      const dispose = observeFinancialRead(() => old.promise, listener);
      dispose();
      observeFinancialRead(() => current.promise, listener);
      current.resolve(42);
      await settle();
      if (outcome === "success") old.resolve(99);
      else old.reject(new Error("private"));
      await settle();
      expect(listener.mock.calls).toEqual([
        [{ status: "loading" }],
        [{ status: "loading" }],
        [{ status: "ready", value: 42 }],
      ]);
    },
  );
  it("hides settled data immediately on site, access or read-revision changes", () => {
    const result = {
      siteId: "wedding-a",
      access,
      revision: 0,
      result: { status: "ready" as const, value: 42 },
    };
    expect(currentFinancialRead(result, "wedding-a", access, 0)).toEqual(
      result.result,
    );
    expect(currentFinancialRead(result, "wedding-b", access, 0)).toBeNull();
    expect(
      currentFinancialRead(result, "wedding-a", { ...access }, 0),
    ).toBeNull();
    expect(currentFinancialRead(result, "wedding-a", null, 0)).toBeNull();
    expect(currentFinancialRead(result, "wedding-a", access, 1)).toBeNull();
    expect(currentFinancialRead(null, "wedding-a", access, 0)).toBeNull();
  });
  it("keeps concurrent overview and history outcomes independent", async () => {
    const overview = deferred<number>();
    const history = deferred<unknown[]>();
    const overviewListener = vi.fn();
    const historyListener = vi.fn();
    observeFinancialRead(() => overview.promise, overviewListener);
    observeFinancialRead(() => history.promise, historyListener);
    overview.resolve(50);
    history.reject(new ApiError(409, "PROVIDER_MODE_UNAVAILABLE"));
    await settle();
    expect(overviewListener).toHaveBeenLastCalledWith({
      status: "ready",
      value: 50,
    });
    expect(historyListener).toHaveBeenLastCalledWith({ status: "unavailable" });
  });
});
