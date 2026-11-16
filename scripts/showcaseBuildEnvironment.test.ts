import { describe, expect, it } from "vitest";
import { showcaseBuildEnvironment } from "./showcaseBuildEnvironment";

describe("reviewed showcase build environments", () => {
  it.each([
    ["botanical", "demo-wedding"],
    ["letters", "demo-wedding-cartas"],
  ])(
    "binds the %s production build to its own showcase only",
    (app, siteId) => {
      expect(showcaseBuildEnvironment(app, "production")).toMatchObject({
        APP_ENV: "production",
        PUBLIC_SITE_ID: siteId,
        PUBLIC_LIVE_DEMO_SITE_ID: siteId,
        PUBLIC_API_URL: "https://api.entrelacosbr.site",
      });
    },
  );
  it("keeps every DEV showcase and the landing in sandbox without a live opt-in", () => {
    for (const app of ["botanical", "letters"])
      expect(
        showcaseBuildEnvironment(app, "development").PUBLIC_LIVE_DEMO_SITE_ID,
      ).toBe("");
    expect(
      showcaseBuildEnvironment("landing", "production")
        .PUBLIC_LIVE_DEMO_SITE_ID,
    ).toBe("");
  });
  it.each([
    ["botanical", "development", "demo-botanico-dev"],
    ["botanical", "production", "demo-botanico"],
    ["letters", "development", "demo-cartas-dev"],
    ["letters", "production", "demo-cartas"],
    ["landing", "development", "dev"],
    ["landing", "production", ""],
  ])(
    "builds %s for %s with the isolated custom domains",
    (app, environment, host) => {
      const suffix = environment === "development" ? "-dev" : "";
      expect(showcaseBuildEnvironment(app, environment)).toMatchObject({
        APP_ENV: environment,
        PUBLIC_SITE_URL: `https://${host ? `${host}.` : ""}entrelacosbr.site/`,
        PUBLIC_BOTANICAL_DEMO_URL: `https://demo-botanico${suffix}.entrelacosbr.site/`,
        PUBLIC_LETTERS_DEMO_URL: `https://demo-cartas${suffix}.entrelacosbr.site/`,
        PUBLIC_API_URL: `https://api${suffix}.entrelacosbr.site`,
        PUBLIC_ADMIN_ORIGIN: `https://admin${suffix}.entrelacosbr.site`,
        PUBLIC_SITE_ID:
          app === "letters" ? "demo-wedding-cartas" : "demo-wedding",
        PUBLIC_SITE_INACTIVE: "false",
        PUBLIC_LANDING_URL:
          environment === "production"
            ? "https://entrelacosbr.site/"
            : "https://dev.entrelacosbr.site/",
      });
    },
  );
  it("rejects unknown targets rather than defaulting to production", () => {
    expect(() => showcaseBuildEnvironment("botanical", "prod")).toThrow();
    expect(() => showcaseBuildEnvironment("unknown", "production")).toThrow();
  });
});
