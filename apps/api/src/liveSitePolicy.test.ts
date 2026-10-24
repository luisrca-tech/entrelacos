import { describe, expect, it } from "vitest";
import { allowsLiveSite } from "./liveSitePolicy";

describe("explicit live site policy", () => {
  const production = {
    mode: "live" as const,
    applicationEnvironment: "production" as const,
  };
  it("allows regular production sites without opt-in", () => {
    expect(
      allowsLiveSite({ ...production, siteId: "real-site", isDemo: false }),
    ).toBe(true);
  });
  it("allows only the explicitly designated production showcase while keeping its demo marker", () => {
    const site = {
      ...production,
      siteId: "demo-wedding",
      isDemo: true,
      liveDemoSiteId: "demo-wedding",
    };
    expect(allowsLiveSite(site)).toBe(true);
    expect(site.isDemo).toBe(true);
    expect(allowsLiveSite({ ...site, siteId: "other-demo" })).toBe(false);
    expect(allowsLiveSite({ ...site, liveDemoSiteId: undefined })).toBe(false);
  });
  it.each(["development", "test"] as const)(
    "never grants live access in %s",
    (applicationEnvironment) => {
      for (const isDemo of [true, false])
        expect(
          allowsLiveSite({
            ...production,
            applicationEnvironment,
            siteId: "demo-wedding",
            isDemo,
            liveDemoSiteId: "demo-wedding",
          }),
        ).toBe(false);
    },
  );
  it.each(["disabled", "sandbox"] as const)(
    "never grants %s access",
    (mode) => {
      expect(
        allowsLiveSite({
          ...production,
          mode,
          siteId: "demo-wedding",
          isDemo: true,
          liveDemoSiteId: "demo-wedding",
        }),
      ).toBe(false);
    },
  );
  it.each([
    "",
    "demo-wedding,other-demo",
    " demo-wedding",
    "demo-wedding/other",
  ])("rejects malformed showcase IDs (%#)", (liveDemoSiteId) => {
    expect(
      allowsLiveSite({
        ...production,
        siteId: liveDemoSiteId,
        isDemo: true,
        liveDemoSiteId,
      }),
    ).toBe(false);
  });
});
