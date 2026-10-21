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
    ).toEqual([
      "invitations",
      "messages",
      "gifts",
      "receiving",
      "team",
      "settings",
    ]);
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).toEqual(["invitations", "messages", "gifts", "receiving", "team"]);
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
    ).toEqual(["invitations", "messages", "gifts"]);
    expect(resolveSiteArea("SITE_ASSISTANT", "settings")).toBe("invitations");
    expect(resolveSiteArea("SITE_ASSISTANT", "team")).toBe("invitations");
    expect(resolveSiteArea("SITE_ASSISTANT", "receiving")).toBe("invitations");
    expect(resolveSiteArea("OWNER", "receiving")).toBe("receiving");
  });

  it("protects the receiving guide with the same roles as receiving", () => {
    expect(resolveSiteArea("SITE_ADMIN", "receiving-guide")).toBe(
      "receiving-guide",
    );
    expect(resolveSiteArea("OWNER", "receiving-guide")).toBe("receiving-guide");
    expect(resolveSiteArea("SITE_ASSISTANT", "receiving-guide")).toBe(
      "invitations",
    );
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).not.toContain("receiving-guide");
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
