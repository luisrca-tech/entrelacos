import { afterEach, describe, expect, it, vi } from "vitest";
import { giftPaymentsEnabled } from "./giftPayments";

afterEach(() => vi.unstubAllEnvs());
describe("gift payments flag", () => {
  it("is off when the build defines no flag", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", undefined);
    expect(giftPaymentsEnabled()).toBe(false);
  });
  it.each(["", "false", "0", "TRUE ", "yes"])(
    "stays off for anything but the exact opt-in (%j)",
    (value) => {
      vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", value);
      expect(giftPaymentsEnabled()).toBe(false);
    },
  );
  it("turns on only with the explicit opt-in", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "true");
    expect(giftPaymentsEnabled()).toBe(true);
  });
});
