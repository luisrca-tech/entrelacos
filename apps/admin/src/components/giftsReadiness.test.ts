import { describe, expect, it, vi } from "vitest";
import { loadGiftsReadiness } from "./giftsReadiness";

const locked = {
  siteId: "wedding-a",
  state: "NOT_CONFIGURED",
  reason: "PROVIDER_DISABLED",
  observedAt: null,
  destinationVersion: null,
  catalogEligible: false,
  mode: "disabled",
};

describe("gift readiness client boundary", () => {
  it("reads only the official same-site readiness projection", async () => {
    const request = vi.fn().mockResolvedValue({ readiness: locked });
    await expect(loadGiftsReadiness("wedding-a", request)).resolves.toEqual(
      locked,
    );
    expect(request).toHaveBeenCalledWith(
      "/v1/sites/wedding-a/receiving/readiness",
    );
  });

  it("rejects other-site, malformed, private and unsupported READY projections", async () => {
    for (const readiness of [
      { ...locked, siteId: "wedding-b" },
      { ...locked, catalogEligible: true },
      { ...locked, state: "READY", reason: null, catalogEligible: true },
      { ...locked, walletId: "private-wallet" },
    ]) {
      await expect(
        loadGiftsReadiness(
          "wedding-a",
          vi.fn().mockResolvedValue({ readiness }),
        ),
      ).rejects.toThrow();
    }
  });

  it("leaves an unavailable endpoint unavailable without constructing readiness", async () => {
    const failure = new Error("offline");
    await expect(
      loadGiftsReadiness("wedding-a", vi.fn().mockRejectedValue(failure)),
    ).rejects.toBe(failure);
  });
});
