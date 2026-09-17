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
    ).toContain("settings");
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).not.toContain("settings");
  });

  it("fails closed to overview when a site admin requests settings", () => {
    expect(resolveSiteArea("SITE_ADMIN", "settings")).toBe("overview");
    expect(resolveSiteArea("OWNER", "settings")).toBe("settings");
    expect(resolveSiteArea("SITE_ADMIN", "unknown")).toBe("overview");
  });
});
