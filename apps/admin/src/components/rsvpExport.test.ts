import { describe, expect, it } from "vitest";
import { exportFilename, rsvpExportPath } from "./rsvpExport";

describe("RSVP export helpers", () => {
  it("requires an explicit phone choice and binds filters to a request ID", () => {
    expect(
      rsvpExportPath("casamento-a", "csv", {
        requestId: "f4217d1d-bcae-4ac1-a67b-fabc195b7b86",
        includePhone: false,
        groupId: "group/a",
        state: "CONFIRMED",
      }),
    ).toBe(
      "/v1/sites/casamento-a/reports/rsvp.csv?requestId=f4217d1d-bcae-4ac1-a67b-fabc195b7b86&includePhone=false&groupId=group%2Fa&state=CONFIRMED",
    );
  });

  it("accepts only safe attachment filenames", () => {
    expect(
      exportFilename(
        'attachment; filename="entrelacos-rsvp-casamento-a.csv"',
        "fallback.csv",
      ),
    ).toBe("entrelacos-rsvp-casamento-a.csv");
    expect(
      exportFilename('attachment; filename="../../secret"', "fallback.csv"),
    ).toBe("fallback.csv");
  });
});
