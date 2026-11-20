// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  paymentsAreaOpen,
  paymentsAreaPending,
  paymentsAvailabilityStore as store,
  usePaymentsProbe,
} from "./paymentsAvailability";

beforeEach(() => store.reset());
afterEach(() => vi.unstubAllEnvs());

describe("payments availability from the API mode", () => {
  it("starts unknown, so the payment areas stay closed", () => {
    expect(store.get()).toBe("unknown");
    expect(store.getServerSnapshot()).toBe("unknown");
    expect(paymentsAreaOpen()).toBe(false);
    expect(paymentsAreaPending()).toBe(true);
  });

  it("opens for sandbox and live and closes for disabled", () => {
    store.reportMode("sandbox");
    expect(paymentsAreaOpen()).toBe(true);
    store.reportMode("live");
    expect(paymentsAreaOpen()).toBe(true);
    store.reportMode("disabled");
    expect(store.get()).toBe("unavailable");
    expect(paymentsAreaOpen()).toBe(false);
    expect(paymentsAreaPending()).toBe(false);
  });

  it("lets the manual pause close the areas even when the API allows payments", () => {
    store.reportMode("live");
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
    expect(paymentsAreaOpen()).toBe(false);
    expect(paymentsAreaPending()).toBe(false);
  });

  it("does not let a failed check override what the API already said", () => {
    store.reportMode("live");
    store.reportFailure();
    expect(store.get()).toBe("available");
    store.reset();
    store.reportFailure();
    expect(store.get()).toBe("unreachable");
    expect(paymentsAreaOpen()).toBe(false);
    expect(paymentsAreaPending()).toBe(false);
  });

  it("notifies subscribers only when the value changes", () => {
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.reportMode("disabled");
    store.reportMode("disabled");
    store.reportMode("sandbox");
    unsubscribe();
    store.reportMode("disabled");
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe("payments probe", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const seen: string[] = [];
  function Probe({
    siteId,
    probe,
  }: {
    siteId?: string;
    probe: (id: string) => Promise<unknown>;
  }) {
    seen.push(usePaymentsProbe(siteId, probe));
    return null;
  }
  const mount = (
    probe: (id: string) => Promise<unknown>,
    siteId: string | null = "site-1",
  ) =>
    act(async () =>
      root.render(createElement(Probe, { siteId: siteId ?? undefined, probe })),
    );

  it("asks the API once while the availability is unknown", async () => {
    const probe = vi.fn(async () => store.reportMode("disabled"));
    await mount(probe);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("site-1");
    expect(store.get()).toBe("unavailable");
    await mount(probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("does not ask again when the API already answered", async () => {
    store.reportMode("sandbox");
    const probe = vi.fn(async () => {});
    await mount(probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not ask without a site or while the build has the pause on", async () => {
    const probe = vi.fn(async () => {});
    await mount(probe, null);
    expect(probe).not.toHaveBeenCalled();
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
    await mount(probe);
    expect(probe).not.toHaveBeenCalled();
  });

  it("records a failed check as unreachable and retries for another site", async () => {
    const probe = vi.fn(async () => {
      throw new Error("offline");
    });
    await mount(probe);
    expect(store.get()).toBe("unreachable");
    await mount(probe, "site-2");
    expect(probe).toHaveBeenLastCalledWith("site-2");
  });
});
