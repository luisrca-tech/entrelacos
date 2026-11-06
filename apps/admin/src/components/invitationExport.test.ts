import { describe, expect, it } from "vitest";
import { invitationExportPath } from "./invitationExport";

describe("invitation export URL", () => {
  it("uses the chosen model and preserves the group-level partial filter", () => {
    expect(
      invitationExportPath("site-1", {
        model: "groups",
        filters: { search: "Costa", status: "PARTIAL", guestType: "CHILD" },
        requestId: "request-3",
        includePhone: true,
        includeEmail: false,
      }),
    ).toBe(
      "/v1/sites/site-1/reports/invitations.csv?requestId=request-3&model=groups&includePhone=true&includeEmail=false&search=Costa&groupStatus=PARTIAL&guestType=CHILD",
    );
  });

  it("does not send filters or contact information with the reception list", () => {
    expect(
      invitationExportPath("site-1", {
        model: "reception",
        filters: { search: "Costa", status: "DECLINED", guestType: "ADULT" },
        requestId: "request-4",
        includePhone: true,
        includeEmail: true,
      }),
    ).toBe(
      "/v1/sites/site-1/reports/invitations.pdf?requestId=request-4&model=reception&includePhone=false&includeEmail=false",
    );
  });

  it("uses the selected detailed CSV and exports the whole wedding when no filters are selected", () => {
    const url = invitationExportPath("site/1", {
      model: "guests",
      requestId: "request-2",
      includePhone: false,
      includeEmail: true,
    });
    expect(url).toBe(
      "/v1/sites/site%2F1/reports/invitations.csv?requestId=request-2&model=guests&includePhone=false&includeEmail=true",
    );
  });
});
