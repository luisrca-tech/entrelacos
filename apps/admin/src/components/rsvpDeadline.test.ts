import { describe, expect, it } from "vitest";
import {
  deadlineCountdown,
  deadlineInstantFromLocal,
  deadlineLocalFromInstant,
  joinDeadlineLocal,
  resetDeadlineDraft,
  splitDeadlineLocal,
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

  it("copies persisted values when cancelling a deadline draft", () => {
    const saved = {
      deadlineLocal: "2028-04-01T00:00",
      deadlineTimezone: "America/Sao_Paulo",
    };

    const restored = resetDeadlineDraft(saved);
    expect(restored).toEqual(saved);
    restored.deadlineLocal = "";
    expect(saved.deadlineLocal).toBe("2028-04-01T00:00");
  });

  it("splits and joins the date and time fields without changing the value", () => {
    expect(splitDeadlineLocal("2028-04-01T18:30")).toEqual({
      date: "2028-04-01",
      time: "18:30",
    });
    expect(joinDeadlineLocal("2028-04-01", "18:30")).toBe("2028-04-01T18:30");
  });

  it("keeps an empty deadline valid but rejects incomplete fields", () => {
    expect(joinDeadlineLocal("", "")).toBe("");
    expect(() => joinDeadlineLocal("2028-04-01", "")).toThrow(
      "Informe a data e o horário do prazo.",
    );
  });
});

describe("RSVP deadline countdown", () => {
  const deadline = "2027-01-16T02:59:00.000Z"; // 15/01/2027 23:59 in São Paulo

  it("counts calendar days left in São Paulo", () => {
    expect(deadlineCountdown(deadline, new Date("2026-11-05T15:00:00Z"))).toBe(
      "Faltam 71 dias para encerrar as respostas",
    );
    // 23:30 on 05/11 in São Paulo is already 06/11 in UTC.
    expect(deadlineCountdown(deadline, new Date("2026-11-06T02:30:00Z"))).toBe(
      "Faltam 71 dias para encerrar as respostas",
    );
  });

  it("uses the singular and the same-day wording", () => {
    expect(deadlineCountdown(deadline, new Date("2027-01-14T12:00:00Z"))).toBe(
      "Falta 1 dia para encerrar as respostas",
    );
    expect(deadlineCountdown(deadline, new Date("2027-01-15T12:00:00Z"))).toBe(
      "As respostas encerram hoje",
    );
  });

  it("reports a deadline that has passed", () => {
    expect(deadlineCountdown(deadline, new Date("2027-01-16T02:59:00Z"))).toBe(
      "Prazo encerrado",
    );
    expect(deadlineCountdown(deadline, new Date("2027-03-01T12:00:00Z"))).toBe(
      "Prazo encerrado",
    );
  });

  it("returns nothing for a missing or invalid deadline", () => {
    expect(deadlineCountdown(null, new Date())).toBeNull();
    expect(deadlineCountdown("not a date", new Date())).toBeNull();
  });
});
