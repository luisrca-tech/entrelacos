import { describe, expect, it } from "vitest";
import { formatDateOnly, parseDateOnly } from "./date";

describe("date-only values", () => {
  it("round-trips calendar dates without UTC conversion", () => {
    const date = parseDateOnly("2026-02-03");

    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(1);
    expect(date?.getDate()).toBe(3);
    if (!date) throw new Error("Expected a valid date");
    expect(formatDateOnly(date)).toBe("2026-02-03");
  });

  it("rejects malformed and impossible dates", () => {
    expect(parseDateOnly("2026-2-03")).toBeUndefined();
    expect(parseDateOnly("2026-02-31")).toBeUndefined();
    expect(parseDateOnly("2026-02-03T00:00:00.000Z")).toBeUndefined();
  });
});
