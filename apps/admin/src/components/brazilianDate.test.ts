import { describe, expect, it } from "vitest";
import { formatBrazilianDate } from "./brazilianDate";

describe("formatBrazilianDate", () => {
  it("renders a calendar date as day-month-year", () => {
    expect(formatBrazilianDate("2027-09-18")).toBe("18-09-2027");
  });

  it("keeps non-calendar values unchanged", () => {
    expect(formatBrazilianDate("Aguardando aprovação")).toBe(
      "Aguardando aprovação",
    );
    expect(formatBrazilianDate("2027-02-31")).toBe("2027-02-31");
  });
});
