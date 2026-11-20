import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentsAvailabilityStore } from "../lib/paymentsAvailability";
import {
  getInitials,
  getMobileNavigation,
  getSiteNavigation,
  resolveSiteArea,
} from "./adminNavigation";

// The API reports payments as available unless a test says otherwise.
beforeEach(() => paymentsAvailabilityStore.reportMode("sandbox"));
afterEach(() => paymentsAvailabilityStore.reset());

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

describe("navigation with money gifts switched off", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("drops the receiving area from every menu and redirects its links home", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
    for (const role of ["OWNER", "SITE_ADMIN", "SITE_ASSISTANT"] as const) {
      const areas = getSiteNavigation(role, "site-1").map((item) => item.area);
      expect(areas).not.toContain("receiving");
      expect(areas).toContain("gifts");
      expect(resolveSiteArea(role, "receiving")).toBe("home");
      expect(resolveSiteArea(role, "receiving-guide")).toBe("home");
    }
    const mobile = getMobileNavigation(getSiteNavigation("OWNER", "site-1"));
    expect(
      [...mobile.primary, ...mobile.more].map((item) => item.area),
    ).not.toContain("receiving");
  });
  it("keeps the receiving area by default once the API accepts payments", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", undefined);
    expect(
      getSiteNavigation("SITE_ADMIN", "site-1").map((item) => item.area),
    ).toContain("receiving");
    expect(resolveSiteArea("OWNER", "receiving-guide")).toBe("receiving-guide");
  });
});

describe("navigation follows what the API reports about payments", () => {
  afterEach(() => vi.unstubAllEnvs());
  const receiving = (role: "OWNER" | "SITE_ADMIN") =>
    getSiteNavigation(role, "site-1").map((item) => item.area);

  it.each([
    ["disabled", "unavailable"],
    ["not asked yet", "unknown"],
    ["unreachable", "unreachable"],
  ] as const)("hides receiving when the API is %s", (_label, state) => {
    paymentsAvailabilityStore.reset();
    if (state === "unavailable")
      paymentsAvailabilityStore.reportMode("disabled");
    if (state === "unreachable") paymentsAvailabilityStore.reportFailure();
    for (const role of ["OWNER", "SITE_ADMIN"] as const) {
      expect(receiving(role)).not.toContain("receiving");
      expect(receiving(role)).toContain("gifts");
    }
    const mobile = getMobileNavigation(getSiteNavigation("OWNER", "site-1"));
    expect(
      [...mobile.primary, ...mobile.more].map((item) => item.area),
    ).not.toContain("receiving");
  });

  it("shows receiving for sandbox and live", () => {
    for (const mode of ["sandbox", "live"] as const) {
      paymentsAvailabilityStore.reportMode(mode);
      expect(receiving("OWNER")).toContain("receiving");
      expect(receiving("SITE_ADMIN")).toContain("receiving");
    }
  });

  it("lets the caller pass the availability it subscribed to", () => {
    paymentsAvailabilityStore.reportMode("disabled");
    expect(
      getSiteNavigation("OWNER", "site-1", true).map((item) => item.area),
    ).toContain("receiving");
    paymentsAvailabilityStore.reportMode("live");
    expect(
      getSiteNavigation("OWNER", "site-1", false).map((item) => item.area),
    ).not.toContain("receiving");
  });

  it("keeps the manual pause stronger than the API", () => {
    vi.stubEnv("PUBLIC_GIFT_PAYMENTS_ENABLED", "false");
    paymentsAvailabilityStore.reportMode("live");
    expect(receiving("OWNER")).not.toContain("receiving");
    expect(resolveSiteArea("OWNER", "receiving")).toBe("home");
  });

  it("sends receiving links home when the API says disabled or unreachable", () => {
    for (const state of ["unavailable", "unreachable"] as const) {
      paymentsAvailabilityStore.reset();
      if (state === "unavailable")
        paymentsAvailabilityStore.reportMode("disabled");
      else paymentsAvailabilityStore.reportFailure();
      expect(resolveSiteArea("OWNER", "receiving")).toBe("home");
      expect(resolveSiteArea("SITE_ADMIN", "receiving-guide")).toBe("home");
    }
    expect(resolveSiteArea("OWNER", "gifts")).toBe("gifts");
  });

  it("waits for the API instead of redirecting a deep link while unknown", () => {
    paymentsAvailabilityStore.reset();
    expect(resolveSiteArea("OWNER", "receiving")).toBe("receiving");
    expect(resolveSiteArea("SITE_ADMIN", "receiving-guide")).toBe(
      "receiving-guide",
    );
    expect(resolveSiteArea("SITE_ASSISTANT", "receiving")).toBe("home");
  });

  it("accepts an explicit availability for pure callers", () => {
    expect(resolveSiteArea("OWNER", "receiving", "unavailable")).toBe("home");
    expect(resolveSiteArea("OWNER", "receiving", "available")).toBe(
      "receiving",
    );
  });
});
