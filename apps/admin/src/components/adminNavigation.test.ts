import { describe, expect, it } from "vitest";
import {
  getInitials,
  getMobileNavigation,
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
    ).toEqual([
      "home",
      "invitations",
      "messages",
      "gifts",
      "receiving",
      "team",
      "settings",
    ]);
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).toEqual([
      "home",
      "invitations",
      "messages",
      "gifts",
      "receiving",
      "team",
    ]);
  });

  it("keeps the gifts route accessible before receiving setup", () => {
    expect(resolveSiteArea("SITE_ADMIN", "gifts")).toBe("gifts");
    expect(getSiteNavigation("SITE_ADMIN", "site/one")).toContainEqual({
      area: "gifts",
      label: "Presentes",
      href: "/sites/site%2Fone/gifts",
    });
  });

  it("keeps assistant navigation operational and denies owner settings", () => {
    expect(
      getSiteNavigation("SITE_ASSISTANT", "wedding-a").map((item) => item.area),
    ).toEqual(["home", "invitations", "messages", "gifts"]);
    expect(resolveSiteArea("SITE_ASSISTANT", "settings")).toBe("home");
    expect(resolveSiteArea("SITE_ASSISTANT", "team")).toBe("home");
    expect(resolveSiteArea("SITE_ASSISTANT", "receiving")).toBe("home");
    expect(resolveSiteArea("OWNER", "receiving")).toBe("receiving");
  });

  it("protects the receiving guide with the same roles as receiving", () => {
    expect(resolveSiteArea("SITE_ADMIN", "receiving-guide")).toBe(
      "receiving-guide",
    );
    expect(resolveSiteArea("OWNER", "receiving-guide")).toBe("receiving-guide");
    expect(resolveSiteArea("SITE_ASSISTANT", "receiving-guide")).toBe("home");
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).not.toContain("receiving-guide");
  });

  it("starts at home and safely returns unknown or restricted areas there", () => {
    expect(resolveSiteArea("SITE_ADMIN", undefined)).toBe("home");
    expect(resolveSiteArea("SITE_ADMIN", "home")).toBe("home");
    expect(resolveSiteArea("SITE_ADMIN", "settings")).toBe("home");
    expect(resolveSiteArea("OWNER", "settings")).toBe("settings");
    expect(resolveSiteArea("SITE_ADMIN", "unknown")).toBe("home");
    expect(resolveSiteArea("SITE_ADMIN", "guests")).toBe("home");
    expect(resolveSiteArea("SITE_ADMIN", "rsvp")).toBe("home");
  });

  it("keeps mobile navigation compact without losing any authorized page", () => {
    for (const role of ["OWNER", "SITE_ADMIN", "SITE_ASSISTANT"] as const) {
      const all = getSiteNavigation(role, "wedding-a");
      const mobile = getMobileNavigation(all);
      expect(
        mobile.primary.length + Number(mobile.more.length > 0),
      ).toBeLessThanOrEqual(5);
      expect(
        [...mobile.primary, ...mobile.more].map((x) => x.area).sort(),
      ).toEqual(all.map((x) => x.area).sort());
      expect(mobile.primary[0].area).toBe("home");
    }
    expect(
      getMobileNavigation(
        getSiteNavigation("SITE_ADMIN", "wedding-a"),
      ).more.map((x) => x.area),
    ).toEqual(["messages", "team"]);
  });
});
