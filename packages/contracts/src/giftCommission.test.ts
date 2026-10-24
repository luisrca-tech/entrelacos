import { describe, expect, it } from "vitest";
import {
  getGiftCommissionCents,
  getGiftPriceWithCommission,
} from "./giftCommission";

describe("embedded gift commission", () => {
  it.each([
    [0, 0, 0],
    [24, 0, 24],
    [25, 1, 26],
    [1000, 20, 1020],
    [10000, 200, 10200],
    [12345, 247, 12592],
  ])("adds the rounded commission to %i cents", (base, fee, price) => {
    expect(getGiftCommissionCents(base)).toBe(fee);
    expect(getGiftPriceWithCommission(base)).toBe(price);
  });

  it.each([-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid monetary input %s",
    (value) => {
      expect(() => getGiftCommissionCents(value)).toThrow(RangeError);
      expect(() => getGiftPriceWithCommission(value)).toThrow(RangeError);
    },
  );

  it("rejects a final price outside safe integer cents", () => {
    expect(() => getGiftPriceWithCommission(Number.MAX_SAFE_INTEGER)).toThrow(
      RangeError,
    );
  });
});
