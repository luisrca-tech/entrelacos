import { describe, expect, it } from "vitest";
import { giftImageAlt } from "./giftImageAlt";
import { giftImageAlt as exported } from "./index";

describe("gift image alt", () => {
  it("uses the trimmed description when one was written", () => {
    expect(giftImageAlt("  Mesa posta para o jantar  ", 3)).toBe(
      "Mesa posta para o jantar",
    );
  });

  it.each([
    ["", 1],
    ["   ", 2],
    ["\n\t", 12],
    [null, 4],
    [undefined, 5],
  ])("falls back to the list position for %j", (alt, position) => {
    expect(giftImageAlt(alt, position)).toBe(
      `Imagem do presente ${position} na lista`,
    );
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects the invalid position %s",
    (position) => {
      expect(() => giftImageAlt("", position)).toThrow(RangeError);
    },
  );

  it("is exported from the package entry", () => {
    expect(exported).toBe(giftImageAlt);
  });
});
