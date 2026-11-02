import { describe, expect, it } from "vitest";
import { showcaseBuildEnvironment } from "./showcaseBuildEnvironment";

describe("reviewed showcase build environments", () => {
  it("enables only the authorized production Botanical tenant", () => {
    const env = showcaseBuildEnvironment("botanical", "production");
    expect(env).toMatchObject({
      APP_ENV: "production",
      PUBLIC_SITE_ID: "demo-wedding",
      PUBLIC_LIVE_DEMO_SITE_ID: "demo-wedding",
      PUBLIC_API_URL: "https://entrelacosapi-production.up.railway.app",
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
    ["landing", "development", "entrelacos-dev"],
    ["landing", "production", "entrelacos"],
  ])(
    "builds %s for %s with the current Worker origins",
    (app, environment, host) => {
      const suffix = environment === "development" ? "-dev" : "";
      expect(showcaseBuildEnvironment(app, environment)).toMatchObject({
        APP_ENV: environment,
        PUBLIC_SITE_URL: `https://${host}.entrelacos.workers.dev/`,
        PUBLIC_BOTANICAL_DEMO_URL: `https://demo-botanico${suffix}.entrelacos.workers.dev/`,
        PUBLIC_LETTERS_DEMO_URL: `https://demo-cartas${suffix}.entrelacos.workers.dev/`,
        PUBLIC_API_URL: `https://entrelacosapi-${environment}.up.railway.app`,
        PUBLIC_ADMIN_ORIGIN: `https://admin${suffix}.entrelacos.workers.dev`,
        PUBLIC_SITE_ID:
          app === "letters" ? "demo-wedding-cartas" : "demo-wedding",
        PUBLIC_SITE_INACTIVE: "false",
      });
    },
  );
  it("rejects unknown targets rather than defaulting to production", () => {
    expect(() => showcaseBuildEnvironment("botanical", "prod")).toThrow();
    expect(() => showcaseBuildEnvironment("unknown", "production")).toThrow();
  });
});
