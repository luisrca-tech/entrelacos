import { describe, expect, it } from "vitest";
import {
  fingerprintClientValue,
  GUEST_LOOKUP_LIMIT,
  GUEST_LOOKUP_WINDOW_MS,
  lookupGuestGroup,
} from "./guestLookup";

describe("guest lookup primitives", () => {
  it("uses a keyed fingerprint without returning the client address", () => {
    const fingerprint = fingerprintClientValue("203.0.113.5", "test-secret");

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("203.0.113.5");
    expect(fingerprintClientValue("203.0.113.5", "test-secret")).toBe(
      fingerprint,
    );
    expect(fingerprintClientValue("203.0.113.5", "other-secret")).not.toBe(
      fingerprint,
    );
  });

  it("keeps the reduced lookup policy explicit", () => {
    expect(GUEST_LOOKUP_LIMIT).toBe(10);
    expect(GUEST_LOOKUP_WINDOW_MS).toBe(15 * 60 * 1000);
  });

  it("requires a client address and fingerprint secret", async () => {
    await expect(
      lookupGuestGroup(
        {} as never,
        "site-1",
        {
          fullName: "Ana Silva",
          phone: "+5511999999999",
        },
        { ipAddress: "", fingerprintSecret: "test-secret" },
      ),
    ).rejects.toMatchObject({ code: "LOOKUP_CONFIGURATION_ERROR" });
    await expect(
      lookupGuestGroup(
        {} as never,
        "site-1",
        {
          fullName: "Ana Silva",
          phone: "+5511999999999",
        },
        { ipAddress: "203.0.113.5", fingerprintSecret: "" },
      ),
    ).rejects.toMatchObject({ code: "LOOKUP_CONFIGURATION_ERROR" });
  });
});
