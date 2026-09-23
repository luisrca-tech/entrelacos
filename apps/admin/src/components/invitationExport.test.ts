import { describe, expect, it } from "vitest";
import { invitationExportPath } from "./invitationExport";

describe("invitation export URL", () => {
  it("applies visible filters and excludes contacts by default", () => {
    expect(
      invitationExportPath("site/1", "csv", {
        requestId: "request-1",
        search: "Família Silva",
        status: "PENDING",
        guestType: "CHILD",
      }),
    ).toBe(
      "/v1/sites/site%2F1/reports/invitations.csv?requestId=request-1&includePhone=false&includeEmail=false&search=Fam%C3%ADlia+Silva&status=PENDING&guestType=CHILD",
    );
  });

  it("includes each contact field only when explicitly selected", () => {
    const url = invitationExportPath("site-1", "pdf", {
      requestId: "request-2",
      search: "",
      status: "ALL",
      guestType: "ALL",
      includePhone: true,
    });
    expect(url).toContain("includePhone=true&includeEmail=false");
    expect(url).not.toContain("status=");
    expect(url).not.toContain("guestType=");
    expect(url).not.toContain("search=");
  });
});
