import { afterEach, describe, expect, it, vi } from "vitest";
import { giftPaymentsEnabled } from "./giftPayments";

afterEach(() => vi.unstubAllEnvs());
describe("gift payments switch", () => {
  it("is on when the build defines no switch", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", undefined);
    expect(giftPaymentsEnabled()).toBe(true);
  });
  it.each(["", "true", "TRUE", "0", "no", "yes"])(
    "stays on for anything but the exact opt-out (%j)",
    (value) => {
      vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", value);
      expect(giftPaymentsEnabled()).toBe(true);
    },
  );
  it("turns off only with the explicit opt-out", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
    expect(giftPaymentsEnabled()).toBe(false);
  });
});
