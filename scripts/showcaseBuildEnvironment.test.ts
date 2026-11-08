import { describe, expect, it } from "vitest";
import { showcaseBuildEnvironment } from "./showcaseBuildEnvironment";

describe("reviewed showcase build environments", () => {
  it("enables only the authorized production Botanical tenant", () => {
    const env = showcaseBuildEnvironment("botanical", "production");
    expect(env).toMatchObject({
      APP_ENV: "production",
      PUBLIC_SITE_ID: "demo-wedding",
      PUBLIC_LIVE_DEMO_SITE_ID: "demo-wedding",
      PUBLIC_API_URL: "https://api.entrelacosbr.site",
    });
  });
  it("keeps DEV sandbox and Letters without a live opt-in", () => {
    expect(
      showcaseBuildEnvironment("botanical", "development")
        .PUBLIC_LIVE_DEMO_SITE_ID,
    ).toBe("");
    for (const environment of ["development", "production"]) {
      expect(showcaseBuildEnvironment("letters", environment)).toMatchObject({
        PUBLIC_SITE_ID: "demo-wedding-cartas",
        PUBLIC_LIVE_DEMO_SITE_ID: "",
      });
    }
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
