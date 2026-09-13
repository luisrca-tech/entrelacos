import { describe, expect, it, vi } from "vitest";
import { startGuestChallenge } from "./guestVerification";

describe("guest verification provider configuration", () => {
  it("rejects a real provider in simulated mode before dispatch", async () => {
    const send = vi.fn();

    await expect(
      startGuestChallenge(
        null as never,
        "site-a",
        { fullName: "Ana Silva", phone: "+5511999999999" },
        {
          ipAddress: "203.0.113.10",
          fingerprintSecret:
            "guest-verification-unit-secret-with-at-least-32-characters",
          smsMode: "simulated",
          provider: { mode: "TWILIO", send },
        },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "VERIFICATION_CONFIGURATION_ERROR",
    });
    expect(send).not.toHaveBeenCalled();
  });
});
