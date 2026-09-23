import { describe, expect, it } from "vitest";
import {
  getInitials,
  getSiteNavigation,
  resolveSiteArea,
} from "./adminNavigation";

describe("admin shell navigation", () => {
  it("derives circular account initials from the actor name", () => {
    expect(getInitials("Ana Beatriz Costa")).toBe("AC");
    expect(getInitials("João")).toBe("J");
    expect(getInitials("  ")).toBe("?");
  });

  it("shows settings only to owners", () => {
    expect(
      getSiteNavigation("OWNER", "site-1").map((item) => item.area),
    ).toEqual(["invitations", "messages", "settings"]);
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).toEqual(["invitations", "messages"]);
  });

  it("defaults every site entry to invitations and rejects removed pages", () => {
    expect(resolveSiteArea("SITE_ADMIN", undefined)).toBe("invitations");
    expect(resolveSiteArea("SITE_ADMIN", "settings")).toBe("invitations");
    expect(resolveSiteArea("OWNER", "settings")).toBe("settings");
    expect(resolveSiteArea("SITE_ADMIN", "unknown")).toBe("invitations");
    expect(resolveSiteArea("SITE_ADMIN", "guests")).toBe("invitations");
    expect(resolveSiteArea("SITE_ADMIN", "rsvp")).toBe("invitations");
  });
});
