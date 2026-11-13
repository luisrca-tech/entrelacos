import { describe, expect, it } from "vitest";
import { addBusinessDays } from "./ownerFinanceRepository";

describe("addBusinessDays", () => {
  it("counts Monday to Friday only", () => {
    // 2026-10-14 is a Wednesday.
    expect(
      addBusinessDays(new Date("2026-10-14T12:00:00.000Z"), 2).toISOString(),
    ).toBe("2026-10-16T12:00:00.000Z");
  });

  it("skips the weekend", () => {
    // 2026-10-16 is a Friday: two business days later is Tuesday.
    expect(
      addBusinessDays(new Date("2026-10-16T12:00:00.000Z"), 2).toISOString(),
    ).toBe("2026-10-20T12:00:00.000Z");
    // A Saturday start also lands on Tuesday.
    expect(
      addBusinessDays(new Date("2026-10-17T12:00:00.000Z"), 2).toISOString(),
    ).toBe("2026-10-20T12:00:00.000Z");
  });

  it("does not mutate the input and returns it unchanged for zero days", () => {
    const start = new Date("2026-10-14T12:00:00.000Z");
    expect(addBusinessDays(start, 0).getTime()).toBe(start.getTime());
    expect(start.toISOString()).toBe("2026-10-14T12:00:00.000Z");
  });
});
