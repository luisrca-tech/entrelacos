import { describe, expect, it } from "vitest";
import {
  deadlineInstantFromLocal,
  deadlineLocalFromInstant,
} from "./rsvpDeadline";

describe("RSVP deadline conversion", () => {
  it("converts the selected wall clock using its explicit IANA timezone", () => {
    expect(
      deadlineInstantFromLocal("2028-04-01T00:00", "America/Sao_Paulo"),
    ).toBe("2028-04-01T03:00:00.000Z");
    expect(
      deadlineInstantFromLocal("2028-07-01T00:00", "America/New_York"),
    ).toBe("2028-07-01T04:00:00.000Z");
  });

  it("formats a stored instant back into the configured wall clock", () => {
    expect(
      deadlineLocalFromInstant("2028-04-01T03:00:00.000Z", "America/Sao_Paulo"),
    ).toBe("2028-04-01T00:00");
  });

  it("rejects invalid or nonexistent wall-clock values", () => {
    expect(() =>
      deadlineInstantFromLocal("invalid", "America/Sao_Paulo"),
    ).toThrow();
    expect(() =>
      deadlineInstantFromLocal("2028-04-01T00:00", "Not/A_Timezone"),
    ).toThrow();
    expect(() =>
      deadlineInstantFromLocal("2028-03-12T02:30", "America/New_York"),
    ).toThrow();
  });
});
