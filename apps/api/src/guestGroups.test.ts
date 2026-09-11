import { describe, expect, it } from "vitest";
import { normalizeGuestName } from "./guestGroups";

describe("guest group name normalization", () => {
  it("trims, collapses spaces, removes accents, and folds case", () => {
    expect(normalizeGuestName("  Família  Silva  ")).toBe("familia silva");
  });
});
