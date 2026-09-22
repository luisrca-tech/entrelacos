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
    ).toEqual(["guests", "rsvp", "messages", "settings"]);
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).toEqual(["guests", "rsvp", "messages"]);
  });

  it("defaults every site entry to guests and fails closed there", () => {
    expect(resolveSiteArea("SITE_ADMIN", undefined)).toBe("guests");
    expect(resolveSiteArea("SITE_ADMIN", "settings")).toBe("guests");
    expect(resolveSiteArea("OWNER", "settings")).toBe("settings");
    expect(resolveSiteArea("SITE_ADMIN", "unknown")).toBe("guests");
  });
});
